// ============================================================================
// 60-levels.js — LEVELS：五张内置地图、随机图生成、连通性校验（规格书 §2/§3）
// 顶层唯一名字：LEVELS。纯字符串/数组运算，不依赖 THREE，控制台无输出。
// 地图单位为“块”（13×13），块坐标 (c,r)，c 向右、r 向下，均从 0 开始。
// ============================================================================
const LEVELS = (() => {
  'use strict';

  // ---- §3 五张内置地图（逐字符照抄，13 行 × 13 字符） -----------------------
  const MAPS = [
    // 地图1·经典开局
    [
      '.............',
      '.B.B.B.B.B.B.',
      '.B.B.B.B.B.B.',
      '.B.B.BSB.B.B.',
      '.B.B.B.B.B.B.',
      '.B.B.B.B.B.B.',
      '......B......',
      'BB.B..B..B.BB',
      '.............',
      '.B.B.BBB.B.B.',
      '.B.B.....B.B.',
      '.B...BBB...B.',
      '.....BEB.....',
    ],
    // 地图2·渡河作战
    [
      '.............',
      '.BB.B..B.BB..',
      '.BB.B.SS.B.B.',
      '....B....B...',
      'WWWWWW..WWWWW',
      'WWWWWW..WWWWW',
      '....B....B...',
      '.BB.B.BB.B.B.',
      '.BB.B.BB.B.B.',
      '....B....B...',
      '.SB........BS',
      '..B.BBBBB.B..',
      '.....BEB.....',
    ],
    // 地图3·钢铁丛林
    [
      '.............',
      '.B.TT.T.TT.B.',
      '.B.TT...TT.B.',
      '....S.B.S....',
      'TT...BBB...TT',
      'TT..B...B..TT',
      '..B...S...B..',
      'TT..B...B..TT',
      'TT...BBB...TT',
      '....S.B.S....',
      '.B.TT...TT.B.',
      '.B.TTBBBTT.B.',
      '.....BEB.....',
    ],
    // 地图4·冰原突袭
    [
      '.............',
      '..II.....II..',
      '.BBIIB.BIIBB.',
      '..II.....II..',
      '......B......',
      '.SSB.....BSS.',
      '....II.II....',
      '.BB.III.I.BB.',
      '....II.II....',
      '.B...BBB...B.',
      '.B.B.....B.B.',
      '.B.BBBBBBB.B.',
      '.....BEB.....',
    ],
    // 地图5·最终要塞
    [
      '.............',
      'SSS..B.B..SSS',
      '...B.B.B.B...',
      '.B.B.SSS.B.B.',
      '.B.B.....B.B.',
      '...B.....B...',
      '.W.B.BBB.B.W.',
      '.W...B.B...W.',
      '..B..B.B..B..',
      '.B.BB...BB.B.',
      '.B...B.B...B.',
      '.B...BBB...B.',
      '.....BEB.....',
    ],
  ];

  // ---- §2/§3 固定块坐标与字符规则 -------------------------------------------
  const SIZE = 13;                                   // 13×13 块
  const SPAWN_BLOCKS = [                             // 敌方三处 + 玩家两处
    [0, 0], [6, 0], [12, 0], [4, 12], [8, 12],
  ];
  const PLAYER_SPAWN_BLOCKS = [[4, 12], [8, 12]];    // 其 3×3 邻域随机图保留
  const EAGLE_BLOCK = [6, 12];                       // 鹰徽固定位
  const GUARD_BLOCKS = [                             // 五块护卫砖固定位
    [5, 11], [6, 11], [7, 11], [5, 12], [7, 12],
  ];
  const OPEN_CHARS = { '.': true, 'T': true, 'I': true }; // §3 连通性判定中的开放格
  const VALID_CHARS = {
    '.': true, 'B': true, 'S': true, 'W': true, 'T': true, 'I': true, 'E': true,
  };
  const NEIGHBORS4 = [[0, -1], [1, 0], [0, 1], [-1, 0]]; // 正交四邻
  const THEME_ORDER = [0, 0, 1, 2, 3];               // §4 (stage-1)%5：白昼/白昼/黄昏/冰原/夜战

  // §3 随机图数量范围（单位：块，按整张成品图统计）与失败重试上限。
  // 砖的随机撒布量取 7–13，加上固定 5 块护卫砖后全图砖数为 12–18。
  const RANDOM_RULES = {
    attempts: 50,
    bricks: [7, 13],
    steel: [2, 5],
    water: [0, 8],
    trees: [0, 6],
    ice: [0, 8],
  };

  // ---- 基础工具 --------------------------------------------------------------
  function normalizeStage(stage) {
    const n = Math.floor(Number(stage));
    return Number.isFinite(n) && n >= 1 ? n : 1;
  }

  function randInt(min, max) {
    return min + Math.floor(Math.random() * (max - min + 1));
  }

  function inBounds(c, r) {
    return c >= 0 && r >= 0 && c < SIZE && r < SIZE;
  }

  // 将单行字符串的 c 列替换为 ch（长度按 13 处理）
  function setChar(row, c, ch) {
    return row.slice(0, c) + ch + row.slice(c + 1);
  }

  // 规范化成 13 个长度 13 的字符串；缺行/短行用 '.' 补齐，超长截断
  function copyRows(rows) {
    const out = new Array(SIZE);
    for (let r = 0; r < SIZE; r++) {
      const raw = rows && typeof rows[r] === 'string' ? rows[r] : '';
      out[r] = raw.length >= SIZE ? raw.slice(0, SIZE) : raw.padEnd(SIZE, '.');
    }
    return out;
  }

  function emptyRows() {
    const rows = new Array(SIZE);
    for (let r = 0; r < SIZE; r++) rows[r] = '.'.repeat(SIZE);
    return rows;
  }

  // ---- 连通性校验 ------------------------------------------------------------
  // 从 (startC,startR) 洪泛开放格（'.'/'T'/'I'），返回 Uint8Array 标记位图。
  function floodOpen(rows, startC, startR) {
    const reach = new Uint8Array(SIZE * SIZE);
    if (!inBounds(startC, startR)) return reach;
    if (!OPEN_CHARS[rows[startR][startC]]) return reach;
    const startIndex = startR * SIZE + startC;
    reach[startIndex] = 1;
    const stack = [startIndex];
    while (stack.length > 0) {
      const index = stack.pop();
      const r = (index / SIZE) | 0;
      const c = index % SIZE;
      for (let k = 0; k < NEIGHBORS4.length; k++) {
        const nc = c + NEIGHBORS4[k][0];
        const nr = r + NEIGHBORS4[k][1];
        if (!inBounds(nc, nr)) continue;
        const ni = nr * SIZE + nc;
        if (reach[ni]) continue;
        if (!OPEN_CHARS[rows[nr][nc]]) continue;
        reach[ni] = 1;
        stack.push(ni);
      }
    }
    return reach;
  }

  // §3 校验：结构合法、五出生块为 '.' 且与 (0,0) 连通、护卫墙有正交开放邻格。
  function validate(rows) {
    const reasons = [];
    if (!Array.isArray(rows)) {
      return { ok: false, reasons: ['地图必须是 13 行字符串数组'] };
    }
    if (rows.length !== SIZE) {
      return { ok: false, reasons: [`地图行数必须为 ${SIZE}，实际为 ${rows.length}`] };
    }

    let shapeOk = true;
    for (let r = 0; r < SIZE; r++) {
      const row = rows[r];
      if (typeof row !== 'string') {
        reasons.push(`第 ${r + 1} 行必须是字符串`);
        shapeOk = false;
        continue;
      }
      if (row.length !== SIZE) {
        reasons.push(`第 ${r + 1} 行长度必须为 ${SIZE}，实际为 ${row.length}`);
        shapeOk = false;
        continue;
      }
      for (let c = 0; c < SIZE; c++) {
        if (!VALID_CHARS[row[c]]) {
          reasons.push(`第 ${r + 1} 行第 ${c + 1} 列出现非法字符 '${row[c]}'`);
          shapeOk = false;
          break;
        }
      }
    }
    if (!shapeOk) {
      return { ok: false, reasons };
    }

    // ① 五个出生块必须为 '.'（空地）
    for (let i = 0; i < SPAWN_BLOCKS.length; i++) {
      const c = SPAWN_BLOCKS[i][0];
      const r = SPAWN_BLOCKS[i][1];
      if (rows[r][c] !== '.') {
        reasons.push(`出生块 (${c},${r}) 必须为 '.'，实际为 '${rows[r][c]}'`);
      }
    }

    // ② 洪泛：五出生块必须与 (0,0) 处于同一开放连通域
    const reach = floodOpen(rows, SPAWN_BLOCKS[0][0], SPAWN_BLOCKS[0][1]);
    for (let i = 0; i < SPAWN_BLOCKS.length; i++) {
      const c = SPAWN_BLOCKS[i][0];
      const r = SPAWN_BLOCKS[i][1];
      if (!reach[r * SIZE + c]) {
        reasons.push(`出生块 (${c},${r}) 与 (0,0) 不连通`);
      }
    }

    // ③ 至少一个开放格与五块护卫墙正交相邻
    let guardReachable = false;
    for (let i = 0; i < GUARD_BLOCKS.length && !guardReachable; i++) {
      const gc = GUARD_BLOCKS[i][0];
      const gr = GUARD_BLOCKS[i][1];
      for (let k = 0; k < NEIGHBORS4.length; k++) {
        const c = gc + NEIGHBORS4[k][0];
        const r = gr + NEIGHBORS4[k][1];
        if (!inBounds(c, r)) continue;
        if (OPEN_CHARS[rows[r][c]]) {
          guardReachable = true;
          break;
        }
      }
    }
    if (!guardReachable) {
      reasons.push('没有开放格与基地护卫墙正交相邻');
    }

    return { ok: reasons.length === 0, reasons };
  }

  // ---- 解析 ------------------------------------------------------------------
  // 返回 { grid: string[13][13], counts }；counts 按地形字符统计块数。
  function parse(rows) {
    const normalized = copyRows(rows);
    const counts = {
      bricks: 0, steel: 0, water: 0, trees: 0, ice: 0, eagle: 0, empty: 0,
      total: SIZE * SIZE,
    };
    const grid = new Array(SIZE);
    for (let r = 0; r < SIZE; r++) {
      const line = new Array(SIZE);
      const source = normalized[r];
      for (let c = 0; c < SIZE; c++) {
        const ch = source[c];
        line[c] = ch;
        switch (ch) {
          case 'B': counts.bricks++; break;
          case 'S': counts.steel++; break;
          case 'W': counts.water++; break;
          case 'T': counts.trees++; break;
          case 'I': counts.ice++; break;
          case 'E': counts.eagle++; break;
          default: counts.empty++; break;
        }
      }
      grid[r] = line;
    }
    return { grid, counts };
  }

  // ---- 固定形状：鹰徽 + 五块护卫砖 ------------------------------------------
  // 随机图与外部调用共用；不修改入参，返回新的 13 行副本。
  function placeGuard(rows) {
    const out = copyRows(rows);
    out[EAGLE_BLOCK[1]] = setChar(out[EAGLE_BLOCK[1]], EAGLE_BLOCK[0], 'E');
    for (let i = 0; i < GUARD_BLOCKS.length; i++) {
      const c = GUARD_BLOCKS[i][0];
      const r = GUARD_BLOCKS[i][1];
      out[r] = setChar(out[r], c, 'B');
    }
    return out;
  }

  // ---- §3 随机图（第 6 关起） -------------------------------------------------
  // 保留出生点、鹰徽、护卫砖、玩家出生点 3×3 邻域后随机撒布；
  // 生成结果必须 validate.ok 才返回，最多尝试 50 次，仍失败回退地图 1。
  function generateRandom() {
    const rows = emptyRows();
    const reserved = new Uint8Array(SIZE * SIZE);
    const reserve = (c, r) => {
      if (inBounds(c, r)) reserved[r * SIZE + c] = 1;
    };

    for (let i = 0; i < SPAWN_BLOCKS.length; i++) {
      reserve(SPAWN_BLOCKS[i][0], SPAWN_BLOCKS[i][1]);
    }
    for (let i = 0; i < PLAYER_SPAWN_BLOCKS.length; i++) {
      const pc = PLAYER_SPAWN_BLOCKS[i][0];
      const pr = PLAYER_SPAWN_BLOCKS[i][1];
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) reserve(pc + dc, pr + dr);
      }
    }
    for (let i = 0; i < GUARD_BLOCKS.length; i++) {
      reserve(GUARD_BLOCKS[i][0], GUARD_BLOCKS[i][1]);
    }
    reserve(EAGLE_BLOCK[0], EAGLE_BLOCK[1]);

    const candidates = [];
    for (let r = 0; r < SIZE; r++) {
      for (let c = 0; c < SIZE; c++) {
        if (!reserved[r * SIZE + c]) candidates.push([c, r]);
      }
    }
    // Fisher–Yates 洗牌，保证每块位置等概率
    for (let i = candidates.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = candidates[i];
      candidates[i] = candidates[j];
      candidates[j] = tmp;
    }

    const plan = [
      ['B', randInt(RANDOM_RULES.bricks[0], RANDOM_RULES.bricks[1])],
      ['S', randInt(RANDOM_RULES.steel[0], RANDOM_RULES.steel[1])],
      ['W', randInt(RANDOM_RULES.water[0], RANDOM_RULES.water[1])],
      ['T', randInt(RANDOM_RULES.trees[0], RANDOM_RULES.trees[1])],
      ['I', randInt(RANDOM_RULES.ice[0], RANDOM_RULES.ice[1])],
    ];
    let index = 0;
    for (let p = 0; p < plan.length; p++) {
      const ch = plan[p][0];
      const count = plan[p][1];
      for (let k = 0; k < count && index < candidates.length; k++, index++) {
        const cell = candidates[index];
        rows[cell[1]] = setChar(rows[cell[1]], cell[0], ch);
      }
    }

    return placeGuard(rows);
  }

  function random(stage) {
    // stage 参数按契约保留；§3 未要求随机图数量随关数变化，主题由 themeOf 决定。
    void stage;
    for (let attempt = 0; attempt < RANDOM_RULES.attempts; attempt++) {
      const rows = generateRandom();
      if (validate(rows).ok) return rows;
    }
    return copyRows(MAPS[0]); // §3 回退地图 1
  }

  // ---- 对外接口 --------------------------------------------------------------
  // 1..5 返回固定图副本；6+ 返回随机图（随机图内部已保证连通校验）。
  function build(stage) {
    const s = normalizeStage(stage);
    if (s <= MAPS.length) return copyRows(MAPS[s - 1]);
    return random(s);
  }

  // §4 主题：stage 1,2 白昼；3 黄昏；4 冰原；5 夜战；之后按 (stage-1)%5 循环。
  function themeOf(stage) {
    const s = normalizeStage(stage);
    const order = (typeof CONFIG !== 'undefined' && CONFIG && Array.isArray(CONFIG.themeOrder)
      && CONFIG.themeOrder.length === THEME_ORDER.length)
      ? CONFIG.themeOrder
      : THEME_ORDER;
    return order[(s - 1) % order.length];
  }

  return {
    MAPS,
    build,
    random,
    validate,
    themeOf,
    parse,
    placeGuard,
  };
})();
