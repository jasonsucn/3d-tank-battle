// ============================================================================
// 80-ui.js — UI：HUD / 八屏流程 / 设置 / 菜单输入（规格书 §2 §4 §5 §7，契约 §9）
// 说明：DOM 来自 ui.html，样式来自 ui.css；本分片与其它分片同处一个 module 作用域，
//       不重复声明顶层名字。所有公开方法都做空值/重复调用保护。
// ============================================================================
const UI = (() => {
  'use strict';

  // ---- 配置引用（全部从 CONFIG 读取，避免魔法数字） -------------------------
  const CFG = (typeof CONFIG !== 'undefined' && CONFIG) ? CONFIG : {};
  const UI_CFG = CFG.ui || {};
  const FLOW_CFG = CFG.flow || {};
  const AUDIO_CFG = CFG.audio || {};
  const SCORE_CFG = CFG.score || {};
  const POWERUP_CFG = CFG.powerup || {};
  const PLAYER_CFG = CFG.player || {};
  const ENEMY_CFG = CFG.enemy || {};
  const DIGITS = Number.isFinite(Number(SCORE_CFG.digits)) ? Number(SCORE_CFG.digits) : 7;
  const DEFAULT_LIVES = Number.isFinite(Number(PLAYER_CFG.lives)) ? Number(PLAYER_CFG.lives) : 3;
  const ICON_FALLBACK_COUNT = 20;

  const SCREEN_IDS = {
    loading: 'screen-loading',
    title: 'screen-title',
    help: 'screen-help',
    settings: 'screen-settings',
    intro: 'screen-intro',
    pause: 'screen-pause',
    tally: 'screen-tally',
    gameover: 'screen-gameover',
  };
  const SCREEN_NAMES = Object.keys(SCREEN_IDS);
  const DIM_SCREENS = { help: true, settings: true, pause: true, tally: true, gameover: true };

  const PU_ORDER = ['star', 'grenade', 'helmet', 'timer', 'shovel', 'tank'];
  const PU_FALLBACK = {
    star: { name: '星星', desc: '火力 +1，上限 3 级' },
    grenade: { name: '手雷', desc: '全屏敌军爆炸' },
    helmet: { name: '头盔', desc: '护盾 10 秒' },
    timer: { name: '定时器', desc: '敌军冻结 8 秒' },
    shovel: { name: '铁锹', desc: '基地护墙变钢 15 秒' },
    tank: { name: '坦克', desc: '生命 +1' },
  };
  const VOLUME_KEYS = ['master', 'music', 'sfx'];
  const QUALITY_VALUES = ['high', 'medium', 'low'];
  const VIEW_VALUES = ['follow', 'classic'];
  // Game 的 G.effects 用 shield/freeze 命名，HUD 统一映射到道具种类
  const PU_KIND_ALIAS = { shield: 'helmet', freeze: 'timer', life: 'tank' };
  const PU_TOTAL_FALLBACK = {
    helmet: Number.isFinite(Number(POWERUP_CFG.shieldTime)) ? Number(POWERUP_CFG.shieldTime) : 10,
    timer: Number.isFinite(Number(POWERUP_CFG.freezeTime)) ? Number(POWERUP_CFG.freezeTime) : 8,
    shovel: Number.isFinite(Number(POWERUP_CFG.shovelTime)) ? Number(POWERUP_CFG.shovelTime) : 15,
  };
  const PU_RING_R = 19;
  const PU_RING_C = 2 * Math.PI * PU_RING_R;

  // ---- 图标：全部用内联 SVG 线段绘制（规格书 §7 禁止 emoji 图标） -----------
  const ICON_PATHS = {
    star: '<path class="fill" d="M12 2.8l2.85 5.78 6.38.93-4.62 4.5 1.09 6.36L12 17.37l-5.7 3 1.09-6.36-4.62-4.5 6.38-.93z"/>',
    grenade: '<circle cx="11.6" cy="14.2" r="6"/><path d="M10.2 8.1V6.3h3.2v1.8"/><path d="M13.4 6.3c1.9-.4 3.2-1.7 3.9-3.4"/><path d="M8.9 14.2h5.4"/><path d="M11.6 11.5v5.4"/>',
    helmet: '<path d="M4.2 14.6V13a7.8 7.8 0 0 1 15.6 0v1.6"/><path d="M2.8 15.2h18.4v2.5H2.8z"/><path d="M8 7c1.1-1.5 2.4-2.2 4-2.2"/>',
    timer: '<circle cx="12" cy="13.2" r="7.2"/><path d="M12 9v4.6l3 1.8"/><path d="M9.6 2.4h4.8"/><path d="M12 2.4v2.8"/>',
    shovel: '<path d="M9.4 3.2h5.2"/><path d="M12 3.2v9.3"/><path d="M8.4 12.5h7.2l-.9 4.4a2.7 2.7 0 0 1-5.4 0z"/>',
    tank: '<path d="M3.4 10.4h17.2v5.2H3.4z"/><path d="M8.4 10.4V7.4h7.2v3z"/><path d="M15.6 8.3h5.8v1.8h-5.8z"/><rect x="1.6" y="15.6" width="20.8" height="2.8" rx="1.2"/>',
  };
  const TANK_PATHS = '<path d="M3.4 10.4h17.2v5.2H3.4z"/><path d="M8.4 10.4V7.4h7.2v3z"/><path d="M15.6 8.3h5.8v1.8h-5.8z"/><rect x="1.6" y="15.6" width="20.8" height="2.8" rx="1.2"/>';

  // ---- 运行期状态 -----------------------------------------------------------
  let actionsRef = {};
  let el = {};
  let domReady = false;
  let initialized = false;
  let currentScreen = 'loading';

  let titleItems = [];
  let pauseItems = [];
  let settingsRows = [];
  let fireStars = [];
  let enemyIcons = [];
  let titleIndex = 0;
  let pauseIndex = 0;
  let settingsIndex = 0;

  const puChips = new Map();
  const tallyTimers = [];
  let tallyReady = false;
  let toastTimer = 0;
  let lastLoadingStatus = '';
  let audioUnlocked = false;

  // 设置本地副本：滑杆/分段/开关先即时反映，再通过 actions.setting 交给 Game
  const localSettings = {
    master: clampInt(AUDIO_CFG.master !== undefined ? AUDIO_CFG.master : 80, 0, 100),
    music: clampInt(AUDIO_CFG.music !== undefined ? AUDIO_CFG.music : 60, 0, 100),
    sfx: clampInt(AUDIO_CFG.sfx !== undefined ? AUDIO_CFG.sfx : 80, 0, 100),
    quality: 'high',
    view: 'follow',
    scanline: true,
    shake: true,
  };

  // ==========================================================================
  // 工具函数
  // ==========================================================================
  function toNumber(v, fallback) {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  }

  function clampInt(v, min, max) {
    let n = Math.round(Number(v));
    if (!Number.isFinite(n)) n = min;
    if (n < min) n = min;
    if (n > max) n = max;
    return n;
  }

  function clamp01(v) {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) return 0;
    return n > 1 ? 1 : n;
  }

  function toBool(v, fallback) {
    if (typeof v === 'boolean') return v;
    if (typeof v === 'number') return v !== 0;
    if (typeof v === 'string') {
      const s = v.toLowerCase();
      if (s === 'true' || s === '1' || s === 'on' || s === 'yes') return true;
      if (s === 'false' || s === '0' || s === 'off' || s === 'no') return false;
    }
    return typeof fallback === 'boolean' ? fallback : false;
  }

  function normalizeEnum(v, allowed, fallback) {
    if (typeof v === 'string' && allowed.indexOf(v) >= 0) return v;
    if (allowed.indexOf(fallback) >= 0) return fallback;
    return allowed[0];
  }

  function fmtScore(v) {
    const n = Math.max(0, Math.floor(toNumber(v, 0)));
    return String(n).padStart(DIGITS, '0');
  }

  function byId(id) {
    return document.getElementById(id) || null;
  }

  function on(target, type, handler, options) {
    if (!target || typeof target.addEventListener !== 'function') return;
    target.addEventListener(type, handler, options);
  }

  function svgIcon(kind, cls) {
    const body = ICON_PATHS[kind];
    if (!body) return '';
    return '<svg class="' + (cls || '') + '" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' + body + '</svg>';
  }

  function tankMarkup(cls) {
    return '<svg class="' + (cls || '') + '" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' + TANK_PATHS + '</svg>';
  }

  function puInfo(kind) {
    const meta = (typeof POWERUP_META !== 'undefined' && POWERUP_META && POWERUP_META[kind]) ? POWERUP_META[kind] : null;
    const fb = PU_FALLBACK[kind] || { name: kind, desc: '' };
    return {
      name: meta && typeof meta.name === 'string' && meta.name ? meta.name : fb.name,
      desc: meta && typeof meta.desc === 'string' && meta.desc ? meta.desc : fb.desc,
    };
  }

  function iconCount() {
    const n = Math.floor(Number(UI_CFG.enemyIconCount));
    if (!Number.isFinite(n) || n <= 0) return ICON_FALLBACK_COUNT;
    return Math.min(40, n);
  }

  function hasAction(name) {
    return !!(actionsRef && typeof actionsRef[name] === 'function');
  }

  // 调用 Game 提供的回调；用户回调的异常不会破坏 UI 事件循环
  function invoke(name) {
    if (!hasAction(name)) return;
    const fn = actionsRef[name];
    const args = Array.prototype.slice.call(arguments, 1);
    try {
      fn.apply(null, args);
    } catch (err) {
      /* 静默：回调失败时保持 UI 可继续操作 */
    }
  }

  function sfx(name) {
    if (typeof AudioSys === 'undefined' || !AudioSys || typeof AudioSys.play !== 'function') return;
    try {
      AudioSys.play(name);
    } catch (err) {
      /* 音频未解锁或未初始化时静默 */
    }
  }

  // ==========================================================================
  // DOM 缓存 / 动态节点
  // ==========================================================================
  function cacheDom() {
    el = {
      view: byId('view'),
      hud: byId('hud'),
      hudScore: byId('hud-score'),
      hudHi: byId('hud-hiscore'),
      hudFire: byId('hud-fire'),
      enemyGrid: byId('hud-enemy-grid'),
      enemyCount: byId('hud-enemy-count'),
      powerups: byId('hud-powerups'),
      hudLives: byId('hud-lives'),
      hudLivesCount: byId('hud-lives-count'),
      hudLivesDuo: byId('hud-lives-duo'),
      hudLivesP1: byId('hud-lives-p1-count'),
      hudLivesP2: byId('hud-lives-p2-count'),
      hudStage: byId('hud-stage'),
      crt: byId('crt'),
      flashWhite: byId('flash-white'),
      flashRed: byId('flash-red'),
      toast: byId('toast'),
      loadingBar: byId('loading-bar'),
      loadingFill: byId('loading-fill'),
      loadingStatus: byId('loading-status'),
      loadingPercent: byId('loading-percent'),
      loadingHint: byId('loading-hint'),
      titleMenu: byId('title-menu'),
      titleHiscore: byId('title-hiscore'),
      helpPowerups: byId('help-powerup-list'),
      helpBack: byId('help-back'),
      settingsRows: byId('settings-rows'),
      settingsBack: byId('settings-back'),
      setQuality: byId('set-quality'),
      setView: byId('set-view'),
      setScanline: byId('set-scanline'),
      setShake: byId('set-shake'),
      introStage: byId('intro-stage'),
      pauseMenu: byId('pause-menu'),
      tallyPanel: byId('tally-panel'),
      tallyBonus: byId('tally-bonus'),
      tallyTotal: byId('tally-total'),
      tallyNext: byId('tally-next'),
      goScore: byId('go-score'),
      goHi: byId('go-hiscore'),
      goStage: byId('go-stage'),
      gameoverBack: byId('gameover-back'),
      screens: {},
    };
    el.volumeControls = [
      { key: 'master', input: byId('set-master'), value: byId('set-master-val') },
      { key: 'music', input: byId('set-music'), value: byId('set-music-val') },
      { key: 'sfx', input: byId('set-sfx'), value: byId('set-sfx-val') },
    ];
    for (let i = 0; i < SCREEN_NAMES.length; i++) {
      const name = SCREEN_NAMES[i];
      el.screens[name] = byId(SCREEN_IDS[name]);
    }
  }

  function buildDynamicDom() {
    // 火力星级（3 枚 SVG 星，等级改变时切换填充）
    if (el.hudFire) {
      let html = '';
      for (let i = 0; i < 3; i++) html += '<span class="fire-star off">' + svgIcon('star') + '</span>';
      el.hudFire.innerHTML = html;
      fireStars = Array.prototype.slice.call(el.hudFire.querySelectorAll('.fire-star'));
    }

    // 敌方余量：2 列 SVG 小坦克，共 20 个
    buildEnemyIcons(iconCount());

    // HELP：六道具图鉴（名称/说明来自 POWERUP_META）
    if (el.helpPowerups) {
      el.helpPowerups.innerHTML = '';
      for (let i = 0; i < PU_ORDER.length; i++) {
        const kind = PU_ORDER[i];
        const info = puInfo(kind);
        const li = document.createElement('li');
        li.className = 'codex-item pu-' + kind;
        const icon = document.createElement('span');
        icon.className = 'codex-icon';
        icon.innerHTML = svgIcon(kind);
        const text = document.createElement('span');
        text.className = 'codex-text';
        const name = document.createElement('span');
        name.className = 'codex-name';
        name.textContent = info.name;
        const desc = document.createElement('span');
        desc.className = 'codex-desc';
        desc.textContent = info.desc;
        text.appendChild(name);
        text.appendChild(desc);
        li.appendChild(icon);
        li.appendChild(text);
        el.helpPowerups.appendChild(li);
      }
    }

    // TALLY：四类击杀行的小坦克图标
    if (el.tallyPanel) {
      const rows = el.tallyPanel.querySelectorAll('.tally-row');
      for (let i = 0; i < rows.length; i++) {
        const holder = rows[i].querySelector('.tally-ico');
        if (holder && !holder.firstChild) holder.innerHTML = tankMarkup('');
      }
    }
  }

  function buildEnemyIcons(count) {
    if (!el.enemyGrid) return;
    const total = Math.min(40, Math.max(0, Math.floor(toNumber(count, iconCount()))));
    let html = '';
    for (let i = 0; i < total; i++) html += tankMarkup('enemy-ico');
    el.enemyGrid.innerHTML = html;
    enemyIcons = Array.prototype.slice.call(el.enemyGrid.querySelectorAll('.enemy-ico'));
  }

  // ==========================================================================
  // 事件绑定（只绑定一次；全部按钮都有真实回调）
  // ==========================================================================
  function bindEvents() {
    titleItems = el.titleMenu ? Array.prototype.slice.call(el.titleMenu.querySelectorAll('.menu-item')) : [];
    pauseItems = el.pauseMenu ? Array.prototype.slice.call(el.pauseMenu.querySelectorAll('.menu-item')) : [];
    settingsRows = el.settingsRows ? Array.prototype.slice.call(el.settingsRows.querySelectorAll('.set-row')) : [];

    bindMenuItems(titleItems, 'title');
    bindMenuItems(pauseItems, 'pause');

    // LOADING：点击任意处解锁音频
    on(el.screens.loading, 'pointerdown', unlockAudio);
    on(document, 'keydown', function () {
      if (currentScreen === 'loading') unlockAudio();
    });

    // HELP：返回按钮 + 点击空白处
    on(el.helpBack, 'click', function () {
      sfx('uiSelect');
      invoke('back');
    });
    on(el.screens.help, 'click', function (ev) {
      if (ev && ev.target === el.screens.help) {
        sfx('uiSelect');
        invoke('back');
      }
    });

    // SETTINGS：返回 + 三滑杆 + 两组分段 + 两开关
    on(el.settingsBack, 'click', function () {
      sfx('uiSelect');
      invoke('back');
    });

    for (let i = 0; i < el.volumeControls.length; i++) {
      (function (ctl) {
        if (!ctl.input) return;
        on(ctl.input, 'input', function () {
          const v = clampInt(ctl.input.value, 0, 100);
          setSetting(ctl.key, v, false);
        });
      })(el.volumeControls[i]);
    }

    for (let i = 0; i < settingsRows.length; i++) {
      (function (row, idx) {
        on(row, 'pointerenter', function () { setSettingsIndex(idx, false); });
        on(row, 'focusin', function () { setSettingsIndex(idx, false); });
      })(settingsRows[i], i);
    }

    bindSegButtons(el.setQuality, 'quality');
    bindSegButtons(el.setView, 'view');
    bindToggle(el.setScanline, 'scanline');
    bindToggle(el.setShake, 'shake');

    // TALLY：动画播放完毕后可继续
    on(el.tallyNext, 'click', function () {
      if (!tallyReady || !hasAction('next')) return;
      sfx('uiSelect');
      setTallyReady(false);
      invoke('next');
    });

    // GAME OVER：返回标题
    on(el.gameoverBack, 'click', function () {
      sfx('uiSelect');
      invoke('toTitle');
    });
  }

  function bindMenuItems(items, which) {
    for (let i = 0; i < items.length; i++) {
      (function (item, idx) {
        on(item, 'click', function () {
          setMenuIndex(which, idx, false);
          activateMenu(which);
        });
        on(item, 'pointerenter', function () { setMenuIndex(which, idx, false); });
        on(item, 'focus', function () { setMenuIndex(which, idx, false); });
      })(items[i], i);
    }
  }

  function bindSegButtons(container, key) {
    if (!container) return;
    const buttons = container.querySelectorAll('.seg-btn');
    for (let i = 0; i < buttons.length; i++) {
      (function (btn) {
        on(btn, 'click', function () {
          selectRowOf(btn);
          setSetting(key, btn.getAttribute('data-value'), true);
        });
      })(buttons[i]);
    }
  }

  function bindToggle(node, key) {
    if (!node) return;
    on(node, 'click', function () {
      selectRowOf(node);
      setSetting(key, !toBool(localSettings[key], true), true);
    });
  }

  function selectRowOf(node) {
    if (!node || typeof node.closest !== 'function') return;
    const row = node.closest('.set-row');
    if (!row) return;
    const idx = settingsRows.indexOf(row);
    if (idx >= 0) setSettingsIndex(idx, false);
  }

  // ==========================================================================
  // 屏幕调度
  // ==========================================================================
  function restartElementAnimation(node) {
    if (!node || !node.classList || !node.classList.contains('active')) return;
    node.classList.remove('active');
    void node.offsetWidth;
    node.classList.add('active');
  }

  function setScreen(name) {
    let valid = null;
    if (typeof name === 'string' && Object.prototype.hasOwnProperty.call(SCREEN_IDS, name)) valid = name;
    const changed = valid !== currentScreen;

    if (changed) {
      clearTallyTimers();
      setTallyReady(false);
      if (valid !== 'tally' && el.tallyPanel) el.tallyPanel.classList.remove('tally-run', 'ready');
    }

    // aria-hidden 之前先把焦点移出被隐藏的屏幕（避免浏览器可访问性告警）
    const focused = document.activeElement;
    if (focused && focused !== document.body) {
      for (let i = 0; i < SCREEN_NAMES.length; i++) {
        const node = el.screens[SCREEN_NAMES[i]];
        if (node && node !== el.screens[valid] && node.contains(focused)) {
          try { focused.blur(); } catch (err) { /* 忽略焦点丢失 */ }
          break;
        }
      }
    }

    for (let i = 0; i < SCREEN_NAMES.length; i++) {
      const key = SCREEN_NAMES[i];
      const node = el.screens[key];
      if (!node) continue;
      const isOn = key === valid;
      node.classList.toggle('active', isOn);
      node.setAttribute('aria-hidden', isOn ? 'false' : 'true');
    }

    if (el.view) el.view.classList.toggle('screen-dim', !!valid && !!DIM_SCREENS[valid]);
    currentScreen = valid;

    if (changed) {
      if (valid === 'title') setMenuIndex('title', 0, false);
      else if (valid === 'pause') setMenuIndex('pause', 0, false);
      else if (valid === 'settings') setSettingsIndex(0, false);
      else if (valid === 'intro' && el.screens.intro) restartElementAnimation(el.screens.intro);
    } else if (valid === 'settings') {
      setSettingsIndex(settingsIndex, false);
    }
  }

  function setHudVisible(show) {
    if (!el.hud) return;
    const onFlag = !!show;
    el.hud.classList.toggle('on', onFlag);
    el.hud.setAttribute('aria-hidden', onFlag ? 'false' : 'true');
  }

  // ==========================================================================
  // HUD
  // ==========================================================================
  function setHUD(h) {
    if (!h || typeof h !== 'object') return;

    if (h.score !== undefined && el.hudScore) el.hudScore.textContent = fmtScore(h.score);
    if (h.hiScore !== undefined && el.hudHi) el.hudHi.textContent = fmtScore(h.hiScore);
    if (h.stage !== undefined && el.hudStage) el.hudStage.textContent = String(clampInt(h.stage, 1, 999));
    if (h.fireLevel !== undefined) setFireLevel(h.fireLevel);

    let mode = 'single';
    if (h.mode === 'duo' || h.mode === 'single') mode = h.mode;
    else if (typeof G !== 'undefined' && G && G.mode === 'duo') mode = 'duo';

    const lives = h.lives !== undefined ? clampInt(h.lives, 0, 99) : DEFAULT_LIVES;
    const livesP2 = h.livesP2 !== undefined ? clampInt(h.livesP2, 0, 99) : lives;

    if (el.hudLives) el.hudLives.classList.toggle('is-hidden', mode === 'duo');
    if (el.hudLivesDuo) el.hudLivesDuo.classList.toggle('is-hidden', mode !== 'duo');
    if (el.hudLivesCount) el.hudLivesCount.textContent = String(lives);
    if (el.hudLivesP1) el.hudLivesP1.textContent = String(lives);
    if (el.hudLivesP2) el.hudLivesP2.textContent = String(livesP2);
  }

  function setFireLevel(level) {
    const lv = clampInt(level, 0, 3);
    for (let i = 0; i < fireStars.length; i++) {
      const onStar = i < lv;
      fireStars[i].classList.toggle('on', onStar);
      fireStars[i].classList.toggle('off', !onStar);
    }
  }

  function setEnemyIcons(total, killed) {
    let totalN = Math.floor(toNumber(total, -1));
    if (!Number.isFinite(totalN) || totalN < 0) totalN = iconCount();
    totalN = Math.min(40, totalN);
    if (enemyIcons.length !== totalN) buildEnemyIcons(totalN);

    let killedN = Math.floor(toNumber(killed, 0));
    if (!Number.isFinite(killedN) || killedN < 0) killedN = 0;
    killedN = Math.min(killedN, totalN);

    for (let i = 0; i < enemyIcons.length; i++) {
      enemyIcons[i].classList.toggle('dead', i >= totalN - killedN);
    }
    if (el.enemyCount) el.enemyCount.textContent = String(totalN - killedN).padStart(2, '0');
  }

  function createPowerupChip(kind) {
    if (!el.powerups || !ICON_PATHS[kind]) return null;
    const root = document.createElement('div');
    root.className = 'pu-chip pu-' + kind;
    root.setAttribute('role', 'img');
    root.innerHTML =
      '<svg class="pu-ring" viewBox="0 0 44 44" aria-hidden="true" focusable="false">' +
      '<circle class="pu-track" cx="22" cy="22" r="' + PU_RING_R + '"></circle>' +
      '<circle class="pu-arc" cx="22" cy="22" r="' + PU_RING_R + '"></circle>' +
      '</svg>' +
      '<span class="pu-glyph" aria-hidden="true">' + svgIcon(kind) + '</span>' +
      '<span class="pu-secs"></span>';
    const arc = root.querySelector('.pu-arc');
    if (arc) {
      arc.style.strokeDasharray = PU_RING_C.toFixed(2);
      arc.style.strokeDashoffset = '0';
    }
    return {
      kind: kind,
      root: root,
      arc: arc,
      secs: root.querySelector('.pu-secs'),
      lastSecs: -1,
      lastFrac: -1,
      lastExpire: false,
    };
  }

  function updatePowerupChip(chip, item) {
    if (!chip || !item) return;
    const remain = Math.max(0, toNumber(item.remain, 0));
    let total = Math.max(0, toNumber(item.total, 0));
    if (total <= 0) total = Math.max(0, toNumber(PU_TOTAL_FALLBACK[chip.kind], 0));
    const frac = total > 0 ? clamp01(remain / total) : 0;

    if (chip.arc) {
      const offset = Math.round((PU_RING_C * (1 - frac)) * 100) / 100;
      if (Math.abs(offset - chip.lastFrac) > 0.4) {
        chip.arc.style.strokeDashoffset = String(offset);
        chip.lastFrac = offset;
      }
    }

    const secs = Math.max(0, Math.ceil(remain));
    if (chip.secs && secs !== chip.lastSecs) {
      chip.lastSecs = secs;
      chip.secs.textContent = String(secs);
      if (chip.root) chip.root.setAttribute('aria-label', puInfo(chip.kind).name + ' 剩余 ' + secs + ' 秒');
    }

    const blinkTime = Number.isFinite(Number(POWERUP_CFG.blinkTime)) ? Number(POWERUP_CFG.blinkTime) : 3;
    const expiring = remain > 0 && remain <= blinkTime;
    if (expiring !== chip.lastExpire) {
      chip.lastExpire = expiring;
      if (chip.root) chip.root.classList.toggle('expiring', expiring);
    }
  }

  // 道具状态：按 kind 复用卡片，逐帧调用也不重建 DOM
  function setPowerups(list) {
    if (!el.powerups) return;
    const items = Array.isArray(list) ? list : [];
    const seen = new Set();

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (!item || typeof item !== 'object') continue;
      const rawKind = item.kind || item.type;
      const kind = PU_KIND_ALIAS[rawKind] || rawKind;
      if (!kind || !ICON_PATHS[kind] || seen.has(kind)) continue;
      seen.add(kind);
      let chip = puChips.get(kind);
      if (!chip) {
        chip = createPowerupChip(kind);
        if (!chip) continue;
        puChips.set(kind, chip);
        el.powerups.appendChild(chip.root);
      }
      updatePowerupChip(chip, item);
    }

    const kinds = Array.from(puChips.keys());
    for (let i = 0; i < kinds.length; i++) {
      if (!seen.has(kinds[i])) {
        const chip = puChips.get(kinds[i]);
        if (chip && chip.root && chip.root.parentNode) chip.root.parentNode.removeChild(chip.root);
        puChips.delete(kinds[i]);
      }
    }

    el.powerups.classList.toggle('empty', seen.size === 0);
  }

  function setTitleMeta(hiScore) {
    if (!el.titleHiscore) return;
    el.titleHiscore.textContent = fmtScore(hiScore);
  }

  // ==========================================================================
  // LOADING
  // ==========================================================================
  function loadingStatusFor(p) {
    if (p <= 0) return '准备加载';
    if (p < 0.28) return '生成贴图材质';
    if (p < 0.58) return '构建关卡与模型';
    if (p < 0.84) return '准备特效与音频';
    if (p < 1) return '完成最后准备';
    return '加载完成';
  }

  function updateLoadingHint() {
    if (!el.loadingHint) return;
    const ready = audioUnlocked || (typeof AudioSys !== 'undefined' && AudioSys && AudioSys.ready === true);
    if (ready) {
      el.loadingHint.textContent = '按任意键开始';
      el.loadingHint.classList.add('ready');
      if (el.screens.loading) el.screens.loading.classList.remove('locked');
    } else {
      el.loadingHint.textContent = '点击或按任意键解锁音频';
      el.loadingHint.classList.remove('ready');
      if (el.screens.loading) el.screens.loading.classList.add('locked');
    }
  }

  function unlockAudio() {
    if (audioUnlocked) return;
    audioUnlocked = true;
    invoke('unlockAudio');
    updateLoadingHint();
  }

  function setLoading(progress) {
    const p = clamp01(progress);
    const pct = Math.round(p * 100);

    if (el.loadingFill) el.loadingFill.style.width = pct + '%';
    if (el.loadingPercent) el.loadingPercent.textContent = pct + '%';
    if (el.loadingBar) el.loadingBar.setAttribute('aria-valuenow', String(pct));

    const status = loadingStatusFor(p);
    if (el.loadingStatus && status !== lastLoadingStatus) {
      el.loadingStatus.textContent = status;
      lastLoadingStatus = status;
    }
    updateLoadingHint();
  }

  // ==========================================================================
  // INTRO / TALLY / GAME OVER
  // ==========================================================================
  function setIntro(stage) {
    const n = clampInt(stage, 1, 999);
    if (el.introStage) el.introStage.textContent = String(n);
    setScreen('intro');
    if (el.screens.intro) restartElementAnimation(el.screens.intro);
  }

  function clearTallyTimers() {
    while (tallyTimers.length) {
      const id = tallyTimers.pop();
      try { clearTimeout(id); } catch (err) { /* 忽略已失效定时器 */ }
    }
  }

  function setTallyReady(ready) {
    tallyReady = !!ready;
    if (el.tallyPanel) el.tallyPanel.classList.toggle('ready', tallyReady);
  }

  function scheduleTally(fn, delay) {
    const id = setTimeout(function () {
      if (currentScreen !== 'tally') return;
      try { fn(); } catch (err) { /* 结算动画不阻塞流程 */ }
    }, Math.max(0, delay));
    tallyTimers.push(id);
  }

  function showTally(data) {
    const d = (data && typeof data === 'object') ? data : {};
    const counts = (d.counts && typeof d.counts === 'object') ? d.counts : {};
    const step = Math.max(0.15, toNumber(UI_CFG.tallyStep, toNumber(FLOW_CFG.tallyStep, 0.35)));
    const bonusDelay = Math.max(0.05, toNumber(FLOW_CFG.tallyBonus, 0.6));
    const rows = el.tallyPanel ? el.tallyPanel.querySelectorAll('.tally-row') : [];

    if (el.tallyPanel) el.tallyPanel.style.setProperty('--tally-step', step + 's');

    let sum = 0;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const type = row.getAttribute('data-type') || 'basic';
      const n = Math.max(0, Math.floor(toNumber(counts[type], 0)));
      const per = toNumber(ENEMY_CFG.score ? ENEMY_CFG.score[type] : 0, 0);
      const points = n * per;
      sum += points;
      const countNode = row.querySelector('[data-count]');
      const pointsNode = row.querySelector('[data-points]');
      if (countNode) countNode.textContent = String(n);
      if (pointsNode) pointsNode.textContent = String(points);
    }

    const bonus = Number.isFinite(Number(d.bonus)) ? Math.max(0, Math.floor(Number(d.bonus))) : Math.max(0, Math.floor(toNumber(SCORE_CFG.stageClear, 1000)));
    const total = Number.isFinite(Number(d.total)) ? Math.max(0, Math.floor(Number(d.total))) : sum + bonus;

    if (el.tallyBonus) el.tallyBonus.textContent = '+' + bonus;
    if (el.tallyTotal) el.tallyTotal.textContent = fmtScore(total);
    if (d.hiScore !== undefined && el.hudHi) el.hudHi.textContent = fmtScore(d.hiScore);
    if (d.hiScore !== undefined) setTitleMeta(d.hiScore);

    setScreen('tally');
    setTallyReady(false);
    clearTallyTimers();

    if (el.tallyPanel) {
      el.tallyPanel.classList.remove('tally-run');
      void el.tallyPanel.offsetWidth;
      el.tallyPanel.classList.add('tally-run');
    }

    for (let i = 0; i < rows.length; i++) {
      scheduleTally(function () { sfx('tick'); }, Math.round(i * step * 1000));
    }
    scheduleTally(function () { sfx('tick'); }, Math.round(rows.length * step * 1000));
    scheduleTally(function () { setTallyReady(true); }, Math.round((rows.length * step + bonusDelay) * 1000));
  }

  function showGameOver(data) {
    const d = (data && typeof data === 'object') ? data : {};
    if (el.goScore) el.goScore.textContent = fmtScore(d.score);
    if (el.goHi) el.goHi.textContent = fmtScore(d.hiScore);
    if (el.goStage) el.goStage.textContent = String(clampInt(d.stage, 1, 999));
    if (d.hiScore !== undefined) setTitleMeta(d.hiScore);

    setScreen('gameover');
    if (el.screens.gameover) restartElementAnimation(el.screens.gameover);
    flashRed(0.7);
  }

  // ==========================================================================
  // 闪屏 / toast
  // ==========================================================================
  function flashLayer(node, duration) {
    if (!node) return;
    let ms = Number(duration);
    if (!Number.isFinite(ms) || ms <= 0) ms = 320;
    else if (ms <= 20) ms = ms * 1000; // 兼容以“秒”传入的时长
    ms = Math.max(60, Math.min(3000, ms));

    node.style.transition = 'none';
    node.style.opacity = '1';
    void node.offsetWidth;
    node.style.transition = 'opacity ' + ms + 'ms ease-out';
    node.style.opacity = '0';
  }

  function flashWhite(duration) {
    flashLayer(el.flashWhite, duration);
  }

  function flashRed(duration) {
    flashLayer(el.flashRed, duration);
  }

  function toast(text, ms) {
    if (!el.toast) return;
    const msg = (text === null || text === undefined) ? '' : String(text);
    if (toastTimer) {
      clearTimeout(toastTimer);
      toastTimer = 0;
    }
    if (!msg) {
      el.toast.classList.remove('show');
      return;
    }
    el.toast.textContent = msg;
    el.toast.classList.add('show');
    const wait = Math.max(600, Number.isFinite(Number(ms)) && Number(ms) > 0 ? Number(ms) : toNumber(UI_CFG.toastTime, 2200));
    toastTimer = setTimeout(function () {
      toastTimer = 0;
      if (el.toast) el.toast.classList.remove('show');
    }, wait);
  }

  // ==========================================================================
  // 设置
  // ==========================================================================
  function syncSeg(container, value) {
    if (!container) return;
    const buttons = container.querySelectorAll('.seg-btn');
    for (let i = 0; i < buttons.length; i++) {
      const active = buttons[i].getAttribute('data-value') === value;
      buttons[i].classList.toggle('active', active);
      buttons[i].setAttribute('aria-pressed', active ? 'true' : 'false');
    }
  }

  function syncToggle(node, value) {
    if (!node) return;
    const onFlag = !!value;
    node.setAttribute('aria-checked', onFlag ? 'true' : 'false');
    const label = node.querySelector('.toggle-text');
    if (label) label.textContent = onFlag ? '开' : '关';
  }

  function syncSettingsDom() {
    for (let i = 0; i < el.volumeControls.length; i++) {
      const ctl = el.volumeControls[i];
      const value = clampInt(localSettings[ctl.key], 0, 100);
      if (ctl.input) {
        const str = String(value);
        if (ctl.input.value !== str) ctl.input.value = str;
        ctl.input.style.setProperty('--fill', value + '%');
      }
      if (ctl.value) ctl.value.textContent = String(value);
    }
    syncSeg(el.setQuality, localSettings.quality);
    syncSeg(el.setView, localSettings.view);
    syncToggle(el.setScanline, localSettings.scanline);
    syncToggle(el.setShake, localSettings.shake);
    setScanline(localSettings.scanline);
  }

  function setScanline(enable) {
    const onFlag = toBool(enable, true);
    localSettings.scanline = onFlag;
    if (el.crt) el.crt.classList.toggle('off', !onFlag);
    syncToggle(el.setScanline, onFlag);
  }

  function applySettings(s) {
    const src = (s && typeof s === 'object') ? s : {};
    if (src.master !== undefined) localSettings.master = clampInt(src.master, 0, 100);
    if (src.music !== undefined) localSettings.music = clampInt(src.music, 0, 100);
    if (src.sfx !== undefined) localSettings.sfx = clampInt(src.sfx, 0, 100);
    if (src.quality !== undefined) localSettings.quality = normalizeEnum(src.quality, QUALITY_VALUES, localSettings.quality);
    if (src.view !== undefined) localSettings.view = normalizeEnum(src.view, VIEW_VALUES, localSettings.view);
    if (src.scanline !== undefined) localSettings.scanline = toBool(src.scanline, localSettings.scanline);
    if (src.shake !== undefined) localSettings.shake = toBool(src.shake, localSettings.shake);
    syncSettingsDom();
  }

  function setSetting(key, value, withSound) {
    if (!key) return;
    if (VOLUME_KEYS.indexOf(key) >= 0) {
      value = clampInt(value, 0, 100);
    } else if (key === 'quality') {
      value = normalizeEnum(value, QUALITY_VALUES, localSettings.quality);
    } else if (key === 'view') {
      value = normalizeEnum(value, VIEW_VALUES, localSettings.view);
    } else if (key === 'scanline' || key === 'shake') {
      value = toBool(value, localSettings[key]);
    } else {
      return;
    }

    localSettings[key] = value;
    syncSettingsDom();
    if (withSound) sfx('uiSelect');
    invoke('setting', key, value);
  }

  function setSettingsIndex(index, withSound) {
    if (!settingsRows.length) return;
    const len = settingsRows.length;
    const i = ((Math.floor(index) % len) + len) % len;
    settingsIndex = i;
    for (let j = 0; j < settingsRows.length; j++) {
      settingsRows[j].classList.toggle('focus', j === i);
    }
    if (withSound) sfx('uiMove');
  }

  function adjustSettingRow(row, dir) {
    if (!row) return;
    const key = row.getAttribute('data-key');
    const type = row.getAttribute('data-type');
    if (!key) return;

    if (type === 'slider') {
      const cur = clampInt(localSettings[key], 0, 100);
      const next = clampInt(cur + dir * 5, 0, 100);
      if (next !== cur) setSetting(key, next, false);
      return;
    }
    if (type === 'toggle') {
      setSetting(key, dir > 0, true);
      return;
    }
    if (type === 'seg') {
      const values = key === 'quality' ? QUALITY_VALUES : VIEW_VALUES;
      let idx = values.indexOf(localSettings[key]);
      if (idx < 0) idx = 0;
      idx = (idx + dir + values.length) % values.length;
      setSetting(key, values[idx], true);
    }
  }

  function activateSettingRow(row) {
    if (!row) return;
    const key = row.getAttribute('data-key');
    const type = row.getAttribute('data-type');
    if (!key) return;
    if (type === 'toggle') {
      setSetting(key, !toBool(localSettings[key], true), true);
    } else if (type === 'seg') {
      adjustSettingRow(row, 1);
    }
  }

  // ==========================================================================
  // 菜单 / 键盘路由
  // ==========================================================================
  function setMenuIndex(which, index, withSound) {
    const items = which === 'title' ? titleItems : pauseItems;
    if (!items.length) return;
    const len = items.length;
    const i = ((Math.floor(index) % len) + len) % len;
    if (which === 'title') titleIndex = i;
    else pauseIndex = i;
    for (let j = 0; j < items.length; j++) {
      items[j].classList.toggle('focus', j === i);
    }
    if (withSound) sfx('uiMove');
  }

  function runAction(action) {
    switch (action) {
      case 'single': invoke('start', 'single'); break;
      case 'duo': invoke('start', 'duo'); break;
      case 'help': invoke('showHelp'); break;
      case 'settings': invoke('showSettings'); break;
      case 'resume': invoke('resume'); break;
      case 'restart': invoke('restart'); break;
      case 'toTitle': invoke('toTitle'); break;
      case 'back': invoke('back'); break;
      case 'next': invoke('next'); break;
      default: break;
    }
  }

  function activateMenu(which) {
    const items = which === 'title' ? titleItems : pauseItems;
    const idx = which === 'title' ? titleIndex : pauseIndex;
    const item = items[idx];
    if (!item) return;
    sfx('uiSelect');
    runAction(item.getAttribute('data-action'));
  }

  function consumeEvent(e) {
    if (e && typeof e.preventDefault === 'function') {
      try { e.preventDefault(); } catch (err) { /* 忽略不可取消事件 */ }
    }
    return true;
  }

  function key(e) {
    if (!e || typeof e !== 'object') return false;
    const k = typeof e.key === 'string' ? e.key : '';
    const code = typeof e.code === 'string' ? e.code : '';
    const enter = k === 'Enter' || code === 'NumpadEnter' || k === ' ' || k === 'Spacebar';
    const esc = k === 'Escape' || k === 'Esc';
    const up = k === 'ArrowUp';
    const down = k === 'ArrowDown';
    const left = k === 'ArrowLeft';
    const right = k === 'ArrowRight';
    const repeat = !!e.repeat;

    if (currentScreen === 'loading') {
      unlockAudio();
      return false;
    }

    if (currentScreen === 'title') {
      if (up || left) { setMenuIndex('title', titleIndex - 1, true); return consumeEvent(e); }
      if (down || right) { setMenuIndex('title', titleIndex + 1, true); return consumeEvent(e); }
      if (enter && !repeat) { activateMenu('title'); return consumeEvent(e); }
      return false;
    }

    if (currentScreen === 'help') {
      if ((enter && !repeat) || esc) {
        sfx('uiSelect');
        invoke('back');
        return consumeEvent(e);
      }
      return false;
    }

    if (currentScreen === 'settings') {
      if (up) { setSettingsIndex(settingsIndex - 1, true); return consumeEvent(e); }
      if (down) { setSettingsIndex(settingsIndex + 1, true); return consumeEvent(e); }
      if (left || right) {
        adjustSettingRow(settingsRows[settingsIndex], left ? -1 : 1);
        return consumeEvent(e);
      }
      if (enter && !repeat) {
        activateSettingRow(settingsRows[settingsIndex]);
        return consumeEvent(e);
      }
      if (esc) {
        sfx('uiSelect');
        invoke('back');
        return consumeEvent(e);
      }
      return false;
    }

    if (currentScreen === 'pause') {
      if (up || left) { setMenuIndex('pause', pauseIndex - 1, true); return consumeEvent(e); }
      if (down || right) { setMenuIndex('pause', pauseIndex + 1, true); return consumeEvent(e); }
      if (enter && !repeat) { activateMenu('pause'); return consumeEvent(e); }
      if (esc) {
        sfx('uiSelect');
        invoke('resume');
        return consumeEvent(e);
      }
      return false;
    }

    if (currentScreen === 'tally') {
      if (enter && !repeat) {
        if (hasAction('next')) {
          // 与 Input 的 TALLY 兜底一致：动画期间按 Enter 也可立即进入下一关
          sfx('uiSelect');
          setTallyReady(false);
          invoke('next');
        }
        return consumeEvent(e);
      }
      return false;
    }

    if (currentScreen === 'gameover') {
      if ((enter || esc) && !repeat) {
        sfx('uiSelect');
        invoke('toTitle');
        return consumeEvent(e);
      }
      return false;
    }

    return false;
  }

  // ==========================================================================
  // 初始化
  // ==========================================================================
  function init(actions) {
    actionsRef = (actions && typeof actions === 'object') ? actions : {};
    cacheDom();

    // 若脚本被提前执行而 DOM 尚未就绪，等下一次 init 再绑定
    if (!el.screens.title) return;

    if (!domReady) {
      buildDynamicDom();
      bindEvents();
      domReady = true;
    }

    if (!initialized) {
      initialized = true;
      setScreen('loading');
      setHudVisible(false);
      setPowerups([]);
      applySettings((typeof G !== 'undefined' && G && G.settings) ? G.settings : null);
      setHUD({
        score: (typeof G !== 'undefined' && G) ? G.score : 0,
        hiScore: (typeof G !== 'undefined' && G) ? G.hiScore : 0,
        lives: DEFAULT_LIVES,
        stage: (typeof G !== 'undefined' && G) ? G.stage : 1,
        fireLevel: 0,
        mode: (typeof G !== 'undefined' && G) ? G.mode : 'single',
        livesP2: DEFAULT_LIVES,
      });
      setTitleMeta((typeof G !== 'undefined' && G) ? G.hiScore : 0);
      setEnemyIcons(iconCount(), 0);
      setLoading(0);
      updateLoadingHint();
      setMenuIndex('title', 0, false);
      setMenuIndex('pause', 0, false);
      setSettingsIndex(0, false);
    } else {
      syncSettingsDom();
      updateLoadingHint();
    }
  }

  // ---- 对外接口（契约 §9） --------------------------------------------------
  return {
    init: init,
    setScreen: setScreen,
    setHudVisible: setHudVisible,
    setHUD: setHUD,
    setEnemyIcons: setEnemyIcons,
    setPowerups: setPowerups,
    setIntro: setIntro,
    showTally: showTally,
    showGameOver: showGameOver,
    setLoading: setLoading,
    flashWhite: flashWhite,
    flashRed: flashRed,
    toast: toast,
    applySettings: applySettings,
    setScanline: setScanline,
    key: key,
    setTitleMeta: setTitleMeta,
  };
})();
