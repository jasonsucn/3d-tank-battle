// ============================================================================
// 90-input.js — 键位、暂停/视角/静音、失焦暂停、音频解锁（规格书 §7/§8）
// ============================================================================
const Input = (() => {
  const keys = new Set();
  const stacks = [[], []]; // 两个玩家的方向按压栈（后按优先）
  let inited = false;
  let gestureHandled = false;

  const P1 = {
    up: 'KeyW', down: 'KeyS', left: 'KeyA', right: 'KeyD',
    fire: ['KeyJ', 'Space'],
  };
  const P2 = {
    up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight',
    fire: ['KeyK', 'Numpad0'],
  };
  const DIR_CODES = {
    KeyW: [0, 'up'], KeyS: [0, 'down'], KeyA: [0, 'left'], KeyD: [0, 'right'],
    ArrowUp: [1, 'up'], ArrowDown: [1, 'down'], ArrowLeft: [1, 'left'], ArrowRight: [1, 'right'],
  };
  const BLOCK_DEFAULT = new Set([
    'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space',
  ]);

  function init() {
    if (inited) return;
    inited = true;
    window.addEventListener('keydown', onKeyDown, { passive: false });
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    document.addEventListener('visibilitychange', onVisibility);
    document.addEventListener('pointerdown', unlockAudio, { passive: true });
  }

  function unlockAudio() {
    if (gestureHandled) return;
    gestureHandled = true;
    AudioSys.init();
    if (typeof Game !== 'undefined') Game.onAudioUnlocked();
  }

  function onKeyDown(ev) {
    const code = ev.code;
    if (BLOCK_DEFAULT.has(code)) ev.preventDefault();
    // 首次交互（键或指针）只用于解锁音频，不同时触发菜单/游戏
    if (!gestureHandled) {
      unlockAudio();
      return;
    }
    if (ev.repeat) return;

    // 静音快捷键（除输入框焦点外始终可用）
    if (code === 'KeyM') {
      AudioSys.setMuted(!AudioSys.muted);
      if (typeof UI !== 'undefined') UI.toast(AudioSys.muted ? '静音开' : '静音关', 1200);
      return;
    }

    // 菜单/说明/设置/暂停/结算等屏幕优先交给 UI
    const menuStates = ['TITLE', 'HELP', 'SETTINGS', 'PAUSED', 'TALLY', 'GAMEOVER', 'LOADING'];
    if (menuStates.indexOf(G.state) !== -1) {
      if (typeof UI !== 'undefined' && UI.key(ev)) {
        return;
      }
      // UI 未消费的兜底键
      if (G.state === 'PAUSED' && (code === 'Escape' || code === 'KeyP')) {
        Game.resume();
        return;
      }
      if (G.state === 'TALLY' && code === 'Enter') {
        Game.next();
        return;
      }
      if (G.state === 'GAMEOVER' && code === 'Enter') {
        Game.next();
        return;
      }
      return;
    }

    if (G.state !== 'PLAYING') return;

    if (code === 'Escape' || code === 'KeyP') {
      Game.pause();
      return;
    }
    if (code === 'KeyC') {
      Main.cycleView();
      return;
    }
    const dir = DIR_CODES[code];
    if (dir) {
      keys.add(code);
      pushDir(dir[0], dir[1]);
      return;
    }
    if (P1.fire.indexOf(code) !== -1 || P2.fire.indexOf(code) !== -1) {
      keys.add(code);
    }
  }

  function onKeyUp(ev) {
    const code = ev.code;
    if (BLOCK_DEFAULT.has(code)) ev.preventDefault();
    keys.delete(code);
    const dir = DIR_CODES[code];
    if (dir) {
      removeDir(dir[0], dir[1]);
    }
  }

  function pushDir(player, dir) {
    const stack = stacks[player];
    const existing = stack.indexOf(dir);
    if (existing !== -1) stack.splice(existing, 1);
    stack.push(dir);
  }

  function removeDir(player, dir) {
    const stack = stacks[player];
    const i = stack.indexOf(dir);
    if (i !== -1) stack.splice(i, 1);
  }

  function playerIntent(index) {
    const stack = stacks[index] || stacks[0];
    const dir = stack.length ? stack[stack.length - 1] : null;
    const fireKeys = index === 1 ? P2.fire : P1.fire;
    const fire = fireKeys.some((k) => keys.has(k));
    return { dir, moving: !!dir, fire };
  }

  function clear() {
    keys.clear();
    stacks[0].length = 0;
    stacks[1].length = 0;
  }

  function onBlur() {
    clear();
    if (G.state === 'PLAYING') Game.pause();
  }

  function onVisibility() {
    if (document.hidden) {
      clear();
      if (G.state === 'PLAYING') Game.pause();
    }
  }

  return { init, playerIntent, clear, unlockAudio };
})();
