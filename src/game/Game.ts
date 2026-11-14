import * as THREE from 'three';
import type { Collider } from '../core/geometry';
import { DEG, worldToLocal } from '../core/math';
import { loadRecords, loadSettings, mechMirrorTarget, QUALITY_PRESETS, sanitizeSettings, saveRecords, saveSettings, type Records, type Settings } from '../core/settings';
import { removeKey } from '../core/storage';
import { getMap, mapColliders } from '../maps';
import { buildMap, type BuiltMap } from '../maps/mapBuilder';
import type { MapData, MapMission, MapSlot } from '../maps/types';
import { HOLD_SECONDS, HEADING_TOLERANCE, MissionRunner } from '../mission/parking';
import { MechInRunner } from '../mission/mech';
import { MechController } from '../mech/controller';
import { buildMech, type MechBuilt } from '../mech/mechBuilder';
import { STATION, floorLabel, slotDef } from '../mech/machine';
import { computeAreas, recommend, statusText, summaryLine, type AreaAvail, type Recommendation } from '../parking/availability';
import { entranceOf, frameOf, toLocalXZ, transformCollider, type Frame, type MechFacilityConfig } from '../mech/facility';
import { playClunk } from '../mech/sfx';
import { MechPanel } from '../ui/mechPanel';
import { MechControl } from '../ui/mechControl';
import { freeSlots } from '../mech/machine';
import { Beeper } from '../sensors/beeper';
import { SpatialIndex } from '../core/spatial';
import { newSignalCancel, updateSignalCancel } from '../vehicle/signalCancel';
import { liftBlocksDriving, liftChecklist, liftDown, liftStop, liftUp, liftedPose, newLift, stepLift, type LiftCarInput, type LiftCheck, type LiftConfig, type LiftState } from '../service/lift';
import { buildLift, type LiftBuilt } from '../service/liftBuilder';
import { LiftPanel } from '../ui/liftPanel';
import { VIEW_RADIUS } from '../world/tiles';
import { stepVehicleInWorld } from '../vehicle/worldStep';
import { EngineSound } from '../audio/engineSound';
import { ENGINE_PROFILES, newEngine, powerOn, engineOn, pressStartStop, profileOf, stepEngine, type Engine } from '../vehicle/engine';
import { SensorView, type SensorViewSize } from '../sensors/SensorView';
import {
  DEFAULT_SENSOR_CONFIG,
  activeGroupsFor,
  beepIntervalMs,
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
import { WHEEL_LOCK_DEG } from '../core/wheel';
import { ceilingAbove, groundAt, levelAt } from '../maps/terrain';
import { gateViewRisk } from '../pdc/viewGate';
import { buildTowerVisual, type TowerVisual } from '../maps/towerBuilder';
import { chooseBeepTarget } from '../sensors/beepPlan';
import { buildCameraTiles, buildWarnLines } from '../pdc/overlay';
import { guideCutDistance } from '../pdc/guidelines';
import { pointToObbGap, RiskTracker, type RiskOutput } from '../pdc/risk';
import { frameView } from '../pdc/framing';
import { fromLocalFrame, RelatchGate, toLocalFrame, type LocalFrame } from '../pdc/latch';
import { segmentBlocked } from '../pdc/visibility';
import { allowedViews, autoViewAllowed, cameraCycle, clampView, restrictAssist } from '../pdc/capabilities';
import { ASSIST_VIEW_NAME, ViewPolicy, type AssistView, type SideObservation } from '../pdc/viewPolicy';
import { InfotainmentController, type InfoOutput, type InfoSettings } from '../infotainment/controller';
import { drawCenterScreen, drawCluster, speedScale, type CabinHit, type ClusterData } from '../infotainment/cabinScreens';
import { Navigator, type NavState } from '../nav/navigator';
import { drawNavMap } from '../nav/navView';
import { SHIFTER_ORDER } from '../ui/shifter';
import { shiftGear, type ShiftDecision } from '../vehicle/transmission';
import { mapGamepad } from './gamepad';
import { MirrorOverlay, MirrorSystem } from './mirrors';
import { exportVehicleGlb } from './devGlb';
import { proximityLevel, type ProximityLevel } from '../sensors/sensorSystem';
import { applyGlbVisual, createCarModel, type CarModel } from '../vehicle/carModel';
import { substepCount,
  centerOf,
  createVehicleState,
  obbOf,
 
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

/** 맵에 설치된 기계식 시설의 런타임 (독립 상태기계/모델/셔터 충돌체) */
export interface FacilityRt {
  cfg: MechFacilityConfig;
  frame: Frame;
  ctl: MechController;
  built: MechBuilt;
  doorCol: Collider;
  doorOn: boolean;
}

export class Game {
  readonly canvas: HTMLCanvasElement;
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly rig = new CameraRig();
  readonly input = new Input();
  readonly beeper = new Beeper();
  readonly engineSound = new EngineSound();
  /** 엔진 상태기계 (v0.5.3). 시동 OFF 에서는 가속/크리프가 차단된다 */
  engine: Engine = newEngine(ENGINE_PROFILES.sedan, true);
  readonly hud: Hud;
  readonly menu: Menu;
  readonly sensorView: SensorView;
  readonly showroom: Showroom;
  readonly assist = new AssistController();
  readonly assistPanel: AssistPanel;
  private beepGroup: 'front' | 'rear' | 'left' | 'right' = 'rear';
  private risk = new RiskTracker();
  riskOut: RiskOutput | null = null;
  private cabinHits: CabinHit[] = [];
  private tower: TowerVisual | null = null;
  /** v0.5.0 승강기식 기계식 주차장 (map.mech) */
  /** v0.5.3: 맵에 설치된 기계식 시설들 — 시설마다 독립 상태기계/모델/셔터 충돌체. `mech`/`mechBuilt` 는 현재(가장 가까운 또는 사용 중인) 시설을 가리킨다 */
  facilities: FacilityRt[] = [];
  private activeFac: FacilityRt | null = null;
  /** 충돌체 공간 인덱스(균일 격자) + 차량 주변 조회 캐시 */
  readonly spatial = new SpatialIndex(8);
  /** 실내 구역(지하층) 진입 정도 0..1 */
  indoorK = 0;
  private near: Collider[] = [];
  private nearCx = Infinity;
  private nearCz = Infinity;
  /** 주차 현황(구역별 점유/잔여) + 추천 (0.5초마다 갱신) */
  parkAreas: AreaAvail[] = [];
  parkArea: AreaAvail | null = null;
  parkRec: Recommendation | null = null;
  private parkAcc = 99;
  private readonly noMech = new MechController();
  get mech(): MechController {
    return this.activeFac?.ctl ?? this.noMech;
  }
  get mechBuilt(): MechBuilt | null {
    return this.activeFac?.built ?? null;
  }
  get activeFacility(): FacilityRt | null {
    return this.activeFac;
  }
  private mechPanel!: MechPanel;
  private mechCtl!: MechControl;
  /** v0.5.4 정비소 2주식 리프트: 리프트마다 독립 상태/모델. activeLift = 차량에 가장 가까운(6m 이내) 리프트 */
  lifts: { cfg: LiftConfig; st: LiftState; built: LiftBuilt }[] = [];
  activeLift: { cfg: LiftConfig; st: LiftState; built: LiftBuilt } | null = null;
  liftChecks: LiftCheck[] = [];
  private liftPanel!: LiftPanel;
  private zoneAcc = 0;
  /** 통합 맵: 현재 구역 id */
  zoneId: string | null = null;
  /** 보관 슬롯별 차량 모델(플레이어가 입고한 차 / 미션에서 미리 보관된 차) */
  private storedModels = new Map<string, { model: CarModel; spec: VehicleSpec; carId: number }>();
  /** 시설 간 슬롯 id 충돌을 막는 저장 키 */
  private skey(slot: string, fac: FacilityRt | null = this.activeFac): string {
    return `${fac?.cfg.id ?? ''}/${slot}`;
  }
  /**
   * v0.5.2 핫픽스: 플레이어 차량이 보관 슬롯에 들어간 관찰 상태. 이 동안 `this.car`/`this.model` 은 **보관된 그 차량**이며(모델 소유권은 storedModels),
   * 조작할 수 없고 시작 위치로 되돌리거나 새 차량을 자동 생성하지 않는다. 새 차량은 명시적 조작(mechNewCar)으로만 시작한다.
   */
  playerStoredSlot: string | null = null;
  /** playerStoredSlot 이 속한 시설 */
  playerStoredFac: FacilityRt | null = null;
  /** 명시적 '새 차량' 조작으로 시작한 횟수(자동 생성은 없어야 하므로 사용자 조작 없이는 0) */
  newCarCount = 0;
  /** 출고로 차량이 교체될 때 입구 밖에 남겨 두는 기존 플레이어 차량(삭제하지 않음): 모델 + 충돌체 */
  private parkedCars: { model: CarModel; col: Collider }[] = [];
  private cullLevelY = NaN;
  lastClusterData: ClusterData | null = null;
  private clusterSpeedMax = 60;
  /** 방향별 PDC 최고 단계(계기판 평면도용, 색만) */
  private clusterZones(): NonNullable<ClusterData['zones']> {
    const rank: Record<string, number> = { none: 0, far: 1, mid: 2, near: 3, critical: 4 };
    const z = { front: 'none', rear: 'none', left: 'none', right: 'none' };
    for (const q of this.pdcState?.zones ?? []) if (rank[q.level] > rank[z[q.group]]) z[q.group] = q.level;
    return z;
  }
  lastHitId = '';
  /** 테스트 전용: 자동 시점 게이트 입력을 덮어쓴다(정지 상태에서 "그 쪽으로 조향하며 접근 중"인 상황을 재현). steer 'closest' = 더 가까운 쪽으로 조향 */
  debugViewCtx: { v?: number; steer?: number | 'closest'; pathCut?: number } | null = null;
  private overlayView = '';
  private latch: LocalFrame | null = null;
  private relatchGate = new RelatchGate();
  private outAcc = 0;
  private nearOut = false;
  private sideBlocked = { left: false, right: false };
  private blockedAcc = 99;
  private lastHits: { x: number; z: number }[] = [];
  private lastHitsAge = 99;
  assistOut: AssistOutput = { active: false, camera: 'rear', manualView: null, focus: 'rear', cameraMode: 'auto', reason: '' };
  /** 인포테인먼트 공유 상태 (3인칭 플로팅/1인칭 실내가 같은 상태를 본다) */
  readonly info = new InfotainmentController();
  readonly nav = new Navigator();
  readonly viewPolicy = new ViewPolicy();
  /** 기어 변경 후 차량이 실제로 움직였는가 (자동 시점 전환 허용 조건). 테스트에서 직접 설정 가능 */
  viewGate = false;
  private viewGateGear: Gear = 'P';
  infoOut: InfoOutput = { floatingVisible: false, content: 'nav', override: null, wantVisible: false, reason: '', expanded: false, forcedContent: null };
  viewOut: { view: AssistView; auto: boolean; reason: string } = { view: 'rear', auto: false, reason: '' };
  navState: NavState = this.nav.state;
  pdcState: PdcState | null = null;
  private padPrev: boolean[] = [];
  private cabinAcc = 0;
  private navAcc = 0;
  private destIndex = 0;
  readonly mirrors = new MirrorSystem();
  readonly mirrorOverlay = new MirrorOverlay();
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
  /** 방향지시등 자동 해제(핸들 180° 이상 돌린 뒤 풀릴 때) */
  private sigCancel = newSignalCancel();
  /** 자동 해제된 횟수(테스트/디버그) */
  sigAutoCancels = 0;
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
    this.mechCtl = new MechControl(this.hud.root, {
      action: (a) => this.onAction(a),
      select: (slot) => {
        this.mech.selectedSlot = slot;
      },
      auto: (v) => {
        this.settings.mechAutoSlot = v;
        saveSettings(this.settings);
      },
    });
    this.mechPanel = new MechPanel((this.hud.root.querySelector('#top-right') as HTMLElement) ?? this.hud.root, (a) => this.onAction(a));
    this.liftPanel = new LiftPanel((this.hud.root.querySelector('#top-right') as HTMLElement) ?? this.hud.root, (a) => this.onAction(a));
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
      onSetPdcView: (m) => this.onAction(m === 'surround' ? 'pdcSurround' : 'pdcSensor'),
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
    canvas.addEventListener('pointerdown', (e) => {
      // 1인칭에서 실내 디스플레이를 눌렀으면 그 동작을 실행 (다른 UI 위에서 시작한 입력은 캔버스에 오지 않는다)
      if (this.handleCabinPointer(e.clientX, e.clientY)) e.preventDefault();
    });
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
    if (before.touchControls !== this.settings.touchControls || before.touchScale !== this.settings.touchScale || before.steerControl !== this.settings.steerControl) this.applyTouch();
    this.assistPanel.setPdcView(this.settings.pdcView);
    this.beeper.volume = this.settings.sensorVolume;
    this.beeper.enabled = this.settings.sensorSound && this.settings.sensorEnabled;
    if (!this.settings.sensorSound || !this.settings.sensorEnabled) this.beeper.silence();
    this.engineSound.enabled = this.settings.engineSound;
    this.engineSound.volume = this.settings.engineVolume;
    if (!this.settings.engineSound) this.engineSound.silence();
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
    this.hud.setSteerControl(this.settings.steerControl);
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
    if (this.tower) {
      this.scene.remove(this.tower.group);
      this.tower.dispose();
      this.tower = null;
    }
    for (const f of this.facilities) {
      this.scene.remove(f.built.group);
      f.built.dispose();
    }
    this.facilities = [];
    this.activeFac = null;
    for (const l of this.lifts) {
      this.scene.remove(l.built.group);
      l.built.dispose();
    }
    this.lifts = [];
    this.activeLift = null;
    const tier = this.settings.quality;
    const maxAniso = this.renderer.capabilities.getMaxAnisotropy();
    this.cullLevelY = NaN;
    this.built = buildMap(map, {
      textureSize: tier === 'low' ? 128 : tier === 'medium' ? 256 : 512,
      anisotropy: tier === 'low' ? 1 : Math.min(tier === 'medium' ? 4 : 8, maxAniso),
      shadows: this.shadowMapSize() > 0,
    });
    this.scene.add(this.built.group);
    this.built.setLevelVisibility(map.spawn.y ?? 0); // 다층 맵: 시작 층에서 먼 층의 주차 차량 모델은 처음부터 그리지 않는다
    if (map.terrain) {
      this.tower = buildTowerVisual(map, map.terrain);
      this.scene.add(this.tower.group);
    }
    if (map.mech) {
      const lowTier = this.settings.quality === 'low';
      for (const cfg of map.mechFacilities ?? []) {
        // 시설마다 독립 모델(로컬 좌표로 만든 뒤 위치/회전만 적용). 거울은 가까운 시설만 렌더한다(update 의 near).
        const built = buildMech({ mirrorSize: lowTier ? 224 : 384, mirrorFps: mechMirrorTarget(this.settings.quality, this.settings.mechMirrorFps), floors: cfg.floors });
        built.group.position.set(cfg.x, 0, cfg.z);
        built.group.rotation.y = cfg.rotationY;
        this.scene.add(built.group);
        const fr = frameOf(cfg);
        const doorCol = transformCollider<Collider>({ kind: 'box', id: `${cfg.id}:door`, tag: 'wall', x: STATION.doorX, z: 0, w: 0.3, d: 2.4, rot: 0, y0: 0, h: 1.9 }, fr);
        this.facilities.push({ cfg, frame: fr, ctl: new MechController(cfg.floors, fr), built, doorCol, doorOn: false });
      }
      this.activeFac = this.facilities[0] ?? null;
    }
    for (const cfg of map.lifts ?? []) {
      const built = buildLift(cfg);
      this.scene.add(built.group);
      this.lifts.push({ cfg, st: newLift(), built });
    }
    this.scene.background = new THREE.Color(map.env.sky);
    // 대형 맵(통합 맵): 먼 타일은 그리지 않으므로 안개 끝을 가시 반경에 맞춰 경계가 드러나지 않게 한다
    const vr = VIEW_RADIUS[this.settings.quality].load;
    const bigMap = (map.bounds.maxX - map.bounds.minX) * (map.bounds.maxZ - map.bounds.minZ) > 40000;
    this.scene.fog = map.env.indoor ? new THREE.Fog(0x0d1015, 28, 110) : bigMap ? new THREE.Fog(map.env.sky, vr * 0.5, vr * 1.02) : new THREE.Fog(map.env.sky, 100, 320);
    this.zoneAcc = 1; // 첫 프레임에 타일 가시성 갱신
    this.colliders = map.mech ? [...mapColliders(map)] : mapColliders(map); // 기계식 맵은 셔터 충돌체를 동적으로 넣고 빼므로 복사본을 쓴다
    this.colliderById = new Map(this.colliders.map((c) => [c.id, c]));
    this.rig.colliders = this.colliders;
    this.nearCx = this.nearCz = Infinity;
    this.indoorK = 0;
    // 천장 아래로 추적 카메라 높이 제한: 다층 맵은 위층 바닥 아랫면, 실내 평면 맵은 천장 높이
    this.rig.ceilingFn = map.terrain ? (x, z, y) => ceilingAbove(map.terrain!, x, z, y) : map.env.indoor ? (x, z) => { const r = map.env.ceilingRect; return !r || (x >= r.minX && x <= r.maxX && z >= r.minZ && z <= r.maxZ) ? (map.env.ceilingHeight ?? 2.9) : Infinity; } : null;
    this.hud.minimap.setMap(map);
    this.loadedMapId = map.id;
    this.map = map;
    this.applyShadows();
  }

  startRun(): void {
    this.beeper.init();
    this.engineSound.init(); // 사용자 조작(시작 버튼) 이후 — 자동재생 정책
    this.engineSound.enabled = this.settings.engineSound;
    this.engineSound.volume = this.settings.engineVolume;
    this.beeper.volume = this.settings.sensorVolume;
    const map = getMap(this.settings.mapId);
    if (this.loadedMapId !== map.id || !this.built) this.loadMap(map);
    this.map = map;
    this.missionDef = map.missions.find((m) => m.id === this.settings.missionId) ?? null;
    this.targetSlot = this.missionDef ? (map.slots.find((s) => s.id === this.missionDef!.slotId) ?? null) : null;
    this.mission = this.missionDef && this.targetSlot ? (this.missionDef.kind === 'mech-in' ? new MechInRunner(this.missionDef, this.targetSlot, () => !!this.mech.m.slots[this.missionDef!.mech?.slot ?? ''] && this.mech.m.phase === 'waiting' && this.mech.m.palletLoc === 'station', () => this.mech.m.phase === 'waiting' && !this.playerStoredSlot) : new MissionRunner(this.missionDef, this.targetSlot)) : null;
    this.built!.setTarget(this.targetSlot);

    if (this.model) {
      this.scene.remove(this.model.root);
      if (!this.modelIsStored()) this.model.dispose(); // 보관 슬롯 모델은 clearStoredModels 가 해제
    }
    this.spec = getVehicle(this.settings.vehicleId);
    this.model = createCarModel(this.spec, { blobTexture: this.built!.textures.blob });
    this.scene.add(this.model.root);
    if (this.spec.visual.kind === 'glb') void applyGlbVisual(this.model, this.spec);
    this.sensorView.setSpec(this.spec);
    this.assistPanel.setSpec(this.spec);
    this.assistPanel.setPdcView(this.settings.pdcView);
    this.assistPanel.setPalette(this.settings.pdcPalette);
    this.assist.reset('P');
    this.assistLastCamera = '';
    this.assistOut = { active: false, camera: 'rear', manualView: null, focus: 'rear', cameraMode: 'auto', reason: '' };
    this.info.reset('P');
    this.viewPolicy.reset();
    this.viewGate = false;
    this.infoOut = { floatingVisible: false, content: 'nav', override: null, wantVisible: false, reason: '', expanded: false, forcedContent: null };
    this.viewOut = { view: 'rear', auto: false, reason: '' };
    this.nav.setVehicle(this.spec);
    this.nav.setMap(map);
    this.destIndex = 0;
    const sp0 = this.missionDef?.spawn ?? map.spawn;
    this.nav.setDestination(this.targetSlot, { x: sp0.x, z: sp0.z, y: sp0.y ?? 0 });
    this.navState = this.nav.state;

    const sp = this.missionDef?.spawn ?? map.spawn;
    this.car = createVehicleState(this.spec, sp.x, sp.z, sp.heading);
    if (map.terrain) {
      // 다층 맵: 시작 위치의 지면 높이/피치 (스폰 y 가 층을 정한다)
      const wb = this.spec.wheelbase;
      const yR = groundAt(map.terrain, this.car.x, this.car.z, sp.y ?? 0) ?? sp.y ?? 0;
      const yF = groundAt(map.terrain, this.car.x + Math.sin(sp.heading) * wb, this.car.z + Math.cos(sp.heading) * wb, yR) ?? yR;
      this.car.y = yR;
      this.car.pitch = Math.atan2(yF - yR, wb);
      this.car.slope = Math.sin(this.car.pitch);
    }
    this.engine = newEngine(profileOf(this.spec), !this.settings.engineStartOff);
    for (const f of this.facilities) f.ctl.reset();
    for (const l of this.lifts) {
      l.st = newLift();
      l.built.update(l.st);
    }
    this.liftPanel.setVisible(false);
    this.parkAcc = 99;
    this.lastHitId = ''; // 이전 런의 충돌 기록이 새 런의 판정/테스트에 남지 않게
    this.newCarCount = 0; // 새 차량 생성 횟수는 런마다 센다(자동 생성 0 검증용)
    this.activeFac = this.facilities.find((f) => f.cfg.id === this.missionDef?.mech?.facility) ?? this.facilities[0] ?? null;
    this.clearStoredModels();
    // 출고 미션: 첫 번째 시드는 **플레이어 자신의 차량**이 이미 그 슬롯에 보관된 상태로 시작한다(관찰 상태). 나머지 시드는 다른 보관 차량.
    (this.missionDef?.mech?.seed ?? []).forEach((sd, i) => {
      if (i === 0 && this.model) {
        const sc = this.mech.seedStored(sd.slot, this.spec.id, sd.mode, this.spec);
        const pose = this.mech.storedPoseW(sd.slot, sc);
        this.storedModels.set(this.skey(sd.slot), { model: this.model, spec: this.spec, carId: sc.carId });
        this.placeModel(this.model, pose);
        this.playerStoredSlot = sd.slot;
        this.playerStoredFac = this.activeFac;
        this.mech.observing = true;
        Object.assign(this.car, { x: pose.x, z: pose.z, y: pose.y, heading: pose.heading, v: 0, pitch: 0, slope: 0, gear: 'P' as const, handbrake: true });
      } else this.mech.seedStored(sd.slot, sd.specId, sd.mode, getVehicle(sd.specId));
    });
    if (this.missionDef?.mech?.slot) this.mech.selectedSlot = this.missionDef.mech.slot;
    this.mechPanel.setVisible(!!map.mech);
    this.mechCtl.setOpen(false);
    this.hud.setOn('mirrorToggle', this.settings.thirdMirror);
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

  private poseNow(): { x: number; z: number; heading: number; y: number; pitch: number } {
    const c = centerOf(this.car, this.spec);
    const off = this.spec.length / 2 - this.spec.rearOverhang;
    return { x: c.x, z: c.z, heading: this.car.heading, y: this.car.y + off * Math.tan(this.car.pitch), pitch: this.car.pitch };
  }

  pause(): void {
    if (this.state !== 'playing') return;
    this.state = 'paused';
    this.input.enabled = false;
    this.input.clear();
    this.hud.resetTouchInputs();
    this.beeper.silence();
    this.engineSound.silence();
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
    this.engineSound.silence();
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
    if (this.playerStoredSlot) {
      // 보관된 차량의 모델이 시작 위치로 옮겨지는 것을 막는다(관찰 상태에서는 초기화 불가). 새 차량은 '새 차' 버튼/I 로만.
      this.hud.toast('보관 중인 차량은 초기화할 수 없습니다 — 새 차(I)로 새 차량을 시작하세요', 'warn');
      return;
    }
    const sp = this.missionDef?.spawn ?? this.map.spawn;
    this.car = createVehicleState(this.spec, sp.x, sp.z, sp.heading);
    if (this.map.terrain) {
      const wb = this.spec.wheelbase;
      const yR = groundAt(this.map.terrain, this.car.x, this.car.z, sp.y ?? 0) ?? sp.y ?? 0;
      const yF = groundAt(this.map.terrain, this.car.x + Math.sin(sp.heading) * wb, this.car.z + Math.cos(sp.heading) * wb, yR) ?? yR;
      this.car.y = yR;
      this.car.pitch = Math.atan2(yF - yR, wb);
      this.car.slope = Math.sin(this.car.pitch);
    }
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
    const base = t ? [t, ...free.filter((f) => f.id !== t.id)] : free;
    // 기계식 시설 입구도 목적지로 선택할 수 있다(사용자가 고른 시설은 순위와 무관하게 안내). 추천 시설이 먼저 온다.
    const rec = this.parkRec?.facility?.id;
    const facs = [...this.facilities].sort((a, b) => (a.cfg.id === rec ? -1 : 0) - (b.cfg.id === rec ? -1 : 0));
    const dest: MapSlot[] = facs.map((f) => {
      const e = entranceOf(f.cfg);
      return { id: f.cfg.name, x: e.x, z: e.z, w: 3, l: 6, dir: f.cfg.rotationY + Math.PI / 2, style: 'box' } as MapSlot;
    });
    return [...base, ...dest];
  }

  /** 구역별 주차 현황/추천 갱신 */
  private updateParking(dt: number): void {
    this.parkAcc += dt;
    if (this.parkAcc < 0.5) return;
    this.parkAcc = 0;
    const extra: { x: number; z: number }[] = [];
    if (!this.playerStoredSlot && Math.abs(this.car.v) < 0.3) {
      const c = centerOf(this.car, this.spec);
      extra.push({ x: c.x, z: c.z });
    }
    for (const p of this.parkedCars) extra.push({ x: p.col.x, z: p.col.z });
    this.parkAreas = computeAreas(this.map, this.facilities.map((f) => ({ cfg: f.cfg, m: f.ctl.m })), extra);
    const zones = (this.map as unknown as { zones?: { id: string; bounds: { minX: number; maxX: number; minZ: number; maxZ: number } }[] }).zones;
    const zid = zones?.find((z) => this.car.x >= z.bounds.minX && this.car.x <= z.bounds.maxX && this.car.z >= z.bounds.minZ && this.car.z <= z.bounds.maxZ)?.id;
    this.parkArea = this.parkAreas.find((a) => a.id === zid) ?? this.parkAreas[0] ?? null;
    this.parkRec = this.parkArea ? recommend(this.parkArea, this.parkAreas, { x: this.car.x, z: this.car.z }, this.settings.parkLowRatio) : null;
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
      case 'mirrorToggle':
        this.settings.thirdMirror = !this.settings.thirdMirror;
        saveSettings(this.settings);
        this.hud.setOn('mirrorToggle', this.settings.thirdMirror);
        this.hud.toast(this.settings.thirdMirror ? '3인칭 미러 ON' : '3인칭 미러 OFF');
        break;
      case 'mechPanel':
        if (this.map.mech) this.mechCtl.toggle();
        break;
      case 'mechNewCar':
        if (this.map.mech) this.startNewCar();
        break;
      case 'mechExit':
      case 'mechStart':
      case 'mechRetrieve':
      case 'mechEstop': {
        if (!this.map.mech) break;
        if (a === 'mechExit' && this.playerStoredSlot) {
          this.hud.toast('차량이 보관되어 있습니다 — 새 차량은 \'새 차\' 버튼(I)으로 시작하세요', 'warn'); // 하차/탑승과 새 차량 생성은 별개 기능
          break;
        }
        if (a === 'mechStart' && this.settings.mechAutoSlot) {
          const f = freeSlots(this.mech.m)[0];
          if (f) this.mech.selectedSlot = f.id; // 자동: 빈 슬롯 중 가장 낮은 층
        }
        const r = this.mech.onAction(a, this.spec, this.car);
        if (r) this.hud.toast(r.msg, r.kind);
        break;
      }
      case 'liftUp':
      case 'liftDown':
      case 'liftStop': {
        const L = this.activeLift;
        if (!L) {
          if (this.lifts.length) this.hud.toast('리프트 베이 안에서 조작하세요', 'warn');
          break;
        }
        let ok = false;
        if (a === 'liftStop') ok = liftStop(L.st);
        else if (a === 'liftUp') ok = L.st.phase === 'raising' ? liftStop(L.st) : liftUp(L.cfg, this.spec, this.liftInput(), L.st);
        else ok = L.st.phase === 'lowering' ? liftStop(L.st) : liftDown(L.st);
        this.hud.toast(L.st.message || (ok ? '리프트 조작' : '지금은 조작할 수 없습니다'), ok ? 'good' : 'warn');
        break;
      }
      case 'engineToggle': {
        if (this.playerStoredSlot) {
          this.hud.toast('보관된 차량입니다', 'warn');
          break;
        }
        this.engineSound.init();
        const r = pressStartStop(this.engine, { speed: Math.abs(this.car.v), gear: this.car.gear, brake: this.brake });
        // 시동을 끄면서 P 로: 정차 상태에서만 일어나므로 브레이크를 밟은 것과 같은 조건으로 인터록(shiftGear)을 통과시킨다
        if (r.ok && r.autoPark) shiftGear(this.car, 'P', true);
        this.hud.toast(r.reason, r.ok ? 'good' : 'warn');
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
        if (this.rig.mode === 'driver') {
          // 1인칭: 대시보드 디스플레이가 기본. B/버튼으로 확대 화면을 직접 열고 닫는다
          this.info.setExpanded(!this.info.isExpanded);
          if (!this.info.isExpanded) this.info.hide();
          this.hud.toast(this.info.isExpanded ? '확대 화면' : '확대 화면 닫음');
        } else this.hud.toast(this.info.toggle() ? '인포테인먼트 표시' : '인포테인먼트 숨김');
        break;
      case 'assistClose':
        this.info.hide();
        break;
      case 'assistCamera': {
        const order = this.gearCameraCycle();
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
          this.nav.setDestination(slots[this.destIndex], { x: this.car.x, z: this.car.z, y: this.car.y });
          this.hud.toast(`목적지: ${slots[this.destIndex].id}`);
        }
        break;
      }
      case 'pdcSurround':
      case 'pdcSensor': {
        // 오른쪽 PDC 표시 방식만 바꾼다 — 왼쪽 메인 카메라(수동/자동)와 기어 상태는 그대로
        const mode = a === 'pdcSurround' ? 'surround' : 'sensor';
        if (mode === 'surround' && !this.spec.assist.virtualSurround3D) {
          this.hud.toast('이 차량은 3D 서라운드뷰를 지원하지 않습니다(센서 화면만 제공)');
          break;
        }
        this.updateSettings({ pdcView: mode });
        this.hud.toast(`오른쪽 화면: ${mode === 'surround' ? '3D 서라운드' : '센서'}`);
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

  /** 자동 테스트 전용: 설정되면 키보드/터치 대신 이 입력으로 주행한다 (E2E 자동 주행) */
  debugInput: VehicleInput | null = null;

  private readInput(dt: number): VehicleInput {
    if (this.debugInput) {
      this.throttle = this.debugInput.throttle;
      this.brake = this.debugInput.brake;
      this.steerIn = this.debugInput.steerInput;
      return this.debugInput;
    }
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
    // 회전 핸들(터치): 손가락이 닿아 있거나 아직 중앙 복귀 중이면 핸들 각도가 조향 입력이 된다
    const w = this.hud.wheel;
    w.update(dt, this.car.v, this.settings.steerReturn);
    if (this.settings.steerControl === 'wheel' && (w.dragging || w.angle !== 0) && st === 0) this.steerIn = w.steer(this.settings.steerSensitivity);
    else this.steerIn = ramp(this.steerIn, st, 5, 7);
    return { throttle: this.throttle, brake: this.brake, steerInput: this.steerIn };
  }

  private liftInput(): LiftCarInput {
    const c = centerOf(this.car, this.spec);
    return { cx: c.x, cz: c.z, heading: this.car.heading, v: this.car.v, gear: this.car.gear, handbrake: this.car.handbrake, engineOn: engineOn(this.engine) };
  }

  /** 리프트 진행 + 현재 리프트 선택 + 패널 갱신. 차량이 리프트에 고정(또는 암 전개 중)이면 true → 주행 입력 차단 */
  private updateLifts(dt: number): boolean {
    if (!this.lifts.length) return false;
    for (const l of this.lifts) {
      stepLift(l.cfg, l.st, dt);
      l.built.update(l.st);
    }
    const cur = this.activeLift;
    if (!cur || !liftBlocksDriving(cur.st)) {
      const c = centerOf(this.car, this.spec);
      let best: (typeof this.lifts)[number] | null = null;
      let bd = 6;
      for (const l of this.lifts) {
        const d = Math.hypot(c.x - l.cfg.x, c.z - l.cfg.z);
        if (d < bd) {
          bd = d;
          best = l;
        }
      }
      this.activeLift = best;
    }
    const L = this.activeLift;
    this.liftPanel.setVisible(!!L);
    if (!L) return false;
    this.liftChecks = liftChecklist(L.cfg, this.spec, this.liftInput());
    this.liftPanel.update(L.st, this.liftChecks, L.cfg.kind === '4post' ? '4주식 리프트' : '2주식 리프트');
    return liftBlocksDriving(L.st);
  }

  /** 리프트에 고정된 차량: 리프트 높이를 따라 올라가고 내려온다(수평 위치/방향 고정, 속도 0) */
  private applyLiftPose(): void {
    this.car.handbrake = true; // v0.5.5: 리프트에 고정된 동안 주차 브레이크 자동(상승 조건에서는 뺐다)
    const L = this.activeLift;
    if (!L) return;
    const p = liftedPose(L.cfg, L.st, 0);
    if (!p) return;
    const off = this.spec.length / 2 - this.spec.rearOverhang;
    this.car.x = p.cx - Math.sin(p.heading) * off;
    this.car.z = p.cz - Math.cos(p.heading) * off;
    this.car.heading = p.heading;
    this.car.y = p.y;
    this.car.v = 0;
    this.car.pitch = 0;
    this.car.slope = 0;
  }

  /** 현재 시설 선택: 사용 중(보관 관찰/동작 중/고정)이면 유지, 아니면 가장 가까운 시설로(히스테리시스 3m) */
  private selectActiveFacility(): void {
    if (!this.facilities.length) return;
    if (this.playerStoredSlot && this.playerStoredFac) {
      this.activeFac = this.playerStoredFac;
      return;
    }
    const cur = this.activeFac;
    if (cur && (cur.ctl.m.locked || cur.ctl.m.phase !== 'waiting')) return;
    const dist = (f: FacilityRt): number => Math.hypot(this.car.x - f.cfg.x, this.car.z - f.cfg.z);
    let best = this.facilities[0];
    for (const f of this.facilities) if (dist(f) < dist(best)) best = f;
    if (!cur || (best !== cur && dist(best) + 3 < dist(cur))) this.activeFac = best;
  }

  private simulate(dt: number): void {
    if (this.map.mech) this.selectActiveFacility();
    let vin = this.readInput(dt);
    stepEngine(this.engine, dt, { throttle: this.throttle, speed: Math.abs(this.car.v), gear: this.car.gear });
    vin.engineOn = powerOn(this.engine);
    if (this.map.mech) this.mech.engineOn = engineOn(this.engine);
    const mech = this.map.mech ? this.mech : null;
    if (mech?.blocksDriving()) vin = { throttle: 0, brake: 1, steerInput: 0, engineOn: vin.engineOn };
    const liftHold = this.updateLifts(dt);
    if (liftHold) vin = { throttle: 0, brake: 1, steerInput: 0, engineOn: vin.engineOn }; // 하차했거나 팔레트에 고정된 동안 운전 불가
    this.acc += dt;
    let steps = 0;
    while (this.acc >= STEP && steps < 12) {
      if (mech?.m.locked) mech.applyLocked(this.car);
      else if (liftHold && this.activeLift?.st.locked) this.applyLiftPose();
      else if (this.playerStoredSlot) this.holdStoredCar();
      else {
        // 고속: 한 스텝 이동량이 0.12m 를 넘지 않도록 서브스텝으로 나눠 충돌을 검사한다 (얇은 벽/기둥 관통 방지)
        const n = substepCount(this.car.v, STEP);
        for (let k = 0; k < n; k++) this.physicsStep(vin, STEP / n);
      }
      this.acc -= STEP;
      steps++;
    }
    if (steps >= 12) this.acc = 0;

    if (mech) {
      mech.step(dt, this.spec, this.car);
      this.handleMechEvents();
      this.syncStoredVisuals();
      if (!mech.m.locked && mech.settle(dt, this.spec, this.car)) playClunk(mech.lastSeatImpact, this.settings.sensorSound ? this.settings.sensorVolume : 0); // 앞바퀴 정지 홈 안착
      // 다른 시설은 플레이어와 무관하게 독립적으로 진행한다(자기 슬롯/셔터/승강기 상태만 변경)
      for (const f of this.facilities) {
        if (f.ctl === mech) continue;
        f.ctl.stepIdle(dt);
        f.ctl.events.length = 0;
      }
      // 출입문(셔터) 충돌체: 문이 닫혀 가는 동안에는 차량이 통과할 수 없다 (시설마다)
      for (const f of this.facilities) {
        const wantDoor = f.ctl.doorBlocking();
        if (wantDoor !== f.doorOn) {
          f.doorOn = wantDoor;
          if (wantDoor) {
            this.colliders.push(f.doorCol);
            this.colliderById.set(f.doorCol.id, f.doorCol);
          } else {
            const i = this.colliders.indexOf(f.doorCol);
            if (i >= 0) this.colliders.splice(i, 1);
            this.colliderById.delete(f.doorCol.id);
          }
        }
        // 거울(Reflector)은 플레이어가 그 시설 앞 구역에 있을 때만 켠다 — 먼 시설은 렌더하지 않는다
        const l = toLocalXZ(f.frame, this.car.x, this.car.z);
        const near = l.x < STATION.palletX + 14 && l.x > STATION.doorX - 28 && Math.abs(l.z) < 20;
        f.built.update(f.ctl.m, dt, near && f.ctl === mech, f.ctl.guide);
      }
      this.mechPanel.update(mech.m, mech.items, mech.guide, !!this.playerStoredSlot);
      this.mechCtl.update(mech.m, mech.selectedSlot, this.settings.mechAutoSlot, this.activeFac?.cfg.name ?? '');
    }

    this.updateParking(dt);

    // 방향지시등 자동 해제: 켠 방향으로 핸들을 180° 이상 돌렸다가 풀리면 끈다 (핸들 각도 = 조향각 비율 × 540°, 왼쪽 +)
    if (updateSignalCancel(this.sigCancel, this.sigLeft ? 'left' : this.sigRight ? 'right' : null, (this.car.steer / this.spec.maxSteer) * WHEEL_LOCK_DEG)) {
      this.sigLeft = this.sigRight = false;
      this.sigAutoCancels++;
    }
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
    this.sensorSnap = this.settings.sensorEnabled ? readSensors(pose, this.spec.sensors, this.spec.sensorHeight, this.nearColliders(), cfg) : null;
    this.updateRisk(dt);

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
    // 기어를 바꾼 직후에는 새 기어 방향의 기본 카메라(R=후방, D=전방)를 우선한다.
    // 차량이 실제로 움직이기 시작(|v|>0.3m/s)한 뒤에만 센서 위험에 의한 자동 집중뷰/측면뷰를 허용한다 (정지 중 히트값만으로 재선택 금지).
    if (this.car.gear !== this.viewGateGear) {
      this.viewGateGear = this.car.gear;
      this.viewGate = false;
      this.viewPolicy.reset();
    }
    if (!this.viewGate && Math.abs(this.car.v) > 0.3) this.viewGate = true;
    // 자동 3D 시점(측면 장애물) + 인포테인먼트 공유 상태 + 내비게이션
    this.viewOut = this.viewPolicy.update(
      dt,
      clampView(this.assistOut.camera, caps),
      this.assistOut.manualView && allowedViews(caps).includes(this.assistOut.manualView) ? this.assistOut.manualView : null,
      this.sensorSnap ? this.sideObservation(this.sensorSnap) : null,
      this.viewGate && this.settings.assistAutoView && autoViewAllowed(caps) && this.assistOut.active && this.settings.sensorEnabled && (this.car.gear === 'R' || this.car.gear === 'D'), // N/P 에서는 자동 시점 전환을 하지 않는다
    );
    const infoSet: InfoSettings = { autoShow: this.settings.infoAutoShow, autoHide: this.settings.infoAutoHide, autoHideSec: this.settings.infoAutoHideSec };
    this.infoOut = this.info.update({ dt, gear: this.car.gear, parkingActive: this.assistOut.active, firstPerson: this.rig.mode === 'driver' }, infoSet);
    this.navState = this.nav.update(dt, { x: pose.x, z: pose.z, y: this.car.y });

    // 경고음
    this.beeper.enabled = this.settings.sensorSound && this.settings.sensorEnabled;
    this.beeper.volume = this.settings.sensorVolume;
    let interval: number | null = null;
    if (this.sensorSnap) {
      const groups = activeGroupsFor(this.car.gear, Math.abs(this.car.v) * 3.6);
      const tgt = chooseBeepTarget(this.sensorSnap, groups, this.beepGroup);
      if (tgt) this.beepGroup = tgt.group;
      interval = beepIntervalMs(tgt ? tgt.distance : null, cfg.range, cfg.critical);
    }
    this.beeper.update(dt, interval, this.beepGroup);
    this.engineSound.enabled = this.settings.engineSound;
    this.engineSound.volume = this.settings.engineVolume;
    this.engineSound.update(this.engine, this.playerStoredSlot ? 0 : Math.max(0, this.throttle), this.rig.mode === 'driver');

    // 미션
    if (this.mission) {
      this.mission.update(dt, { x: pose.x, z: pose.z, heading: pose.heading, length: this.spec.length, width: this.spec.width, y: this.map.terrain ? this.car.y : undefined }, this.car.v);
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

  // ------------------------------------------------------------ 기계식: 보관 차량 모델/교체
  private clearStoredModels(): void {
    const seen = new Set<CarModel>();
    for (const [, v] of this.storedModels) {
      if (seen.has(v.model)) continue;
      seen.add(v.model);
      this.scene.remove(v.model.root);
      v.model.dispose();
    }
    this.storedModels.clear();
    for (const p of this.parkedCars) {
      this.scene.remove(p.model.root);
      p.model.dispose();
      const i = this.colliders.indexOf(p.col);
      if (i >= 0) this.colliders.splice(i, 1);
      this.colliderById.delete(p.col.id);
    }
    this.parkedCars = [];
    this.playerStoredSlot = null;
    this.playerStoredFac = null;
    for (const f of this.facilities) f.ctl.observing = false;
  }

  /** `this.model` 이 보관 슬롯 모델과 같은 객체인가(소유권이 storedModels 에 있음) */
  private modelIsStored(): boolean {
    for (const [, v] of this.storedModels) if (v.model === this.model) return true;
    return false;
  }

  private placeModel(model: CarModel, pose: { x: number; y: number; z: number; heading: number }): void {
    model.root.position.set(pose.x, pose.y, pose.z);
    model.root.rotation.order = 'YXZ';
    model.root.rotation.y = pose.heading;
  }

  /** 미션에서 미리 보관된 차량(seed)의 모델을 만들어 슬롯에 놓는다 */
  private syncStoredVisuals(): void {
    for (const f of this.facilities) for (const e of f.ctl.storedList()) {
      const key = this.skey(e.slot, f);
      if (this.storedModels.has(key) || !e.car.specId) continue;
      const spec = getVehicle(e.car.specId);
      const model = createCarModel(spec, { lite: true, blobTexture: this.built?.textures.blob });
      if (spec.visual.kind === 'glb') void applyGlbVisual(model, spec);
      this.scene.add(model.root);
      this.placeModel(model, e.pose);
      this.storedModels.set(key, { model, spec, carId: e.car.carId });
    }
  }

  /** 플레이어가 조종하는 차량을 바꾼다(출고된 다른 차량을 인수). 이전 모델은 폐기 */
  /**
   * 조작 차량 교체. 이전 모델의 처리를 명시한다: 'dispose'(폐기), 'keep'(씬에 그대로 둠 — 보관/주차 차량).
   * `this.model` 을 null 로 두는 중간 상태를 만들지 않는다.
   */
  private adoptVehicle(spec: VehicleSpec, model: CarModel | null, old: 'dispose' | 'keep' = 'dispose', engineRunning: boolean = !this.settings.engineStartOff): void {
    if (this.model && this.model !== model) {
      if (old === 'dispose' && !this.modelIsStored()) {
        this.scene.remove(this.model.root);
        this.model.dispose();
      }
      // 'keep': 보관 슬롯/입구 밖에 서 있는 차량 — 씬에서 제거하지 않는다
    }
    this.spec = spec;
    this.engine = newEngine(profileOf(spec), engineRunning);
    this.nav.setVehicle(spec);
    const next = model ?? createCarModel(spec, { blobTexture: this.built!.textures.blob });
    this.model = next;
    if (!next.root.parent) this.scene.add(next.root);
    if (!model && spec.visual.kind === 'glb') void applyGlbVisual(this.model, spec);
    this.sensorView.setSpec(spec);
    this.assistPanel.setSpec(spec);
    this.assistPanel.setPdcView(this.settings.pdcView);
    this.assistPanel.setPalette(this.settings.pdcPalette);
  }

  /** 기계식 이벤트 처리: 입고 완료 → 모델을 슬롯에 남기고 새 차량 공급 / 인출 → 보관된 차량 인수 */
  private handleMechEvents(): void {
    const mech = this.mech;
    for (const e of mech.events.splice(0)) {
      if (e.type === 'rejected') continue;
      if (e.type === 'stored' && e.slot && this.model) {
        const sc = mech.m.slots[e.slot];
        if (!sc) continue;
        // 입고 완료: **그 차량이 그 슬롯에 그대로 남는다.** 모델 소유권은 storedModels 로 넘기고, 플레이어는 보관된 차량을 관찰하는 상태가 된다.
        // 새 차량을 자동 생성하거나 시작 위치로 되돌리지 않는다.
        const pose = mech.storedPoseW(e.slot, sc);
        this.storedModels.set(this.skey(e.slot), { model: this.model, spec: this.spec, carId: e.carId ?? sc.carId });
        this.placeModel(this.model, pose);
        this.playerStoredSlot = e.slot;
        this.playerStoredFac = this.activeFac;
        mech.observing = true;
        this.car.x = pose.x;
        this.car.z = pose.z;
        this.car.y = pose.y;
        this.car.heading = pose.heading;
        this.car.v = 0;
        this.car.pitch = 0;
        this.car.slope = 0;
        this.car.gear = 'P';
        this.car.handbrake = true;
        this.hud.toast(`보관 완료 — ${floorLabel(slotDef(e.slot).floor)} ${slotDef(e.slot).side} 슬롯 (새 차량: I)`, 'good');
      } else if (e.type === 'picked' && e.slot) {
        // 출고: 보관된 그 차량(모델/차종/ID)을 플레이어가 인수한다. 현재 조작 차량이 입구 밖에 있으면 삭제하지 않고 그 자리에 주차해 둔다.
        const entry = this.storedModels.get(this.skey(e.slot));
        const sc = mech.m.carrying;
        const spec = entry?.spec ?? getVehicle(sc?.specId || this.spec.id);
        if (this.playerStoredSlot) {
          // 관찰 중이던 보관 차량은 storedModels 에 그대로 남는다 (다른 슬롯 차량을 호출하는 경우)
          this.playerStoredSlot = null;
          this.playerStoredFac = null;
          mech.observing = false;
        } else if (this.model && !this.modelIsStored()) {
          this.parkOutsideCar();
        }
        this.storedModels.delete(this.skey(e.slot));
        this.adoptVehicle(spec, entry?.model ?? null, 'keep', false); // 이전 모델은 보관/주차 차량으로 남는다. 출고된 차량은 시동 OFF (자동 시동 금지)
        this.car.gear = 'P';
        this.car.handbrake = true;
      } else if (e.type === 'retrieved') {
        this.hud.toast('출고 완료 — 탑승(G) 후 출차하세요', 'good');
      }
    }
  }

  /** 조작 중인 차량을 현재 위치에 세워 둔다(모델 유지 + 충돌체 추가). 출고로 차량을 교체할 때 기존 차량이 사라지지 않게 한다 */
  private parkOutsideCar(): void {
    const model = this.model;
    if (!model) return;
    const c = centerOf(this.car, this.spec);
    const col: Collider = { kind: 'box', id: `parked-${this.parkedCars.length}-${Math.round(c.x)}_${Math.round(c.z)}`, tag: 'car', x: c.x, z: c.z, w: this.spec.width, d: this.spec.length, rot: this.car.heading, y0: this.car.y, h: this.spec.height };
    this.colliders.push(col);
    this.colliderById.set(col.id, col);
    this.parkedCars.push({ model, col });
    this.hud.toast('기존 차량은 입구 밖에 주차됩니다', 'warn');
  }

  /** 관찰 상태: 보관된 차량의 pose 를 슬롯 pose 로 고정(물리/입력 없음) */
  private holdStoredCar(): void {
    const slot = this.playerStoredSlot;
    const sc = slot ? this.mech.m.slots[slot] : null;
    if (!slot || !sc) return;
    const p = this.mech.storedPoseW(slot, sc);
    this.car.x = p.x;
    this.car.z = p.z;
    this.car.y = p.y;
    this.car.heading = p.heading;
    this.car.v = 0;
  }

  /** 명시적 조작: 보관된 차량은 그대로 두고 새 차량을 입구 대기 위치에서 시작한다 */
  startNewCar(): boolean {
    const mech = this.mech;
    if (!this.playerStoredSlot) {
      this.hud.toast('이미 조작 중인 차량이 있습니다', 'warn');
      return false;
    }
    if (mech.m.phase !== 'waiting') {
      this.hud.toast('장치가 동작 중입니다 — 복귀 후 새 차량을 시작하세요', 'warn');
      return false;
    }
    const spec = this.spec; // 같은 차종으로 시작 (보관된 차량의 모델은 storedModels 가 계속 소유)
    const sp = this.missionDef?.spawn ?? this.map.spawn;
    this.playerStoredSlot = null;
    this.playerStoredFac = null;
    mech.observing = false;
    this.car = createVehicleState(spec, sp.x, sp.z, sp.heading);
    this.car.handbrake = false;
    this.adoptVehicle(spec, null, 'keep'); // 보관된 모델은 슬롯에 그대로 둔다
    mech.m.occupant = 'in';
    this.rig.snap();
    this.newCarCount++;
    this.hud.toast('새 차량을 시작합니다', 'good');
    return true;
  }

  /** 차량 주변 충돌체(공간 인덱스 조회 결과). 차량이 조회 중심에서 3m 이상 벗어나거나 충돌체 목록이 바뀌면 다시 조회한다 */
  private nearColliders(): Collider[] {
    const rebuilt = this.spatial.sync(this.colliders);
    const dx = this.car.x - this.nearCx;
    const dz = this.car.z - this.nearCz;
    if (rebuilt || dx * dx + dz * dz > 9) {
      this.nearCx = this.car.x;
      this.nearCz = this.car.z;
      // 반경 = 재조회 이동 여유(3) + 차체 도달(≈3.5) + 센서/가이드 범위(≈6) + 여유
      this.spatial.query(this.car.x, this.car.z, 14, this.near);
    }
    return this.near;
  }

  /**
   * 접촉면 미끄러짐을 쓰는 곳: 기계식 시설 구역(문틀/가이드에 스치며 들어가는 곳).
   * 부속 구역을 붙인 일반 맵(map.annex)은 시설 입구 앞 구역 안에서만 — 그 밖에서는 이전처럼 스치는 접촉도 충돌로 기록한다.
   */
  private slideZone(): boolean {
    if (!this.map.mech) return false;
    if (!this.map.annex) return true;
    return this.facilities.some((f) => {
      const l = toLocalXZ(f.frame, this.car.x, this.car.z);
      return l.x > STATION.doorX - 14 && l.x < STATION.palletX + 6 && Math.abs(l.z) < 9;
    });
  }

  private physicsStep(vin: VehicleInput, dt: number): void {
    const car = this.car;
    // 차량 물리 + 지형/천장/하부/충돌 제약은 vehicle/worldStep.ts (헤드리스 맵 검사와 같은 코드)
    const r = stepVehicleInWorld(car, vin, this.spec, { terrain: this.map.terrain, bounds: this.map.bounds, colliders: this.nearColliders(), levelAware: !!(this.map.terrain || this.map.mech), slide: this.slideZone() }, dt);
    if (r.slid) this.lastHitId = '';
    if (r.blocked) {
      this.contactClear = 0;
      this.lastHitId = r.hit ? r.hit.id : r.reason; // 테스트/디버그 ('edge' 경계/지면 없음, 'ceiling' 천장 높이, 'underbody' 하부 접촉)
      if (!this.inContact && Math.abs(r.prevV) > 0.1) {
        this.inContact = true;
        this.collisions++;
        this.mission?.addCollision();
        this.hud.toast(`충돌! (${r.hit ? tagName(r.hit.tag) : r.reason === 'ceiling' ? '천장 높이 제한' : r.reason === 'underbody' ? '차체 하부 접촉' : '경계'})`, 'bad');
        this.hud.flash();
      } else if (!this.inContact) {
        this.inContact = true;
      }
    } else if (this.inContact) {
      this.contactClear += dt;
      if (this.contactClear > 0.4) this.inContact = false;
    }
    if (this.map.mech) {
      this.mech.bump(this.spec, car, dt); // 낮은 정지턱: 타고 넘는 약한 저항 (멈추지 않음)
      this.mech.guideDrag(this.spec, car, dt); // 낮은 가이드를 타이어가 타고 넘는 동안의 저항/경고
    }
  }

  private finishMission(): void {
    const m = this.mission!;
    this.state = 'result';
    this.input.enabled = false;
    this.input.clear();
    this.hud.resetTouchInputs();
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

    model.root.position.set(pose.x, pose.y, pose.z);
    model.root.rotation.order = 'YXZ';
    model.root.rotation.y = pose.heading;
    model.root.rotation.x = -car.pitch; // 앞이 높으면 코가 위로
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
    // 시동 OFF: 인포테인먼트(내비/주차 보조) 화면 전원이 꺼진다 — 플로팅 패널을 닫고 실내 화면은 검게
    const open = this.state !== 'menu' && this.infoOut.floatingVisible && this.screensOn;
    const firstPerson = this.rig.mode === 'driver';
    const parking = this.infoOut.content === 'parking';
    this.hud.setAssistOpen(open);
    this.assistPanel.setVisible(open);
    this.assistPanel.setContent(this.infoOut.content);
    this.canvas.classList.toggle('mirror', this.rig.mode === 'rear' && this.settings.rearMirror);
    // 후방/전방/3D 시점 카메라는 "보이는 곳(플로팅 또는 1인칭 실내 화면)"이 있을 때만 렌더링한다 (불필요한 렌더링 중단)
    if (parking && (open || firstPerson)) {
      this.renderAssist(dt, pose);
      if (this.assistPanel.surroundActive) this.renderSurround(dt, pose);
    }
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
    // 3인칭 미러(좌/룸/우): 설정이 켜져 있고 3인칭일 때만 렌더 (OFF 이면 거울 렌더 자체를 하지 않는다). 1인칭 실내 미러와 겹치지 않는다
    if (!firstPerson && this.settings.thirdMirror && this.model?.mirrors && this.state === 'playing') {
      const fps = this.settings.quality === 'low' ? 10 : Math.min(15, this.settings.mirrorFps > 0 ? this.settings.mirrorFps : 10);
      this.mirrors.update(this.renderer, this.scene, this.model, pose, this.spec, dt, fps);
      this.mirrorOverlay.draw(this.renderer, this.mirrors.textures(), w, h);
    }

    this.hud.renderWheel();
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
    return computeLighting({ mode: this.lightMode, gear: this.car.gear, ambientDark: this.map.env.indoor || this.indoorK > 0.5 });
  }

  /** 수동 카메라 순환: 현재 진행 방향 카메라가 가장 먼저 (R 에서 전방카메라가 먼저 나오는 일이 없게) */
  /** 1인칭: 실내 센터 디스플레이(3D 평면)를 마우스/터치로 눌렀을 때 — 레이캐스트 → UV → 캔버스 좌표 → 같은 Action 경로 */
  handleCabinPointer(clientX: number, clientY: number): string | null {
    if (this.rig.mode !== 'driver' || !this.model?.cabin || this.state !== 'playing') return null;
    const r = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -(((clientY - r.top) / r.height) * 2 - 1));
    const rc = new THREE.Raycaster();
    this.rig.camera.updateMatrixWorld();
    rc.setFromCamera(ndc, this.rig.camera);
    const hit = rc.intersectObject(this.model.cabin.center.mesh, false)[0];
    if (!hit || !hit.uv) return null;
    const cv = this.model.cabin.center.canvas;
    const px = hit.uv.x * cv.width;
    const py = (1 - hit.uv.y) * cv.height;
    // 메뉴 항목이 먼저, 그 다음 메인 영역(확대)
    const sorted = [...this.cabinHits].sort((a, b) => (a.action === 'expand' ? 1 : 0) - (b.action === 'expand' ? 1 : 0));
    const h = sorted.find((q) => px >= q.x && px <= q.x + q.w && py >= q.y && py <= q.y + q.h);
    if (!h) return null;
    switch (h.action) {
      case 'pdcMode':
        this.onAction(this.assistPanel.surroundActive ? 'pdcSensor' : 'pdcSurround');
        break;
      case 'sensor':
        this.onAction('sensorToggle');
        break;
      case 'sound':
        this.onAction('soundToggle');
        break;
      case 'camera':
        this.onAction('assistCamera');
        break;
      case 'settings':
        this.pause();
        this.menu.showSettings(() => this.menu.showPause());
        break;
      case 'content': {
        const f = this.info.toggleContent(this.infoOut.content);
        this.hud.toast(f ? `실내 화면: ${f === 'parking' ? '주차 보조' : '내비게이션'}` : '실내 화면: 자동');
        break;
      }
      case 'expand':
        this.info.setExpanded(!this.info.isExpanded);
        this.hud.toast(this.info.isExpanded ? '확대 화면 (닫기: × 또는 B)' : '확대 화면 닫음');
        break;
    }
    return h.action;
  }

  private gearCameraCycle(): ('auto' | AssistView)[] {
    const base = cameraCycle(this.spec.assist);
    if (!base.length) return base;
    const rev = this.car.gear === 'R';
    const pref: AssistView[] = rev ? ['rear', 'left', 'right', 'topRear', 'topFront', 'front'] : ['front', 'left', 'right', 'topFront', 'topRear', 'rear'];
    const allowed = new Set(base);
    return ['auto', ...pref.filter((v) => allowed.has(v))];
  }

  private allHits(): { x: number; z: number }[] {
    const out: { x: number; z: number }[] = [];
    if (this.sensorSnap) for (const r of this.sensorSnap.readings) for (const h of r.hits) out.push({ x: h.x, z: h.z });
    return out;
  }

  private carBody(): { x: number; z: number; rot: number; hw: number; hl: number; height: number; base: number } {
    const o = obbOf(this.car, this.spec);
    return { ...o, height: this.spec.height, base: this.poseNow().y };
  }

  /** 방향별 위험(차체 외곽~장애물 간격, 접근 속도) + 측면 3D 시점의 시야 가림 검사 (화면 전환 정책의 입력) */
  /** 현재 기어 방향 예상 이동 경로가 장애물과 만나는 거리(m, 없으면 4.5) — 카메라 전환 판단용 */
  private pathCut = 4.5;
  private pathAcc = 99;
  private updateRisk(dt: number): void {
    this.pathAcc += dt;
    if (this.pathAcc >= 0.1) {
      this.pathAcc = 0;
      const pz = this.poseNow();
      this.pathCut = guideCutDistance(this.spec, this.car.steer, this.car.gear === 'R' ? -1 : 1, pz, this.colliders, pz.y + this.spec.sensorHeight);
    }
    this.riskOut = this.risk.update(dt, this.sensorSnap, obbOf(this.car, this.spec), this.spec);
    const hits = this.allHits();
    if (hits.length) {
      this.lastHits = hits;
      this.lastHitsAge = 0;
    } else this.lastHitsAge += dt;
    this.blockedAcc += dt;
    if (this.blockedAcc >= 0.2) {
      this.blockedAcc = 0;
      const pose = this.poseNow();
      for (const side of ['left', 'right'] as const) {
        if (this.riskOut.groups[side].threat || this.viewOut.view === side) {
          const f = frameView({ view: side, pose, spec: this.spec, hits: this.sideFrameHits(side, pose), colliders: this.colliders, aspect: 16 / 9 });
          this.sideBlocked[side] = !f.visible;
        } else this.sideBlocked[side] = false;
      }
    }
  }

  /**
   * 측면(좌/우) 3D 시점의 가림 판정에 쓰는 히트점: 그 쪽 측면에 있고 차체 길이 구간(앞뒤 +0.35m, 측면 센서 zBound 와 같은 기준) 안의 것만.
   * (이전: 뒤/앞 장애물의 히트까지 포함되어, 후방 벽만 생겨도 측면뷰가 "가려짐"으로 판정되어 시점이 풀리던 버그)
   */
  private sideFrameHits(side: 'left' | 'right', pose: { x: number; z: number; heading: number }): { x: number; z: number }[] {
    const hl = this.spec.length / 2 + 0.35;
    return this.frameHits().filter((h) => {
      const l = worldToLocal(pose.x, pose.z, pose.heading, h.x, h.z);
      return (side === 'left' ? l.x > 0 : l.x < 0) && Math.abs(l.z) <= hl;
    });
  }

  /** 프레이밍에 쓰는 히트점: 현재 감지 + 짧은 유지(해제 대기 중 카메라가 튀지 않게) */
  private frameHits(): { x: number; z: number }[] {
    return this.lastHitsAge < 1.5 ? this.lastHits : [];
  }

  /** 차체 가까이(1.2m 이내)의 감지 장애물이 현재 보조 카메라 화면 밖에 있는가 */
  private nearHitsOutOfView(): boolean {
    const cam = this.rig.assistCamera;
    const body = obbOf(this.car, this.spec);
    const v = new THREE.Vector3();
    const sideView = this.viewOut.view === 'left' || this.viewOut.view === 'right' ? this.viewOut.view : null;
    const relevant = sideView ? new Set(this.sideFrameHits(sideView, this.poseNow()).map((h) => `${h.x}|${h.z}`)) : null; // 측면 시점은 그 쪽 측면 장애물만 본다(후방/전방 벽이 시점을 흔들지 않음)
    for (const h of this.allHits()) {
      if (relevant && !relevant.has(`${h.x}|${h.z}`)) continue;
      if (pointToObbGap(h.x, h.z, body) > 1.2) continue;
      v.set(h.x, this.poseNow().y + 0.3, h.z).project(cam);
      if (v.z > 1 || v.z < -1 || Math.abs(v.x) > 1.0 || Math.abs(v.y) > 1.0) return true;
    }
    return false;
  }

  private viewRisk(): SideObservation['risk'] {
    const r = this.riskOut;
    if (!r) return undefined;
    const pick = <T,>(f: (g: RiskOutput['groups'][keyof RiskOutput['groups']]) => T): Record<'front' | 'rear' | 'left' | 'right', T> => ({ front: f(r.groups.front), rear: f(r.groups.rear), left: f(r.groups.left), right: f(r.groups.right) });
    // v0.4.9: 장애물이 "있다"는 이유만으로 시점을 바꾸지 않는다. 실제 충돌 가능성이 있을 때만 보조 시점 후보가 된다.
    //  - 진행 방향(D=전방/R=후방): 매우 가까운 장애물이 예상 이동 경로(조향 반영) 위에 있을 때만 집중 탑뷰 후보
    //  - 측면: 그 쪽으로 조향하며 실제로 움직이고 있고 간격이 좁을 때만 측면뷰 후보 (나란히 서 있는 벽/차량만으로는 전환 안 함)
    const dbg = this.debugViewCtx;
    const gaps = pick((g) => g.gap);
    const steer = dbg?.steer === 'closest' ? ((gaps.left ?? 9) <= (gaps.right ?? 9) ? 0.3 : -0.3) : (dbg?.steer ?? this.car.steer);
    const gated = gateViewRisk(
      { threat: pick((g) => g.threat), veryClose: pick((g) => g.veryClose), gap: gaps },
      { gear: this.car.gear, v: dbg?.v ?? this.car.v, steer, pathCut: dbg?.pathCut ?? this.pathCut },
    );
    const threat = gated.threat;
    const veryClose = gated.veryClose;
    return { threat, veryClose, pillar: pick((g) => g.pillar), narrow: r.narrow, gap: pick((g) => g.gap), sideBlocked: { ...this.sideBlocked } };
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
    return { level: level as SideObservation['level'], hits: hits as SideObservation['hits'], risk: this.viewRisk() };
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
  private renderAssist(dt: number, pose: { x: number; z: number; heading: number; y?: number }): void {
    const view = this.viewOut.view;
    // 측면/탑/집중 탑뷰: 시점에 "진입할 때" 실제 장애물 경계로 구도를 한 번 정하고 차량 기준 좌표로 고정한다(래치).
    // 이후에는 센서 히트점이 바뀌어도 위치/높이/FOV 를 다시 계산하지 않고 차량만 따라간다.
    // 재구성은 (1) 시점이 바뀔 때 (2) 가까운 감지 장애물이 0.6초 이상 화면 밖일 때(쿨다운 2초)만 한다.
    let frame: { pos: { x: number; y: number; z: number }; look: { x: number; y: number; z: number }; up: { x: number; y: number; z: number }; fov: number } | null = null;
    if (view === 'left' || view === 'right' || view === 'top' || view === 'topZoom' || view === 'topFront' || view === 'topRear') {
      this.outAcc += dt;
      if (this.outAcc >= 0.1) {
        this.outAcc = 0;
        this.nearOut = this.latch ? this.nearHitsOutOfView() : false;
      }
      const relatch = this.relatchGate.update(dt, this.nearOut);
      if (!this.latch || this.latch.view !== view || relatch) {
        const g = this.riskOut?.groups;
        const focusSide = g ? (g.left.veryClose || g.left.pillar ? 'left' : g.right.veryClose || g.right.pillar ? 'right' : g.left.threat ? 'left' : g.right.threat ? 'right' : null) : null;
        const f = frameView({ view, pose, spec: this.spec, hits: view === 'left' || view === 'right' ? this.sideFrameHits(view, pose) : this.frameHits(), colliders: this.colliders, aspect: ASSIST_CAM_W / ASSIST_CAM_H, focusSide });
        this.latch = toLocalFrame(view, f, pose);
        this.relatchGate.reset();
        this.rig.beginTransition();
      }
      frame = fromLocalFrame(this.latch, pose);
    } else {
      this.latch = null;
    }
    this.rig.updateAssistCamera(dt, view, pose, this.spec, frame);
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
    const show3d = true; // v0.4.9: 전/후방 카메라도 자기 차체(범퍼 윗면) 일부가 영상 하단에 보여야 하므로 모든 시점에서 차체를 그린다
    if (show3d) {
      m.bodyGroup.visible = true;
      m.cockpit.visible = false;
    }
    // 전/후방 카메라는 차체 안쪽(범퍼 위치)에 있어 자기 번호판의 뒷면이 영상 아래에 보이므로 이 패스에서만 숨긴다
    const platesHidden: THREE.Object3D[] = [];
    if (view === 'rear' || view === 'front') {
      for (const n of ['Plate_Front', 'Plate_Rear']) {
        const o = m.bodyGroup.getObjectByName(n);
        if (o && o.visible) {
          o.visible = false;
          platesHidden.push(o);
        }
      }
    }
    // 다층: 현재 층보다 위의 바닥 슬래브는 보조 카메라(3D/탑뷰) 패스에서만 숨겨 천장에 가리지 않게 한다
    const decksHidden: THREE.Object3D[] = [];
    if (this.tower) for (const d of this.tower.decks) if (d.y > (pose.y ?? 0) + 0.6 && d.mesh.visible) { d.mesh.visible = false; decksHidden.push(d.mesh); }
    this.renderer.setScissorTest(true);
    this.renderer.setViewport(0, 0, vw, vh);
    this.renderer.setScissor(0, 0, vw, vh);
    this.renderer.render(this.scene, cam);
    this.renderer.setScissorTest(false);
    for (const o of decksHidden) o.visible = true;
    for (const o of platesHidden) o.visible = true;
    m.bodyGroup.visible = prevBody;
    m.cockpit.visible = prevCockpit;
    const sw = Math.max(1, Math.round(vw * pr));
    const sh = Math.max(1, Math.round(vh * pr));
    const mirror = view === 'rear' && this.settings.rearMirror;
    this.assistPanel.blit(this.canvas, 0, this.canvas.height - sh, sw, sh, mirror);
    // 오버레이: 실제 감지된 장애물 구역(전 시점) + 예측 조향 경로. 장애물 구역은 3D 시점에서 가려지는 부분을 제외한다.
    const camPos = cam.position;
    const isCar = view === 'rear' || view === 'front';
    if (this.overlayView !== view) {
      // 시점이 바뀌면 이전 시점의 경고 타일/셀 보간 상태를 버린다 (다른 투영의 잔상 방지)
      this.overlayView = view;
      this.assistPanel.resetOverlay();
    }
    const body = obbOf(this.car, this.spec);
    const rng = this.settings.sensorRange;
    const crt = this.settings.sensorCritical;
    // 전/후방 카메라: 가로 6칸 독립 타일, 3D/탑뷰: 차량 근처 장애물 경계 셀 (같은 센서 스냅샷 사용)
    let zones = !this.settings.sensorEnabled || !isCar ? [] : buildCameraTiles(this.sensorSnap, this.spec, body, view === 'rear' ? 'rear' : 'front', rng, crt, (id) => { const c = this.colliderById.get(id); return c ? c.y0 + c.h : undefined; }, pose.y ?? 0);
    const warnLines = !this.settings.sensorEnabled || isCar ? [] : buildWarnLines(this.sensorSnap, body, rng, crt);
    if (!isCar && zones.length) {
      const cbody = this.carBody();
      zones = zones.filter((z) => {
        const cx = z.corners.reduce((a, c) => a + c.x, 0) / 4;
        const cz = z.corners.reduce((a, c) => a + c.z, 0) / 4;
        return !segmentBlocked({ x: camPos.x, y: camPos.y, z: camPos.z }, { x: cx, y: (pose.y ?? 0) + 0.25, z: cz }, this.colliders, cbody, { ignoreIds: new Set(z.colliderIds), endMargin: 0.3, step: 0.3 });
      });
    }
    if (isCar && zones.length > 1) {
      // 앞에 있는 다른 장애물에 완전히 가려진 뒤쪽 패널은 그리지 않는다 (카메라 → 패널 중심 선분이 다른 충돌체를 지나면 가림)
      zones = zones.filter((z) => {
        const cx = (z.corners[2].x + z.corners[3].x) / 2;
        const cz = (z.corners[2].z + z.corners[3].z) / 2;
        return !segmentBlocked({ x: camPos.x, y: camPos.y, z: camPos.z }, { x: cx, y: (pose.y ?? 0) + Math.min(0.3, (z.panelHeight ?? 0.4) / 2), z: cz }, this.colliders, null, { ignoreIds: new Set(z.colliderIds), endMargin: 0.25, step: 0.2 });
      });
    }
    this.assistPanel.drawOverlay({
      camera: cam,
      pose,
      steer: this.car.steer,
      dir: this.assistOut.focus === 'rear' ? -1 : 1,
      mirror,
      showGuides: this.settings.assistGuides,
      zones,
      lines: warnLines,
      footprint: isCar ? 'none' : view === 'topRear' ? 'rear' : view === 'topFront' ? 'front' : 'none',
      groundY: this.map.terrain ? (x: number, z: number) => groundAt(this.map.terrain!, x, z, pose.y ?? 0, 1.2) ?? (pose.y ?? 0) : undefined,
      guideMax: guideCutDistance(this.spec, this.car.steer, this.assistOut.focus === 'rear' ? -1 : 1, pose, this.colliders, (pose.y ?? 0) + this.spec.sensorHeight),
    });
  }

  private surAcc = 99;
  surPathDbg: { steer: number; dir: 1 | -1; guideMax: number; renders: number } | null = null;
  /** 오른쪽 3D 서라운드뷰: 차량 중심 위에 고정된 카메라로 실제 장면을 렌더링하고, 외곽을 따라가는 경고선을 얹는다 */
  private renderSurround(dt: number, pose: { x: number; z: number; heading: number; y?: number }): void {
    this.surAcc += dt;
    const fps = Math.max(8, this.settings.assistCameraFps * 0.6);
    const dims = this.assistPanel.surroundSize();
    const cam = this.rig.surroundCamera;
    const tan = Math.tan((cam.fov * Math.PI) / 360);
    const aspect = dims.w / dims.h;
    const L = this.spec.length;
    const W = this.spec.width;
    // 차량 제원만으로 정한 고정 구도 (장애물/센서에 따라 움직이지 않음)
    // 앞/뒤 범퍼 너머 3.5m(예측 거리선 0.5/1/2/3m 가 모두 보이는 범위)까지 한 화면에 들어오도록 고정
    const H = Math.min(22, Math.max(8, Math.max((L + 7.4) / 2 / tan, (W + 4.4) / 2 / (tan * aspect))));
    const gy = pose.y ?? 0;
    cam.aspect = aspect;
    cam.up.set(Math.sin(pose.heading), 0, Math.cos(pose.heading));
    cam.position.set(pose.x, gy + H, pose.z);
    cam.lookAt(pose.x, gy, pose.z);
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
    if (this.surAcc >= 1 / fps) {
      this.surAcc = 0;
      const pr = this.renderer.getPixelRatio();
      const vw = Math.min(dims.w, Math.floor(window.innerWidth));
      const vh = Math.min(dims.h, Math.floor(window.innerHeight));
      const m = this.model!;
      const prevBody = m.bodyGroup.visible;
      const prevCockpit = m.cockpit.visible;
      m.bodyGroup.visible = true;
      m.cockpit.visible = false;
      const hidden: THREE.Object3D[] = [];
      if (this.tower) for (const d of this.tower.decks) if (d.y > gy + 0.6 && d.mesh.visible) { d.mesh.visible = false; hidden.push(d.mesh); }
      this.renderer.setScissorTest(true);
      this.renderer.setViewport(0, 0, vw, vh);
      this.renderer.setScissor(0, 0, vw, vh);
      this.renderer.render(this.scene, cam);
      this.renderer.setScissorTest(false);
      for (const o of hidden) o.visible = true;
      m.bodyGroup.visible = prevBody;
      m.cockpit.visible = prevCockpit;
      this.assistPanel.blitSurround(this.canvas, 0, this.canvas.height - Math.round(vh * pr), Math.round(vw * pr), Math.round(vh * pr));
    }
    const sdir: 1 | -1 = this.assistOut.focus === 'rear' ? -1 : 1;
    const sGuideMax = this.settings.assistGuides ? guideCutDistance(this.spec, this.car.steer, sdir, pose, this.colliders, gy + this.spec.sensorHeight) : 0;
    /** 테스트/디버그: 서라운드 예측선이 사용한 값 (메인 카메라 예측선과 같은 guidelines 계산) */
    this.surPathDbg = { steer: this.car.steer, dir: sdir, guideMax: sGuideMax, renders: (this.surPathDbg?.renders ?? 0) + 1 };
    this.assistPanel.drawWarnLines({
      camera: cam,
      y: gy,
      warn: this.settings.sensorEnabled && this.spec.assist.virtualSurround3D ? buildWarnLines(this.sensorSnap, obbOf(this.car, this.spec), this.settings.sensorRange, this.settings.sensorCritical) : [],
      path: this.settings.assistGuides
        ? {
            pose,
            steer: this.car.steer,
            dir: sdir,
            guideMax: sGuideMax,
            groundY: this.map.terrain ? (x: number, z: number) => groundAt(this.map.terrain!, x, z, gy, 1.2) ?? gy : undefined,
          }
        : undefined,
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

  /** 차량 화면(계기판/센터 디스플레이/플로팅 인포테인먼트) 전원: 시동이 완전히 꺼진(OFF) 동안에는 꺼진다. 시동 중/정지 중에는 켜져 있다 */
  get screensOn(): boolean {
    return this.engine.state !== 'OFF';
  }

  /** 1인칭 실내 센터 디스플레이/계기판 갱신 (설정 FPS) */
  private drawCabin(dt: number): void {
    const cab = this.model?.cabin;
    if (!cab) return;
    this.cabinAcc += dt;
    if (this.cabinAcc < 1 / this.settings.cabinFps) return;
    this.cabinAcc = 0;
    if (!this.screensOn) {
      // 시동 OFF: 계기판/센터 디스플레이 꺼짐(검은 화면). 터치 영역도 없다
      for (const scr of [cab.center, cab.cluster]) {
        scr.ctx.fillStyle = '#020304';
        scr.ctx.fillRect(0, 0, scr.canvas.width, scr.canvas.height);
        scr.texture.needsUpdate = true;
      }
      this.cabinHits = [];
      this.lastClusterData = null;
      return;
    }
    const c = this.car;
    const slotName = this.navState.destination?.id ?? '';
    this.cabinHits = drawCenterScreen(cab.center.ctx, cab.center.canvas.width, cab.center.canvas.height, {
      content: this.infoOut.content,
      cam: this.assistPanel.cam,
      guide: this.assistPanel.guide,
      navCanvas: this.assistPanel.navCanvas,
      spec: this.spec,
      pdc: this.pdcState,
      surround: this.assistPanel.surroundActive ? this.assistPanel.sur : null,
      surroundOv: this.assistPanel.surroundActive ? this.assistPanel.surOv : null,
      pdcView: this.assistPanel.surroundActive ? 'surround' : 'sensor',
      surroundSupported: this.spec.assist.virtualSurround3D,
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
    const clusterData: ClusterData = {
      speedKmh: spd,
      gear: c.gear,
      rpm: this.engine.rpm,
      engineState: this.engine.state,
      signalLeft: (this.sigLeft || this.hazard) && this.blinkOn,
      signalRight: (this.sigRight || this.hazard) && this.blinkOn,
      hazard: this.hazard && this.blinkOn,
      lightMode: LIGHT_MODE_NAME[this.lightMode],
      lowBeam: L.low,
      highBeam: L.high,
      handbrake: c.handbrake,
      pdcLevel: this.pdcState?.overall ?? 'none',
      pdcOn: this.settings.sensorEnabled,
      steerDeg: c.steer / DEG,
      wheelDeg: (c.steer / this.spec.maxSteer) * 540,
      floor: this.map.terrain ? levelAt(this.map.terrain, c.y).name : null,
      mission: this.mission ? this.mission.def.name.replace(/ \(임시\)/, '') : '자유주행',
      throttle: Math.max(0, this.throttle),
      brake: Math.max(0, this.brake),
      pitchDeg: (c.pitch ?? 0) / DEG,
      speedMax: (this.clusterSpeedMax = speedScale(spd, this.clusterSpeedMax, this.spec.maxSpeedFwd * 3.6)),
      redline: this.engine.profile.redline,
      engineLabel: this.engine.profile.label,
      clock: new Date().toTimeString().slice(0, 5),
      tail: L.tail > 0.5,
      doorOpen: this.mech.m.occupant === 'out',
      locked: this.mech.m.locked ? 'mech' : this.activeLift?.st.locked ? 'lift' : null,
      zones: this.clusterZones(),
    };
    this.lastClusterData = clusterData; // 테스트/디버그: 계기판이 실제 게임 상태와 일치하는지 검사
    drawCluster(cab.cluster.ctx, cab.cluster.canvas.width, cab.cluster.canvas.height, clusterData);
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
      steerWheelDeg: -(car.steer / this.spec.maxSteer) * WHEEL_LOCK_DEG,
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
      engineState: this.engine.state,
      parking: this.parkArea && this.parkRec && (this.parkArea.regularTotal > 0 || this.parkArea.mech.length > 0) ? { summary: summaryLine(this.parkArea), headline: this.parkRec.facility && this.parkRec.kind !== 'both' ? `${this.parkRec.headline} · ${this.parkRec.facility.name} (${this.parkRec.facility.free}칸 · ${statusText(this.parkRec.facility.status)})` : this.parkRec.headline, kind: this.parkRec.kind } : null,
      mission: mh,
      fpsText: this.settings.showFps ? `FPS ${this.fpsInstant.toFixed(0)} · 평균 ${this.avgFps().toFixed(0)}` : null,
    };
    // 통합 맵: 가까운 구역 중심 렌더(주차 차량 모델 거리 컬링) + 구역 이름 알림 + 기계식 패널은 기계식 구역 근처에서만
    const zones = (this.map as unknown as { zones?: { id: string; label: string; bounds: { minX: number; maxX: number; minZ: number; maxZ: number } }[] }).zones;
    if (zones) {
      this.zoneAcc += 1 / 60;
      if (this.zoneAcc > 0.4) {
        this.zoneAcc = 0;
        this.built?.setViewCenter(this.car.x, this.car.z, VIEW_RADIUS[this.settings.quality].load); // 화질별 타일/차량 모델 가시 반경
        const zn = zones.find((z) => this.car.x >= z.bounds.minX - 2 && this.car.x <= z.bounds.maxX + 2 && this.car.z >= z.bounds.minZ - 2 && this.car.z <= z.bounds.maxZ + 2) ?? null;
        if (zn?.id !== this.zoneId) {
          this.zoneId = zn?.id ?? null;
          if (zn) this.hud.toast(`구역: ${zn.label}`);
        }
        // 기계식 패널: 어느 시설이든 입구 앞 구역(로컬 x -28..+14, |z|<20)에 있을 때만
        this.mechPanel.setVisible(this.facilities.some((f) => { const l = toLocalXZ(f.frame, this.car.x, this.car.z); return l.x > STATION.doorX - 28 && l.x < STATION.palletX + 14 && Math.abs(l.z) < 20; }));
      }
    }
    else if (this.map.mech) {
      // 단일 맵: 전용 맵(mechpark)은 항상, 그 밖의 맵(outdoor 등)은 시설 입구 앞 구역에서만 기계식 패널을 보인다
      this.mechPanel.setVisible(this.map.id === 'mechpark' || this.facilities.some((f) => { const l = toLocalXZ(f.frame, this.car.x, this.car.z); return l.x > STATION.doorX - 28 && l.x < STATION.palletX + 14 && Math.abs(l.z) < 20; }));
    }
    // 야외 맵 안의 실내 구역(지하 B1 등): 들어가면 주변광을 서서히 줄이고 자동 전조등 조건(어두움)을 켠다
    if (this.map.indoorZones) {
      const zin = this.map.indoorZones.some((q) => this.car.y >= q.yMin && this.car.y <= q.yMax && Math.abs(this.car.x - q.rect.x) <= q.rect.w / 2 && Math.abs(this.car.z - q.rect.z) <= q.rect.d / 2);
      const target = zin ? 1 : 0;
      if (this.indoorK !== target) {
        this.indoorK += Math.sign(target - this.indoorK) * Math.min(Math.abs(target - this.indoorK), 0.03);
        this.built?.setIndoorFactor(this.indoorK);
      }
    }
    if (this.map.terrain) {
      const lv = levelAt(this.map.terrain, this.car.y);
      if (this.cullLevelY !== lv.y) {
        this.cullLevelY = lv.y;
        this.built?.setLevelVisibility(this.car.y);
      }
      this.hud.setFloor(lv.name);
      this.hud.minimap.setLevel(lv.y);
    } else this.hud.setFloor(null);
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
    guide: '팔레트 가이드',
    bollard: '볼라드',
    car: '주차된 차량',
  };
  return t[tag] ?? '장애물';
}

export { QUALITY_PRESETS };
