// ============================================================================
// 01-config.js — CONFIG（全部可调数值，规格书 §0 禁止魔法数字）与运行期 G
// 单位：场地单位 = 原版半格；时间秒；速度单位/秒。
// ============================================================================
const CONFIG = {
  version: '1.0.0',
  storage: {
    hiScore: 'bc3d.hiscore',
    settings: 'bc3d.settings',
  },

  // ---- 场地（§2） -----------------------------------------------------------
  field: {
    size: 26,          // 26×26 单位
    half: 13,
    blocks: 13,        // 13×13 块
    blockSize: 2,
    brickHeight: 1.2,
    steelHeight: 1.4,
    treeCrownY: 1.6,   // 树冠底 ≥1.6，保证遮挡
    iceHeight: 0.04,
    waterHeight: 0.08,
    boundary: 13,      // 不可见边界墙 |x|,|z| >= 13
  },

  // ---- 坦克（§2） -----------------------------------------------------------
  tank: {
    size: 2,
    half: 1,
    aabbHalf: 0.95,    // 坦克互相推开用
    snap: 2,           // 转向吸附 Math.round(v/2)*2
    turnDamp: 8,       // 视觉朝向阻尼 8/s
    muzzleOffset: 1.05,// 炮口距车心
  },

  // ---- 玩家（§2） -----------------------------------------------------------
  player: {
    speed: 6.0,
    lives: 3,
    respawnDelay: 2.0,
    respawnShield: 3.0,
    spawnBlocks: [{ c: 4, r: 12 }, { c: 8, r: 12 }],
    maxFireLevel: 3,
    extraLifeScore: 20000,
    fire: [
      { speed: 14, maxBullets: 1, breakSteel: false, cooldown: 0.35 },
      { speed: 18, maxBullets: 1, breakSteel: false, cooldown: 0.35 },
      { speed: 18, maxBullets: 2, breakSteel: false, cooldown: 0.35 },
      { speed: 20, maxBullets: 2, breakSteel: true,  cooldown: 0.35 },
    ],
  },

  // ---- 敌方（§2/§3） --------------------------------------------------------
  enemy: {
    speed: { basic: 4.0, fast: 7.5, power: 5.0, armor: 4.5 },
    hp:    { basic: 1,   fast: 1,   power: 1,   armor: 4 },
    score: { basic: 100, fast: 200, power: 300, armor: 400 },
    color: { basic: '#8f8f96', fast: '#c9cdd4', power: '#c96a3a', armor: '#4f7d5c' },
    armorColors: ['#4f7d5c', '#b8a24a', '#cfd6dd'], // 血量 4→3→2；1 血高频闪白
    fire: {
      basic: { speed: 12, maxBullets: 1, cooldown: [0.9, 1.6] },
      fast:  { speed: 14, maxBullets: 1, cooldown: [0.7, 1.2] },
      power: { speed: 16, maxBullets: 1, cooldown: [0.8, 1.4] },
      armor: { speed: 14, maxBullets: 1, cooldown: [0.9, 1.5] },
    },
    // 每关编制：基础/快速/强化/装甲（§3）；6+ 关由公式补充
    queueTable: [
      [18, 2, 0, 0],
      [12, 6, 2, 0],
      [8, 6, 4, 2],
      [6, 6, 4, 4],
      [4, 6, 5, 5],
    ],
    total: 20,
    carrierSlots: [4, 11, 17, 20], // 1-based，携带者必掉道具
    spawnMaxAlive: [3, 3, 4, 4, 4],
    spawnInterval: 3.0,
    spawnIntervalDecay: 0.1,
    spawnIntervalMin: 1.6,
    spawnRetry: 2.0,
    spawnBeam: 1.0,
    spawnBlocks: [{ c: 0, r: 0 }, { c: 6, r: 0 }, { c: 12, r: 0 }],
    decision: [0.5, 1.5],
    decisionWeights: { straight: 0.40, baseAxis: 0.25, playerAxis: 0.15, random: 0.20 },
    blockedForceTurn: 1.2,
    fireChance: 0.30,
    alignedFireChance: 0.60,
    alignedTolerance: 0.8,
    alignedRange: 10,
    freezeTint: 0.55,
  },

  // ---- 子弹（§2） -----------------------------------------------------------
  bullet: {
    size: 0.3,
    radius: 0.15,
    brickBreakWidth: 2,   // 命中破坏 2×1
    maxLife: 3.0,
    trailLength: 1.4,
    glowColor: 0xffd27a,
    coreColor: 0xfff6dd,
    enemyGlowColor: 0xff7a4a,
    recoil: 0.18,
    recoilReturn: 6,
  },

  // ---- 道具（§2） -----------------------------------------------------------
  powerup: {
    kinds: ['star', 'grenade', 'helmet', 'timer', 'shovel', 'tank'],
    life: 15,
    blinkTime: 3,
    pickupScore: 500,
    dropChance: 1.0,       // 携带者必掉
    scale: 1.2,            // 道具面板整体放大，保证俯视下可读
    bobHeight: 0.16,
    bobSpeed: 2.0,
    spinSpeed: 1.5,
    floatY: 1.35,
    shieldTime: 10,
    freezeTime: 8,
    shovelTime: 15,
    shovelBlink: 3,
    grenadeChain: 0.06,
    color: {
      star: 0xffd23f, grenade: 0xff6b3a, helmet: 0x4adfff,
      timer: 0x7aa2ff, shovel: 0xffb02e, tank: 0x6cff8a,
    },
  },

  // ---- 计分（§2） -----------------------------------------------------------
  score: {
    powerup: 500,
    stageClear: 1000,
    digits: 7,
  },

  // ---- 流程与演出（§2/§4） --------------------------------------------------
  flow: {
    stageIntro: { curtain: 0.8, text: 1.2, open: 0.8, total: 2.8 },
    tallyStep: 0.35,
    tallyBonus: 0.6,
    slowmo: {
      enemyDeath: { scale: 0.3, time: 0.8 },
      playerDeath: { scale: 0.4, time: 0.4 },
      eagleDeath: { scale: 0.25, time: 1.2 },
    },
    eagleExplosionTime: 2.5,
    gameOverDelay: 2.2,
    titleBgm: 'title',
    battleBgm: 'battle',
  },

  // ---- AI（§3） -------------------------------------------------------------
  ai: {
    stopDistance: 0.05,
    retargetAfterBlocked: true,
  },

  // ---- 音频（§6） -----------------------------------------------------------
  audio: {
    master: 80,
    music: 60,
    sfx: 80,
    bgmLookahead: 0.12,
    bgmTimer: 0.03,
    sameSfxWindow: 0.05,
    maxSameSfx: 4,
    duck: { amount: 0.30, hold: 0.12 },
    engine: { idleGain: 0.015, moveGain: 0.05, pitch: 1.12, baseHz: 50, lowpass: 240 },
    bpm: { battle: 132, title: 96, horn: 140, jingle: 132, gameover: 90 },
    volumes: { master: 0.8, music: 0.6, sfx: 0.8 },
  },

  // ---- 渲染 / 相机 / 后期（§4） ---------------------------------------------
  render: {
    exposure: 1.05,
    toneMapping: 'ACESFilmic',
    shadowMapSize: 2048,
    pixelRatioCap: 2,
    anisotropy: 4,
    clearColor: 0x0a0c10,
  },
  camera: {
    fov: 42,
    near: 0.1,
    far: 320,
    follow: { height: 30, back: 13.5, blend: 0.35, damp: 4 },
    classic: { pos: [0, 41, 9.5], fov: 40 },
    shake: { decay: 1.8, maxYaw: 0.012, maxPitch: 0.01, maxRoll: 0.02, maxOffset: 0.55 },
    eagleZoom: { height: 18, back: 8, fov: 36 },
  },
  post: {
    bloom: { strength: 0.35, radius: 0.6, threshold: 0.85 },
    crt: { scanline: 0.08, vignette: 0.35, aberration: 0.0015 },
    fxaa: true,
  },

  // ---- 特效（§5/§8） --------------------------------------------------------
  fx: {
    particles: { high: 2000, medium: 1200, low: 600 },
    debris: 64,
    rings: 8,
    flashes: 8,
    scoreTexts: 12,
    lights: 6,
    shake: {
      brick: 0.04, steel: 0.08, enemyDeath: 0.18,
      playerDeath: 0.30, eagleDeath: 0.50, fire: 0.02,
    },
    dustInterval: 0.09,
    tracerDuskBoost: 1.3,
    explosion: { debrisGravity: -20, debrisBounce: 0.35, debrisLife: 2.0 },
  },

  // ---- 画质档（§8） ---------------------------------------------------------
  quality: {
    high:   { pixelRatio: 2,   shadow: 2048, post: true,  particles: 2000 },
    medium: { pixelRatio: 1.5, shadow: 1024, post: true,  particles: 1200 },
    low:    { pixelRatio: 1,   shadow: 0,    post: false, particles: 600 },
    degradeFps: 45,
    degradeTime: 5.0,
  },

  // ---- UI（§7） -------------------------------------------------------------
  ui: {
    screenFade: 0.25,
    intro: { curtain: 0.8, text: 1.2, open: 0.8 },
    tallyStep: 0.35,
    toastTime: 2200,
    titleFloat: 3.0,
    enemyIconCount: 20,
    freezeVignette: 0.5,
    helpSections: 2,
  },

  // ---- 主题（§4） -----------------------------------------------------------
  themes: [
    {
      key: 'day', name: '白昼', sun: '#fff3d6', sunIntensity: 2.4, sunPos: [14, 30, 10],
      skyTop: '#87b7e8', skyBottom: '#d8e8f5', fog: null, ambientBoost: 1.0,
      hemiSky: '#9db4ff', hemiGround: '#3a2f2a', stars: false, tracerBoost: 1.0,
    },
    {
      key: 'dusk', name: '黄昏', sun: '#ff9a3c', sunIntensity: 2.0, sunPos: [24, 11, 15],
      skyTop: '#ff9a5c', skyBottom: '#5a3a6e', fog: { color: '#d97a4a', density: 0.015 },
      ambientBoost: 1.0, hemiSky: '#ffb07a', hemiGround: '#3a2a2a', stars: false, tracerBoost: 1.3,
    },
    {
      key: 'ice', name: '冰原', sun: '#eaf4ff', sunIntensity: 2.6, sunPos: [10, 30, -6],
      skyTop: '#cfe6f2', skyBottom: '#eef7fc', fog: { color: '#cfe6f2', density: 0.012 },
      ambientBoost: 1.3, hemiSky: '#dff0ff', hemiGround: '#55606a', stars: false, tracerBoost: 1.0,
    },
    {
      key: 'night', name: '夜战', sun: '#7fa8ff', sunIntensity: 0.7, sunPos: [12, 24, 8],
      skyTop: '#0b1026', skyBottom: '#1a2440', fog: { color: '#0b1026', density: 0.02 },
      ambientBoost: 1.0, hemiSky: '#3b4f8a', hemiGround: '#1a1c24', stars: true, tracerBoost: 1.0,
    },
  ],
  themeOrder: [0, 0, 1, 2, 3], // stage 1,2 白昼；3 黄昏；4 冰原；5 夜战；(stage-1)%5

  // ---- 颜色（§4） -----------------------------------------------------------
  colors: {
    playerBody: '#d8a028', playerAccent: '#ffcf5e', playerTrack: '#3d3a35',
    bullet: '#ffe9b0', white: '#ffffff', red: '#ff4b3a',
    dust: 0xc9a86a, ice: 0xcfeeff, water: 0x2f7ec2,
    trail: 0xffbe55,
    scoreText: '#ffd23f',
  },
};

