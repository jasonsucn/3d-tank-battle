// ============================================================================
// 02-utils.js — 方向常量、地形编码、数学/存储工具（规格书 §2/§8）
// ============================================================================

// 四方向：up 对应 -Z（屏幕上），right 对应 +X
const DIRS = {
  up:    { x: 0,  z: -1, angle: 0,             axis: 'z', opposite: 'down'  },
  right: { x: 1,  z: 0,  angle: -Math.PI / 2,  axis: 'x', opposite: 'left'  },
  down:  { x: 0,  z: 1,  angle: Math.PI,       axis: 'z', opposite: 'up'    },
  left:  { x: -1, z: 0,  angle: Math.PI / 2,   axis: 'x', opposite: 'right' },
};
const DIR_LIST = ['up', 'right', 'down', 'left'];
const DIR_BY_DELTA = {
  '0,-1': 'up', '1,0': 'right', '0,1': 'down', '-1,0': 'left',
};

// 地形编码（单位格）
const TILES = {
  EMPTY: 0,
  BRICK: 1,
  STEEL: 2,
  WATER: 3,
  TREE: 4,
  ICE: 5,
  EAGLE: 6,
};
const TILE_CHARS = {
  '.': TILES.EMPTY, 'B': TILES.BRICK, 'S': TILES.STEEL, 'W': TILES.WATER,
  'T': TILES.TREE, 'I': TILES.ICE, 'E': TILES.EAGLE,
};
const SOLID_FOR_TANK = { [TILES.BRICK]: true, [TILES.STEEL]: true, [TILES.WATER]: true, [TILES.EAGLE]: true };
const BLOCKS_BULLET = { [TILES.BRICK]: true, [TILES.STEEL]: true, [TILES.EAGLE]: true };

const UTILS = {
  clamp(v, a, b) { return v < a ? a : (v > b ? b : v); },
  clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); },
  lerp(a, b, t) { return a + (b - a) * t; },
  invLerp(a, b, v) { return a === b ? 0 : (v - a) / (b - a); },
  // 帧率无关阻尼：1 - exp(-k*dt)
  damp(current, target, lambda, dt) { return UTILS.lerp(current, target, 1 - Math.exp(-lambda * dt)); },
  smoothstep(a, b, x) {
    const t = UTILS.clamp01((x - a) / (b - a || 1e-6));
    return t * t * (3 - 2 * t);
  },
  easeOutCubic(t) { const u = 1 - UTILS.clamp01(t); return 1 - u * u * u; },
  easeInCubic(t) { const u = UTILS.clamp01(t); return u * u * u; },
  easeOutBack(t) {
    const c1 = 1.70158, c3 = c1 + 1, u = UTILS.clamp01(t) - 1;
    return 1 + c3 * u * u * u + c1 * u * u;
  },
  rand(a, b) { return a + Math.random() * (b - a); },
  randInt(a, b) { return Math.floor(UTILS.rand(a, b + 1)); },
  chance(p) { return Math.random() < p; },
  choice(arr) { return arr[Math.floor(Math.random() * arr.length)]; },
  shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  },
  weightedPick(items, weights) {
    let total = 0;
    for (let i = 0; i < weights.length; i++) total += Math.max(0, weights[i]);
    if (total <= 0) return items[0];
    let r = Math.random() * total;
    for (let i = 0; i < items.length; i++) {
      r -= Math.max(0, weights[i]);
      if (r <= 0) return items[i];
    }
    return items[items.length - 1];
  },
  // 角度差归一化到 [-π, π]
  angleDelta(a, b) {
    let d = (b - a) % (Math.PI * 2);
    if (d > Math.PI) d -= Math.PI * 2;
    if (d < -Math.PI) d += Math.PI * 2;
    return d;
  },
  angleLerp(a, b, t) { return a + UTILS.angleDelta(a, b) * UTILS.clamp01(t); },
  // 安全归一化：零向量返回 {x:0,y:0,z:0}
  normalize2(x, z) {
    const len = Math.hypot(x, z);
    if (len < 1e-6) return { x: 0, z: 0, len: 0 };
    return { x: x / len, z: z / len, len };
  },
  snapAxis(v) { return Math.round(v / 2) * 2; },
  pad(n, len) { return String(Math.max(0, Math.floor(n))).padStart(len, '0'); },
  formatScore(n) { return UTILS.pad(n, 7); },
  // 世界 ↔ 单位格
  cellCenter(i) { return i - 12.5; },
  blockCenter(c) { return (c - 6) * 2; },
  worldToCell(v) { return Math.floor(v + 13); },
  cellOf(x, z) { return { i: UTILS.worldToCell(x), j: UTILS.worldToCell(z) }; },
  blockOfCell(i) { return { c: Math.floor(i / 2), r: Math.floor(i / 2) }; },
  cellInBounds(i, j) { return i >= 0 && j >= 0 && i < 26 && j < 26; },
  distance2(ax, az, bx, bz) { return Math.hypot(ax - bx, az - bz); },
  // 是否有可用的 WebGL
  hasWebGL() {
    try {
      const c = document.createElement('canvas');
      return !!(window.WebGL2RenderingContext && (c.getContext('webgl2') || c.getContext('webgl')));
    } catch (e) { return false; }
  },
  deepMerge(base, patch) {
    const out = Array.isArray(base) ? base.slice() : Object.assign({}, base);
    if (!patch || typeof patch !== 'object') return out;
    for (const k of Object.keys(patch)) {
      const v = patch[k];
      if (v && typeof v === 'object' && !Array.isArray(v) && base && typeof base[k] === 'object' && !Array.isArray(base[k])) {
        out[k] = UTILS.deepMerge(base[k], v);
      } else {
        out[k] = v;
      }
    }
    return out;
  },
};

// 本地存储（不可用时降级内存，规格书 §8）
const Store = (() => {
  const memory = {};
  let available = true;
  try {
    const k = '__bc3d_probe__';
    window.localStorage.setItem(k, '1');
    window.localStorage.removeItem(k);
  } catch (e) { available = false; }
  return {
    get available() { return available; },
    read(key, fallback) {
      try {
        if (available) {
          const raw = window.localStorage.getItem(key);
          if (raw === null) return fallback;
          return JSON.parse(raw);
        }
      } catch (e) { /* 解析失败走默认值 */ }
      return key in memory ? memory[key] : fallback;
    },
    write(key, value) {
      memory[key] = value;
      try { if (available) window.localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* 存储满/被禁用时静默 */ }
    },
  };
})();
