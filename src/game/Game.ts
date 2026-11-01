import * as THREE from 'three';
import { findVehicleCollision, type Collider } from '../core/geometry';
import { DEG } from '../core/math';
import { loadRecords, loadSettings, QUALITY_PRESETS, sanitizeSettings, saveRecords, saveSettings, type Records, type Settings } from '../core/settings';
import { removeKey } from '../core/storage';
import { getMap, mapColliders } from '../maps';
import { buildMap, type BuiltMap } from '../maps/mapBuilder';
import type { MapData, MapMission } from '../maps/types';
import { HOLD_SECONDS, HEADING_TOLERANCE, MissionRunner, type ParkingSlot } from '../mission/parking';
import { Beeper } from '../sensors/beeper';
import { SensorView, type SensorViewSize } from '../sensors/SensorView';
import {
  DEFAULT_SENSOR_CONFIG,
  activeGroupsFor,
  beepIntervalMs,
  minDistance,
  readSensors,
  type SensorConfig,
  type SensorSnapshot,
} from '../sensors/sensorSystem';
import { Hud, type HudData, type MissionHud } from '../ui/hud';
import { PdcDisplay } from '../ui/PdcDisplay';
import { Menu, type ResultInfo } from '../ui/menu';
import { applyGlbVisual, createCarModel, type CarModel } from '../vehicle/carModel';
import {
  centerOf,
  createVehicleState,
  obbOf,
  requestGear,
  stepVehicle,
  type Gear,
  type VehicleInput,
  type VehicleState,
} from '../vehicle/physics';
import { getVehicle, type VehicleSpec } from '../vehicle/spec';
import { CAMERA_NAMES, CameraRig } from './cameras';
import { Input, type Action } from './input';

const STEP = 1 / 120;
type GameState = 'menu' | 'playing' | 'paused' | 'result';

const fmtTime = (s: number): string => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

export class Game {
  readonly canvas: HTMLCanvasElement;
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly rig = new CameraRig();
  readonly input = new Input();
  readonly beeper = new Beeper();
  readonly hud: Hud;
  readonly parkingDisplay: PdcDisplay;
  readonly menu: Menu;
  readonly sensorView: SensorView;
  private pip: HTMLCanvasElement;
  private pipCtx: CanvasRenderingContext2D;

  settings: Settings = loadSettings();
  records: Records = loadRecords();
  state: GameState = 'menu';

  map!: MapData;
  built: BuiltMap | null = null;
  colliders: Collider[] = [];
  colliderById = new Map<string, Collider>();
  spec!: VehicleSpec;
  car!: VehicleState;
  model: CarModel | null = null;
  missionDef: MapMission | null = null;
  mission: MissionRunner | null = null;
  targetSlot: ParkingSlot | null = null;
  sensorSnap: SensorSnapshot | null = null;

  private headlights = false;
  private sigLeft = false;
  private sigRight = false;
  private hazard = false;
  private blinkOn = false;
  private blinkT = 0;
  private throttle = 0;
  private brake = 0;
  private steerIn = 0;
  private acc = 0;
  private collisions = 0;
  private inContact = false;
  private contactClear = 0;
  private minimapMode: 'small' | 'large' | 'hidden' = 'small';
  private last = 0;
  private time = 0;
  private hudAcc = 0;
  private svAcc = 0;
  private fpsFrames = 0;
  private fpsTime = 0;
  private fpsInstant = 0;
  private fpsAvgLast = 0;
  private fpsWinFrames = 0;
  private fpsWinTime = 0;
  private resultTimer = 0;
  private hintTimer = 0;
  private loadedMapId = '';
  private pendingResult: ResultInfo | null = null;

