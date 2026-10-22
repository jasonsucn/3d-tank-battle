// ============================================================================
// 11-textures.js — Tex：全部 Canvas 程序化贴图（规格书 §4；契约 §5）
// 无任何外部图片；顶层只声明 const Tex，辅助函数全部包在 IIFE 内。
// 通用贴图 256²；道具面板 128×256。全部颜色贴图 colorSpace = SRGBColorSpace。
// 说明：Canvas 绘制使用原始 sRGB 十六进制颜色，交给渲染器前由贴图色彩空间统一处理。
// ============================================================================
const Tex = (() => {
  'use strict';

  const SIZE = 256;          // 通用贴图边长
  const PANEL_W = 128;       // 道具面板宽
  const PANEL_H = 256;       // 道具面板高
  const TAU = Math.PI * 2;
  const ANISO = (typeof CONFIG !== 'undefined' && CONFIG.render && CONFIG.render.anisotropy)
    ? CONFIG.render.anisotropy
    : 4;

  let built = false;
  const T = { panel: {} };

  // -------------------------------------------------------------------------
  // 基础工具：确定性随机 / Canvas / 纹理包装 / 路径
  // -------------------------------------------------------------------------
  let seed = 0x3c6ef372;
  function resetSeed(v) { seed = v | 0; }
  function rand() {
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  function randRange(a, b) { return a + rand() * (b - a); }
  function randInt(a, b) { return Math.floor(randRange(a, b + 1)); }
  function chance(p) { return rand() < p; }
  function clampByte(v) { return v < 0 ? 0 : (v > 255 ? 255 : Math.round(v)); }

  function canvas(w, h) {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  }
  function getCtx(c) {
    const ctx = c.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D 不可用，无法生成程序化贴图');
    return ctx;
  }

  function cssColor(color) {
    if (typeof color === 'number') return '#' + color.toString(16).padStart(6, '0');
    return String(color);
  }
  function rgba(color, alpha) {
    const n = typeof color === 'number' ? color : parseInt(String(color).replace('#', ''), 16);
    const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    return 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')';
  }

  // CanvasTexture 统一包装：sRGB、各向异性、按用途决定 Repeat/Clamp 与 mipmap
  function makeTexture(cv, opt) {
    const o = opt || {};
    const tx = new THREE.CanvasTexture(cv);
    tx.name = o.name || 'canvas';
    tx.colorSpace = THREE.SRGBColorSpace;
    const wrap = o.repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
    tx.wrapS = wrap;
    tx.wrapT = wrap;
    tx.anisotropy = ANISO;
    if (o.mipmaps === false) {
      tx.generateMipmaps = false;
      tx.minFilter = THREE.LinearFilter;
      tx.magFilter = THREE.LinearFilter;
    } else {
      tx.generateMipmaps = true;
      tx.minFilter = THREE.LinearMipmapLinearFilter;
      tx.magFilter = THREE.LinearFilter;
    }
    tx.needsUpdate = true;
    return tx;
  }

  function roundedRectPath(ctx, x, y, w, h, r) {
    const rr = Math.min(r, w * 0.5, h * 0.5);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.lineTo(x + w - rr, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
    ctx.lineTo(x + w, y + h - rr);
    ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
    ctx.lineTo(x + rr, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
    ctx.lineTo(x, y + rr);
    ctx.quadraticCurveTo(x, y, x + rr, y);
    ctx.closePath();
  }

  function starPath(ctx, cx, cy, outer, inner, spikes, rot) {
    ctx.beginPath();
    const total = spikes * 2;
    for (let i = 0; i < total; i++) {
      const r = (i % 2 === 0) ? outer : inner;
      const a = rot + (i / total) * TAU;
      const x = cx + Math.cos(a) * r;
      const y = cy + Math.sin(a) * r;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
  }

  // 有机斑块路径（迷彩、土斑等）
  function blobPath(ctx, cx, cy, radius, rough, points) {
    const n = points || 11;
    const pts = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU;
      const r = radius * (1 - rough * 0.5 + rand() * rough);
      pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r * randRange(0.78, 1.12)]);
    }
    const mid = (a, b) => [(a[0] + b[0]) * 0.5, (a[1] + b[1]) * 0.5];
    const start = mid(pts[n - 1], pts[0]);
    ctx.beginPath();
    ctx.moveTo(start[0], start[1]);
    for (let i = 0; i < n; i++) {
      const cur = pts[i];
      const nxt = pts[(i + 1) % n];
      const m = mid(cur, nxt);
      ctx.quadraticCurveTo(cur[0], cur[1], m[0], m[1]);
    }
    ctx.closePath();
  }

  function noiseSpecks(ctx, w, h, count, colors, sizeMin, sizeMax, alphaMin, alphaMax) {
    for (let i = 0; i < count; i++) {
      const x = rand() * w;
      const y = rand() * h;
      const s = randRange(sizeMin, sizeMax);
      ctx.globalAlpha = randRange(alphaMin, alphaMax);
      ctx.fillStyle = colors[randInt(0, colors.length - 1)];
      ctx.beginPath();
      ctx.ellipse(x, y, s, s * randRange(0.55, 1.25), rand() * TAU, 0, TAU);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  // -------------------------------------------------------------------------
  // §4 地面： #1a1714 碎石 + 26×26 淡网格 #26221e + 轮胎痕 / 弹坑
  // -------------------------------------------------------------------------
  function drawTireTrack(ctx, baseY, amp, phase, width) {
    const pts = [];
    for (let x = -8; x <= SIZE + 8; x += 4) {
      const y = baseY
        + Math.sin(x * 0.032 + phase) * amp
        + Math.sin(x * 0.081 + phase * 2) * amp * 0.25;
      pts.push([x, y]);
    }
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    for (let i = 0; i < pts.length; i++) {
      if (i === 0) ctx.moveTo(pts[i][0], pts[i][1]);
      else ctx.lineTo(pts[i][0], pts[i][1]);
    }
    ctx.strokeStyle = 'rgba(4,3,2,0.30)';
    ctx.lineWidth = width;
    ctx.stroke();
    ctx.strokeStyle = 'rgba(86,74,58,0.16)';
    ctx.lineWidth = Math.max(1, width * 0.28);
    ctx.stroke();
    // 履齿压痕
    for (let i = 1; i < pts.length; i += 2) {
      const x = pts[i][0], y = pts[i][1];
      ctx.strokeStyle = 'rgba(6,5,4,0.32)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x - 1, y - width * 0.45);
      ctx.lineTo(x + 1, y + width * 0.45);
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawCrater(ctx, x, y, r) {
    ctx.save();
    const g = ctx.createRadialGradient(x, y, r * 0.05, x, y, r);
    g.addColorStop(0, 'rgba(3,3,2,0.90)');
    g.addColorStop(0.45, 'rgba(9,8,6,0.78)');
    g.addColorStop(0.72, 'rgba(38,32,26,0.52)');
    g.addColorStop(0.90, 'rgba(74,64,52,0.20)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.ellipse(x, y, r, r * 0.86, randRange(-0.4, 0.4), 0, TAU);
    ctx.fill();
    // 坑沿碎土
    for (let i = 0; i < 14; i++) {
      const a = rand() * TAU;
      const d = r * randRange(0.72, 1.08);
      ctx.fillStyle = chance(0.5) ? 'rgba(74,64,51,0.45)' : 'rgba(18,15,12,0.55)';
      ctx.beginPath();
      ctx.ellipse(
        x + Math.cos(a) * d,
        y + Math.sin(a) * d * 0.86,
        randRange(1, 3.5),
        randRange(0.8, 2.2),
        a, 0, TAU
      );
      ctx.fill();
    }
    // 灼烧内圈
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.ellipse(x, y, r * 0.62, r * 0.55, 0, 0, TAU);
    ctx.stroke();
    ctx.restore();
  }

  function makeGroundCanvas() {
    resetSeed(0x51ed270b);
    const c = canvas(SIZE, SIZE);
    const ctx = getCtx(c);
    ctx.fillStyle = '#1a1714';
    ctx.fillRect(0, 0, SIZE, SIZE);

    // 大面积土色/阴影起伏
    for (let i = 0; i < 34; i++) {
      const x = rand() * SIZE, y = rand() * SIZE, r = randRange(20, 90);
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, chance(0.5) ? 'rgba(52,46,39,0.28)' : 'rgba(6,5,4,0.30)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, TAU);
      ctx.fill();
    }

    // 碎石颗粒
    const stones = ['#2a251f', '#373129', '#211d18', '#403930', '#12100d', '#4a4135'];
    noiseSpecks(ctx, SIZE, SIZE, 3000, stones, 0.5, 2.4, 0.18, 0.62);
    // 少量反光石粒
    ctx.globalAlpha = 0.35;
    ctx.fillStyle = '#5d5345';
    for (let i = 0; i < 90; i++) ctx.fillRect(rand() * SIZE, rand() * SIZE, 1, 1);
    ctx.globalAlpha = 1;

    // 26×26 淡网格线（单位格边界，颜色 #26221e）
    const step = SIZE / 26;
    ctx.strokeStyle = '#26221e';
    ctx.lineWidth = 1;
    for (let i = 0; i < 26; i++) {
      const p = Math.round(i * step) + 0.5;
      ctx.beginPath(); ctx.moveTo(p, 0); ctx.lineTo(p, SIZE); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, p); ctx.lineTo(SIZE, p); ctx.stroke();
    }
    // 网格交点的轻微磨损
    ctx.fillStyle = 'rgba(64,57,48,0.32)';
    for (let i = 0; i < 26; i++) {
      for (let j = 0; j < 26; j++) {
        if (!chance(0.16)) continue;
        const px = Math.round(i * step) + randRange(-1.5, 1.5);
        const py = Math.round(j * step) + randRange(-1.5, 1.5);
        ctx.fillRect(px, py, 1, 1);
      }
    }

    // 轮胎痕（两条平行、轻微 S 弯）
    drawTireTrack(ctx, 84, 10, 1.7, 12);
    drawTireTrack(ctx, 106, 10, 1.7, 12);
    drawTireTrack(ctx, 196, 7, 4.2, 10);
    drawTireTrack(ctx, 214, 7, 4.2, 10);

    // 弹坑
    drawCrater(ctx, 78, 196, 25);
    drawCrater(ctx, 184, 68, 17);
    drawCrater(ctx, 218, 206, 12);
    drawCrater(ctx, 40, 38, 9);

    // 干裂纹
    ctx.strokeStyle = 'rgba(30,26,21,0.5)';
    ctx.lineWidth = 1;
    for (let i = 0; i < 10; i++) {
      let x = rand() * SIZE, y = rand() * SIZE;
      ctx.beginPath();
      ctx.moveTo(x, y);
      for (let s = 0; s < 4; s++) {
        x += randRange(-12, 12);
        y += randRange(-10, 10);
        ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    return c;
  }

  // -------------------------------------------------------------------------
  // §4 砖： #b3552e 底 + 错缝砖缝 #6b3220 + 烧灼噪点
  // -------------------------------------------------------------------------
  function drawBrick(ctx, x, y, w, h) {
    const k = randRange(0.84, 1.14);
    ctx.fillStyle = 'rgb(' + clampByte(179 * k) + ',' + clampByte(85 * k) + ',' + clampByte(46 * k) + ')';
    ctx.fillRect(x, y, w, h);
    // 上/左受光边
    ctx.fillStyle = 'rgba(255,190,140,0.16)';
    ctx.fillRect(x, y, w, 2);
    ctx.fillRect(x, y, 2, h);
    // 下/右阴影边
    ctx.fillStyle = 'rgba(52,16,6,0.38)';
    ctx.fillRect(x, y + h - 2, w, 2);
    ctx.fillRect(x + w - 2, y, 2, h);
    // 砖面颗粒
    for (let i = 0; i < 14; i++) {
      ctx.fillStyle = chance(0.5) ? 'rgba(255,214,172,0.10)' : 'rgba(60,20,8,0.16)';
      ctx.fillRect(x + rand() * w, y + rand() * h, randRange(1, 3), randRange(1, 2));
    }
    // 裂纹
    if (chance(0.45)) {
      ctx.strokeStyle = 'rgba(58,22,10,0.42)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      let px = x + randRange(w * 0.2, w * 0.8);
      let py = y + randRange(2, h - 4);
      ctx.moveTo(px, py);
      for (let s = 0; s < 3; s++) {
        px += randRange(-8, 8);
        py += randRange(3, 8);
        ctx.lineTo(px, py);
      }
      ctx.stroke();
    }
    // 烧焦角
    if (chance(0.22)) {
      const gx = chance(0.5) ? x : x + w;
      const gy = chance(0.5) ? y : y + h;
      const grad = ctx.createRadialGradient(gx, gy, 0, gx, gy, Math.max(w, h) * 0.72);
      grad.addColorStop(0, 'rgba(10,7,5,0.52)');
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = grad;
      ctx.fillRect(x, y, w, h);
    }
    // 少量掉角
    if (chance(0.10)) {
      const cx = x + randRange(4, w - 10);
      const cy = y + randRange(4, h - 8);
      ctx.fillStyle = '#6b3220';
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + randRange(3, 8), cy + randRange(1, 4));
      ctx.lineTo(cx + randRange(1, 5), cy + randRange(4, 8));
      ctx.closePath();
      ctx.fill();
    }
  }

  function makeBrickCanvas() {
    resetSeed(0x2545f491);
    const c = canvas(SIZE, SIZE);
    const ctx = getCtx(c);
    ctx.fillStyle = '#6b3220';
    ctx.fillRect(0, 0, SIZE, SIZE);
    // 砂浆颗粒
    noiseSpecks(ctx, SIZE, SIZE, 900, ['#4e2417', '#7d3d28', '#3a1a10'], 0.5, 1.8, 0.18, 0.5);

    const rowH = SIZE / 8;    // 32
    const brickW = SIZE / 4;  // 64
    for (let row = 0; row < 8; row++) {
      const y = row * rowH;
      const offset = (row % 2) ? brickW * 0.5 : 0;
      for (let col = -1; col < 5; col++) {
        const x = col * brickW + offset;
        // 2px 灰缝
        drawBrick(ctx, x + 2, y + 2, brickW - 4, rowH - 4);
      }
    }

    // 大面积烧灼烟熏
    for (let i = 0; i < 26; i++) {
      const x = rand() * SIZE, y = rand() * SIZE, r = randRange(5, 28);
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, 'rgba(16,9,5,' + randRange(0.16, 0.40).toFixed(3) + ')');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, TAU);
      ctx.fill();
    }
    // 炭黑颗粒
    noiseSpecks(ctx, SIZE, SIZE, 320, ['#120b07', '#24130a', '#3b2114'], 0.6, 2.2, 0.2, 0.5);
    return c;
  }

  // -------------------------------------------------------------------------
  // §4 钢： #9aa3ad 拉丝 + 四角铆钉 #5c646d
  // -------------------------------------------------------------------------
  function drawRivet(ctx, x, y, r) {
    ctx.save();
    ctx.fillStyle = 'rgba(18,22,26,0.35)';
    ctx.beginPath();
    ctx.arc(x + 1.5, y + 2, r, 0, TAU);
    ctx.fill();
    const g = ctx.createRadialGradient(x - r * 0.35, y - r * 0.4, r * 0.1, x, y, r);
    g.addColorStop(0, '#9aa3ad');
    g.addColorStop(0.5, '#5c646d');
    g.addColorStop(1, '#383e45');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.22)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(x, y, r * 0.82, Math.PI * 1.05, Math.PI * 1.85);
    ctx.stroke();
    // 十字槽
    ctx.strokeStyle = 'rgba(32,36,41,0.8)';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(x - r * 0.45, y);
    ctx.lineTo(x + r * 0.45, y);
    ctx.moveTo(x, y - r * 0.45);
    ctx.lineTo(x, y + r * 0.45);
    ctx.stroke();
    ctx.restore();
  }

  function makeSteelCanvas() {
    resetSeed(0x68e31da4);
    const c = canvas(SIZE, SIZE);
    const ctx = getCtx(c);
    ctx.fillStyle = '#9aa3ad';
    ctx.fillRect(0, 0, SIZE, SIZE);

    // 大范围拉丝明暗
    const g = ctx.createLinearGradient(0, 0, 0, SIZE);
    g.addColorStop(0, 'rgba(255,255,255,0.16)');
    g.addColorStop(0.45, 'rgba(255,255,255,0.0)');
    g.addColorStop(1, 'rgba(18,22,28,0.22)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, SIZE, SIZE);

    // 横向拉丝
    for (let i = 0; i < 1200; i++) {
      const y = rand() * SIZE;
      ctx.globalAlpha = randRange(0.03, 0.14);
      ctx.fillStyle = chance(0.5) ? '#ffffff' : '#5c646d';
      const x = rand() * SIZE;
      const w = randRange(10, SIZE * 0.9);
      ctx.fillRect(x, y, w, chance(0.85) ? 1 : 2);
    }
    ctx.globalAlpha = 1;

    // 斜向划痕
    for (let i = 0; i < 26; i++) {
      const x = rand() * SIZE;
      const y = rand() * SIZE;
      const len = randRange(8, 46);
      const a = -0.55 + randRange(-0.15, 0.15);
      ctx.strokeStyle = chance(0.6) ? 'rgba(240,245,250,0.14)' : 'rgba(40,45,52,0.18)';
      ctx.lineWidth = randRange(0.6, 1.4);
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len);
      ctx.stroke();
    }

    // 内嵌钢板边（上/左亮，下/右暗）
    ctx.strokeStyle = 'rgba(255,255,255,0.20)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(9, SIZE - 9);
    ctx.lineTo(9, 9);
    ctx.lineTo(SIZE - 9, 9);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(30,35,41,0.30)';
    ctx.beginPath();
    ctx.moveTo(SIZE - 9, 9);
    ctx.lineTo(SIZE - 9, SIZE - 9);
    ctx.lineTo(9, SIZE - 9);
    ctx.stroke();

    // 四角铆钉 #5c646d
    const rp = [[30, 30], [SIZE - 30, 30], [30, SIZE - 30], [SIZE - 30, SIZE - 30]];
    for (let i = 0; i < rp.length; i++) drawRivet(ctx, rp[i][0], rp[i][1], 8);

    // 轻微油污
    ctx.fillStyle = 'rgba(52,58,64,0.10)';
    for (let i = 0; i < 7; i++) {
      ctx.beginPath();
      ctx.ellipse(rand() * SIZE, rand() * SIZE, randRange(8, 28), randRange(4, 14), rand() * TAU, 0, TAU);
      ctx.fill();
    }
    return c;
  }

  // -------------------------------------------------------------------------
  // §4 履带： 4px 竖向履齿条纹（周期 16px，贴图可被 offset.x 滚动）
  // 同时每 32px 叠一条横向链节接缝：Models 按契约滚动 offset.y 时，
  // 接缝沿 −Y 移动，同样能看到清晰的履带运动。
  // -------------------------------------------------------------------------
  function makeTrackCanvas() {
    resetSeed(0x1b873593);
    const c = canvas(SIZE, SIZE);
    const ctx = getCtx(c);
    // 浅灰纹理：Mat.track 以 #3d3a35 着色后得到规格书要求的深色履带
    ctx.fillStyle = '#d8d8d8';
    ctx.fillRect(0, 0, SIZE, SIZE);

    // 4px 竖向履齿条纹，周期 16px
    for (let x = 0; x < SIZE; x += 16) {
      const g = ctx.createLinearGradient(x, 0, x + 4, 0);
      g.addColorStop(0, '#ffffff');
      g.addColorStop(0.55, '#e6e6e6');
      g.addColorStop(1, '#bdbdbd');
      ctx.fillStyle = g;
      ctx.fillRect(x, 0, 4, SIZE);
      ctx.fillStyle = 'rgba(130,130,130,0.50)';
      ctx.fillRect(x + 4, 0, 2, SIZE);
      ctx.fillStyle = 'rgba(255,255,255,0.30)';
      ctx.fillRect(x, 0, 1, SIZE);
    }

    // 横向链节接缝：供 offset.y 滚动，位置每 32px
    for (let y = 0; y < SIZE; y += 32) {
      ctx.fillStyle = 'rgba(118,118,118,0.62)';
      ctx.fillRect(0, y, SIZE, 3);
      ctx.fillStyle = 'rgba(255,255,255,0.36)';
      ctx.fillRect(0, y + 3, SIZE, 1);
      ctx.fillStyle = 'rgba(90,90,90,0.30)';
      ctx.fillRect(0, y + 4, SIZE, 1);
    }

    // 两侧履带边缘导轨
    ctx.fillStyle = 'rgba(150,150,150,0.55)';
    ctx.fillRect(8, 0, 5, SIZE);
    ctx.fillRect(SIZE - 13, 0, 5, SIZE);
    ctx.fillStyle = 'rgba(255,255,255,0.34)';
    ctx.fillRect(9, 0, 2, SIZE);
    ctx.fillRect(SIZE - 12, 0, 2, SIZE);

    // 磨损与锈迹
    for (let i = 0; i < 700; i++) {
      ctx.globalAlpha = randRange(0.05, 0.20);
      ctx.fillStyle = chance(0.5) ? '#8a8a8a' : '#ffffff';
      ctx.fillRect(rand() * SIZE, rand() * SIZE, randRange(1, 4), randRange(1, 2));
    }
    ctx.globalAlpha = 1;
    return c;
  }

  // -------------------------------------------------------------------------
  // §4 冰： #bfe3ef 斜刮痕
  // -------------------------------------------------------------------------
  function makeIceCanvas() {
    resetSeed(0xc2b2ae35);
    const c = canvas(SIZE, SIZE);
    const ctx = getCtx(c);
    const bg = ctx.createLinearGradient(0, 0, SIZE, SIZE);
    bg.addColorStop(0, '#c9e9f3');
    bg.addColorStop(0.5, '#bfe3ef');
    bg.addColorStop(1, '#a9d6e6');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, SIZE, SIZE);

    // 霜斑
    for (let i = 0; i < 22; i++) {
      const x = rand() * SIZE, y = rand() * SIZE, r = randRange(16, 58);
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, chance(0.5) ? 'rgba(235,250,255,0.20)' : 'rgba(150,195,212,0.18)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, TAU);
      ctx.fill();
    }

    // 斜刮痕
    for (let i = 0; i < 180; i++) {
      const x = rand() * SIZE;
      const y = rand() * SIZE;
      const len = randRange(10, 90);
      const a = -Math.PI / 3 + randRange(-0.12, 0.12);
      ctx.strokeStyle = chance(0.6)
        ? 'rgba(255,255,255,' + randRange(0.12, 0.42).toFixed(3) + ')'
        : 'rgba(120,160,180,' + randRange(0.08, 0.22).toFixed(3) + ')';
      ctx.lineWidth = randRange(0.6, 1.8);
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len);
      ctx.stroke();
    }

    // 裂纹
    for (let i = 0; i < 9; i++) {
      let x = rand() * SIZE, y = rand() * SIZE;
      ctx.strokeStyle = 'rgba(110,150,170,0.28)';
      ctx.lineWidth = randRange(0.6, 1.2);
      ctx.beginPath();
      ctx.moveTo(x, y);
      for (let s = 0; s < 4; s++) {
        x += randRange(-22, 22);
        y += randRange(-16, 16);
        ctx.lineTo(x, y);
      }
      ctx.stroke();
    }

    // 冰晶亮点
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    for (let i = 0; i < 160; i++) {
      ctx.globalAlpha = randRange(0.25, 0.75);
      ctx.fillRect(rand() * SIZE, rand() * SIZE, 1, 1);
    }
    ctx.globalAlpha = 1;
    return c;
  }

  // -------------------------------------------------------------------------
  // §4 玩家迷彩： #d8a028 底 + #b07f1e / #8a6318 斑块
  // -------------------------------------------------------------------------
  function makeCamoCanvas(dark) {
    resetSeed(0x9e3779b9); // 同一 seed 保证 camo / camoDark 图案一致
    const c = canvas(SIZE, SIZE);
    const ctx = getCtx(c);
    ctx.fillStyle = '#d8a028';
    ctx.fillRect(0, 0, SIZE, SIZE);

    // 大斑块
    for (let i = 0; i < 26; i++) {
      const cx = rand() * SIZE;
      const cy = rand() * SIZE;
      const r = randRange(22, 70);
      ctx.fillStyle = chance(0.55) ? '#b07f1e' : '#8a6318';
      blobPath(ctx, cx, cy, r, randRange(0.45, 0.95), randInt(9, 14));
      ctx.fill();
    }
    // 小斑块
    for (let i = 0; i < 40; i++) {
      const cx = rand() * SIZE;
      const cy = rand() * SIZE;
      const r = randRange(5, 16);
      ctx.fillStyle = chance(0.5) ? '#8a6318' : '#b07f1e';
      blobPath(ctx, cx, cy, r, randRange(0.4, 0.9), randInt(7, 11));
      ctx.fill();
    }
    // 涂料颗粒
    for (let i = 0; i < 1200; i++) {
      ctx.globalAlpha = randRange(0.04, 0.14);
      ctx.fillStyle = chance(0.5) ? '#f1c45c' : '#5e4210';
      ctx.fillRect(rand() * SIZE, rand() * SIZE, randRange(1, 3), randRange(1, 2));
    }
    ctx.globalAlpha = 1;
    // 边缘磨损高光
    for (let i = 0; i < 26; i++) {
      const x = rand() * SIZE, y = rand() * SIZE;
      ctx.strokeStyle = 'rgba(255,240,190,0.12)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + randRange(4, 18), y + randRange(-4, 4));
      ctx.stroke();
    }
    if (dark) {
      // 炮塔用深一档的同形迷彩
      ctx.fillStyle = 'rgba(0,0,0,0.24)';
      ctx.fillRect(0, 0, SIZE, SIZE);
    }
    return c;
  }

  // -------------------------------------------------------------------------
  // §5 粒子贴图： spark / smoke / snow / ring / star / decalShadow
  // -------------------------------------------------------------------------
  function makeSparkCanvas() {
    const c = canvas(SIZE, SIZE);
    const ctx = getCtx(c);
    const g = ctx.createRadialGradient(SIZE / 2, SIZE / 2, 0, SIZE / 2, SIZE / 2, SIZE / 2);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.16, 'rgba(255,255,255,0.98)');
    g.addColorStop(0.34, 'rgba(255,255,255,0.52)');
    g.addColorStop(0.62, 'rgba(255,255,255,0.14)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(SIZE / 2, SIZE / 2, SIZE / 2, 0, TAU);
    ctx.fill();
    return c;
  }

  function makeSmokeCanvas() {
    const c = canvas(SIZE, SIZE);
    const ctx = getCtx(c);
    // 主团
    const g = ctx.createRadialGradient(SIZE / 2, SIZE / 2, 0, SIZE / 2, SIZE / 2, SIZE * 0.46);
    g.addColorStop(0, 'rgba(255,255,255,0.85)');
    g.addColorStop(0.45, 'rgba(255,255,255,0.42)');
    g.addColorStop(0.75, 'rgba(255,255,255,0.15)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(SIZE / 2, SIZE / 2, SIZE * 0.46, 0, TAU);
    ctx.fill();
    // 边缘翻卷团块，避免过于规则
    for (let i = 0; i < 16; i++) {
      const a = rand() * TAU;
      const d = randRange(SIZE * 0.10, SIZE * 0.30);
      const x = SIZE / 2 + Math.cos(a) * d;
      const y = SIZE / 2 + Math.sin(a) * d * 0.9;
      const r = randRange(SIZE * 0.08, SIZE * 0.20);
      const sg = ctx.createRadialGradient(x, y, 0, x, y, r);
      sg.addColorStop(0, 'rgba(255,255,255,' + randRange(0.10, 0.24).toFixed(3) + ')');
      sg.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = sg;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, TAU);
      ctx.fill();
    }
    return c;
  }

  function makeSnowCanvas() {
    const c = canvas(SIZE, SIZE);
    const ctx = getCtx(c);
    const cx = SIZE / 2, cy = SIZE / 2;
    const halo = ctx.createRadialGradient(cx, cy, 0, cx, cy, SIZE * 0.48);
    halo.addColorStop(0, 'rgba(255,255,255,0.55)');
    halo.addColorStop(0.5, 'rgba(255,255,255,0.16)');
    halo.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(cx, cy, SIZE * 0.48, 0, TAU);
    ctx.fill();

    // 六角雪花
    ctx.save();
    ctx.translate(cx, cy);
    ctx.strokeStyle = 'rgba(255,255,255,0.95)';
    ctx.lineCap = 'round';
    for (let i = 0; i < 6; i++) {
      ctx.save();
      ctx.rotate(i * (Math.PI / 3)); // 每 60° 一条主枝
      ctx.lineWidth = 5;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(0, -SIZE * 0.34);
      ctx.stroke();
      ctx.lineWidth = 3.2;
      ctx.beginPath();
      ctx.moveTo(0, -SIZE * 0.16);
      ctx.lineTo(-SIZE * 0.075, -SIZE * 0.24);
      ctx.moveTo(0, -SIZE * 0.16);
      ctx.lineTo(SIZE * 0.075, -SIZE * 0.24);
      ctx.moveTo(0, -SIZE * 0.26);
      ctx.lineTo(-SIZE * 0.052, -SIZE * 0.32);
      ctx.moveTo(0, -SIZE * 0.26);
      ctx.lineTo(SIZE * 0.052, -SIZE * 0.32);
      ctx.stroke();
      ctx.restore();
    }
    ctx.fillStyle = 'rgba(255,255,255,0.95)';
    ctx.beginPath();
    ctx.arc(0, 0, 6, 0, TAU);
    ctx.fill();
    ctx.restore();
    return c;
  }

  function makeRingCanvas() {
    const c = canvas(SIZE, SIZE);
    const ctx = getCtx(c);
    const cx = SIZE / 2, cy = SIZE / 2;
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, SIZE / 2);
    g.addColorStop(0.00, 'rgba(255,255,255,0)');
    g.addColorStop(0.30, 'rgba(255,255,255,0)');
    g.addColorStop(0.38, 'rgba(255,255,255,0.18)');
    g.addColorStop(0.445, 'rgba(255,255,255,0.95)');
    g.addColorStop(0.50, 'rgba(255,255,255,0.42)');
    g.addColorStop(0.58, 'rgba(255,255,255,0.08)');
    g.addColorStop(0.72, 'rgba(255,255,255,0.03)');
    g.addColorStop(1.00, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cy, SIZE / 2, 0, TAU);
    ctx.fill();
    return c;
  }

  function makeStarCanvas() {
    const c = canvas(SIZE, SIZE);
    const ctx = getCtx(c);
    const cx = SIZE / 2, cy = SIZE / 2;
    const halo = ctx.createRadialGradient(cx, cy, 0, cx, cy, SIZE * 0.48);
    halo.addColorStop(0, 'rgba(255,255,255,0.38)');
    halo.addColorStop(0.5, 'rgba(255,255,255,0.10)');
    halo.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(cx, cy, SIZE * 0.48, 0, TAU);
    ctx.fill();

    starPath(ctx, cx, cy, SIZE * 0.40, SIZE * 0.16, 5, -Math.PI / 2);
    const sg = ctx.createRadialGradient(cx, cy, SIZE * 0.04, cx, cy, SIZE * 0.40);
    sg.addColorStop(0, '#ffffff');
    sg.addColorStop(0.55, 'rgba(255,252,232,0.98)');
    sg.addColorStop(1, 'rgba(255,226,150,0.75)');
    ctx.fillStyle = sg;
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth = 3;
    ctx.stroke();
    return c;
  }

  function makeDecalShadowCanvas() {
    const c = canvas(SIZE, SIZE);
    const ctx = getCtx(c);
    const cx = SIZE / 2, cy = SIZE / 2;
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, SIZE * 0.49);
    g.addColorStop(0, 'rgba(0,0,0,0.72)');
    g.addColorStop(0.35, 'rgba(0,0,0,0.56)');
    g.addColorStop(0.68, 'rgba(0,0,0,0.22)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cy, SIZE * 0.49, 0, TAU);
    ctx.fill();
    return c;
  }

  // -------------------------------------------------------------------------
  // §2/§4/§5 道具面板：128×256 深底 + 高饱和图标（全部 Canvas path，无 emoji）
  // -------------------------------------------------------------------------
  const PANEL_FALLBACK = {
    star: 0xffd23f,
    grenade: 0xff6b3a,
    helmet: 0x4adfff,
    timer: 0x7aa2ff,
    shovel: 0xffb02e,
    tank: 0x6cff8a,
  };

  function panelAccent(kind) {
    if (typeof CONFIG !== 'undefined' && CONFIG.powerup && CONFIG.powerup.color) {
      const c = CONFIG.powerup.color[kind];
      if (typeof c === 'number') return c;
    }
    return PANEL_FALLBACK[kind] || 0xffd23f;
  }

  function panelHalo(ctx, accent, cx, cy, radius) {
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
    g.addColorStop(0, rgba(accent, 0.38));
    g.addColorStop(0.55, rgba(accent, 0.15));
    g.addColorStop(1, rgba(accent, 0));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, TAU);
    ctx.fill();
  }

  function panelBase(ctx, accent) {
    ctx.clearRect(0, 0, PANEL_W, PANEL_H);

    // 卡片外发光
    const glow = ctx.createRadialGradient(64, 118, 4, 64, 118, 88);
    glow.addColorStop(0, rgba(accent, 0.30));
    glow.addColorStop(0.55, rgba(accent, 0.10));
    glow.addColorStop(1, rgba(accent, 0));
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, PANEL_W, PANEL_H);

    // 深底圆角卡片
    roundedRectPath(ctx, 7, 7, PANEL_W - 14, PANEL_H - 14, 16);
    const bg = ctx.createLinearGradient(0, 7, 0, PANEL_H - 7);
    bg.addColorStop(0, '#162233');
    bg.addColorStop(0.42, '#0a1119');
    bg.addColorStop(1, '#05080d');
    ctx.fillStyle = bg;
    ctx.fill();

    // 卡内扫描线 + 顶部色光
    ctx.save();
    roundedRectPath(ctx, 7, 7, PANEL_W - 14, PANEL_H - 14, 16);
    ctx.clip();
    for (let y = 10; y < PANEL_H - 8; y += 4) {
      ctx.fillStyle = 'rgba(255,255,255,0.024)';
      ctx.fillRect(8, y, PANEL_W - 16, 1);
    }
    const top = ctx.createLinearGradient(0, 7, 0, 58);
    top.addColorStop(0, rgba(accent, 0.24));
    top.addColorStop(1, rgba(accent, 0));
    ctx.fillStyle = top;
    ctx.fillRect(8, 8, PANEL_W - 16, 50);
    ctx.restore();

    // 双层描边
    roundedRectPath(ctx, 7, 7, PANEL_W - 14, PANEL_H - 14, 16);
    ctx.strokeStyle = rgba(accent, 0.92);
    ctx.lineWidth = 3;
    ctx.stroke();
    roundedRectPath(ctx, 13, 13, PANEL_W - 26, PANEL_H - 26, 11);
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.lineWidth = 1;
    ctx.stroke();

    // 四角高亮三角
    ctx.fillStyle = rgba(accent, 0.95);
    const corners = [
      [12, 24, 12, 12, 24, 12],
      [PANEL_W - 12, 24, PANEL_W - 12, 12, PANEL_W - 24, 12],
      [12, PANEL_H - 24, 12, PANEL_H - 12, 24, PANEL_H - 12],
      [PANEL_W - 12, PANEL_H - 24, PANEL_W - 12, PANEL_H - 12, PANEL_W - 24, PANEL_H - 12],
    ];
    for (let i = 0; i < corners.length; i++) {
      const p = corners[i];
      ctx.beginPath();
      ctx.moveTo(p[0], p[1]);
      ctx.lineTo(p[2], p[3]);
      ctx.lineTo(p[4], p[5]);
      ctx.closePath();
      ctx.fill();
    }

    // 顶部色条
    ctx.fillStyle = rgba(accent, 0.90);
    ctx.fillRect(26, 30, PANEL_W - 52, 3);
    ctx.fillStyle = 'rgba(255,255,255,0.22)';
    ctx.fillRect(26, 33, PANEL_W - 52, 1);

    // 底部能量点
    for (let i = 0; i < 3; i++) {
      ctx.save();
      ctx.translate(64 + (i - 1) * 16, 230);
      ctx.rotate(Math.PI / 4);
      ctx.fillStyle = rgba(accent, i === 1 ? 0.95 : 0.42);
      ctx.fillRect(-4, -4, 8, 8);
      ctx.restore();
    }
  }

  function drawStarIcon(ctx, accent) {
    panelHalo(ctx, accent, 0, -2, 72);
    ctx.save();
    ctx.translate(0, -4);
    ctx.rotate(-0.04);
    starPath(ctx, 0, 0, 56, 24, 5, -Math.PI / 2);
    const grad = ctx.createLinearGradient(0, -58, 0, 58);
    grad.addColorStop(0, '#fffbe0');
    grad.addColorStop(0.45, cssColor(accent));
    grad.addColorStop(1, '#c98a12');
    ctx.fillStyle = grad;
    ctx.shadowColor = cssColor(accent);
    ctx.shadowBlur = 22;
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = 'rgba(255,255,255,0.92)';
    ctx.lineWidth = 2.5;
    ctx.stroke();
    // 内层高光
    starPath(ctx, 0, -3, 35, 14, 5, -Math.PI / 2);
    ctx.fillStyle = 'rgba(255,255,255,0.24)';
    ctx.fill();
    // 小闪光
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.beginPath();
    ctx.arc(-20, -26, 4, 0, TAU);
    ctx.fill();
    ctx.restore();
  }

  function drawGrenadeIcon(ctx, accent) {
    panelHalo(ctx, accent, 0, 4, 72);
    ctx.save();

    // 雷体
    ctx.save();
    ctx.translate(0, 8);
    ctx.beginPath();
    ctx.ellipse(0, 0, 37, 43, 0, 0, TAU);
    const body = ctx.createRadialGradient(-13, -17, 6, 0, 8, 54);
    body.addColorStop(0, '#ffd2a4');
    body.addColorStop(0.34, '#ff8a4a');
    body.addColorStop(0.78, '#d4421c');
    body.addColorStop(1, '#7a1e08');
    ctx.fillStyle = body;
    ctx.shadowColor = cssColor(accent);
    ctx.shadowBlur = 18;
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = '#3a0f04';
    ctx.lineWidth = 3;
    ctx.stroke();

    // 菠萝纹（裁剪在雷体内）
    ctx.save();
    ctx.beginPath();
    ctx.ellipse(0, 0, 35, 41, 0, 0, TAU);
    ctx.clip();
    ctx.strokeStyle = 'rgba(70,18,6,0.42)';
    ctx.lineWidth = 2;
    for (let i = -4; i <= 4; i++) {
      ctx.beginPath();
      ctx.moveTo(i * 9, -46);
      ctx.lineTo(i * 9 + 8, 46);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(-40, i * 9);
      ctx.lineTo(40, i * 9 + 6);
      ctx.stroke();
    }
    // 高光
    ctx.beginPath();
    ctx.ellipse(-13, -17, 10, 17, -0.5, 0, TAU);
    ctx.fillStyle = 'rgba(255,236,212,0.35)';
    ctx.fill();
    ctx.restore();
    ctx.restore();

    // 引信座
    roundedRectPath(ctx, -12, -42, 24, 16, 4);
    ctx.fillStyle = '#5c646d';
    ctx.fill();
    ctx.strokeStyle = '#2d3238';
    ctx.lineWidth = 2;
    ctx.stroke();

    // 保险握片
    ctx.beginPath();
    ctx.moveTo(12, -38);
    ctx.quadraticCurveTo(32, -24, 27, -2);
    ctx.quadraticCurveTo(24, 12, 12, 14);
    ctx.lineTo(9, 5);
    ctx.quadraticCurveTo(19, -10, 5, -32);
    ctx.closePath();
    ctx.fillStyle = '#8f98a2';
    ctx.fill();
    ctx.strokeStyle = '#3a4047';
    ctx.lineWidth = 2;
    ctx.stroke();

    // 拉环
    ctx.beginPath();
    ctx.arc(-24, -46, 9, 0, TAU);
    ctx.strokeStyle = '#c9cdd4';
    ctx.lineWidth = 3;
    ctx.stroke();

    // 引信火花
    ctx.save();
    ctx.translate(0, -52);
    const spark = ctx.createRadialGradient(0, 0, 0, 0, 0, 18);
    spark.addColorStop(0, 'rgba(255,255,255,1)');
    spark.addColorStop(0.35, 'rgba(255,220,130,0.9)');
    spark.addColorStop(1, 'rgba(255,120,40,0)');
    ctx.fillStyle = spark;
    ctx.beginPath();
    ctx.arc(0, 0, 18, 0, TAU);
    ctx.fill();
    starPath(ctx, 0, 0, 10, 3, 4, 0);
    ctx.fillStyle = '#fffbe8';
    ctx.fill();
    ctx.restore();
    ctx.restore();
  }

  function drawHelmetIcon(ctx, accent) {
    panelHalo(ctx, accent, 0, 0, 74);
    ctx.save();

    // 头盔主体
    ctx.beginPath();
    ctx.moveTo(-52, 18);
    ctx.bezierCurveTo(-56, -12, -34, -46, 0, -46);
    ctx.bezierCurveTo(34, -46, 56, -12, 52, 18);
    ctx.quadraticCurveTo(28, 30, 0, 30);
    ctx.quadraticCurveTo(-28, 30, -52, 18);
    ctx.closePath();
    const grad = ctx.createLinearGradient(-40, -42, 40, 34);
    grad.addColorStop(0, '#c8f8ff');
    grad.addColorStop(0.4, '#4adfff');
    grad.addColorStop(1, '#157a94');
    ctx.fillStyle = grad;
    ctx.shadowColor = cssColor(accent);
    ctx.shadowBlur = 20;
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = '#083a4a';
    ctx.lineWidth = 3;
    ctx.stroke();

    // 帽檐
    ctx.beginPath();
    ctx.moveTo(-56, 18);
    ctx.quadraticCurveTo(0, 40, 56, 18);
    ctx.quadraticCurveTo(0, 30, -56, 18);
    ctx.closePath();
    ctx.fillStyle = '#12839b';
    ctx.fill();
    ctx.strokeStyle = '#083a4a';
    ctx.lineWidth = 2.5;
    ctx.stroke();

    // 束带
    ctx.fillStyle = 'rgba(8,58,74,0.55)';
    ctx.fillRect(-50, 4, 100, 8);

    // 高光
    ctx.beginPath();
    ctx.ellipse(-16, -19, 13, 20, -0.32, 0, TAU);
    ctx.fillStyle = 'rgba(255,255,255,0.32)';
    ctx.fill();

    // 侧铆钉
    ctx.fillStyle = '#bff6ff';
    const helmetRivets = [[-38, 11], [38, 11], [0, 14]];
    for (let i = 0; i < helmetRivets.length; i++) {
      ctx.beginPath();
      ctx.arc(helmetRivets[i][0], helmetRivets[i][1], 3, 0, TAU);
      ctx.fill();
    }

    // 下颚带
    ctx.strokeStyle = 'rgba(190,246,255,0.55)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(-32, 28);
    ctx.lineTo(-24, 46);
    ctx.lineTo(24, 46);
    ctx.lineTo(32, 28);
    ctx.stroke();
    ctx.fillStyle = 'rgba(90,220,245,0.5)';
    ctx.beginPath();
    ctx.arc(-24, 46, 4, 0, TAU);
    ctx.arc(24, 46, 4, 0, TAU);
    ctx.fill();
    ctx.restore();
  }

  function drawTimerIcon(ctx, accent) {
    panelHalo(ctx, accent, 0, 0, 72);
    ctx.save();

    // 顶部按钮
    roundedRectPath(ctx, -12, -58, 24, 12, 4);
    ctx.fillStyle = '#8f98a2';
    ctx.fill();
    ctx.strokeStyle = '#3a4047';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = '#c9cdd4';
    ctx.fillRect(-3, -64, 6, 7);

    // 表体
    ctx.beginPath();
    ctx.arc(0, 0, 47, 0, TAU);
    const face = ctx.createRadialGradient(-14, -18, 8, 0, 0, 50);
    face.addColorStop(0, '#2a3b6a');
    face.addColorStop(0.7, '#111b33');
    face.addColorStop(1, '#080d18');
    ctx.fillStyle = face;
    ctx.shadowColor = cssColor(accent);
    ctx.shadowBlur = 20;
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = cssColor(accent);
    ctx.lineWidth = 5;
    ctx.stroke();

    // 内圈
    ctx.beginPath();
    ctx.arc(0, 0, 37, 0, TAU);
    ctx.strokeStyle = rgba(accent, 0.35);
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // 刻度
    for (let i = 0; i < 12; i++) {
      const a = i * (TAU / 12) - Math.PI / 2;
      const r1 = (i % 3 === 0) ? 26 : 30;
      const r2 = 35;
      ctx.strokeStyle = (i % 3 === 0) ? '#eaf4ff' : rgba(accent, 0.75);
      ctx.lineWidth = (i % 3 === 0) ? 3.5 : 2;
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * r1, Math.sin(a) * r1);
      ctx.lineTo(Math.cos(a) * r2, Math.sin(a) * r2);
      ctx.stroke();
    }

    // 指针
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#eaf4ff';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(Math.cos(-Math.PI / 3) * 20, Math.sin(-Math.PI / 3) * 20);
    ctx.stroke();
    ctx.strokeStyle = cssColor(accent);
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(Math.cos(Math.PI * 0.72) * 30, Math.sin(Math.PI * 0.72) * 30);
    ctx.stroke();

    // 中心帽
    ctx.fillStyle = cssColor(accent);
    ctx.beginPath();
    ctx.arc(0, 0, 5.5, 0, TAU);
    ctx.fill();
    ctx.fillStyle = '#eaf4ff';
    ctx.beginPath();
    ctx.arc(-1.5, -1.5, 2, 0, TAU);
    ctx.fill();

    // 倒计时弧
    ctx.strokeStyle = rgba(accent, 0.85);
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(0, 0, 41, -Math.PI / 2, -Math.PI / 2 + Math.PI * 1.35);
    ctx.stroke();
    ctx.restore();
  }

  function drawShovelIcon(ctx, accent) {
    panelHalo(ctx, accent, 0, 6, 72);
    ctx.save();
    ctx.rotate(-0.18);

    // 手柄
    ctx.strokeStyle = '#5a3a0e';
    ctx.lineWidth = 13;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(0, -58);
    ctx.lineTo(0, 2);
    ctx.stroke();
    ctx.strokeStyle = '#c98a2a';
    ctx.lineWidth = 8;
    ctx.beginPath();
    ctx.moveTo(0, -58);
    ctx.lineTo(0, 2);
    ctx.stroke();

    // T 形握把
    roundedRectPath(ctx, -22, -70, 44, 11, 5);
    ctx.fillStyle = '#d99a32';
    ctx.fill();
    ctx.strokeStyle = '#5a3a0e';
    ctx.lineWidth = 2.5;
    ctx.stroke();

    // 铲头
    ctx.beginPath();
    ctx.moveTo(-25, 0);
    ctx.lineTo(25, 0);
    ctx.lineTo(29, 28);
    ctx.quadraticCurveTo(0, 60, -29, 28);
    ctx.closePath();
    const grad = ctx.createLinearGradient(-28, 0, 28, 58);
    grad.addColorStop(0, '#fff0b0');
    grad.addColorStop(0.4, cssColor(accent));
    grad.addColorStop(1, '#a85a06');
    ctx.fillStyle = grad;
    ctx.shadowColor = cssColor(accent);
    ctx.shadowBlur = 20;
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = '#5a3206';
    ctx.lineWidth = 3;
    ctx.stroke();

    // 铲面高光
    ctx.beginPath();
    ctx.moveTo(-14, 9);
    ctx.lineTo(-5, 44);
    ctx.strokeStyle = 'rgba(255,246,210,0.55)';
    ctx.lineWidth = 4;
    ctx.stroke();

    // 连接环
    ctx.beginPath();
    ctx.arc(0, 1, 8, 0, TAU);
    ctx.fillStyle = '#5c646d';
    ctx.fill();
    ctx.strokeStyle = '#2d3238';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();
  }

  function drawTankIcon(ctx, accent) {
    panelHalo(ctx, accent, 0, 0, 74);
    ctx.save();

    // 左右履带
    roundedRectPath(ctx, -47, -45, 20, 90, 8);
    ctx.fillStyle = '#123d22';
    ctx.fill();
    ctx.strokeStyle = '#2c8a4a';
    ctx.lineWidth = 2.5;
    ctx.stroke();
    roundedRectPath(ctx, 27, -45, 20, 90, 8);
    ctx.fillStyle = '#123d22';
    ctx.fill();
    ctx.strokeStyle = '#2c8a4a';
    ctx.lineWidth = 2.5;
    ctx.stroke();

    // 履带齿
    ctx.fillStyle = 'rgba(160,255,195,0.30)';
    for (let y = -39; y < 40; y += 11) {
      ctx.fillRect(-45, y, 16, 4);
      ctx.fillRect(29, y, 16, 4);
    }

    // 车身
    roundedRectPath(ctx, -28, -38, 56, 76, 10);
    const hull = ctx.createLinearGradient(-20, -38, 24, 38);
    hull.addColorStop(0, '#a6ffc0');
    hull.addColorStop(0.45, cssColor(accent));
    hull.addColorStop(1, '#1c8a44');
    ctx.fillStyle = hull;
    ctx.shadowColor = cssColor(accent);
    ctx.shadowBlur = 18;
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = '#0b3a1a';
    ctx.lineWidth = 3;
    ctx.stroke();

    // 车体细节线
    ctx.strokeStyle = rgba(12, 70, 30, 0.55);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(-20, 24);
    ctx.lineTo(20, 24);
    ctx.moveTo(-20, -26);
    ctx.lineTo(20, -26);
    ctx.stroke();

    // 炮管
    roundedRectPath(ctx, -6, -68, 12, 48, 3);
    ctx.fillStyle = '#d8ffe4';
    ctx.fill();
    ctx.strokeStyle = '#0b3a1a';
    ctx.lineWidth = 2.5;
    ctx.stroke();
    roundedRectPath(ctx, -9, -73, 18, 10, 3);
    ctx.fillStyle = '#ecfff2';
    ctx.fill();
    ctx.stroke();

    // 炮塔
    ctx.beginPath();
    ctx.arc(0, -4, 19, 0, TAU);
    const turret = ctx.createRadialGradient(-6, -12, 2, 0, -4, 24);
    turret.addColorStop(0, '#eafff0');
    turret.addColorStop(0.5, cssColor(accent));
    turret.addColorStop(1, '#1c8a44');
    ctx.fillStyle = turret;
    ctx.fill();
    ctx.strokeStyle = '#0b3a1a';
    ctx.lineWidth = 3;
    ctx.stroke();

    // 舱盖
    ctx.beginPath();
    ctx.arc(0, -4, 7, 0, TAU);
    ctx.fillStyle = '#0d4a22';
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.beginPath();
    ctx.arc(0, -4, 3, 0, TAU);
    ctx.fill();
    ctx.restore();
  }

  function makePanelCanvas(kind) {
    const c = canvas(PANEL_W, PANEL_H);
    const ctx = getCtx(c);
    const accent = panelAccent(kind);
    panelBase(ctx, accent);
    ctx.save();
    ctx.translate(64, 122);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    if (kind === 'star') drawStarIcon(ctx, accent);
    else if (kind === 'grenade') drawGrenadeIcon(ctx, accent);
    else if (kind === 'helmet') drawHelmetIcon(ctx, accent);
    else if (kind === 'timer') drawTimerIcon(ctx, accent);
    else if (kind === 'shovel') drawShovelIcon(ctx, accent);
    else if (kind === 'tank') drawTankIcon(ctx, accent);
    ctx.restore();
    return c;
  }

  // -------------------------------------------------------------------------
  // 一次性构建全部贴图
  // -------------------------------------------------------------------------
  function build() {
    if (built) return;

    T.ground = makeTexture(makeGroundCanvas(), { name: 'tex.ground', repeat: true });
    T.brick = makeTexture(makeBrickCanvas(), { name: 'tex.brick', repeat: true });
    T.steel = makeTexture(makeSteelCanvas(), { name: 'tex.steel', repeat: true });
    T.track = makeTexture(makeTrackCanvas(), { name: 'tex.track', repeat: true });
    T.ice = makeTexture(makeIceCanvas(), { name: 'tex.ice', repeat: true });
    T.camo = makeTexture(makeCamoCanvas(false), { name: 'tex.camo', repeat: false });
    T.camoDark = makeTexture(makeCamoCanvas(true), { name: 'tex.camoDark', repeat: false });

    T.spark = makeTexture(makeSparkCanvas(), { name: 'tex.spark', repeat: false, mipmaps: false });
    T.smoke = makeTexture(makeSmokeCanvas(), { name: 'tex.smoke', repeat: false, mipmaps: false });
    T.snow = makeTexture(makeSnowCanvas(), { name: 'tex.snow', repeat: false, mipmaps: false });
    T.ring = makeTexture(makeRingCanvas(), { name: 'tex.ring', repeat: false, mipmaps: false });
    T.star = makeTexture(makeStarCanvas(), { name: 'tex.star', repeat: false, mipmaps: false });
    T.decalShadow = makeTexture(makeDecalShadowCanvas(), { name: 'tex.decalShadow', repeat: false, mipmaps: false });

    const kinds = ['star', 'grenade', 'helmet', 'timer', 'shovel', 'tank'];
    for (let i = 0; i < kinds.length; i++) {
      const kind = kinds[i];
      T.panel[kind] = makeTexture(makePanelCanvas(kind), { name: 'tex.panel.' + kind, repeat: false });
    }

    built = true;
  }

  const api = {
    // 幂等：LOADING 阶段可多次调用
    init() {
      build();
      return api;
    },
    get ground() { build(); return T.ground; },
    get brick() { build(); return T.brick; },
    get steel() { build(); return T.steel; },
    get track() { build(); return T.track; },
    get ice() { build(); return T.ice; },
    get camo() { build(); return T.camo; },
    get camoDark() { build(); return T.camoDark; },
    get spark() { build(); return T.spark; },
    get smoke() { build(); return T.smoke; },
    get snow() { build(); return T.snow; },
    get ring() { build(); return T.ring; },
    get star() { build(); return T.star; },
    get decalShadow() { build(); return T.decalShadow; },
    get panel() { build(); return T.panel; },
  };
  return api;
})();