// ---------------------------------------------------------------------------
// G — 运行期全局。模块初始化函数里可安全引用，运行时按调用时读取。
// ---------------------------------------------------------------------------
const G = {
  state: 'BOOT',        // LOADING / TITLE / HELP / SETTINGS / INTRO / PLAYING / PAUSED / TALLY / GAMEOVER
  mode: 'single',       // 'single' | 'duo'
  stage: 1,
  score: 0,
  hiScore: 0,
  theme: 0,
  time: 0,              // 游戏逻辑累计时间（仅 PLAYING 推进）
  timeScale: 1,
  paused: false,
  isTitle: false,
  slowmo: { scale: 1, remain: 0 },

  renderer: null,
  scene: null,
  camera: null,
  composer: null,
  bloomPass: null,
  fxaaPass: null,
  titleStage: null,

  world: null,
  fx: null,
  input: null,

  players: [],
  player: null,
  enemies: [],
  bullets: [],
  powerups: [],

  settings: {
    master: 80, music: 60, sfx: 80,
    quality: 'high', view: 'follow', scanline: true, shake: true,
  },
  quality: 'high',
  stats: {
    enemiesLeft: 0,
    remainingByType: { basic: 0, fast: 0, power: 0, armor: 0 },
    kills: { basic: 0, fast: 0, power: 0, armor: 0 },
    fps: 60,
    lowFpsTime: 0,
    degradeToastShown: false,
    startTime: 0,
  },
  // 本关运行时（由 Game 填充）
  level: {
    rows: null,
    queue: [],
    spawned: 0,
    killed: 0,
    carriersLeft: 0,
    cleared: false,
    tally: null,
    spawnTimer: 0,
    spawnPointIndex: 0,
    active: false,
  },
  // 道具状态（多种可叠加）
  effects: {
    shield: 0, shieldTotal: 0,
    freeze: 0, freezeTotal: 0,
    shovel: 0, shovelTotal: 0,
  },
};

// 道具图标元数据（UI/HUD 与实体共用）
const POWERUP_META = {
  star:    { name: '火力', desc: '火力 +1（上限 3）' },
  grenade: { name: '手雷', desc: '全屏敌军爆炸' },
  helmet:  { name: '头盔', desc: '护盾 10 秒' },
  timer:   { name: '定时器', desc: '敌军冻结 8 秒' },
  shovel:  { name: '铁锹', desc: '基地护墙变钢 15 秒' },
  tank:    { name: '坦克', desc: '生命 +1' },
};