  constructor(root: HTMLElement, canvas: HTMLCanvasElement, pip: HTMLCanvasElement) {
    this.canvas = canvas;
    this.pip = pip;
    this.pipCtx = pip.getContext('2d')!;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: this.settings.quality !== 'low', powerPreference: 'high-performance' });
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.setClearColor(0x9ec9ee);
    this.applyQuality();

    this.hud = new Hud(root, { action: (a) => this.onAction(a), input: this.input });
    this.hud.bindExtra();
    this.parkingDisplay = new PdcDisplay(root, pip, () => this.onAction('soundToggle'));
    this.hud.onSensorSize = (s) => (s === 'reset' ? this.sensorView.resetCamera() : this.setSensorSize(s));
    this.sensorView = new SensorView(this.hud.sensorSlot);
    this.sensorView.setSize('small');

    this.menu = new Menu(root, {
      settings: () => this.settings,
      update: (p) => this.updateSettings(p),
      records: () => this.records,
      resetRecords: () => {
        this.records = {};
        removeKey('records');
        this.hud.toast('기록을 초기화했습니다');
      },
      avgFps: () => this.avgFps(),
      startGame: () => this.startRun(),
      resume: () => this.resume(),
      restart: () => this.startRun(),
      toMainMenu: () => this.toMainMenu(),
      nextMission: () => this.nextMission(),
      hasNextMission: () => this.nextMissionId() !== null,
    });

    this.input.onAction = (a) => this.onAction(a);
    this.input.attach();
    this.rig.bind(canvas);
    window.addEventListener('resize', () => this.onResize());
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && this.state === 'playing') this.pause();
    });
    this.applyTouch();
    this.onResize();
  }

  // ------------------------------------------------------------ 설정/품질
  updateSettings(patch: Partial<Settings>): void {
    const before = this.settings;
    this.settings = sanitizeSettings({ ...before, ...patch });
    saveSettings(this.settings);
    if (before.resolutionScale !== this.settings.resolutionScale) this.applyQuality();
    if (before.quality !== this.settings.quality) this.loadedMapId = ''; // 텍스처 해상도는 맵을 다시 만들 때 적용
    if (before.shadows !== this.settings.shadows) this.applyShadows();
    if (before.touchControls !== this.settings.touchControls || before.touchScale !== this.settings.touchScale) this.applyTouch();
    this.beeper.volume = this.settings.sensorVolume;
    this.beeper.enabled = this.settings.sensorSound && this.settings.sensorEnabled;
    if (!this.settings.sensorSound || !this.settings.sensorEnabled) this.beeper.silence();
  }

  private applyQuality(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.renderer.setPixelRatio(dpr * this.settings.resolutionScale);
    this.renderer.setSize(window.innerWidth, window.innerHeight, false);
  }

  private shadowMapSize(): number {
    switch (this.settings.shadows) {
      case 'low': return 512;
      case 'medium': return 1024;
      case 'high': return 2048;
      default: return 0;
    }
  }

  private applyShadows(): void {
    const size = this.shadowMapSize();
    this.renderer.shadowMap.enabled = size > 0;
    const sun = this.built?.sun;
    if (sun) {
      sun.castShadow = size > 0;
      if (size > 0 && sun.shadow.mapSize.x !== size) {
        sun.shadow.mapSize.set(size, size);
        sun.shadow.map?.dispose();
        sun.shadow.map = null;
      }
    }
    this.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && m.material) {
        const mats = Array.isArray(m.material) ? m.material : [m.material];
        for (const mat of mats) mat.needsUpdate = true;
      }
    });
  }

  private applyTouch(): void {
    const coarse = window.matchMedia?.('(pointer: coarse)').matches || navigator.maxTouchPoints > 0;
    const show = this.settings.touchControls === 'on' || (this.settings.touchControls === 'auto' && coarse);
    this.hud.setTouchVisible(show, this.settings.touchScale);
  }

  private onResize(): void {
    this.applyQuality();
    this.rig.setAspect(window.innerWidth, window.innerHeight);
  }

  // ------------------------------------------------------------ FPS
  avgFps(): number {
    if (this.fpsWinTime > 1) return this.fpsWinFrames / this.fpsWinTime;
    return this.fpsAvgLast || this.fpsInstant;
  }

  // ------------------------------------------------------------ 맵/실행
  private loadMap(map: MapData): void {
    if (this.built) {
      this.scene.remove(this.built.group);
      this.built.dispose();
    }
    const tier = this.settings.quality;
    const maxAniso = this.renderer.capabilities.getMaxAnisotropy();
    this.built = buildMap(map, {
      textureSize: tier === 'low' ? 128 : tier === 'medium' ? 256 : 512,
      anisotropy: tier === 'low' ? 1 : Math.min(tier === 'medium' ? 4 : 8, maxAniso),
      shadows: this.shadowMapSize() > 0,
    });
    this.scene.add(this.built.group);
    this.scene.background = new THREE.Color(map.env.sky);
    this.scene.fog = map.env.indoor ? new THREE.Fog(0x0d1015, 28, 110) : new THREE.Fog(map.env.sky, 100, 320);
    this.colliders = mapColliders(map);
    this.colliderById = new Map(this.colliders.map((c) => [c.id, c]));
    this.hud.minimap.setMap(map);
    this.loadedMapId = map.id;
    this.map = map;
    this.applyShadows();
  }

  startRun(): void {
    this.beeper.init();
    this.beeper.volume = this.settings.sensorVolume;
    const map = getMap(this.settings.mapId);
    if (this.loadedMapId !== map.id || !this.built) this.loadMap(map);
    this.map = map;
    this.missionDef = map.missions.find((m) => m.id === this.settings.missionId) ?? null;
    this.targetSlot = this.missionDef ? (map.slots.find((s) => s.id === this.missionDef!.slotId) ?? null) : null;
    this.mission = this.missionDef && this.targetSlot ? new MissionRunner(this.missionDef, this.targetSlot) : null;
    this.built!.setTarget(this.targetSlot);

    if (this.model) {
      this.scene.remove(this.model.root);
      this.model.dispose();
    }
    this.spec = getVehicle(this.settings.vehicleId);
    this.model = createCarModel(this.spec, { blobTexture: this.built!.textures.blob });
    this.scene.add(this.model.root);
    if (this.spec.visual.kind === 'glb') void applyGlbVisual(this.model, this.spec);
    this.sensorView.setSpec(this.spec);

    const sp = this.missionDef?.spawn ?? map.spawn;
    this.car = createVehicleState(this.spec, sp.x, sp.z, sp.heading);
    this.headlights = map.env.indoor;
    this.sigLeft = this.sigRight = this.hazard = false;
    this.throttle = this.brake = this.steerIn = 0;
    this.collisions = 0;
    this.inContact = false;
    this.acc = 0;
    this.sensorSnap = null;
    this.rig.setMode(this.rig.mode, this.poseNow());
    this.rig.snap();

    this.menu.close();
    this.parkingDisplay.update(false, false, false, false, null);
    this.hud.show();
    this.hud.setMinimapMode(this.minimapMode);
    this.hud.setSensorControls(this.sensorView.getSize());
    this.state = 'playing';
    this.input.enabled = true;
    this.input.clear();
    this.hintTimer = 8;
    const coarse = this.settings.touchControls === 'on' || (this.settings.touchControls === 'auto' && (navigator.maxTouchPoints > 0 || window.matchMedia?.('(pointer: coarse)').matches));
    this.hud.hint(
      (this.missionDef ? `<b>${this.missionDef.name}</b> — ${this.missionDef.desc}<br>` : '<b>자유주행</b><br>') +
        (coarse ? '화면의 <b>D</b>/<b>R</b> 버튼으로 기어를 바꾸고 가속·브레이크 버튼으로 운전하세요' : '<b>F</b> 전진(D) · <b>R</b> 후진 · <b>W/S</b> 가속·브레이크 · <b>A/D</b> 조향 · <b>Space</b> 주차 브레이크') +
        '<br>초록색으로 표시된 칸에 주차하세요.',
    );
    if (!this.last) {
      this.last = performance.now();
      requestAnimationFrame((t) => this.frame(t));
    }
  }

  private poseNow(): { x: number; z: number; heading: number } {
    const c = centerOf(this.car, this.spec);
    return { x: c.x, z: c.z, heading: this.car.heading };
  }

  pause(): void {
    if (this.state !== 'playing') return;
    this.state = 'paused';
    this.input.enabled = false;
    this.input.clear();
    this.beeper.silence();
    this.menu.showPause();
  }

  resume(): void {
    if (this.state !== 'paused') return;
    this.menu.close();
    this.state = 'playing';
    this.input.enabled = true;
    this.input.clear();
    this.last = performance.now();
  }

  toMainMenu(): void {
    this.state = 'menu';
    this.input.enabled = false;
    this.beeper.silence();
    this.hud.hide();
    this.parkingDisplay.update(false, false, false, false, null);
    this.menu.showMain();
  }

  private nextMissionId(): string | null {
    const i = this.map?.missions.findIndex((m) => m.id === this.settings.missionId) ?? -1;
    if (i < 0 || !this.map || i + 1 >= this.map.missions.length) return null;
    return this.map.missions[i + 1].id;
  }

  nextMission(): void {
    const id = this.nextMissionId();
    if (id) this.updateSettings({ missionId: id });
    this.startRun();
  }

  resetCar(): void {
    const sp = this.missionDef?.spawn ?? this.map.spawn;
    this.car = createVehicleState(this.spec, sp.x, sp.z, sp.heading);
    this.rig.snap();
    this.hud.toast('차량을 초기 위치로 되돌렸습니다');
  }

  // ------------------------------------------------------------ 액션
  setSensorSize(s: SensorViewSize): void {
    this.sensorView.setSize(s);
    this.hud.setSensorControls(s);
  }

  onAction(a: Action): void {
    if (a === 'pause') {
      if (this.state === 'playing') this.pause();
      else if (this.state === 'paused') this.resume();
      return;
    }
    if (this.state !== 'playing') return;
    switch (a) {
      case 'gearD':
      case 'gearR':
      case 'gearP':
      case 'gearN': {
        const g = a.slice(4) as Gear;
        const r = requestGear(this.car, g);
        if (!r.ok) {
          this.hud.toast(r.reason ?? '지금은 기어를 바꿀 수 없습니다', 'warn');
        } else if (g === 'R') {
          this.hud.toast('후진(R) · 후방 카메라/주차 센서 작동');
          if (this.settings.sensorEnabled && this.sensorView.getSize() === 'hidden') this.setSensorSize('small');
        } else {
          this.hud.toast(`기어 ${g}`);
        }
        break;
      }
      case 'handbrake':
        this.car.handbrake = !this.car.handbrake;
        this.hud.toast(this.car.handbrake ? '주차 브레이크 ON' : '주차 브레이크 OFF');
        break;
      case 'camera': {
        const m = this.rig.next(this.poseNow());
        this.hud.toast(`카메라: ${CAMERA_NAMES[m]}`);
        break;
      }
      case 'minimap':
        this.minimapMode = this.minimapMode === 'small' ? 'large' : this.minimapMode === 'large' ? 'hidden' : 'small';
        this.hud.setMinimapMode(this.minimapMode);
        break;
      case 'sensorView': {
        const cur = this.sensorView.getSize();
        this.setSensorSize(cur === 'small' ? 'large' : cur === 'large' ? 'hidden' : 'small');
        break;
      }
      case 'signalLeft':
        this.sigLeft = !this.sigLeft;
        if (this.sigLeft) this.sigRight = false;
        this.hazard = false;
        break;
      case 'signalRight':
        this.sigRight = !this.sigRight;
        if (this.sigRight) this.sigLeft = false;
        this.hazard = false;
        break;
      case 'hazard':
        this.hazard = !this.hazard;
        if (this.hazard) this.sigLeft = this.sigRight = false;
        break;
      case 'headlights':
        this.headlights = !this.headlights;
        this.hud.toast(this.headlights ? '전조등 ON' : '전조등 OFF');
        break;
      case 'reset':
        this.resetCar();
        break;
      case 'restart':
        this.startRun();
        break;
      case 'sensorToggle':
        this.updateSettings({ sensorEnabled: !this.settings.sensorEnabled });
        this.hud.toast(this.settings.sensorEnabled ? '주차 센서 ON' : '주차 센서 OFF', this.settings.sensorEnabled ? '' : 'warn');
        break;
      case 'soundToggle':
        this.updateSettings({ sensorSound: !this.settings.sensorSound });
        this.hud.toast(this.settings.sensorSound ? '센서 경고음 ON' : '센서 경고음 OFF');
        break;
    }
  }

  // ------------------------------------------------------------ 루프
  private frame(now: number): void {
    requestAnimationFrame((t) => this.frame(t));
    const dt = Math.min(0.05, Math.max(0.0001, (now - this.last) / 1000));
    this.last = now;
    this.time += dt;
    this.trackFps(dt);
    if (!this.car) return;

    if (this.state === 'playing') this.simulate(dt);
    else if (this.state === 'result') {
      // 결과 대기: 차는 천천히 정지, 결과 화면 표시 지연
      this.resultTimer -= dt;
      if (this.resultTimer <= 0 && this.pendingResult) {
        this.menu.showResult(this.pendingResult);
        this.pendingResult = null;
      }
    }
    this.render(dt);
  }

  private trackFps(dt: number): void {
    this.fpsFrames++;
    this.fpsTime += dt;
    if (this.fpsTime >= 0.5) {
      this.fpsInstant = this.fpsFrames / this.fpsTime;
      this.fpsFrames = 0;
      this.fpsTime = 0;
    }
    this.fpsWinFrames++;
    this.fpsWinTime += dt;
    if (this.fpsWinTime >= 5) {
      this.fpsAvgLast = this.fpsWinFrames / this.fpsWinTime;
      this.fpsWinFrames = 0;
      this.fpsWinTime = 0;
    }
  }

  private readInput(dt: number): VehicleInput {
    const h = this.input.held;
    const ramp = (cur: number, target: number, up: number, down: number): number => {
      const d = target - cur;
      const r = (d > 0 ? up : down) * dt;
      return Math.abs(d) <= r ? target : cur + Math.sign(d) * r;
    };
    this.throttle = ramp(this.throttle, h.throttle ? 1 : 0, 3.5, 6);
    this.brake = ramp(this.brake, h.brake ? 1 : 0, 6, 8);
    const st = (h.left ? 1 : 0) - (h.right ? 1 : 0);
    this.steerIn = ramp(this.steerIn, st, 5, 7);
    return { throttle: this.throttle, brake: this.brake, steerInput: this.steerIn };
  }

  private simulate(dt: number): void {
    const vin = this.readInput(dt);
    this.acc += dt;
    let steps = 0;
    while (this.acc >= STEP && steps < 12) {
      this.physicsStep(vin, STEP);
      this.acc -= STEP;
      steps++;
    }
    if (steps >= 12) this.acc = 0;

    // 깜빡이
    this.blinkT += dt;
    if (this.blinkT >= 0.38) {
      this.blinkT = 0;
      this.blinkOn = !this.blinkOn;
    }

    // 센서 읽기 (실제 충돌체 기하 데이터 사용)
    const pose = this.poseNow();
    const cfg: SensorConfig = {
      ...DEFAULT_SENSOR_CONFIG,
      range: this.settings.sensorRange,
      critical: this.settings.sensorCritical,
      collectRays: this.settings.sensorDebug,
    };
    this.sensorSnap = this.settings.sensorEnabled ? readSensors(pose, this.spec.sensors, this.spec.sensorHeight, this.colliders, cfg) : null;

    // 경고음
    this.beeper.enabled = this.settings.sensorSound && this.settings.sensorEnabled;
    this.beeper.volume = this.settings.sensorVolume;
    let interval: number | null = null;
    if (this.sensorSnap) {
      const groups = activeGroupsFor(this.car.gear, Math.abs(this.car.v) * 3.6);
      interval = beepIntervalMs(minDistance(this.sensorSnap, groups), cfg.range, cfg.critical);
    }
    this.beeper.update(dt, interval);

    // 미션
    if (this.mission) {
      this.mission.update(dt, { x: pose.x, z: pose.z, heading: pose.heading, length: this.spec.length, width: this.spec.width }, this.car.v);
      if (this.mission.status !== 'running') this.finishMission();
    }

    if (this.hintTimer > 0) {
      this.hintTimer -= dt;
      if (this.hintTimer <= 0 || Math.abs(this.car.v) > 1.5) {
        this.hud.hint(null);
        this.hintTimer = 0;
      }
    }
  }

  private physicsStep(vin: VehicleInput, dt: number): void {
    const car = this.car;
    const px = car.x;
    const pz = car.z;
    const ph = car.heading;
    const pv = car.v;
    stepVehicle(car, vin, this.spec, dt);
    const c = centerOf(car, this.spec);
    const b = this.map.bounds;
    const outside = c.x < b.minX || c.x > b.maxX || c.z < b.minZ || c.z > b.maxZ;
    const hit = outside ? null : findVehicleCollision(obbOf(car, this.spec), this.colliders);
    if (hit || outside) {
      car.x = px;
      car.z = pz;
      car.heading = ph;
      car.v = 0;
      this.contactClear = 0;
      if (!this.inContact && Math.abs(pv) > 0.1) {
        this.inContact = true;
        this.collisions++;
        this.mission?.addCollision();
        this.hud.toast(`충돌! (${hit ? tagName(hit.tag) : '경계'})`, 'bad');
        this.hud.flash();
      } else if (!this.inContact) {
        this.inContact = true;
      }
    } else if (this.inContact) {
      this.contactClear += dt;
      if (this.contactClear > 0.4) this.inContact = false;
    }
  }

  private finishMission(): void {
    const m = this.mission!;
    this.state = 'result';
    this.input.enabled = false;
    this.input.clear();
    this.beeper.silence();
    this.car.handbrake = true;
    const key = `${this.map.id}/${m.def.id}`;
    const rec = this.records[key] ?? { bestScore: 0, bestTime: 0, plays: 0, clears: 0 };
    rec.plays++;
    let isBest = false;
    if (m.status === 'success' && m.score) {
      rec.clears++;
      if (m.score.total > rec.bestScore) {
        rec.bestScore = m.score.total;
        rec.bestTime = m.elapsed;
        isBest = true;
      }
    }
    this.records[key] = rec;
    saveRecords(this.records);
    this.pendingResult = {
      success: m.status === 'success',
      title: m.def.name,
      reason: m.failReason,
      score: m.score,
      accuracy: m.check?.accuracy ?? 0,
      timeSec: m.elapsed,
      collisions: m.collisions,
      isBest,
    };
    this.resultTimer = m.status === 'success' ? 0.9 : 0.3;
  }

  // ------------------------------------------------------------ 렌더링
  private render(dt: number): void {
    const pose = this.poseNow();
    const car = this.car;
    const model = this.model!;
    this.rig.update(dt, pose, this.spec);

    model.root.position.set(pose.x, 0, pose.z);
    model.root.rotation.y = pose.heading;
    model.setState({
      steer: car.steer,
      roll: car.wheelRoll,
      headlights: this.headlights,
      brake: this.brakeLightOn(),
      reverse: car.gear === 'R',
      signalLeft: (this.sigLeft || this.hazard) && this.blinkOn,
      signalRight: (this.sigRight || this.hazard) && this.blinkOn,
    });
    const driver = this.rig.mode === 'driver';
    model.bodyGroup.visible = !driver;
    model.cockpit.visible = driver;

    const sun = this.built?.sun;
    if (sun) {
      sun.position.set(pose.x + 30, 50, pose.z + 20);
      sun.target.position.set(pose.x, 0, pose.z);
      sun.target.updateMatrixWorld();
    }
    this.built?.animate(this.time);

    // 후방 카메라 보조 화면 (R 기어, 후방 모드가 아닐 때)
    const wantPip = this.state !== 'menu' && car.gear === 'R' && this.settings.rearPip && this.rig.mode !== 'rear';
    this.hud.setParkingOpen(this.state !== 'menu' && car.gear === 'R');
    this.canvas.classList.toggle('mirror', this.rig.mode === 'rear' && this.settings.rearMirror);
    if (wantPip) this.renderPip();
    else this.pip.classList.add('hidden');

    this.renderer.setScissorTest(false);
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setViewport(0, 0, w, h);
    this.rig.rearCamera.aspect = w / h;
    this.rig.rearCamera.updateProjectionMatrix();
    this.renderer.render(this.scene, this.rig.active);

    // HUD / 미니맵 / 센서 화면은 낮은 빈도로 갱신
    this.hudAcc += dt;
    if (this.hudAcc >= 1 / 20) {
      this.hudAcc = 0;
      this.updateHud();
      if (this.state !== 'menu') this.hud.minimap.draw(pose, this.spec, this.targetSlot, this.time);
    }
    this.svAcc += dt;
    if (this.state !== 'menu' && this.svAcc >= 1 / this.settings.sensorViewFps) {
      this.svAcc = 0;
      this.sensorView.update(this.sensorSnap, pose, this.colliderById, {
        enabled: this.settings.sensorEnabled,
        debug: this.settings.sensorDebug,
        range: this.settings.sensorRange,
        critical: this.settings.sensorCritical,
        activeGroups: this.settings.sensorEnabled ? activeGroupsFor(car.gear, Math.abs(car.v) * 3.6) : [],
        gear: car.gear,
      });
    }
  }

  private brakeLightOn(): boolean {
    return this.brake > 0.05 || this.car.handbrake;
  }

  private renderPip(): void {
    const pw = 320;
    const ph = 180;
    const pr = this.renderer.getPixelRatio();
    const cam = this.rig.rearCamera;
    cam.aspect = pw / ph;
    cam.updateProjectionMatrix();
    this.renderer.setScissorTest(true);
    this.renderer.setViewport(0, 0, pw, ph);
    this.renderer.setScissor(0, 0, pw, ph);
    this.renderer.render(this.scene, cam);
    this.renderer.setScissorTest(false);
    const sw = Math.round(pw * pr);
    const sh = Math.round(ph * pr);
    if (this.pip.width !== 320) {
      this.pip.width = 320;
      this.pip.height = 180;
    }
    const g = this.pipCtx;
    g.save();
    if (this.settings.rearMirror) {
      g.translate(320, 0);
      g.scale(-1, 1);
    }
    try {
      g.drawImage(this.canvas, 0, this.canvas.height - sh, sw, sh, 0, 0, 320, 180);
    } catch {
      /* 일부 환경에서 WebGL 캔버스 복사가 불가하면 보조 화면은 건너뜀 */
    }
    g.restore();
    this.pip.classList.remove('hidden');
  }

  private updateHud(): void {
    if (this.state === 'menu') return;
    const car = this.car;
    const m = this.mission;
    let mh: MissionHud | null = null;
    if (m) {
      const c = m.check;
      const nIn = c ? c.corners.filter(Boolean).length : 0;
      const tol = (HEADING_TOLERANCE[m.def.kind] / DEG).toFixed(0);
      mh = {
        name: m.def.name,
        timeText: `${fmtTime(m.elapsed)} / ${fmtTime(m.def.timeLimitSec)}`,
        checks: [
          { label: '모서리 안쪽', value: `${nIn}/4`, ok: c ? c.allInside : false },
          { label: `방향 ±${tol}°`, value: c ? `${(c.headingErrorRad / DEG).toFixed(1)}°` : '--', ok: c ? c.headingOk : false },
          { label: '정차', value: `${(Math.abs(car.v) * 3.6).toFixed(1)}km/h`, ok: Math.abs(car.v) < 0.08 },
          { label: '정확도', value: c ? `${c.accuracy}%` : '--', ok: null },
          { label: '충돌', value: `${m.collisions}회`, ok: null },
        ],
        holdPct: Math.min(100, (m.hold / HOLD_SECONDS) * 100),
        status: m.status,
      };
    }
    const d: HudData = {
      speedKmh: Math.abs(car.v) * 3.6,
      gear: car.gear,
      steerDeg: car.steer / DEG,
      steerWheelDeg: -(car.steer / DEG) * 6,
      handbrake: car.handbrake,
      signalLeft: (this.sigLeft || this.hazard) && this.blinkOn,
      signalRight: (this.sigRight || this.hazard) && this.blinkOn,
      hazard: this.hazard && this.blinkOn,
      headlights: this.headlights,
      braking: this.brakeLightOn(),
      cameraName: CAMERA_NAMES[this.rig.mode],
      sensorOn: this.settings.sensorEnabled,
      soundOn: this.settings.sensorSound,
      mission: mh,
      fpsText: this.settings.showFps ? `FPS ${this.fpsInstant.toFixed(0)} · 평균 ${this.avgFps().toFixed(0)}` : null,
    };
    this.hud.update(d);
    const reverse = this.state !== 'menu' && car.gear === 'R';
    const cameraAvailable = reverse && this.settings.rearPip && this.rig.mode !== 'rear';
    this.parkingDisplay.update(reverse, cameraAvailable, this.settings.sensorEnabled, this.settings.sensorSound, this.sensorSnap);
  }
}

function tagName(tag: string): string {
  const t: Record<string, string> = {
    wall: '벽',
    pillar: '기둥',
    cone: '콘',
    barrier: '방호벽',
    building: '건물',
    lamp: '가로등',
    tree: '나무',
    planter: '화단',
    curb: '연석',
    drum: '드럼통',
    car: '주차된 차량',
  };
  return t[tag] ?? '장애물';
}

export { QUALITY_PRESETS };
