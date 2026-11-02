import * as THREE from 'three';
import { findVehicleCollision, type Collider } from '../core/geometry';
import { DEG } from '../core/math';
import { loadRecords, loadSettings, QUALITY_PRESETS, sanitizeSettings, saveRecords, saveSettings, type Records, type Settings } from '../core/settings';
import { removeKey } from '../core/storage';
import { getMap, mapColliders } from '../maps';
import { buildMap, type BuiltMap } from '../maps/mapBuilder';
import type { MapData, MapMission, MapSlot } from '../maps/types';
import { HOLD_SECONDS, HEADING_TOLERANCE, MissionRunner } from '../mission/parking';
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
import { Menu, type ResultInfo } from '../ui/menu';
import { LIGHT_MODE_NAME, computeLighting, nextLightMode, stepLeveling, type LightMode } from '../vehicle/lighting';
import { AssistController, type AssistOutput, type AssistSettings } from '../pdc/assistPolicy';
import { ASSIST_CAM_H, ASSIST_CAM_W, AssistPanel } from '../pdc/assistPanel';
import { buildPdcState, type PdcState } from '../pdc/pdcModel';
import { allowedViews, autoViewAllowed, cameraCycle, clampView, restrictAssist } from '../pdc/capabilities';
import { ASSIST_VIEW_NAME, ViewPolicy, type AssistView, type SideObservation } from '../pdc/viewPolicy';
import { InfotainmentController, type InfoOutput, type InfoSettings } from '../infotainment/controller';
import { drawCenterScreen, drawCluster } from '../infotainment/cabinScreens';
import { Navigator, type NavState } from '../nav/navigator';
import { drawNavMap } from '../nav/navView';
import { SHIFTER_ORDER } from '../ui/shifter';
import { shiftGear, type ShiftDecision } from '../vehicle/transmission';
import { mapGamepad } from './gamepad';
import { MirrorSystem } from './mirrors';
import { exportVehicleGlb } from './devGlb';
import { proximityLevel, type ProximityLevel } from '../sensors/sensorSystem';
import { applyGlbVisual, createCarModel, type CarModel } from '../vehicle/carModel';
import {
  centerOf,
  createVehicleState,
  obbOf,
  stepVehicle,
  type Gear,
  type VehicleInput,
  type VehicleState,
} from '../vehicle/physics';
import { getVehicle, type VehicleSpec } from '../vehicle/spec';
import { CAMERA_NAMES, CameraRig } from './cameras';
import { Showroom } from './showroom';
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
  readonly menu: Menu;
  readonly sensorView: SensorView;
  readonly showroom: Showroom;
  readonly assist = new AssistController();
  readonly assistPanel: AssistPanel;
  assistOut: AssistOutput = { active: false, camera: 'rear', manualView: null, focus: 'rear', cameraMode: 'auto', reason: '' };
  /** 인포테인먼트 공유 상태 (3인칭 플로팅/1인칭 실내가 같은 상태를 본다) */
  readonly info = new InfotainmentController();
  readonly nav = new Navigator();
  readonly viewPolicy = new ViewPolicy();
  infoOut: InfoOutput = { floatingVisible: false, content: 'nav', override: null, wantVisible: false, reason: '' };
  viewOut: { view: AssistView; auto: boolean; reason: string } = { view: 'rear', auto: false, reason: '' };
  navState: NavState = this.nav.state;
  pdcState: PdcState | null = null;
  private padPrev: boolean[] = [];
  private cabinAcc = 0;
  private navAcc = 0;
  private destIndex = 0;
  readonly mirrors = new MirrorSystem();
  private assistCamAcc = 0;
  private assistLastCamera = '';

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
  targetSlot: MapSlot | null = null;
  sensorSnap: SensorSnapshot | null = null;

  private lightMode: LightMode = 'auto';
  private levelPitch = 0;
  private lastV = 0;
  private accelF = 0;
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

  constructor(root: HTMLElement, canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: this.settings.quality !== 'low', powerPreference: 'high-performance' });
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.setClearColor(0x9ec9ee);
    this.applyQuality();
    this.showroom = new Showroom(this.renderer);
    this.showroom.setVehicle(getVehicle(this.settings.vehicleId));

    this.hud = new Hud(root, {
      action: (a) => this.onAction(a),
      input: this.input,
      shifter: { request: (g) => this.requestShift(g), context: () => this.shiftContext() },
    });
    this.hud.bindExtra();
    this.assistPanel = new AssistPanel(root, {
      onToggleSensor: () => this.onAction('sensorToggle'),
      onToggleSound: () => this.onAction('soundToggle'),
      onCycleCamera: () => this.onAction('assistCamera'),
      onSettings: () => {
        this.pause();
        this.menu.showSettings(() => this.menu.showPause());
      },
      onClose: () => this.onAction('assistClose'),
      onCycleDestination: () => this.onAction('infoDest'),
    });
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

    (window as unknown as { __devExportGlb?: typeof exportVehicleGlb }).__devExportGlb = exportVehicleGlb;
    (window as unknown as { __perfStats?: () => unknown }).__perfStats = () => this.perfStats();
    this.input.onAction = (a) => this.onAction(a);
    this.input.attach();
    this.rig.bind(canvas);
    window.addEventListener('resize', () => this.onResize());
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && this.state === 'playing') this.pause();
    });
    this.applyTouch();
    this.onResize();
    // 메뉴 상태에서도 쇼룸(차량 미리보기)을 그리기 위해 루프를 바로 시작한다
    this.last = performance.now();
    requestAnimationFrame((t) => this.frame(t));
  }

  // ------------------------------------------------------------ 설정/품질
  updateSettings(patch: Partial<Settings>): void {
    const before = this.settings;
    this.settings = sanitizeSettings({ ...before, ...patch });
    if (before.vehicleId !== this.settings.vehicleId) this.showroom.setVehicle(getVehicle(this.settings.vehicleId));
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
    this.showroom.setAspect(window.innerWidth, window.innerHeight);
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
    this.assistPanel.setSpec(this.spec);
    this.assistPanel.setPalette(this.settings.pdcPalette);
    this.assist.reset('P');
    this.assistLastCamera = '';
    this.assistOut = { active: false, camera: 'rear', manualView: null, focus: 'rear', cameraMode: 'auto', reason: '' };
    this.info.reset('P');
    this.viewPolicy.reset();
    this.infoOut = { floatingVisible: false, content: 'nav', override: null, wantVisible: false, reason: '' };
    this.viewOut = { view: 'rear', auto: false, reason: '' };
    this.nav.setMap(map);
    this.destIndex = 0;
    const sp0 = this.missionDef?.spawn ?? map.spawn;
    this.nav.setDestination(this.targetSlot, { x: sp0.x, z: sp0.z });
    this.navState = this.nav.state;

    const sp = this.missionDef?.spawn ?? map.spawn;
    this.car = createVehicleState(this.spec, sp.x, sp.z, sp.heading);
    this.lightMode = 'auto'; // 어두운 곳(지하)에서는 자동으로 하향등
    this.levelPitch = 0;
    this.lastV = 0;
    this.accelF = 0;
    this.sigLeft = this.sigRight = this.hazard = false;
    this.throttle = this.brake = this.steerIn = 0;
    this.collisions = 0;
    this.inContact = false;
    this.acc = 0;
    this.sensorSnap = null;
    this.rig.setMode(this.rig.mode, this.poseNow());
    this.rig.snap();

    this.menu.close();
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
    this.assistPanel.setVisible(false);
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

  // ------------------------------------------------------------ 변속 (브레이크 인터록)
  private brakePressed(): boolean {
    return this.input.held.brake || (this.input.pad.brake ?? 0) > 0.2;
  }

  shiftContext(): { gear: Gear; v: number; brake: boolean } {
    const c = this.car as VehicleState | undefined;
    return { gear: c?.gear ?? 'P', v: c?.v ?? 0, brake: this.brakePressed() };
  }

  /** 키보드/터치 레버/게임패드/화면 버튼이 모두 통과하는 변속 경로 */
  requestShift(g: Gear): ShiftDecision {
    if (this.state !== 'playing') return { ok: false, code: 'brake_required', reason: '지금은 변속할 수 없습니다' };
    const prev = this.car.gear;
    const d = shiftGear(this.car, g, this.brakePressed());
    if (!d.ok) {
      this.hud.toast(d.reason ?? '지금은 기어를 바꿀 수 없습니다', 'warn');
    } else if (g !== prev) {
      if (g === 'R') this.hud.toast(this.settings.sensorEnabled ? '후진(R) · 후방카메라/PDC 작동' : '후진(R) · PDC 꺼짐(설정)');
      else this.hud.toast(`기어 ${g}`);
    }
    return d;
  }

  /** 목적지로 고를 수 있는 주차 구획: 미션 목표 먼저, 그다음 비어 있는 구획 */
  private selectableSlots(): MapSlot[] {
    const cars = this.map.obstacles.filter((o) => o.tag === 'car');
    const free = this.map.slots.filter((sl) => !cars.some((c) => Math.hypot(c.x - sl.x, c.z - sl.z) < Math.min(sl.w, sl.l) * 0.5));
    const t = this.targetSlot;
    return t ? [t, ...free.filter((f) => f.id !== t.id)] : free;
  }

  private pollGamepad(): void {
    const pads = typeof navigator !== 'undefined' && navigator.getGamepads ? navigator.getGamepads() : [];
    const gp = pads && pads[0] ? pads[0] : null;
    const { out, pressed } = mapGamepad(gp ? { axes: gp.axes, buttons: gp.buttons } : null, this.padPrev);
    this.padPrev = pressed;
    this.input.pad = gp ? { steer: out.steer, throttle: out.throttle, brake: out.brake } : { steer: null, throttle: null, brake: null };
    if (this.input.enabled || out.actions.includes('pause')) for (const act of out.actions) this.onAction(act);
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
      case 'gearN':
        this.requestShift(a.slice(4) as Gear);
        break;
      case 'gearStepUp':
      case 'gearStepDown': {
        const i = SHIFTER_ORDER.indexOf(this.car.gear) + (a === 'gearStepUp' ? -1 : 1);
        if (i >= 0 && i < SHIFTER_ORDER.length) this.requestShift(SHIFTER_ORDER[i]);
        break;
      }
      case 'handbrake':
        this.car.handbrake = !this.car.handbrake;
        this.hud.toast(this.car.handbrake ? '주차 브레이크 ON' : '주차 브레이크 OFF');
        break;
      case 'camera': {
        const m = this.rig.next(this.poseNow(), this.spec.assist.frontCamera);
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
        this.lightMode = nextLightMode(this.lightMode);
        this.hud.toast(`조명: ${LIGHT_MODE_NAME[this.lightMode]}`);
        break;
      case 'reset':
        this.resetCar();
        break;
      case 'restart':
        this.startRun();
        break;
      case 'assistToggle':
        this.hud.toast(this.info.toggle() ? '인포테인먼트 표시' : '인포테인먼트 숨김');
        break;
      case 'assistClose':
        this.info.hide();
        break;
      case 'assistCamera': {
        const order = cameraCycle(this.spec.assist);
        if (order.length === 0) {
          this.hud.toast('이 차량은 후방카메라 전용입니다');
          break;
        }
        const next = order[(Math.max(0, order.indexOf(this.assist.cameraMode)) + 1) % order.length];
        this.assist.setManualCamera(next);
        this.viewPolicy.reset();
        this.hud.toast(`카메라 화면: ${next === 'auto' ? '자동(기어/센서 연동)' : ASSIST_VIEW_NAME[next]}`);
        break;
      }
      case 'infoDest': {
        const slots = this.selectableSlots();
        if (slots.length) {
          this.destIndex = (this.destIndex + 1) % slots.length;
          this.nav.setDestination(slots[this.destIndex], this.poseNow());
          this.hud.toast(`목적지: ${slots[this.destIndex].id}`);
        }
        break;
      }
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
    if (this.state === 'menu') {
      // 메뉴: 차량 쇼룸(3D 미리보기)
      this.showroom.update(dt);
      this.canvas.classList.remove('mirror');
      this.renderer.setScissorTest(false);
      this.renderer.setViewport(0, 0, window.innerWidth, window.innerHeight);
      this.renderer.render(this.showroom.scene, this.showroom.camera);
      return;
    }
    if (!this.car) return;

    this.pollGamepad();
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
    this.throttle = ramp(this.throttle, Math.max(h.throttle ? 1 : 0, this.input.pad.throttle ?? 0), 3.5, 6);
    this.brake = ramp(this.brake, Math.max(h.brake ? 1 : 0, this.input.pad.brake ?? 0), 6, 8);
    const kb = (h.left ? 1 : 0) - (h.right ? 1 : 0);
    const st = this.input.pad.steer ? this.input.pad.steer : kb;
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

    // AUTO Leveling: 속도 변화로 구한 가속도(근사)로 조사각 보정
    const aRaw = (this.car.v - this.lastV) / Math.max(dt, 1e-3);
    this.lastV = this.car.v;
    this.accelF += (aRaw - this.accelF) * Math.min(1, dt * 6);
    this.levelPitch = stepLeveling(this.levelPitch, this.accelF, dt);

    // 주차 보조 표시 정책 (R: 후방, D: 전방, 속도/기어 조건)
    const asSet: AssistSettings = {
      autoRear: this.settings.rearPip,
      autoFront: this.settings.assistFrontAuto,
      frontMaxKmh: this.settings.assistFrontMaxKmh,
      pExitSec: this.settings.assistExitSec,
    };
    const caps = this.spec.assist;
    this.assistOut = this.assist.update({ gear: this.car.gear, speedKmh: Math.abs(this.car.v) * 3.6, dt }, restrictAssist(asSet, caps));
    // 자동 3D 시점(측면 장애물) + 인포테인먼트 공유 상태 + 내비게이션
    this.viewOut = this.viewPolicy.update(
      dt,
      clampView(this.assistOut.camera, caps),
      this.assistOut.manualView && allowedViews(caps).includes(this.assistOut.manualView) ? this.assistOut.manualView : null,
      this.sensorSnap ? this.sideObservation(this.sensorSnap) : null,
      this.settings.assistAutoView && autoViewAllowed(caps) && this.assistOut.active && this.settings.sensorEnabled,
    );
    const infoSet: InfoSettings = { autoShow: this.settings.infoAutoShow, autoHide: this.settings.infoAutoHide, autoHideSec: this.settings.infoAutoHideSec };
    this.infoOut = this.info.update({ dt, gear: this.car.gear, parkingActive: this.assistOut.active, firstPerson: this.rig.mode === 'driver' }, infoSet);
    this.navState = this.nav.update(dt, { x: pose.x, z: pose.z });

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
      lighting: this.currentLighting(),
      levelPitch: this.levelPitch,
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

    // 주차 보조 디스플레이: 실제 3D 장면을 후방/전방 카메라로 렌더링해 패널에 표시
    const open = this.state !== 'menu' && this.infoOut.floatingVisible;
    const firstPerson = this.rig.mode === 'driver';
    const parking = this.infoOut.content === 'parking';
    this.hud.setAssistOpen(open);
    this.assistPanel.setVisible(open);
    this.assistPanel.setContent(this.infoOut.content);
    this.canvas.classList.toggle('mirror', this.rig.mode === 'rear' && this.settings.rearMirror);
    // 후방/전방/3D 시점 카메라는 "보이는 곳(플로팅 또는 1인칭 실내 화면)"이 있을 때만 렌더링한다 (불필요한 렌더링 중단)
    if (parking && (open || firstPerson)) this.renderAssist(dt, pose);
    if (!parking && (open || firstPerson)) this.drawNav(dt, pose);
    if (firstPerson) {
      this.drawCabin(dt);
      if (this.settings.mirrorFps > 0 && this.model) this.mirrors.update(this.renderer, this.scene, this.model, pose, this.spec, dt, this.settings.mirrorFps);
    }

    this.renderer.setScissorTest(false);
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setViewport(0, 0, w, h);
    this.rig.rearCamera.aspect = w / h;
    this.rig.rearCamera.updateProjectionMatrix();
    this.rig.frontCamera.aspect = w / h;
    this.rig.frontCamera.updateProjectionMatrix();
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

  private currentLighting() {
    return computeLighting({ mode: this.lightMode, gear: this.car.gear, ambientDark: this.map.env.indoor });
  }

  private sideObservation(snap: SensorSnapshot): SideObservation {
    const rank: Record<ProximityLevel, number> = { none: 0, far: 1, mid: 2, near: 3, critical: 4 };
    const level: Record<string, ProximityLevel> = { front: 'none', rear: 'none', left: 'none', right: 'none' };
    const hits: Record<string, number> = { front: 0, rear: 0, left: 0, right: 0 };
    for (const r of snap.readings) {
      hits[r.group] += r.hits.length;
      const lv = proximityLevel(r.distance, snap.range, snap.critical);
      if (rank[lv] > rank[level[r.group]]) level[r.group] = lv;
    }
    return { level: level as SideObservation['level'], hits: hits as SideObservation['hits'] };
  }

  private brakeLightOn(): boolean {
    return this.brake > 0.05 || this.car.handbrake;
  }

  /** 주차 보조 카메라: 실제 3D 장면을 선택된 시점의 가상 카메라로 렌더링해 패널(및 실내 화면)에 복사 */
  /** 개발용 성능 지표 (이 환경의 소프트웨어 WebGL 수치는 실기기 FPS 가 아님) */
  perfStats(): { drawCalls: number; triangles: number; geometries: number; textures: number; vehicleMeshes: number; vehicleTriangles: number; avgFps: number; assistRenders: number; mirrorRenders: number } {
    const info = this.renderer.info;
    let meshes = 0;
    let tris = 0;
    this.model?.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      meshes++;
      const g = m.geometry;
      tris += (g.index ? g.index.count : g.attributes.position.count) / 3;
    });
    return {
      drawCalls: info.render.calls,
      triangles: info.render.triangles,
      geometries: info.memory.geometries,
      textures: info.memory.textures,
      vehicleMeshes: meshes,
      vehicleTriangles: Math.round(tris),
      avgFps: this.avgFps(),
      assistRenders: this.assistRenderCount,
      mirrorRenders: this.mirrors.renders,
    };
  }

  private assistRenderCount = 0;
  private renderAssist(dt: number, pose: { x: number; z: number; heading: number }): void {
    const view = this.viewOut.view;
    this.rig.updateAssistCamera(dt, view, pose, this.spec); // 시점 보간은 매 프레임
    const switched = this.assistLastCamera !== view;
    this.assistCamAcc += dt;
    // 부하 관리: 보조 카메라는 설정 FPS 로만 다시 렌더링한다 (시점이 바뀌면 즉시)
    if (!switched && this.assistCamAcc < 1 / this.settings.assistCameraFps) return;
    this.assistCamAcc = 0;
    this.assistRenderCount++;
    this.assistLastCamera = view;
    const cam = this.rig.assistCamera;
    const pw = ASSIST_CAM_W;
    const ph = ASSIST_CAM_H;
    const pr = this.renderer.getPixelRatio();
    const maxW = Math.min(pw, window.innerWidth);
    const maxH = Math.min(ph, window.innerHeight);
    const vw = Math.min(maxW, maxH * (pw / ph));
    const vh = vw * (ph / pw);
    cam.aspect = pw / ph;
    cam.updateProjectionMatrix();
    // 3D 시점(측면/탑/사선)에서는 내 차 모델이 보여야 한다. 1인칭에서 숨겨 둔 차체를 이 패스에서만 켠다.
    const m = this.model!;
    const prevBody = m.bodyGroup.visible;
    const prevCockpit = m.cockpit.visible;
    const show3d = view === 'left' || view === 'right' || view === 'top' || view === 'oblique';
    if (show3d) {
      m.bodyGroup.visible = true;
      m.cockpit.visible = false;
    }
    this.renderer.setScissorTest(true);
    this.renderer.setViewport(0, 0, vw, vh);
    this.renderer.setScissor(0, 0, vw, vh);
    this.renderer.render(this.scene, cam);
    this.renderer.setScissorTest(false);
    m.bodyGroup.visible = prevBody;
    m.cockpit.visible = prevCockpit;
    const sw = Math.max(1, Math.round(vw * pr));
    const sh = Math.max(1, Math.round(vh * pr));
    const mirror = view === 'rear' && this.settings.rearMirror;
    this.assistPanel.blit(this.canvas, 0, this.canvas.height - sh, sw, sh, mirror);
    this.assistPanel.drawGuides({
      camera: cam,
      pose,
      steer: this.car.steer,
      dir: view === 'rear' ? -1 : 1,
      mirror,
      show: this.settings.assistGuides && (view === 'rear' || view === 'front'),
    });
  }

  /** 내비게이션 지도를 캔버스에 그린다 (10Hz) */
  private drawNav(dt: number, pose: { x: number; z: number; heading: number }): void {
    this.navAcc += dt;
    if (this.navAcc < 0.1) return;
    this.navAcc = 0;
    const c = this.assistPanel.navCanvas;
    drawNavMap(c.getContext('2d')!, c.width, c.height, this.map, pose, this.navState, this.spec);
  }

  /** 1인칭 실내 센터 디스플레이/계기판 갱신 (설정 FPS) */
  private drawCabin(dt: number): void {
    const cab = this.model?.cabin;
    if (!cab) return;
    this.cabinAcc += dt;
    if (this.cabinAcc < 1 / this.settings.cabinFps) return;
    this.cabinAcc = 0;
    const c = this.car;
    const slotName = this.navState.destination?.id ?? '';
    drawCenterScreen(cab.center.ctx, cab.center.canvas.width, cab.center.canvas.height, {
      content: this.infoOut.content,
      cam: this.assistPanel.cam,
      guide: this.assistPanel.guide,
      navCanvas: this.assistPanel.navCanvas,
      spec: this.spec,
      pdc: this.pdcState,
      palette: this.settings.pdcPalette,
      viewName: ASSIST_VIEW_NAME[this.viewOut.view],
      gear: c.gear,
      nav: this.navState,
      sensorOn: this.settings.sensorEnabled,
      soundOn: this.settings.sensorSound,
      rearOnly: this.spec.assist.panelLayout === 'rear',
      cameraMode: this.assist.cameraMode === 'auto' ? '자동' : ASSIST_VIEW_NAME[this.assist.cameraMode],
      mission: this.mission ? this.mission.def.name : slotName ? `목적지 ${slotName}` : '자유주행',
    });
    cab.center.texture.needsUpdate = true;
    const L = this.currentLighting();
    const spd = Math.abs(c.v) * 3.6;
    drawCluster(cab.cluster.ctx, cab.cluster.canvas.width, cab.cluster.canvas.height, {
      speedKmh: spd,
      gear: c.gear,
      rpm: c.gear === 'P' || c.gear === 'N' ? 800 + Math.abs(this.throttle) * 1500 : Math.min(5500, 850 + spd * 55 + this.throttle * 700),
      signalLeft: (this.sigLeft || this.hazard) && this.blinkOn,
      signalRight: (this.sigRight || this.hazard) && this.blinkOn,
      hazard: this.hazard && this.blinkOn,
      lightMode: LIGHT_MODE_NAME[this.lightMode],
      lowBeam: L.low,
      handbrake: c.handbrake,
      pdcLevel: this.pdcState?.overall ?? 'none',
      steerDeg: c.steer / DEG,
    });
    cab.cluster.texture.needsUpdate = true;
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
      headlights: this.currentLighting().low,
      lightMode: LIGHT_MODE_NAME[this.lightMode],
      braking: this.brakeLightOn(),
      cameraName: CAMERA_NAMES[this.rig.mode],
      sensorOn: this.settings.sensorEnabled,
      soundOn: this.settings.sensorSound,
      mission: mh,
      fpsText: this.settings.showFps ? `FPS ${this.fpsInstant.toFixed(0)} · 평균 ${this.avgFps().toFixed(0)}` : null,
    };
    this.hud.update(d);
    // PDC 상태는 항상 계산 (패널, 실내 화면, 계기판이 공유). 일반 화면에 거리 숫자는 포함되지 않는다.
    this.pdcState = buildPdcState(this.spec, this.sensorSnap, this.settings.sensorEnabled, this.assistOut.focus);
    if (this.infoOut.floatingVisible || this.rig.mode === 'driver') {
      this.assistPanel.setPalette(this.settings.pdcPalette);
      this.assistPanel.setGear(car.gear);
      this.assistPanel.setMission(mh ? `${mh.name} · ${mh.timeText.split(' / ')[0]}` : '자유주행');
      this.assistPanel.setCamera(this.viewOut.view, this.assist.cameraMode, this.viewOut.auto);
      this.assistPanel.setToggles(this.settings.sensorEnabled, this.settings.sensorSound);
      this.assistPanel.updateZones(this.pdcState);
      this.assistPanel.setNav(this.navState, this.navState.destination?.id ?? '');
    }
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
