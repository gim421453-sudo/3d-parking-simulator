import './style.css';
import './pdc/pdc.css';
import { Game } from './game/Game';

const canvas = document.getElementById('game-canvas') as HTMLCanvasElement;
const root = document.getElementById('ui-root') as HTMLElement;

declare global {
  interface Window {
    __game?: Game;
  }
}

try {
  const game = new Game(root, canvas);
  window.__game = game; // 자동 테스트/디버깅용 훅
  game.menu.showMain();
  document.getElementById('boot')?.remove();
} catch (e) {
  const boot = document.getElementById('boot');
  if (boot) {
    boot.textContent = '그래픽(WebGL)을 시작할 수 없습니다. 브라우저의 하드웨어 가속 설정을 확인해 주세요.';
  }
  console.error(e);
}
