/** 벡터 아이콘(24×24, currentColor 선). 이모지 대신 사용한다. */
const svg = (body: string, extra = ''): string =>
  `<svg class="ic" viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ${extra}>${body}</svg>`;

export const ICON = {
  camera: svg('<path d="M4 8h3l1.5-2h7L17 8h3v11H4z"/><circle cx="12" cy="13.5" r="3.4"/>'),
  map: svg('<path d="M3 6.5l6-2 6 2 6-2v13l-6 2-6-2-6 2z"/><path d="M9 4.5v13M15 6.5v13"/>'),
  pause: svg('<path d="M8 5v14M16 5v14"/>'),
  restart: svg('<path d="M4.5 12a7.5 7.5 0 1 0 2.4-5.5"/><path d="M4 4v4h4"/>'),
  reset: svg('<path d="M12 4v3M12 17v3M4 12h3M17 12h3"/><circle cx="12" cy="12" r="3.2"/>'),
  mirror: svg('<path d="M5 7.5c0-1.4 1.1-2.5 2.5-2.5h9C17.9 5 19 6.1 19 7.5v6c0 1.4-1.1 2.5-2.5 2.5h-9C6.1 16 5 14.9 5 13.5z"/><path d="M12 16v3.5M8.5 19.5h7"/><path d="M8 12l3-3"/>'),
  sensor: svg('<path d="M12 18v2"/><path d="M8.5 15.5a5 5 0 0 1 7 0"/><path d="M5.5 12.5a9 9 0 0 1 13 0"/><path d="M2.8 9.6a13 13 0 0 1 18.4 0"/>'),
  volume: svg('<path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5z"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/>'),
  volumeOff: svg('<path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5z"/><path d="M16 9.5l5 5M21 9.5l-5 5"/>'),
  hazard: svg('<path d="M12 4l9 15.5H3z"/><path d="M12 10v4.5"/><circle cx="12" cy="17" r=".6" fill="currentColor"/>'),
  headlight: svg('<path d="M10 6.5c-3.5 0-6 2.5-6 5.5s2.5 5.5 6 5.5z"/><path d="M13.5 8h7M13.5 12h7M13.5 16h7"/>'),
  parkBrake: svg('<circle cx="12" cy="12" r="8"/><path d="M10 16V8h3a2.5 2.5 0 0 1 0 5h-3"/>'),
  left: svg('<path d="M14.5 6l-6 6 6 6"/>'),
  right: svg('<path d="M9.5 6l6 6-6 6"/>'),
  close: svg('<path d="M6 6l12 12M18 6L6 18"/>'),
  settings: svg('<circle cx="12" cy="12" r="3"/><path d="M12 3v2.4M12 18.6V21M3 12h2.4M18.6 12H21M5.6 5.6l1.7 1.7M16.7 16.7l1.7 1.7M5.6 18.4l1.7-1.7M16.7 7.3l1.7-1.7"/>'),
  /** 주차 보조(차량 위 + 센서 호) */
  parkAssist: svg('<rect x="8.5" y="7" width="7" height="12" rx="2.6"/><path d="M6 5.6a8 8 0 0 1 12 0"/><path d="M4 3.8a11 11 0 0 1 16 0"/>'),
  assist: svg('<circle cx="12" cy="12" r="8"/><path d="M10 16V8h3a2.5 2.5 0 0 1 0 5h-3"/><path d="M19.5 5.5l1.6-1.6"/>'),
  cameraSwitch: svg('<path d="M4 8h3l1.5-2h7L17 8h3v11H4z"/><path d="M9.5 13.5h5M13 12l1.8 1.5L13 15"/>'),
  display: svg('<rect x="3" y="5" width="18" height="11.5" rx="2"/><path d="M9 20h6M12 16.5V20"/><path d="M6.5 13l2.6-3 2 2.2 2.4-3.2 2 4"/>'),
  car: svg('<path d="M4 15.5V12l1.8-4.2A2 2 0 0 1 7.6 6.6h8.8a2 2 0 0 1 1.8 1.2L20 12v3.5"/><path d="M3.5 15.5h17v2.2H3.5z"/><circle cx="7.5" cy="17.7" r="1.4" fill="currentColor"/><circle cx="16.5" cy="17.7" r="1.4" fill="currentColor"/><path d="M5 12h14"/>'),
  keyboard: svg('<rect x="3" y="6.5" width="18" height="11" rx="2"/><path d="M6.5 10h.01M9.5 10h.01M12.5 10h.01M15.5 10h.01M17.5 10h.01M7 14h10"/>'),
  star: svg('<path d="M12 4l2.5 5.1 5.6.8-4 3.9.9 5.6L12 16.8 7 19.4l.9-5.6-4-3.9 5.6-.8z" fill="currentColor" stroke="none"/>'),
  play: svg('<path d="M8 5.5v13l11-6.5z" fill="currentColor"/>'),
};
