// ============================================================================
// 20-fx.js — FX 特效系统（规格书 §5 全部事件 / §8 池化 / 契约 §7）
// 全部对象池在 init() 一次性预分配；运行期不创建新的 THREE 对象、数组或 DOM。
// 顶层只声明 FX，内部辅助全部包在 IIFE 中（契约 §0/§7）。
// ============================================================================
const FX = (() => {
  'use strict';

  // ---------------------------------------------------------------------------
  // 局部表现参数：契约 §1 要求 CONFIG 未给出的数值集中在模块内，不修改 CONFIG 结构
  // ---------------------------------------------------------------------------
  const K = {
    // 粒子渲染
    pointScale: 560,          // renderer 未就绪时的点尺寸换算基准
    maxPointSize: 220,        // 单点最大像素，防止贴近镜头时糊屏
    // 震屏
    traumaMax: 1.0,
    // 浮动分数（契约 §7：3D 精灵池 12）
    score: {
      life: 1.25, rise: 1.15, space: 0.42, scale: 0.56,
      yOffset: 0.45, maxDigits: 5, popTime: 0.18, fadeIn: 0.12, fadeOut: 0.55,
    },
    // 通用冲击环
    ring: { duration: 0.55, opacity: 0.9 },
    // 碎片（契约 §7：重力 -20 / 反弹 0.35 / 2s 缩小消失，数值来自 CONFIG.fx.explosion）
    debris: {
      groundY: 0.08, shrinkAt: 0.55, stopBounce: 0.7, airDamp: 0.72,
      life: CONFIG.fx.explosion.debrisLife,
      gravity: CONFIG.fx.explosion.debrisGravity,
      bounce: CONFIG.fx.explosion.debrisBounce,
    },
    // 光柱 / 泡泡
    beam: { count: 3, baseHeight: 6, radius: 1.0 },
    bubble: { count: 3 },
    // 炮塔残骸
    turret: {
      gravity: -22, launchVy: 7.2, groundY: 0.15, life: 1.45,
      delay: 0.06, spin: 7, shrinkAt: 0.45, bounce: 0.3,
    },
    // 动态光池（契约 §7：6）
    light: { distance: 16, decay: 2 },
    // 炮口开火（§5；震屏由 Entities 在开火后统一调用 FX.shake，避免重复累加）
    muzzle: {
      sparkMin: 3, sparkMax: 5, lightLife: 0.06, flashLife: 0.09,
      lightIntensity: 18,
    },
    // 命中砖（§5：砖屑 5 + 棕色尘雾）
    brick: { debris: 5, dust: 8 },
    // 命中钢（§5：白橙火花扇形 10 + 金属碎片 2）
    steel: { sparks: 10, debris: 2 },
    // 子弹互消（§5：十字火花 8）
    cancel: { sparks: 8 },
    // 敌/玩家坦克亡（§5；玩家亡强化 1.5 倍）
    death: {
      fire: 4, smoke: 12, debris: 8, ringLife: 0.5,
      playerScale: 1.5, lightLife: 0.5,
    },
    // 出生 / 道具 / 水 / 冰 / 护盾 / 铁锹
    spawn: { rise: 12, beamHeight: 5.6, beamRadius: 1.0, life: 1.0, ringScale: 2.4 },
    powerupSpawn: { gold: 16, beamHeight: 4.2 },
    pickup: { stars: 20, ringLife: 0.5, flashLife: 0.18 },
    water: { splash: 6, rippleLife: 0.55 },
    ice: { count: 2 },
    shield: { sparks: 10, bubbleLife: 0.35 },
    shovel: { debris: 6 },
    // 鹰徽毁灭（§5：金碎片 16 + 超大火球 + 三连环 + 2.5s 六连爆 + 白闪）
    eagle: {
      goldDebris: 16, bursts: 6, burstStart: 0.25, burstGap: 0.42,
      lightLife: 1.0, flashLife: 0.3,
    },
    // 通用爆炸
    explosion: { fire: 10, smoke: 8, sparks: 14, debris: 6 },
    // 冻结雪花（§5：定时器期间雪花粒子）
    snow: { interval: 0.06, life: 4.2, minY: 7, maxY: 12 },
  };

  // 语义色（避免散落的十六进制字面量）
  const C = {
    white: 0xffffff, fire: 0xffa040, fireHot: 0xffe6a0, ember: 0xff7a2a,
    spark: 0xffd27a, smoke: 0x4e4a45, dust: 0x8a5a34,
    brick: 0xa8542e, steel: 0xc4ccd6, stone: 0x9aa3ad,
    gold: 0xffc63f, cyan: 0x4adfff, cyanSoft: 0x9ef2ff,
    water: 0xbfe6ff, ice: 0xcfeeff, orange: 0xff8a3a,
    debris: 0x6f6253, spawn: 0xbfefff,
  };

  // ---------------------------------------------------------------------------
  // 池容量（CONFIG.fx 为准，契约 §7）
  // ---------------------------------------------------------------------------
  const MAX_P = CONFIG.fx.particles.high;          // 容量按高画质一次建满
  const MAX_D = CONFIG.fx.debris;                  // InstancedMesh 64
  const MAX_R = CONFIG.fx.rings;                   // 8
  const MAX_F = CONFIG.fx.flashes;                 // 8
  const MAX_SCORE = CONFIG.fx.scoreTexts;          // 12
  const MAX_LIGHT = CONFIG.fx.lights;              // 6
  const MAX_TRACERS = 8;
  const MAX_BURSTS = 8;
  const TURRET_TYPES = ['basic', 'fast', 'power', 'armor', 'player'];
  const TURRET_SLOTS = TURRET_TYPES.length;      // 4 种敌方 + 玩家（Entities 以 'player' 传入）
  const SCORE_GLYPHS = 11;                         // 0-9 与 +
  const TAU = Math.PI * 2;

  // 子弹互消的十字方向（模块加载时一次性建立）
  const CROSS8 = [
    [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1],
    [0.7071, 0.35, 0.7071], [-0.7071, 0.35, 0.7071],
    [0.7071, 0.35, -0.7071], [-0.7071, 0.35, -0.7071],
  ];

  // ---------------------------------------------------------------------------
  // 运行期状态（全部由 build() 一次性创建）
  // ---------------------------------------------------------------------------
  let built = false;
  let root = null;
  let qQuality = null;
  let scoreHex = 0xffd23f;

  // 通用读取暂存（运行时复用，不产生对象）
  let _x = 0, _y = 0, _z = 0;
  let _dx = 0, _dy = 0, _dz = 0;
  let _cr = 1, _cg = 1, _cb = 1;
  const camRight = { x: 1, y: 0, z: 0 };

  // 粒子单 Points
  let pPoints = null, pGeom = null, pMat = null;
  let pPosF32 = null, pColF32 = null, pSizeF32 = null, pLifeF32 = null;
  let pVelF32 = null, pGravF32 = null;
  let pPosAttr = null, pColAttr = null, pSizeAttr = null, pLifeAttr = null;
  let pVelAttr = null, pGravAttr = null;
  let pActive = null, pRemain = null, pTotal = null, pDrag = null;
  let pS0 = null, pS1 = null, pA0 = null;
  let pCap = MAX_P, pCur = 0, pLive = 0;

  // 碎片 InstancedMesh
  let dMesh = null, dGeo = null, dMat = null, dDummy = null, dTmpColor = null;
  let dActive = null, dRemain = null, dTotal = null, dPos = null, dVel = null;
  let dRot = null, dSpin = null, dS0 = null;
  let dCur = 0, dLive = 0;

  // 冲击环
  let ringGeo = null, ringMeshes = null, ringMats = null;
  let rActive = null, rRemain = null, rTotal = null, rS0 = null, rS1 = null, rOp = null;
  let rCur = 0;

  // 闪光精灵
  let flashTex = null, flashSprites = null, flashMats = null;
  let fActive = null, fRemain = null, fTotal = null, fS0 = null, fS1 = null, fOp = null;
  let fCur = 0, fLive = 0;

  // 浮动分数
  let scoreAtlas = null, scoreSprites = null, scoreMats = null, scoreTexes = null;
  let scActive = null, scRemain = null, scTotal = null, scY = null;
  let scBaseX = null, scBaseZ = null;
  let scCur = 0, scLive = 0;

  // 动态点光
  let lightPool = null, lActive = null, lRemain = null, lTotal = null, lBase = null;

  // 光柱
  let beamGeo = null, beamTex = null, beamMeshes = null, beamMats = null;
  let bmActive = null, bmRemain = null, bmTotal = null, bmH = null, bmR = null, bmOpacity = null;
  let bmCur = 0, bmLive = 0;

  // 护盾泡泡
  let bubbleGeo = null, bubbleMeshes = null, bubbleMats = null;
  let bbActive = null, bbRemain = null, bbTotal = null, bbS0 = null, bbS1 = null;
  let bbCur = 0, bbLive = 0;

  // 炮塔残骸（Models.turretDebris 预建 4 份缓存）
  let turretGroups = null;
  let trActive = null, trDelay = null, trRemain = null, trTotal = null;
  let trPos = null, trVel = null, trRot = null, trSpin = null, trScale = null;
  let trSettled = null;

  // 曳光线
  let tracerMesh = null, tracerGeo = null, tracerMat = null;
  let tracerPos = null, tracerCol = null, tracerBase = null;
  let trcActive = null, trcRemain = null, trcTotal = null;
  let trcCur = 0, trcLive = 0;

  // 鹰毁延迟连爆
  let bqActive = null, bqT = null, bqX = null, bqY = null, bqZ = null, bqS = null;

  // 全屏覆盖层（初始化时建一次 DOM，运行时只改透明度）
  let elWhite = null, elRed = null, elFreeze = null;
  let ffT = 0, ffTotal = 0, ffPeak = 0;
  let frT = 0, frTotal = 0, frPeak = 0;
  let fzT = 0, fzTotal = 0, fzPeak = 0;

  // 冻结雪花发射
  let snowRemain = 0, snowAcc = 0;

  // ---------------------------------------------------------------------------
  // 基础工具（运行期零对象分配）
  // ---------------------------------------------------------------------------
  function parseHex(hex) {
    if (typeof hex === 'number' && Number.isFinite(hex)) return (hex >>> 0) & 0xffffff;
    if (typeof hex === 'string' && hex.length >= 6) {
      const start = hex.charCodeAt(0) === 35 ? 1 : 0; // '#'
      let v = 0;
      for (let i = 0; i < 6; i++) {
        const code = hex.charCodeAt(start + i);
        let dgt = 0;
        if (code >= 48 && code <= 57) dgt = code - 48;
        else if (code >= 97 && code <= 102) dgt = code - 87;
        else if (code >= 65 && code <= 70) dgt = code - 55;
        v = (v << 4) | dgt;
      }
      return v & 0xffffff;
    }
    return 0xffffff;
  }

  function toHex(hex) { return parseHex(hex); }

  // 十六进制 → 0..1 颜色分量，写入 _cr/_cg/_cb
  function hexRGB(hex) {
    const v = parseHex(hex);
    _cr = ((v >> 16) & 255) / 255;
    _cg = ((v >> 8) & 255) / 255;
    _cb = (v & 255) / 255;
  }

  // 读取位置：支持 THREE.Vector3 与 {x,y,z}；零值/非法值安全回退
  function readPos(p, fallbackY) {
    _x = 0; _y = fallbackY || 0; _z = 0;
    if (!p) return;
    const px = +p.x, py = +p.y, pz = +p.z;
    if (Number.isFinite(px)) _x = px;
    if (Number.isFinite(py)) _y = py;
    if (Number.isFinite(pz)) _z = pz;
  }

  // 读取方向并归一化；零向量回退到 -Z（契约 §1：归一化前判零）
  function readDir(d) {
    let x = 0, y = 0, z = -1;
    if (d) {
      const px = +d.x, py = +d.y, pz = +d.z;
      if (Number.isFinite(px)) x = px;
      if (Number.isFinite(py)) y = py;
      if (Number.isFinite(pz)) z = pz;
    }
    const len = Math.hypot(x, y, z);
    if (len < 1e-6) { _dx = 0; _dy = 0; _dz = -1; return; }
    _dx = x / len; _dy = y / len; _dz = z / len;
  }

  // 运行期安全调用 UI（UI 在本文件之后定义，调用只发生在运行期）
  function uiCall(name, a, b) {
    try {
      if (typeof UI !== 'undefined' && UI && typeof UI[name] === 'function') {
        UI[name](a, b);
        return true;
      }
    } catch (e) { /* UI 未就绪或调用失败时走内部兜底 */ }
    return false;
  }

  function refMat(name) {
    try {
      if (typeof Mat !== 'undefined' && Mat && Mat[name]) return Mat[name];
    } catch (e) { /* 材质分片未就绪时使用内部材质 */ }
    return null;
  }

  function refTex(name) {
    try {
      if (typeof Tex !== 'undefined' && Tex && Tex[name]) return Tex[name];
    } catch (e) { /* 贴图分片未就绪时使用内部贴图 */ }
    return null;
  }

  // ---------------------------------------------------------------------------
  // 画质（§8：容量一次建满，激活子集）
  // ---------------------------------------------------------------------------
  function resolveQuality(level) {
    if (level === 'high' || level === 'medium' || level === 'low') return level;
    if (G && G.settings) {
      const q = G.settings.quality;
      if (q === 'high' || q === 'medium' || q === 'low') return q;
    }
    return 'high';
  }

  function applyCap() {
    if (!built) return;
    const want = CONFIG.fx.particles[qQuality] || CONFIG.fx.particles.high;
    pCap = Math.max(1, Math.min(MAX_P, want | 0));
    if (pCur >= pCap) pCur = 0;
    for (let i = pCap; i < MAX_P; i++) {
      if (pActive[i]) killP(i);
    }
    pGeom.setDrawRange(0, pCap);
    if (pLive > pCap) pLive = pCap;
  }

  // ---------------------------------------------------------------------------
  // 粒子：单 Points + 自定义 ShaderMaterial（position/color/size/life/velocity/gravity）
  // ---------------------------------------------------------------------------
  function buildParticles() {
    pPosF32 = new Float32Array(MAX_P * 3);
    pColF32 = new Float32Array(MAX_P * 3);
    pSizeF32 = new Float32Array(MAX_P);
    pLifeF32 = new Float32Array(MAX_P);
    pVelF32 = new Float32Array(MAX_P * 3);
    pGravF32 = new Float32Array(MAX_P);
    pActive = new Uint8Array(MAX_P);
    pRemain = new Float32Array(MAX_P);
    pTotal = new Float32Array(MAX_P);
    pDrag = new Float32Array(MAX_P);
    pS0 = new Float32Array(MAX_P);
    pS1 = new Float32Array(MAX_P);
    pA0 = new Float32Array(MAX_P);
    for (let i = 0; i < MAX_P; i++) pPosF32[i * 3 + 1] = -60;

    pGeom = new THREE.BufferGeometry();
    pPosAttr = new THREE.BufferAttribute(pPosF32, 3).setUsage(THREE.DynamicDrawUsage);
    pColAttr = new THREE.BufferAttribute(pColF32, 3).setUsage(THREE.DynamicDrawUsage);
    pSizeAttr = new THREE.BufferAttribute(pSizeF32, 1).setUsage(THREE.DynamicDrawUsage);
    pLifeAttr = new THREE.BufferAttribute(pLifeF32, 1).setUsage(THREE.DynamicDrawUsage);
    pVelAttr = new THREE.BufferAttribute(pVelF32, 3).setUsage(THREE.DynamicDrawUsage);
    pGravAttr = new THREE.BufferAttribute(pGravF32, 1).setUsage(THREE.DynamicDrawUsage);
    pGeom.setAttribute('position', pPosAttr);
    pGeom.setAttribute('color', pColAttr);
    pGeom.setAttribute('size', pSizeAttr);
    pGeom.setAttribute('life', pLifeAttr);
    pGeom.setAttribute('velocity', pVelAttr);
    pGeom.setAttribute('gravity', pGravAttr);
    pGeom.setDrawRange(0, pCap);

    // 颜色分量由自定义 attribute 传入；vertexColors 保持关闭，避免重复声明
    const vert = [
      'attribute float size;',
      'attribute float life;',
      'attribute vec3 color;',
      'uniform float uScale;',
      'uniform float uMaxSize;',
      'varying vec3 vColor;',
      'varying float vAlpha;',
      'void main() {',
      '  vColor = color;',
      '  vAlpha = life;',
      '  vec4 mv = modelViewMatrix * vec4(position, 1.0);',
      '  float depth = max(0.35, -mv.z);',
      '  gl_PointSize = clamp(size * uScale / depth, 0.0, uMaxSize);',
      '  gl_Position = projectionMatrix * mv;',
      '}',
    ].join('\n');
    const frag = [
      'varying vec3 vColor;',
      'varying float vAlpha;',
      'void main() {',
      '  vec2 p = gl_PointCoord - vec2(0.5);',
      '  float r = length(p) * 2.0;',
      '  if (r > 1.0) discard;',
      '  float a = 1.0 - r;',
      '  a = a * a;',
      '  gl_FragColor = vec4(vColor, a * vAlpha);',
      '}',
    ].join('\n');

    pMat = new THREE.ShaderMaterial({
      uniforms: {
        uScale: { value: K.pointScale },
        uMaxSize: { value: K.maxPointSize },
      },
      vertexShader: vert,
      fragmentShader: frag,
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthTest: true,
      depthWrite: false,
    });
    pPoints = new THREE.Points(pGeom, pMat);
    pPoints.frustumCulled = false;
    pPoints.renderOrder = 20;
    pPoints.visible = false;
    root.add(pPoints);
  }

  function killP(i) {
    if (!pActive[i]) return;
    pActive[i] = 0;
    pSizeF32[i] = 0;
    pLifeF32[i] = 0;
    pRemain[i] = 0;
    pLive--;
  }

  // 生成一个粒子（16 个数值参数，运行期无对象分配）
  function spawnP(x, y, z, vx, vy, vz, gravity, drag, life, s0, s1, alpha, r, g, b) {
    if (!built || pCap <= 0 || !Number.isFinite(life) || life <= 0) return;
    let idx = -1;
    if (pLive < pCap) {
      for (let n = 0; n < pCap; n++) {
        const i = (pCur + n) % pCap;
        if (!pActive[i]) { idx = i; pCur = (i + 1) % pCap; break; }
      }
    }
    if (idx < 0) {
      idx = pCur % pCap;
      pCur = (idx + 1) % pCap;
      if (pActive[idx]) pLive--;
    }
    if (!pActive[idx]) pLive++;
    pActive[idx] = 1;
    const i3 = idx * 3;
    pPosF32[i3] = x; pPosF32[i3 + 1] = y; pPosF32[i3 + 2] = z;
    pVelF32[i3] = vx; pVelF32[i3 + 1] = vy; pVelF32[i3 + 2] = vz;
    pGravF32[idx] = gravity;
    pColF32[i3] = r; pColF32[i3 + 1] = g; pColF32[i3 + 2] = b;
    pRemain[idx] = life; pTotal[idx] = life;
    pDrag[idx] = drag;
    pS0[idx] = s0; pS1[idx] = s1; pA0[idx] = alpha;
    pSizeF32[idx] = s0; pLifeF32[idx] = alpha;
    pPosAttr.needsUpdate = true;
    pColAttr.needsUpdate = true;
    pSizeAttr.needsUpdate = true;
    pLifeAttr.needsUpdate = true;
    pVelAttr.needsUpdate = true;
    pGravAttr.needsUpdate = true;
  }

  function updateParticles(dt) {
    if (pLive <= 0) {
      if (pPoints) pPoints.visible = false;
      return;
    }
    let alive = 0;
    for (let i = 0; i < pCap; i++) {
      if (!pActive[i]) continue;
      const rem = pRemain[i] - dt;
      if (rem <= 0) { killP(i); continue; }
      pRemain[i] = rem;
      const total = pTotal[i];
      const t = total > 0 ? 1 - rem / total : 1;
      const i3 = i * 3;
      let vx = pVelF32[i3], vy = pVelF32[i3 + 1], vz = pVelF32[i3 + 2];
      const drag = pDrag[i];
      if (drag > 0) {
        let damp = 1 - drag * dt;
        if (damp < 0) damp = 0;
        vx *= damp; vy *= damp; vz *= damp;
      }
      vy += pGravF32[i] * dt;
      pVelF32[i3] = vx; pVelF32[i3 + 1] = vy; pVelF32[i3 + 2] = vz;
      const nx = pPosF32[i3] + vx * dt;
      const ny = pPosF32[i3 + 1] + vy * dt;
      const nz = pPosF32[i3 + 2] + vz * dt;
      if (ny < -2 || nx < -40 || nx > 40 || nz < -40 || nz > 40) { killP(i); continue; }
      pPosF32[i3] = nx; pPosF32[i3 + 1] = ny; pPosF32[i3 + 2] = nz;
      pSizeF32[i] = pS0[i] + (pS1[i] - pS0[i]) * t;
      let a = pA0[i] * (1 - t);
      if (a < 0) a = 0;
      pLifeF32[i] = a;
      alive++;
    }
    pLive = alive;
    pPoints.visible = alive > 0;
    pPosAttr.needsUpdate = true;
    pSizeAttr.needsUpdate = true;
    pLifeAttr.needsUpdate = true;
  }

  // ---------------------------------------------------------------------------
  // 碎片：InstancedMesh 64（重力 −20 / 反弹 0.35 / 随机旋转 / 2s 缩小消失）
  // ---------------------------------------------------------------------------
  function buildDebris() {
    dGeo = new THREE.BoxGeometry(0.34, 0.2, 0.44);
    dMat = refMat('debrisMat');
    if (!dMat) {
      dMat = new THREE.MeshStandardMaterial({
        color: 0xffffff, roughness: 0.72, metalness: 0.25, flatShading: true,
      });
    }
    dMesh = new THREE.InstancedMesh(dGeo, dMat, MAX_D);
    dMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    dMesh.frustumCulled = false;
    dMesh.castShadow = false;
    dMesh.receiveShadow = false;
    dMesh.renderOrder = 16;
    dDummy = new THREE.Object3D();
    dTmpColor = new THREE.Color(0xffffff);
    for (let i = 0; i < MAX_D; i++) {
      dDummy.position.set(0, -60, 0);
      dDummy.rotation.set(0, 0, 0);
      dDummy.scale.setScalar(0);
      dDummy.updateMatrix();
      dMesh.setMatrixAt(i, dDummy.matrix);
      dMesh.setColorAt(i, dTmpColor);
    }
    if (dMesh.instanceColor) dMesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    dMesh.instanceMatrix.needsUpdate = true;
    dMesh.visible = false;
    root.add(dMesh);

    dActive = new Uint8Array(MAX_D);
    dRemain = new Float32Array(MAX_D);
    dTotal = new Float32Array(MAX_D);
    dPos = new Float32Array(MAX_D * 3);
    dVel = new Float32Array(MAX_D * 3);
    dRot = new Float32Array(MAX_D * 3);
    dSpin = new Float32Array(MAX_D * 3);
    dS0 = new Float32Array(MAX_D);
  }

  function spawnD(x, y, z, vx, vy, vz, scale, life, hex, spin) {
    if (!built) return;
    let idx = -1;
    if (dLive < MAX_D) {
      for (let n = 0; n < MAX_D; n++) {
        const i = (dCur + n) % MAX_D;
        if (!dActive[i]) { idx = i; dCur = (i + 1) % MAX_D; break; }
      }
    }
    if (idx < 0) {
      idx = dCur;
      dCur = (dCur + 1) % MAX_D;
      if (dActive[idx]) dLive--;
    }
    if (!dActive[idx]) dLive++;
    dActive[idx] = 1;
    const i3 = idx * 3;
    dPos[i3] = x; dPos[i3 + 1] = y; dPos[i3 + 2] = z;
    dVel[i3] = vx; dVel[i3 + 1] = vy; dVel[i3 + 2] = vz;
    dRot[i3] = Math.random() * TAU;
    dRot[i3 + 1] = Math.random() * TAU;
    dRot[i3 + 2] = Math.random() * TAU;
    const sp = spin > 0 ? spin : 3;
    dSpin[i3] = UTILS.rand(-sp, sp);
    dSpin[i3 + 1] = UTILS.rand(-sp, sp);
    dSpin[i3 + 2] = UTILS.rand(-sp, sp);
    dRemain[idx] = life; dTotal[idx] = life; dS0[idx] = scale;
    if (!Number.isFinite(dRemain[idx]) || dRemain[idx] <= 0) {
      dRemain[idx] = K.debris.life;
      dTotal[idx] = K.debris.life;
    }
    if (!Number.isFinite(scale) || scale <= 0) dS0[idx] = 0.15;
    dTmpColor.setHex(toHex(hex));
    dMesh.setColorAt(idx, dTmpColor);
    if (dMesh.instanceColor) dMesh.instanceColor.needsUpdate = true;
    dDummy.position.set(x, y, z);
    dDummy.rotation.set(dRot[i3], dRot[i3 + 1], dRot[i3 + 2]);
    dDummy.scale.setScalar(scale);
    dDummy.updateMatrix();
    dMesh.setMatrixAt(idx, dDummy.matrix);
    dMesh.instanceMatrix.needsUpdate = true;
    dMesh.visible = true;
  }

  function updateDebris(dt) {
    if (dLive <= 0) return;
    let alive = 0;
    for (let i = 0; i < MAX_D; i++) {
      if (!dActive[i]) continue;
      const rem = dRemain[i] - dt;
      if (rem <= 0) {
        dActive[i] = 0;
        dDummy.position.set(0, -60, 0);
        dDummy.rotation.set(0, 0, 0);
        dDummy.scale.setScalar(0);
        dDummy.updateMatrix();
        dMesh.setMatrixAt(i, dDummy.matrix);
        continue;
      }
      dRemain[i] = rem;
      const i3 = i * 3;
      dVel[i3 + 1] += K.debris.gravity * dt;
      let px = dPos[i3] + dVel[i3] * dt;
      let py = dPos[i3 + 1] + dVel[i3 + 1] * dt;
      let pz = dPos[i3 + 2] + dVel[i3 + 2] * dt;
      if (py < K.debris.groundY) {
        py = K.debris.groundY;
        const vy = dVel[i3 + 1];
        if (vy < 0) {
          dVel[i3 + 1] = -vy * K.debris.bounce;
          if (dVel[i3 + 1] < K.debris.stopBounce) dVel[i3 + 1] = 0;
        }
        dVel[i3] *= K.debris.airDamp;
        dVel[i3 + 2] *= K.debris.airDamp;
        dSpin[i3] *= 0.55;
        dSpin[i3 + 1] *= 0.55;
        dSpin[i3 + 2] *= 0.55;
      }
      dPos[i3] = px; dPos[i3 + 1] = py; dPos[i3 + 2] = pz;
      dRot[i3] += dSpin[i3] * dt;
      dRot[i3 + 1] += dSpin[i3 + 1] * dt;
      dRot[i3 + 2] += dSpin[i3 + 2] * dt;
      const t = 1 - rem / dTotal[i];
      let sc = dS0[i];
      if (t > K.debris.shrinkAt) sc *= (1 - t) / (1 - K.debris.shrinkAt);
      if (sc < 0) sc = 0;
      dDummy.position.set(px, py, pz);
      dDummy.rotation.set(dRot[i3], dRot[i3 + 1], dRot[i3 + 2]);
      dDummy.scale.setScalar(sc);
      dDummy.updateMatrix();
      dMesh.setMatrixAt(i, dDummy.matrix);
      alive++;
    }
    dLive = alive;
    dMesh.instanceMatrix.needsUpdate = true;
    if (alive <= 0) dMesh.visible = false;
  }

  // ---------------------------------------------------------------------------
  // 冲击环池 8
  // ---------------------------------------------------------------------------
  function buildRings() {
    ringGeo = new THREE.RingGeometry(0.62, 1.0, 48);
    ringMeshes = new Array(MAX_R);
    ringMats = new Array(MAX_R);
    rActive = new Uint8Array(MAX_R);
    rRemain = new Float32Array(MAX_R);
    rTotal = new Float32Array(MAX_R);
    rS0 = new Float32Array(MAX_R);
    rS1 = new Float32Array(MAX_R);
    rOp = new Float32Array(MAX_R);
    for (let i = 0; i < MAX_R; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: 0xffffff, transparent: true, opacity: 0,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(ringGeo, mat);
      mesh.rotation.x = -Math.PI / 2;
      mesh.visible = false;
      mesh.frustumCulled = false;
      mesh.renderOrder = 18;
      root.add(mesh);
      ringMeshes[i] = mesh;
      ringMats[i] = mat;
    }
  }

  function addRing(x, y, z, hex, s0, s1, life, opacity) {
    if (!built) return;
    let idx = -1;
    for (let n = 0; n < MAX_R; n++) {
      const i = (rCur + n) % MAX_R;
      if (!rActive[i]) { idx = i; rCur = (i + 1) % MAX_R; break; }
    }
    if (idx < 0) { idx = rCur; rCur = (rCur + 1) % MAX_R; }
    const dur = (Number.isFinite(life) && life > 0) ? life : K.ring.duration;
    const sc0 = (Number.isFinite(s0) && s0 > 0) ? s0 : 0.2;
    const sc1 = (Number.isFinite(s1) && s1 > sc0) ? s1 : sc0 + 1;
    const op = (Number.isFinite(opacity) && opacity > 0) ? UTILS.clamp01(opacity) : K.ring.opacity;
    rActive[idx] = 1;
    rRemain[idx] = dur; rTotal[idx] = dur;
    rS0[idx] = sc0; rS1[idx] = sc1; rOp[idx] = op;
    const mesh = ringMeshes[idx];
    const mat = ringMats[idx];
    mesh.position.set(x, y < 0.02 ? 0.02 : y, z);
    mesh.scale.set(sc0, sc0, 1);
    mesh.visible = true;
    mat.color.setHex(toHex(hex));
    mat.opacity = op;
  }

  function updateRings(dt) {
    for (let i = 0; i < MAX_R; i++) {
      if (!rActive[i]) continue;
      const rem = rRemain[i] - dt;
      if (rem <= 0) {
        rActive[i] = 0;
        ringMeshes[i].visible = false;
        ringMats[i].opacity = 0;
        continue;
      }
      rRemain[i] = rem;
      const t = 1 - rem / rTotal[i];
      const e = UTILS.easeOutCubic(t);
      const sc = rS0[i] + (rS1[i] - rS0[i]) * e;
      ringMeshes[i].scale.set(sc, sc, 1);
      ringMats[i].opacity = rOp[i] * (1 - t);
    }
  }

  // ---------------------------------------------------------------------------
  // 闪光精灵池 8
  // ---------------------------------------------------------------------------
  function makeRadialTexture() {
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 128;
    const ctx = canvas.getContext('2d');
    const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.35, 'rgba(255,255,255,0.85)');
    g.addColorStop(0.72, 'rgba(255,255,255,0.22)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 128, 128);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    return tex;
  }

  function buildFlashes() {
    flashTex = refTex('spark');
    if (!flashTex) flashTex = makeRadialTexture();
    flashSprites = new Array(MAX_F);
    flashMats = new Array(MAX_F);
    fActive = new Uint8Array(MAX_F);
    fRemain = new Float32Array(MAX_F);
    fTotal = new Float32Array(MAX_F);
    fS0 = new Float32Array(MAX_F);
    fS1 = new Float32Array(MAX_F);
    fOp = new Float32Array(MAX_F);
    for (let i = 0; i < MAX_F; i++) {
      const mat = new THREE.SpriteMaterial({
        map: flashTex, color: 0xffffff, transparent: true, opacity: 0,
        blending: THREE.AdditiveBlending, depthWrite: false, depthTest: true,
      });
      const sp = new THREE.Sprite(mat);
      sp.visible = false;
      sp.frustumCulled = false;
      sp.renderOrder = 22;
      root.add(sp);
      flashSprites[i] = sp;
      flashMats[i] = mat;
    }
  }

  function addFlash(x, y, z, hex, scale, life, grow, alpha) {
    if (!built) return;
    let idx = -1;
    for (let n = 0; n < MAX_F; n++) {
      const i = (fCur + n) % MAX_F;
      if (!fActive[i]) { idx = i; fCur = (i + 1) % MAX_F; break; }
    }
    if (idx < 0) { idx = fCur; fCur = (fCur + 1) % MAX_F; if (fActive[idx]) fLive--; }
    if (!fActive[idx]) fLive++;
    fActive[idx] = 1;
    const dur = (Number.isFinite(life) && life > 0) ? life : 0.12;
    const s = (Number.isFinite(scale) && scale > 0) ? scale : 1;
    fRemain[idx] = dur; fTotal[idx] = dur;
    fS0[idx] = s; fS1[idx] = s * (Number.isFinite(grow) && grow > 0 ? grow : 1.8);
    const op = (Number.isFinite(alpha) && alpha >= 0) ? UTILS.clamp01(alpha) : 1;
    fOp[idx] = op;
    const sp = flashSprites[idx];
    sp.position.set(x, y, z);
    sp.scale.set(s, s, 1);
    sp.visible = true;
    sp.material.rotation = Math.random() * TAU;
    flashMats[idx].color.setHex(toHex(hex));
    flashMats[idx].opacity = op;
  }

  function updateFlashes(dt) {
    let alive = 0;
    for (let i = 0; i < MAX_F; i++) {
      if (!fActive[i]) continue;
      const rem = fRemain[i] - dt;
      if (rem <= 0) {
        fActive[i] = 0;
        flashSprites[i].visible = false;
        flashMats[i].opacity = 0;
        continue;
      }
      fRemain[i] = rem;
      const t = 1 - rem / fTotal[i];
      const e = UTILS.easeOutCubic(t);
      const s = fS0[i] + (fS1[i] - fS0[i]) * e;
      flashSprites[i].scale.set(s, s, 1);
      flashMats[i].opacity = fOp[i] * (1 - t);
      alive++;
    }
    fLive = alive;
  }

  // ---------------------------------------------------------------------------
  // 浮动分数：3D 精灵池 12；数字图集与材质在初始化时一次生成
  // ---------------------------------------------------------------------------
  function makeScoreAtlas() {
    const cell = 64;
    const canvas = document.createElement('canvas');
    canvas.width = cell * SCORE_GLYPHS;
    canvas.height = cell;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = 'bold 50px "Consolas", "Courier New", monospace';
    ctx.shadowColor = 'rgba(255,206,94,0.95)';
    ctx.shadowBlur = 10;
    ctx.fillStyle = '#ffffff';
    for (let i = 0; i < 10; i++) {
      ctx.fillText(String(i), i * cell + cell / 2, cell / 2 + 2);
    }
    ctx.fillText('+', 10 * cell + cell / 2, cell / 2 + 2);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    tex.repeat.set(1 / SCORE_GLYPHS, 1);
    tex.offset.set(0, 0);
    tex.needsUpdate = true;
    return tex;
  }

  function buildScores() {
    scoreAtlas = makeScoreAtlas();
    scoreSprites = new Array(MAX_SCORE);
    scoreMats = new Array(MAX_SCORE);
    scoreTexes = new Array(MAX_SCORE);
    scActive = new Uint8Array(MAX_SCORE);
    scRemain = new Float32Array(MAX_SCORE);
    scTotal = new Float32Array(MAX_SCORE);
    scY = new Float32Array(MAX_SCORE);
    scBaseX = new Float32Array(MAX_SCORE);
    scBaseZ = new Float32Array(MAX_SCORE);
    for (let i = 0; i < MAX_SCORE; i++) {
      // 每个精灵独占一份图集纹理，运行时只改 offset 选字形，避免共享透明度冲突
      const tex = scoreAtlas.clone();
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.wrapS = THREE.ClampToEdgeWrapping;
      tex.wrapT = THREE.ClampToEdgeWrapping;
      tex.minFilter = THREE.LinearFilter;
      tex.magFilter = THREE.LinearFilter;
      tex.generateMipmaps = false;
      tex.repeat.set(1 / SCORE_GLYPHS, 1);
      tex.offset.set(0, 0);
      tex.needsUpdate = true;
      const mat = new THREE.SpriteMaterial({
        map: tex, color: scoreHex, transparent: true, opacity: 1,
        blending: THREE.AdditiveBlending, depthWrite: false, depthTest: true,
      });
      const sp = new THREE.Sprite(mat);
      sp.visible = false;
      sp.frustumCulled = false;
      sp.renderOrder = 24;
      root.add(sp);
      scoreSprites[i] = sp;
      scoreMats[i] = mat;
      scoreTexes[i] = tex;
    }
  }

  function claimScore() {
    let idx = -1;
    if (scLive < MAX_SCORE) {
      for (let n = 0; n < MAX_SCORE; n++) {
        const i = (scCur + n) % MAX_SCORE;
        if (!scActive[i]) { idx = i; scCur = (i + 1) % MAX_SCORE; break; }
      }
    }
    if (idx < 0) {
      idx = scCur;
      scCur = (scCur + 1) % MAX_SCORE;
      if (scActive[idx]) scLive--;
    }
    if (!scActive[idx]) scLive++;
    scActive[idx] = 1;
    return idx;
  }

  // 数值 → 池内精灵（不生成字符串）
  function addScore(x, y, z, value) {
    if (!built) return;
    let v = Math.round(value);
    if (!Number.isFinite(v) || v < 0) v = 0;
    const maxV = 99999;
    if (v > maxV) v = maxV;
    let digits = 1;
    let pow = 10;
    while (digits < K.score.maxDigits && v >= pow) { digits++; pow *= 10; }
    const total = digits + 1;
    for (let n = 0; n < total; n++) {
      let glyph;
      if (n === 0) {
        glyph = 10; // '+'
      } else {
        const place = Math.pow(10, digits - n);
        glyph = Math.floor(v / place) % 10;
      }
      const idx = claimScore();
      const sp = scoreSprites[idx];
      const tex = scoreTexes[idx];
      tex.offset.x = glyph / SCORE_GLYPHS;
      tex.updateMatrix();
      const off = (n - (total - 1) * 0.5) * K.score.space;
      const bx = x + camRight.x * off;
      const by = y + K.score.yOffset;
      const bz = z + camRight.z * off;
      scBaseX[idx] = bx;
      scBaseZ[idx] = bz;
      scY[idx] = by;
      scRemain[idx] = K.score.life;
      scTotal[idx] = K.score.life;
      sp.position.set(bx, by, bz);
      sp.scale.set(K.score.scale, K.score.scale, 1);
      sp.visible = true;
      scoreMats[idx].opacity = 1;
    }
  }

  function updateScores(dt) {
    let alive = 0;
    for (let i = 0; i < MAX_SCORE; i++) {
      if (!scActive[i]) continue;
      const rem = scRemain[i] - dt;
      if (rem <= 0) {
        scActive[i] = 0;
        scoreSprites[i].visible = false;
        scoreMats[i].opacity = 0;
        continue;
      }
      scRemain[i] = rem;
      const t = 1 - rem / scTotal[i];
      const sp = scoreSprites[i];
      sp.position.y = scY[i] + K.score.rise * UTILS.easeOutCubic(t);
      sp.position.x = scBaseX[i];
      sp.position.z = scBaseZ[i];
      let pop = 1;
      if (t < K.score.popTime) pop = 0.55 + 0.45 * UTILS.easeOutBack(t / K.score.popTime);
      const sc = K.score.scale * pop;
      sp.scale.set(sc, sc, 1);
      let op;
      if (t < K.score.fadeIn) op = t / K.score.fadeIn;
      else if (t > K.score.fadeOut) op = 1 - (t - K.score.fadeOut) / (1 - K.score.fadeOut);
      else op = 1;
      if (op < 0) op = 0;
      if (op > 1) op = 1;
      scoreMats[i].opacity = op;
      alive++;
    }
    scLive = alive;
  }

  // ---------------------------------------------------------------------------
  // 动态 PointLight 池 6（无阴影）
  // ---------------------------------------------------------------------------
  function buildLights() {
    lightPool = new Array(MAX_LIGHT);
    lActive = new Uint8Array(MAX_LIGHT);
    lRemain = new Float32Array(MAX_LIGHT);
    lTotal = new Float32Array(MAX_LIGHT);
    lBase = new Float32Array(MAX_LIGHT);
    for (let i = 0; i < MAX_LIGHT; i++) {
      const l = new THREE.PointLight(0xffffff, 0, K.light.distance, K.light.decay);
      l.castShadow = false;
      // 常驻可见（仅强度归零）：避免运行期灯数变化触发着色器重编译
      l.visible = true;
      root.add(l);
      lightPool[i] = l;
    }
  }

  function addLight(x, y, z, hex, intensity, life) {
    if (!built || !Number.isFinite(intensity) || intensity <= 0 || !Number.isFinite(life) || life <= 0) return;
    let idx = -1;
    let weakest = -1;
    let weakRemain = Infinity;
    for (let i = 0; i < MAX_LIGHT; i++) {
      if (!lActive[i]) { idx = i; break; }
      if (lRemain[i] < weakRemain) { weakRemain = lRemain[i]; weakest = i; }
    }
    if (idx < 0) idx = weakest >= 0 ? weakest : 0;
    lActive[idx] = 1;
    lRemain[idx] = life;
    lTotal[idx] = life;
    lBase[idx] = intensity;
    const l = lightPool[idx];
    l.position.set(x, y, z);
    l.color.setHex(toHex(hex));
    l.intensity = intensity;
    l.visible = true;
  }

  function updateLights(dt) {
    for (let i = 0; i < MAX_LIGHT; i++) {
      if (!lActive[i]) continue;
      const rem = lRemain[i] - dt;
      if (rem <= 0) {
        lActive[i] = 0;
        lRemain[i] = 0;
        lightPool[i].intensity = 0;
        continue;
      }
      lRemain[i] = rem;
      const k = rem / lTotal[i];
      lightPool[i].intensity = lBase[i] * k * k;
    }
  }

  // ---------------------------------------------------------------------------
  // 光柱池 3（出生 / 道具出现）
  // ---------------------------------------------------------------------------
  function makeBeamTexture() {
    const canvas = document.createElement('canvas');
    canvas.width = 8;
    canvas.height = 256;
    const ctx = canvas.getContext('2d');
    const g = ctx.createLinearGradient(0, 0, 0, 256);
    g.addColorStop(0, 'rgba(255,255,255,0)');
    g.addColorStop(0.2, 'rgba(255,255,255,0.55)');
    g.addColorStop(0.5, 'rgba(255,255,255,1)');
    g.addColorStop(0.8, 'rgba(255,255,255,0.55)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 8, 256);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    return tex;
  }

  function buildBeams() {
    beamGeo = new THREE.CylinderGeometry(0.55, 0.85, K.beam.baseHeight, 16, 1, true);
    beamGeo.translate(0, K.beam.baseHeight * 0.5, 0);
    beamTex = makeBeamTexture();
    const count = K.beam.count;
    beamMeshes = new Array(count);
    beamMats = new Array(count);
    bmActive = new Uint8Array(count);
    bmRemain = new Float32Array(count);
    bmTotal = new Float32Array(count);
    bmH = new Float32Array(count);
    bmR = new Float32Array(count);
    bmOpacity = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: 0xffffff, map: beamTex, transparent: true, opacity: 0,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(beamGeo, mat);
      mesh.visible = false;
      mesh.frustumCulled = false;
      mesh.renderOrder = 19;
      root.add(mesh);
      beamMeshes[i] = mesh;
      beamMats[i] = mat;
    }
    bmCur = 0;
    bmLive = 0;
  }

  function addBeam(x, y, z, hex, height, radius, life, opacity) {
    if (!built) return;
    const count = beamMeshes.length;
    if (!count) return;
    let idx = -1;
    for (let n = 0; n < count; n++) {
      const i = (bmCur + n) % count;
      if (!bmActive[i]) { idx = i; bmCur = (i + 1) % count; break; }
    }
    if (idx < 0) { idx = bmCur; bmCur = (bmCur + 1) % count; }
    const dur = (Number.isFinite(life) && life > 0) ? life : 1;
    bmActive[idx] = 1;
    bmRemain[idx] = dur;
    bmTotal[idx] = dur;
    bmH[idx] = ((Number.isFinite(height) && height > 0) ? height : K.beam.baseHeight) / K.beam.baseHeight;
    bmR[idx] = (Number.isFinite(radius) && radius > 0) ? radius : K.beam.radius;
    bmOpacity[idx] = (Number.isFinite(opacity) && opacity > 0) ? UTILS.clamp01(opacity) : 0.9;
    const mesh = beamMeshes[idx];
    mesh.position.set(x, y, z);
    mesh.scale.set(bmR[idx], bmH[idx], bmR[idx]);
    mesh.visible = true;
    beamMats[idx].color.setHex(toHex(hex));
    beamMats[idx].opacity = bmOpacity[idx];
  }

  function updateBeams(dt) {
    let alive = 0;
    for (let i = 0; i < beamMeshes.length; i++) {
      if (!bmActive[i]) continue;
      const rem = bmRemain[i] - dt;
      if (rem <= 0) {
        bmActive[i] = 0;
        beamMeshes[i].visible = false;
        beamMats[i].opacity = 0;
        continue;
      }
      bmRemain[i] = rem;
      const t = 1 - rem / bmTotal[i];
      const rise = t < 0.12 ? t / 0.12 : 1; // 光柱先拔起再收束
      const shrink = 1 - t * 0.8;
      beamMeshes[i].scale.set(bmR[i] * shrink, bmH[i] * rise, bmR[i] * shrink);
      beamMats[i].opacity = bmOpacity[i] * (1 - t);
      alive++;
    }
    bmLive = alive;
  }

  // ---------------------------------------------------------------------------
  // 护盾泡泡池 3
  // ---------------------------------------------------------------------------
  function buildBubbles() {
    bubbleGeo = new THREE.SphereGeometry(1, 20, 14);
    const count = K.bubble.count;
    bubbleMeshes = new Array(count);
    bubbleMats = new Array(count);
    bbActive = new Uint8Array(count);
    bbRemain = new Float32Array(count);
    bbTotal = new Float32Array(count);
    bbS0 = new Float32Array(count);
    bbS1 = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: C.cyan, transparent: true, opacity: 0,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(bubbleGeo, mat);
      mesh.visible = false;
      mesh.frustumCulled = false;
      mesh.renderOrder = 21;
      root.add(mesh);
      bubbleMeshes[i] = mesh;
      bubbleMats[i] = mat;
    }
  }

  function addBubble(x, y, z, hex, r0, r1, life) {
    if (!built) return;
    const count = bubbleMeshes.length;
    if (!count) return;
    let idx = -1;
    for (let n = 0; n < count; n++) {
      const i = (bbCur + n) % count;
      if (!bbActive[i]) { idx = i; bbCur = (i + 1) % count; break; }
    }
    if (idx < 0) { idx = bbCur; bbCur = (bbCur + 1) % count; }
    bbActive[idx] = 1;
    bbRemain[idx] = (Number.isFinite(life) && life > 0) ? life : 0.35;
    bbTotal[idx] = bbRemain[idx];
    bbS0[idx] = (Number.isFinite(r0) && r0 > 0) ? r0 : 0.8;
    bbS1[idx] = (Number.isFinite(r1) && r1 > bbS0[idx]) ? r1 : bbS0[idx] + 0.6;
    const mesh = bubbleMeshes[idx];
    mesh.position.set(x, y, z);
    mesh.scale.setScalar(bbS0[idx]);
    mesh.visible = true;
    bubbleMats[idx].color.setHex(toHex(hex));
    bubbleMats[idx].opacity = 0.5;
  }

  function updateBubbles(dt) {
    let alive = 0;
    for (let i = 0; i < bubbleMeshes.length; i++) {
      if (!bbActive[i]) continue;
      const rem = bbRemain[i] - dt;
      if (rem <= 0) {
        bbActive[i] = 0;
        bubbleMeshes[i].visible = false;
        bubbleMats[i].opacity = 0;
        continue;
      }
      bbRemain[i] = rem;
      const t = 1 - rem / bbTotal[i];
      const s = bbS0[i] + (bbS1[i] - bbS0[i]) * UTILS.easeOutCubic(t);
      bubbleMeshes[i].scale.setScalar(s);
      bubbleMats[i].opacity = 0.5 * (1 - t);
      alive++;
    }
    bbLive = alive;
  }

  // ---------------------------------------------------------------------------
  // 炮塔残骸：Models.turretDebris(type) 预建 4 份缓存（契约 §7）
  // ---------------------------------------------------------------------------
  function buildTurretDebris() {
    turretGroups = new Array(TURRET_SLOTS);
    for (let i = 0; i < TURRET_SLOTS; i++) turretGroups[i] = null;
    trActive = new Uint8Array(TURRET_SLOTS);
    trDelay = new Float32Array(TURRET_SLOTS);
    trRemain = new Float32Array(TURRET_SLOTS);
    trTotal = new Float32Array(TURRET_SLOTS);
    trPos = new Float32Array(TURRET_SLOTS * 3);
    trVel = new Float32Array(TURRET_SLOTS * 3);
    trRot = new Float32Array(TURRET_SLOTS * 3);
    trSpin = new Float32Array(TURRET_SLOTS * 3);
    trScale = new Float32Array(TURRET_SLOTS);
    trSettled = new Uint8Array(TURRET_SLOTS);
    let owner = null;
    try {
      if (typeof Models !== 'undefined' && Models && typeof Models.turretDebris === 'function') {
        owner = Models;
      }
    } catch (e) { owner = null; }
    if (!owner) return;
    for (let i = 0; i < TURRET_SLOTS; i++) {
      try {
        const g = owner.turretDebris(TURRET_TYPES[i]);
        if (g) {
          g.visible = false;
          root.add(g);
          turretGroups[i] = g;
        }
      } catch (e) { turretGroups[i] = null; }
    }
  }

  function launchTurret(type, x, y, z, scale) {
    if (!turretGroups) return;
    let slot = -1;
    for (let i = 0; i < TURRET_SLOTS; i++) {
      if (turretGroups[i] && TURRET_TYPES[i] === type) { slot = i; break; }
    }
    if (slot < 0) {
      for (let i = 0; i < TURRET_SLOTS; i++) {
        if (turretGroups[i]) { slot = i; break; }
      }
    }
    if (slot < 0) return;
    const g = turretGroups[slot];
    trActive[slot] = 1;
    trDelay[slot] = K.turret.delay;
    trRemain[slot] = K.turret.life;
    trTotal[slot] = K.turret.life;
    trSettled[slot] = 0;
    trScale[slot] = scale > 0 ? scale : 1;
    const i3 = slot * 3;
    trPos[i3] = x; trPos[i3 + 1] = y + 0.2; trPos[i3 + 2] = z;
    const a = Math.random() * TAU;
    trVel[i3] = Math.cos(a) * UTILS.rand(0.6, 1.8);
    trVel[i3 + 1] = K.turret.launchVy;
    trVel[i3 + 2] = Math.sin(a) * UTILS.rand(0.6, 1.8);
    trRot[i3] = g.rotation.x;
    trRot[i3 + 1] = g.rotation.y;
    trRot[i3 + 2] = g.rotation.z;
    trSpin[i3] = UTILS.rand(-K.turret.spin, K.turret.spin);
    trSpin[i3 + 1] = UTILS.rand(-K.turret.spin, K.turret.spin);
    trSpin[i3 + 2] = UTILS.rand(-K.turret.spin, K.turret.spin);
    g.position.set(x, y + 0.2, z);
    g.scale.setScalar(trScale[slot]);
    g.visible = false; // 白闪之后再弹起（§5 车身白闪 → 炮塔弹起）
  }

  function updateTurrets(dt) {
    if (!turretGroups) return;
    for (let i = 0; i < TURRET_SLOTS; i++) {
      if (!trActive[i]) continue;
      const g = turretGroups[i];
      if (!g) { trActive[i] = 0; continue; }
      if (trDelay[i] > 0) {
        trDelay[i] -= dt;
        if (trDelay[i] > 0) continue;
        g.visible = true;
      }
      const rem = trRemain[i] - dt;
      if (rem <= 0) {
        trActive[i] = 0;
        g.visible = false;
        continue;
      }
      trRemain[i] = rem;
      const i3 = i * 3;
      trVel[i3 + 1] += K.turret.gravity * dt;
      let px = trPos[i3] + trVel[i3] * dt;
      let py = trPos[i3 + 1] + trVel[i3 + 1] * dt;
      let pz = trPos[i3 + 2] + trVel[i3 + 2] * dt;
      if (py < K.turret.groundY) {
        py = K.turret.groundY;
        if (!trSettled[i]) {
          trSettled[i] = 1;
          const vy = trVel[i3 + 1];
          trVel[i3 + 1] = vy < 0 ? -vy * K.turret.bounce : 0;
          if (trVel[i3 + 1] < 1.2) trVel[i3 + 1] = 0;
          trSpin[i3] *= 0.55;
          trSpin[i3 + 1] *= 0.55;
          trSpin[i3 + 2] *= 0.55;
        } else {
          trVel[i3 + 1] = 0;
          trVel[i3] *= 0.82;
          trVel[i3 + 2] *= 0.82;
        }
      }
      trPos[i3] = px; trPos[i3 + 1] = py; trPos[i3 + 2] = pz;
      trRot[i3] += trSpin[i3] * dt;
      trRot[i3 + 1] += trSpin[i3 + 1] * dt;
      trRot[i3 + 2] += trSpin[i3 + 2] * dt;
      let sc = trScale[i];
      if (rem < K.turret.shrinkAt) sc *= rem / K.turret.shrinkAt;
      if (sc < 0) sc = 0;
      g.position.set(px, py, pz);
      g.rotation.set(trRot[i3], trRot[i3 + 1], trRot[i3 + 2]);
      g.scale.setScalar(sc);
    }
  }

  // ---------------------------------------------------------------------------
  // 曳光线池（契约 §7 可选 tracer）
  // ---------------------------------------------------------------------------
  function buildTracer() {
    tracerPos = new Float32Array(MAX_TRACERS * 6);
    tracerCol = new Float32Array(MAX_TRACERS * 6);
    tracerBase = new Float32Array(MAX_TRACERS * 6);
    tracerGeo = new THREE.BufferGeometry();
    tracerGeo.setAttribute('position', new THREE.BufferAttribute(tracerPos, 3).setUsage(THREE.DynamicDrawUsage));
    tracerGeo.setAttribute('color', new THREE.BufferAttribute(tracerCol, 3).setUsage(THREE.DynamicDrawUsage));
    tracerMat = new THREE.LineBasicMaterial({
      vertexColors: true, transparent: true, opacity: 0.9,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    tracerMesh = new THREE.LineSegments(tracerGeo, tracerMat);
    tracerMesh.frustumCulled = false;
    tracerMesh.visible = false;
    tracerMesh.renderOrder = 17;
    root.add(tracerMesh);
    trcActive = new Uint8Array(MAX_TRACERS);
    trcRemain = new Float32Array(MAX_TRACERS);
    trcTotal = new Float32Array(MAX_TRACERS);
  }

  function addTracer(from, to, hex, life) {
    if (!built) return;
    let idx = -1;
    for (let n = 0; n < MAX_TRACERS; n++) {
      const i = (trcCur + n) % MAX_TRACERS;
      if (!trcActive[i]) { idx = i; trcCur = (i + 1) % MAX_TRACERS; break; }
    }
    if (idx < 0) { idx = trcCur; trcCur = (trcCur + 1) % MAX_TRACERS; if (trcActive[idx]) trcLive--; }
    if (!trcActive[idx]) trcLive++;
    trcActive[idx] = 1;
    trcRemain[idx] = life > 0 ? life : 0.1;
    trcTotal[idx] = trcRemain[idx];
    readPos(from, 0);
    const ax = _x, ay = _y, az = _z;
    readPos(to, 0);
    const bx = _x, by = _y, bz = _z;
    const i6 = idx * 6;
    tracerPos[i6] = ax; tracerPos[i6 + 1] = ay; tracerPos[i6 + 2] = az;
    tracerPos[i6 + 3] = bx; tracerPos[i6 + 4] = by; tracerPos[i6 + 5] = bz;
    hexRGB(hex);
    for (let k = 0; k < 6; k += 3) {
      tracerBase[i6 + k] = _cr;
      tracerBase[i6 + k + 1] = _cg;
      tracerBase[i6 + k + 2] = _cb;
      tracerCol[i6 + k] = _cr;
      tracerCol[i6 + k + 1] = _cg;
      tracerCol[i6 + k + 2] = _cb;
    }
    tracerGeo.attributes.position.needsUpdate = true;
    tracerGeo.attributes.color.needsUpdate = true;
    tracerMesh.visible = true;
  }

  function updateTracers(dt) {
    if (trcLive <= 0) return;
    let alive = 0;
    for (let i = 0; i < MAX_TRACERS; i++) {
      if (!trcActive[i]) continue;
      const rem = trcRemain[i] - dt;
      if (rem <= 0) {
        trcActive[i] = 0;
        const i6 = i * 6;
        for (let k = 0; k < 6; k++) tracerCol[i6 + k] = 0;
        continue;
      }
      trcRemain[i] = rem;
      const k = rem / trcTotal[i];
      const i6 = i * 6;
      for (let c = 0; c < 6; c++) tracerCol[i6 + c] = tracerBase[i6 + c] * k;
      alive++;
    }
    trcLive = alive;
    tracerGeo.attributes.color.needsUpdate = true;
    tracerMesh.visible = alive > 0;
  }

  // ---------------------------------------------------------------------------
  // 鹰毁延迟连爆队列（§5：2.5s 六连爆）
  // ---------------------------------------------------------------------------
  function buildBursts() {
    bqActive = new Uint8Array(MAX_BURSTS);
    bqT = new Float32Array(MAX_BURSTS);
    bqX = new Float32Array(MAX_BURSTS);
    bqY = new Float32Array(MAX_BURSTS);
    bqZ = new Float32Array(MAX_BURSTS);
    bqS = new Float32Array(MAX_BURSTS);
  }

  function queueBurst(x, y, z, scale, delay) {
    let idx = -1;
    for (let i = 0; i < MAX_BURSTS; i++) {
      if (!bqActive[i]) { idx = i; break; }
    }
    if (idx < 0) {
      let minT = Infinity;
      for (let i = 0; i < MAX_BURSTS; i++) {
        if (bqT[i] < minT) { minT = bqT[i]; idx = i; }
      }
    }
    if (idx < 0) idx = 0;
    bqActive[idx] = 1;
    bqT[idx] = delay > 0 ? delay : 0.1;
    bqX[idx] = x; bqY[idx] = y; bqZ[idx] = z; bqS[idx] = scale;
  }

  function updateBursts(dt) {
    for (let i = 0; i < MAX_BURSTS; i++) {
      if (!bqActive[i]) continue;
      bqT[i] -= dt;
      if (bqT[i] > 0) continue;
      bqActive[i] = 0;
      explosionAt(bqX[i], bqY[i], bqZ[i], bqS[i], true, C.fire);
    }
  }

  // ---------------------------------------------------------------------------
  // 全屏覆盖层（初始化建池，运行期只改透明度）
  // ---------------------------------------------------------------------------
  function buildDOM() {
    if (typeof document === 'undefined' || !document.body) return;
    elWhite = document.createElement('div');
    elWhite.id = 'fx-fallback-flash-white';
    elWhite.style.cssText = 'position:fixed;left:0;top:0;width:100%;height:100%;background:#ffffff;opacity:0;pointer-events:none;z-index:45;';
    document.body.appendChild(elWhite);

    elRed = document.createElement('div');
    elRed.id = 'fx-fallback-flash-red';
    elRed.style.cssText = 'position:fixed;left:0;top:0;width:100%;height:100%;background:#ff3020;opacity:0;pointer-events:none;z-index:44;';
    document.body.appendChild(elRed);

    elFreeze = document.createElement('div');
    elFreeze.id = 'fx-freeze-vignette';
    elFreeze.style.cssText = 'position:fixed;left:0;top:0;width:100%;height:100%;background:radial-gradient(ellipse at center, rgba(80,170,255,0) 42%, rgba(80,170,255,0.34) 76%, rgba(140,215,255,0.72) 100%);opacity:0;pointer-events:none;z-index:12;';
    document.body.appendChild(elFreeze);
  }

  function setElOpacity(el, v) {
    if (!el) return;
    let s;
    if (v < 0.002) s = '0';
    else if (v > 1) s = '1';
    else s = v.toFixed(3);
    if (el.style.opacity !== s) el.style.opacity = s;
  }

  function flashWhiteInternal(duration) {
    ffTotal = duration;
    ffT = duration;
    ffPeak = 0.92;
    setElOpacity(elWhite, ffPeak);
  }

  function flashRedInternal(duration) {
    frTotal = duration;
    frT = duration;
    frPeak = 0.5;
    setElOpacity(elRed, frPeak);
  }

  function updateOverlays(dt) {
    if (ffT > 0) {
      ffT -= dt;
      if (ffT <= 0) { ffT = 0; setElOpacity(elWhite, 0); }
      else setElOpacity(elWhite, ffPeak * (ffT / ffTotal));
    }
    if (frT > 0) {
      frT -= dt;
      if (frT <= 0) { frT = 0; setElOpacity(elRed, 0); }
      else setElOpacity(elRed, frPeak * (frT / frTotal));
    }
    if (fzT > 0) {
      fzT -= dt;
      if (fzT <= 0) { fzT = 0; setElOpacity(elFreeze, 0); }
      else {
        const p = 1 - fzT / fzTotal;
        setElOpacity(elFreeze, Math.sin(p * Math.PI) * fzPeak);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // 粒子事件配方（规格书 §5）
  // ---------------------------------------------------------------------------
  // 通用爆炸：火球 + 烟 + 火花 + 碎片 + 冲击环 + 动态光
  function explosionAt(x, y, z, scale, big, hex) {
    if (!built) return;
    const s = scale > 0 ? scale : 1;
    const ss = s > 2.5 ? 2.5 : s;
    hexRGB(hex);
    const fr = _cr, fg = _cg, fb = _cb;
    const nFire = Math.round(K.explosion.fire * (big ? 1.4 : 1) * ss) + 2;
    for (let i = 0; i < nFire; i++) {
      const a = Math.random() * TAU;
      const sp = UTILS.rand(1.4, 4.2) * Math.sqrt(ss);
      const hot = Math.random() < 0.35;
      spawnP(
        x + UTILS.rand(-0.16, 0.16),
        y + UTILS.rand(0.1, 0.8) * ss,
        z + UTILS.rand(-0.16, 0.16),
        Math.cos(a) * sp, UTILS.rand(0.8, 3.2), Math.sin(a) * sp,
        -2.5, 1.4, UTILS.rand(0.42, 0.78),
        UTILS.rand(0.55, 1.0) * ss, UTILS.rand(0.06, 0.18) * ss, 0.95,
        hot ? 1 : fr, hot ? 0.92 : fg, hot ? 0.72 : fb,
      );
    }
    const nSmoke = Math.round(K.explosion.smoke * (big ? 1.5 : 1) * ss) + 2;
    for (let i = 0; i < nSmoke; i++) {
      spawnP(
        x + UTILS.rand(-0.5, 0.5) * ss,
        y + UTILS.rand(0.2, 1.3) * ss,
        z + UTILS.rand(-0.5, 0.5) * ss,
        UTILS.rand(-0.6, 0.6), UTILS.rand(0.6, 1.8), UTILS.rand(-0.6, 0.6),
        0.2, 1.1, UTILS.rand(0.8, 1.5),
        UTILS.rand(0.5, 0.9) * ss, UTILS.rand(1.5, 2.4) * ss, 0.32,
        0.30, 0.28, 0.26,
      );
    }
    const nSpark = Math.round(K.explosion.sparks * (big ? 1.4 : 1) * ss) + 2;
    for (let i = 0; i < nSpark; i++) {
      const a = Math.random() * TAU;
      const sp = UTILS.rand(4, 9) * Math.sqrt(ss);
      spawnP(
        x, y + UTILS.rand(0.2, 0.9), z,
        Math.cos(a) * sp, UTILS.rand(1, 5), Math.sin(a) * sp,
        -18, 0.5, UTILS.rand(0.22, 0.45),
        UTILS.rand(0.12, 0.18), 0.01, 0.95,
        1, 0.94, 0.72,
      );
    }
    const nDeb = Math.min(16, Math.round(K.explosion.debris * (big ? 1.5 : 1) * ss));
    for (let i = 0; i < nDeb; i++) {
      const a = Math.random() * TAU;
      const sp = UTILS.rand(2, 5.5);
      spawnD(
        x + UTILS.rand(-0.3, 0.3), y + UTILS.rand(0.2, 0.8), z + UTILS.rand(-0.3, 0.3),
        Math.cos(a) * sp, UTILS.rand(2, 5), Math.sin(a) * sp,
        UTILS.rand(0.12, 0.28), K.debris.life, C.debris, 4,
      );
    }
    addRing(x, 0.05, z, hex, 0.25 * ss, 1.8 * ss, 0.5, 0.9);
    addLight(x, y + 0.5 * ss, z, big ? 0xffd27a : hex, (big ? 30 : 16) * (ss > 1 ? ss : 1), 0.45);
    if (big) addFlash(x, y + 0.6 * ss, z, C.fireHot, 2.6 * ss, 0.16, 2.2, 0.95);
  }

  // 冻结期间持续飘落的雪花粒子
  function emitSnow(dt) {
    if (snowRemain <= 0) return;
    snowRemain -= dt;
    snowAcc += dt;
    const iv = K.snow.interval;
    let guard = 0;
    while (snowAcc >= iv && guard < 4) {
      snowAcc -= iv;
      guard++;
      const sx = UTILS.rand(-12.5, 12.5);
      const sz = UTILS.rand(-12.5, 12.5);
      const sy = UTILS.rand(K.snow.minY, K.snow.maxY);
      spawnP(
        sx, sy, sz,
        UTILS.rand(-0.25, 0.25), UTILS.rand(-1.2, -0.7), UTILS.rand(-0.25, 0.25),
        0, 0.08, K.snow.life, 0.09, 0.055, 0.55,
        0.72, 0.86, 1.0,
      );
    }
    if (snowRemain < 0) snowRemain = 0;
  }

  // ---------------------------------------------------------------------------
  // 构建入口
  // ---------------------------------------------------------------------------
  function build() {
    scoreHex = toHex(CONFIG.colors.scoreText);
    root = new THREE.Group();
    root.name = 'FX';
    if (!qQuality) qQuality = resolveQuality(null);
    pCap = Math.min(MAX_P, CONFIG.fx.particles[qQuality] || CONFIG.fx.particles.high);
    buildParticles();
    buildDebris();
    buildRings();
    buildFlashes();
    buildScores();
    buildLights();
    buildBeams();
    buildBubbles();
    buildTurretDebris();
    buildTracer();
    buildBursts();
    buildDOM();
    built = true;
  }

  // ---------------------------------------------------------------------------
  // 公开 API（契约 §7）
  // ---------------------------------------------------------------------------
  const api = {
    trauma: 0,

    // 创建/挂载全部池；可重复调用（先清场，再挂到新场景）
    init(scene) {
      if (!scene) return;
      if (!built) build();
      if (root.parent && root.parent !== scene) root.parent.remove(root);
      scene.add(root);
      api.clear();
      applyCap();
    },

    // 推进特效；camera 仅用于浮动分数的屏幕横向排布
    update(dt, camera) {
      if (!built) return;
      let d = (typeof dt === 'number' && dt > 0) ? dt : 0;
      if (d > 0.1) d = 0.1;
      if (camera && camera.matrixWorld) {
        const e = camera.matrixWorld.elements;
        const len = Math.hypot(e[0], e[1], e[2]);
        if (len > 1e-6) {
          camRight.x = e[0] / len;
          camRight.y = e[1] / len;
          camRight.z = e[2] / len;
        }
      }
      if (api.trauma > 0) {
        api.trauma -= CONFIG.camera.shake.decay * d;
        if (api.trauma < 0) api.trauma = 0;
      }
      emitSnow(d);
      updateParticles(d);
      updateDebris(d);
      updateRings(d);
      updateFlashes(d);
      updateBeams(d);
      updateBubbles(d);
      updateTurrets(d);
      updateScores(d);
      updateLights(d);
      updateTracers(d);
      updateBursts(d);
      updateOverlays(d);
      if (pPoints) pPoints.visible = pLive > 0;
      if (pMat) {
        const h = (G && G.renderer && G.renderer.domElement) ? G.renderer.domElement.height : 0;
        if (h > 0) pMat.uniforms.uScale.value = h * 0.5;
        else if (pMat.uniforms.uScale.value !== K.pointScale) pMat.uniforms.uScale.value = K.pointScale;
      }
    },

    // 画质切换：只改变粒子激活上限（容量已按 CONFIG.fx.particles 预建，§8）
    setQuality(level) {
      let next = null;
      if (level === 'high' || level === 'medium' || level === 'low') next = level;
      if (!next) return;
      qQuality = next;
      if (!built) return;
      applyCap();
    },

    // 换关/回标题清场：回收所有池
    clear() {
      if (!built) return;
      pLive = 0;
      pActive.fill(0);
      pSizeF32.fill(0);
      pLifeF32.fill(0);
      pRemain.fill(0);
      pVelF32.fill(0);
      pGravF32.fill(0);
      for (let i = 0; i < MAX_P; i++) pPosF32[i * 3 + 1] = -60;
      pPosAttr.needsUpdate = true;
      pColAttr.needsUpdate = true;
      pSizeAttr.needsUpdate = true;
      pLifeAttr.needsUpdate = true;
      pVelAttr.needsUpdate = true;
      pGravAttr.needsUpdate = true;
      pPoints.visible = false;
      pCur = 0;

      dLive = 0;
      dActive.fill(0);
      dRemain.fill(0);
      dPos.fill(0);
      dVel.fill(0);
      dRot.fill(0);
      dSpin.fill(0);
      for (let i = 0; i < MAX_D; i++) {
        dDummy.position.set(0, -60, 0);
        dDummy.rotation.set(0, 0, 0);
        dDummy.scale.setScalar(0);
        dDummy.updateMatrix();
        dMesh.setMatrixAt(i, dDummy.matrix);
      }
      dMesh.instanceMatrix.needsUpdate = true;
      dMesh.visible = false;
      dCur = 0;

      for (let i = 0; i < MAX_R; i++) {
        rActive[i] = 0;
        ringMeshes[i].visible = false;
        ringMats[i].opacity = 0;
      }
      for (let i = 0; i < MAX_F; i++) {
        fActive[i] = 0;
        flashSprites[i].visible = false;
        flashMats[i].opacity = 0;
      }
      fLive = 0;
      for (let i = 0; i < MAX_SCORE; i++) {
        scActive[i] = 0;
        scoreSprites[i].visible = false;
        scoreMats[i].opacity = 0;
      }
      scLive = 0;
      for (let i = 0; i < MAX_LIGHT; i++) {
        lActive[i] = 0;
        lRemain[i] = 0;
        lightPool[i].intensity = 0;
      }
      for (let i = 0; i < beamMeshes.length; i++) {
        bmActive[i] = 0;
        beamMeshes[i].visible = false;
        beamMats[i].opacity = 0;
      }
      bmLive = 0;
      for (let i = 0; i < bubbleMeshes.length; i++) {
        bbActive[i] = 0;
        bubbleMeshes[i].visible = false;
        bubbleMats[i].opacity = 0;
      }
      bbLive = 0;
      if (turretGroups) {
        for (let i = 0; i < TURRET_SLOTS; i++) {
          trActive[i] = 0;
          trRemain[i] = 0;
          const g = turretGroups[i];
          if (g) {
            g.visible = false;
            g.scale.setScalar(1);
          }
        }
      }
      for (let i = 0; i < MAX_TRACERS; i++) {
        trcActive[i] = 0;
        const i6 = i * 6;
        for (let k = 0; k < 6; k++) tracerCol[i6 + k] = 0;
      }
      tracerGeo.attributes.color.needsUpdate = true;
      tracerMesh.visible = false;
      trcLive = 0;
      bqActive.fill(0);
      snowRemain = 0;
      snowAcc = 0;
      ffT = 0; ffTotal = 0; frT = 0; frTotal = 0; fzT = 0; fzTotal = 0;
      setElOpacity(elWhite, 0);
      setElOpacity(elRed, 0);
      setElOpacity(elFreeze, 0);
      api.trauma = 0;
    },

    // 震屏：Main 读取 trauma 做相机偏移，update 内按 1.8/s 衰减（§4）
    shake(amount) {
      if (!Number.isFinite(amount) || amount <= 0) return;
      api.trauma += amount;
      if (api.trauma > K.traumaMax) api.trauma = K.traumaMax;
    },

    // 通用爆炸
    explosion(pos, opts) {
      if (!built) return;
      let scale = 1;
      let big = false;
      let hex = C.fire;
      if (opts) {
        if (typeof opts.scale === 'number' && Number.isFinite(opts.scale) && opts.scale > 0) scale = opts.scale;
        if (opts.big) big = true;
        if (opts.color !== undefined) hex = opts.color;
      }
      readPos(pos, 0.6);
      explosionAt(_x, _y, _z, scale, big, hex);
    },

    // 炮口开火：火光精灵 + 光池 60ms + 火花 3–5 + 震屏（后坐由 Entities 模型负责）
    muzzleFlash(pos, dir) {
      if (!built) return;
      readPos(pos, 0.8);
      readDir(dir);
      const x = _x, y = _y, z = _z;
      const dx = _dx, dy = _dy, dz = _dz;
      addFlash(x + dx * 0.06, y + dy * 0.06, z + dz * 0.06, C.fireHot, 0.9, K.muzzle.flashLife, 2.6, 1);
      addLight(x + dx * 0.12, y + dy * 0.12, z + dz * 0.12, 0xffb060, K.muzzle.lightIntensity, K.muzzle.lightLife);
      const n = UTILS.randInt(K.muzzle.sparkMin, K.muzzle.sparkMax);
      for (let i = 0; i < n; i++) {
        const sp = UTILS.rand(3.2, 6.4);
        spawnP(
          x + dx * 0.15, y + dy * 0.15, z + dz * 0.15,
          dx * sp + UTILS.rand(-1.2, 1.2),
          dy * sp + UTILS.rand(-0.3, 1.0),
          dz * sp + UTILS.rand(-1.2, 1.2),
          -7, 0.45, UTILS.rand(0.12, 0.22),
          0.15, 0.02, 0.95,
          1, i === 0 ? 1 : 0.82, i === 0 ? 1 : 0.48,
        );
      }
    },

    // 命中砖：砖屑 5 + 棕色尘雾 + 震 .04
    impactBrick(pos, dir) {
      if (!built) return;
      readPos(pos, 0.9);
      readDir(dir);
      const x = _x, y = _y, z = _z;
      const dx = _dx, dz = _dz;
      for (let i = 0; i < K.brick.debris; i++) {
        spawnD(
          x + UTILS.rand(-0.2, 0.2), y + UTILS.rand(-0.1, 0.3), z + UTILS.rand(-0.2, 0.2),
          -dx * UTILS.rand(1.2, 3.2) + UTILS.rand(-1.6, 1.6),
          UTILS.rand(1.6, 4.2),
          -dz * UTILS.rand(1.2, 3.2) + UTILS.rand(-1.6, 1.6),
          UTILS.rand(0.12, 0.24), K.debris.life, C.brick, 5,
        );
      }
      for (let i = 0; i < K.brick.dust; i++) {
        spawnP(
          x + UTILS.rand(-0.45, 0.45), y + UTILS.rand(-0.1, 0.5), z + UTILS.rand(-0.45, 0.45),
          -dx * UTILS.rand(0.2, 1.2) + UTILS.rand(-0.7, 0.7),
          UTILS.rand(0.3, 0.9),
          -dz * UTILS.rand(0.2, 1.2) + UTILS.rand(-0.7, 0.7),
          -1.0, 1.8, UTILS.rand(0.5, 0.9),
          0.18, 0.9, 0.35,
          0.42, 0.27, 0.14,
        );
      }
    },

    // 命中钢：白橙火花扇形 10 + 金属碎片 2 + 震 .08
    impactSteel(pos, dir) {
      if (!built) return;
      readPos(pos, 1.1);
      readDir(dir);
      const x = _x, y = _y, z = _z;
      const dx = _dx, dy = _dy, dz = _dz;
      for (let i = 0; i < K.steel.sparks; i++) {
        let vx = -dx * UTILS.rand(2.4, 5.0) + UTILS.rand(-2.0, 2.0);
        let vy = UTILS.rand(1.2, 3.8) + dy * 1.5;
        let vz = -dz * UTILS.rand(2.4, 5.0) + UTILS.rand(-2.0, 2.0);
        const len = Math.hypot(vx, vy, vz);
        if (len > 1e-6) {
          const sp = UTILS.rand(3.6, 7.2) / len;
          vx *= sp; vy *= sp; vz *= sp;
        }
        spawnP(
          x + UTILS.rand(-0.1, 0.1), y + UTILS.rand(-0.1, 0.2), z + UTILS.rand(-0.1, 0.1),
          vx, vy, vz, -16, 0.55, UTILS.rand(0.2, 0.38),
          UTILS.rand(0.11, 0.16), 0.01, 0.95,
          1, i % 2 === 0 ? 0.95 : 0.62, i % 2 === 0 ? 0.78 : 0.25,
        );
      }
      for (let i = 0; i < K.steel.debris; i++) {
        spawnD(
          x + UTILS.rand(-0.15, 0.15), y + UTILS.rand(0, 0.3), z + UTILS.rand(-0.15, 0.15),
          -dx * UTILS.rand(1.5, 3.0) + UTILS.rand(-1.2, 1.2),
          UTILS.rand(2.0, 4.0),
          -dz * UTILS.rand(1.5, 3.0) + UTILS.rand(-1.2, 1.2),
          UTILS.rand(0.1, 0.18), K.debris.life, C.steel, 6,
        );
      }
    },

    // 子弹互消：十字火花 8
    bulletCancel(pos) {
      if (!built) return;
      readPos(pos, 0.8);
      const x = _x, y = _y, z = _z;
      for (let i = 0; i < K.cancel.sparks; i++) {
        const d = CROSS8[i % CROSS8.length];
        const sp = UTILS.rand(3.0, 5.6);
        spawnP(
          x, y, z,
          d[0] * sp + UTILS.rand(-0.5, 0.5),
          d[1] * sp + UTILS.rand(-0.2, 0.6),
          d[2] * sp + UTILS.rand(-0.5, 0.5),
          -6, 1.5, UTILS.rand(0.18, 0.3),
          UTILS.rand(0.12, 0.17), 0.01, 0.95,
          i % 2 === 0 ? 1 : 1, i % 2 === 0 ? 0.95 : 0.72, i % 2 === 0 ? 0.8 : 0.32,
        );
      }
    },

    // 敌坦克亡 / 玩家亡（强化 1.5 倍）
    tankDeath(pos, opts) {
      if (!built) return;
      let player = false;
      let color = 0x8f8f96;
      let turretType = 'basic';
      if (opts) {
        if (opts.player) player = true;
        if (opts.color !== undefined) color = opts.color;
        if (typeof opts.turretType === 'string') turretType = opts.turretType;
      }
      readPos(pos, 0.6);
      const x = _x, y = _y, z = _z;
      const m = player ? K.death.playerScale : 1;

      // 车身白闪
      addFlash(x, y + 0.45 * m, z, C.white, 1.9 * m, 0.13, 1.9, 1);
      // 炮塔弹起抛物线
      launchTurret(turretType, x, y, z, player ? m : 1);
      // 火球 ×4（玩家 ×1.5 → 6）
      const nFire = Math.round(K.death.fire * m);
      for (let i = 0; i < nFire; i++) {
        const a = Math.random() * TAU;
        const sp = UTILS.rand(1.6, 3.6);
        spawnP(
          x + UTILS.rand(-0.3, 0.3), y + UTILS.rand(0.4, 1.0) * m, z + UTILS.rand(-0.3, 0.3),
          Math.cos(a) * sp, UTILS.rand(1.4, 3.4) * m, Math.sin(a) * sp,
          -3, 1.3, UTILS.rand(0.5, 0.75) * m,
          UTILS.rand(0.8, 1.15) * m, UTILS.rand(0.1, 0.25) * m, 0.95,
          1, i % 3 === 0 ? 0.92 : 0.63, i % 3 === 0 ? 0.68 : 0.25,
        );
      }
      // 烟雾 ×12（玩家 ×1.5 → 18）上飘
      const nSmoke = Math.round(K.death.smoke * m);
      for (let i = 0; i < nSmoke; i++) {
        spawnP(
          x + UTILS.rand(-0.6, 0.6) * m, y + UTILS.rand(0.3, 1.1) * m, z + UTILS.rand(-0.6, 0.6) * m,
          UTILS.rand(-0.7, 0.7), UTILS.rand(0.8, 1.9), UTILS.rand(-0.7, 0.7),
          0.15, 1.0, UTILS.rand(0.9, 1.55),
          UTILS.rand(0.55, 0.9) * m, UTILS.rand(1.6, 2.5) * m, 0.34,
          0.32, 0.30, 0.28,
        );
      }
      // 碎片 ×8（玩家 ×1.5 → 12）
      const bodyHex = toHex(color);
      const nDeb = Math.round(K.death.debris * m);
      for (let i = 0; i < nDeb; i++) {
        const a = Math.random() * TAU;
        const sp = UTILS.rand(2.0, 5.0);
        spawnD(
          x + UTILS.rand(-0.5, 0.5), y + UTILS.rand(0.3, 0.9), z + UTILS.rand(-0.5, 0.5),
          Math.cos(a) * sp, UTILS.rand(2.5, 5.5) * m, Math.sin(a) * sp,
          UTILS.rand(0.12, 0.26) * (m > 1 ? 1.25 : 1), K.debris.life,
          i % 3 === 0 ? C.steel : bodyHex, 7,
        );
      }
      // 地面冲击环 0.5s + 橙色光脉冲（震屏与红屏闪由 Entities 在击杀流程调用）
      addRing(x, 0.05, z, C.orange, 0.4 * m, 2.8 * m, K.death.ringLife, 0.92);
      addLight(x, y + 0.8, z, C.orange, 22 * m, K.death.lightLife);
    },

    // 敌出生：竖直光柱收束 1s + 双扩散环 + 上升粒子
    spawnBeam(pos) {
      if (!built) return;
      readPos(pos, 0);
      const x = _x, y = _y, z = _z;
      addBeam(x, y, z, C.spawn, K.spawn.beamHeight, K.spawn.beamRadius, K.spawn.life, 0.9);
      addRing(x, y + 0.06, z, C.cyanSoft, 0.3, K.spawn.ringScale, K.spawn.life, 0.9);
      addRing(x, y + 0.06, z, C.spawn, 0.15, 1.45, K.spawn.life * 0.85, 0.75);
      for (let i = 0; i < K.spawn.rise; i++) {
        const a = Math.random() * TAU;
        spawnP(
          x + Math.cos(a) * UTILS.rand(0.2, 0.9), y + UTILS.rand(0, 1.5), z + Math.sin(a) * UTILS.rand(0.2, 0.9),
          Math.cos(a) * UTILS.rand(0.1, 0.4), UTILS.rand(1.8, 3.4), Math.sin(a) * UTILS.rand(0.1, 0.4),
          0, 0.2, UTILS.rand(0.8, 1.2),
          UTILS.rand(0.1, 0.16), 0.02, 0.9,
          0.7, 0.92, 1.0,
        );
      }
      addLight(x, y + 1.2, z, 0x8fd8ff, 14, K.spawn.life);
    },

    // 道具出现：光柱落地 + 金粒旋落
    powerupSpawn(pos) {
      if (!built) return;
      readPos(pos, 0);
      const x = _x, y = _y, z = _z;
      addBeam(x, y, z, C.gold, K.powerupSpawn.beamHeight, 0.9, 0.9, 0.85);
      addRing(x, y + 0.06, z, C.gold, 0.2, 1.9, 0.8, 0.85);
      for (let i = 0; i < K.powerupSpawn.gold; i++) {
        const a = (i / K.powerupSpawn.gold) * TAU;
        const rad = UTILS.rand(0.4, 1.2);
        spawnP(
          x + Math.cos(a) * rad, y + UTILS.rand(2.6, 3.8), z + Math.sin(a) * rad,
          Math.cos(a) * 0.65, UTILS.rand(-2.0, -1.2), Math.sin(a) * 0.65,
          0.4, 0.2, UTILS.rand(1.2, 1.6),
          UTILS.rand(0.08, 0.14), 0.02, 0.95,
          1.0, 0.82, 0.32,
        );
      }
      addLight(x, y + 1.0, z, C.gold, 16, 0.9);
    },

    // 道具拾取：爆星 20（§5；+500 浮字由 Entities 调 FX.scoreText，避免重复）
    powerupPickup(pos) {
      if (!built) return;
      readPos(pos, 1.0);
      const x = _x, y = _y, z = _z;
      for (let i = 0; i < K.pickup.stars; i++) {
        const a = (i / K.pickup.stars) * TAU + UTILS.rand(-0.15, 0.15);
        const vy = UTILS.rand(-0.8, 1.6);
        const sp = UTILS.rand(2.6, 5.6);
        spawnP(
          x, y, z,
          Math.cos(a) * sp, vy * 2.2, Math.sin(a) * sp,
          -6, 1.0, UTILS.rand(0.35, 0.55),
          UTILS.rand(0.14, 0.22), 0.02, 1.0,
          i % 2 === 0 ? 1 : 1, i % 2 === 0 ? 0.88 : 0.95, i % 2 === 0 ? 0.35 : 0.55,
        );
      }
      addFlash(x, y, z, C.gold, 1.0, K.pickup.flashLife, 2.2, 0.9);
      addRing(x, y, z, C.gold, 0.3, 2.0, K.pickup.ringLife, 0.85);
      addLight(x, y + 0.5, z, C.gold, 18, 0.35);
    },

    // 护盾受击：泡泡脉冲 + 青色电纹粒子
    shieldHit(pos) {
      if (!built) return;
      readPos(pos, 0.7);
      const x = _x, y = _y, z = _z;
      addBubble(x, y, z, C.cyan, 0.75, 1.45, K.shield.bubbleLife);
      for (let i = 0; i < K.shield.sparks; i++) {
        const a = (i / K.shield.sparks) * TAU + UTILS.rand(-0.2, 0.2);
        const sp = UTILS.rand(1.8, 4.2);
        spawnP(
          x + Math.cos(a) * 0.5, y + UTILS.rand(-0.2, 0.5), z + Math.sin(a) * 0.5,
          Math.cos(a) * sp, UTILS.rand(-0.4, 1.2), Math.sin(a) * sp,
          -2.5, 0.8, UTILS.rand(0.2, 0.36),
          UTILS.rand(0.09, 0.14), 0.01, 0.95,
          i % 2 === 0 ? 0.35 : 0.7, i % 2 === 0 ? 0.95 : 1.0, 1.0,
        );
      }
      addRing(x, 0.06, z, C.cyan, 0.5, 1.7, 0.35, 0.8);
      addLight(x, y + 0.3, z, C.cyan, 12, 0.28);
    },

    // 冰面滑行：履带后冰晶屑
    iceTrail(pos, dir) {
      if (!built) return;
      readPos(pos, 0.05);
      readDir(dir);
      const x = _x, y = _y, z = _z;
      const dx = _dx, dz = _dz;
      for (let i = 0; i < K.ice.count; i++) {
        spawnP(
          x + UTILS.rand(-0.35, 0.35), y + UTILS.rand(0, 0.1), z + UTILS.rand(-0.35, 0.35),
          -dx * UTILS.rand(0.3, 1.1) + UTILS.rand(-0.5, 0.5),
          UTILS.rand(0.4, 1.4),
          -dz * UTILS.rand(0.3, 1.1) + UTILS.rand(-0.5, 0.5),
          -4, 1.8, UTILS.rand(0.28, 0.48),
          UTILS.rand(0.08, 0.14), 0.02, 0.85,
          0.82, 0.95, 1.0,
        );
      }
    },

    // 移动扬尘（实体按 CONFIG.fx.dustInterval 节流后调用）
    dust(pos, color) {
      if (!built) return;
      readPos(pos, 0.05);
      hexRGB(color === undefined ? CONFIG.colors.dust : color);
      const r = _cr, g = _cg, b = _cb;
      spawnP(
        _x + UTILS.rand(-0.4, 0.4), _y + UTILS.rand(0, 0.12), _z + UTILS.rand(-0.4, 0.4),
        UTILS.rand(-0.25, 0.25), UTILS.rand(0.18, 0.5), UTILS.rand(-0.25, 0.25),
        -0.5, 1.5, UTILS.rand(0.6, 0.9),
        0.16, 0.55, 0.3,
        r, g, b,
      );
    },

    // 子弹过河：涟漪环 + 白色水花 6
    waterRipple(pos) {
      if (!built) return;
      readPos(pos, CONFIG.field.waterHeight);
      const x = _x, y = _y, z = _z;
      addRing(x, y + 0.02, z, C.water, 0.3, 1.75, K.water.rippleLife, 0.85);
      for (let i = 0; i < K.water.splash; i++) {
        const a = (i / K.water.splash) * TAU + UTILS.rand(-0.3, 0.3);
        spawnP(
          x + Math.cos(a) * UTILS.rand(0.1, 0.4), y + 0.05, z + Math.sin(a) * UTILS.rand(0.1, 0.4),
          Math.cos(a) * UTILS.rand(0.4, 1.3), UTILS.rand(1.8, 3.6), Math.sin(a) * UTILS.rand(0.4, 1.3),
          -9, 0.4, UTILS.rand(0.35, 0.55),
          0.12, 0.02, 0.9,
          0.86, 0.95, 1.0,
        );
      }
    },

    // 鹰徽毁灭：金碎片 16 + 超大火球 + 三连冲击环 + 2.5s 六连爆 + 白闪
    baseDestroyed(pos) {
      if (!built) return;
      readPos(pos, 0.9);
      const x = _x, y = _y, z = _z;
      for (let i = 0; i < K.eagle.goldDebris; i++) {
        const a = Math.random() * TAU;
        const sp = UTILS.rand(2.0, 6.0);
        spawnD(
          x + UTILS.rand(-0.6, 0.6), y + UTILS.rand(0.2, 1.2), z + UTILS.rand(-0.6, 0.6),
          Math.cos(a) * sp, UTILS.rand(3, 7), Math.sin(a) * sp,
          UTILS.rand(0.14, 0.3), K.debris.life, C.gold, 9,
        );
      }
      explosionAt(x, y + 0.4, z, 2.2, true, C.fire);
      addRing(x, 0.05, z, C.gold, 0.6, 4.8, 0.7, 0.92);
      addRing(x, 0.06, z, C.white, 0.3, 3.2, 1.0, 0.85);
      addRing(x, 0.07, z, C.orange, 1.0, 6.5, 1.3, 0.8);
      addFlash(x, y + 1.0, z, C.white, 5.0, K.eagle.flashLife, 2.0, 1);
      addLight(x, y + 1.4, z, 0xffce6a, 55, K.eagle.lightLife);
      // 2.5s 六连爆（§5）
      for (let i = 0; i < K.eagle.bursts; i++) {
        const a = Math.random() * TAU;
        const rad = UTILS.rand(0.4, 3.6);
        queueBurst(
          x + Math.cos(a) * rad,
          0.4 + Math.random() * 1.2,
          z + Math.sin(a) * rad,
          UTILS.rand(0.8, 1.4),
          K.eagle.burstStart + i * K.eagle.burstGap,
        );
      }
      // 震屏（Game 当前只做慢动作/白闪，鹰毁的 .5 由 FX 补足；§4）
      api.shake(CONFIG.fx.shake.eagleDeath);
      api.flashWhite(0.45);
    },
    // 3D 浮动分数（池 12）
    scoreText(pos, value) {
      if (!built) return;
      readPos(pos, 0.8);
      addScore(_x, _y + 0.3, _z, value);
    },

    // 借用 6 个动态点光中的一个
    light(pos, color, intensity, life) {
      if (!built) return;
      readPos(pos, 0.5);
      addLight(_x, _y, _z, color, intensity, life);
    },

    // 全屏白闪：优先 UI，UI 不可用时用内部覆盖层
    flashWhite(duration) {
      if (!built) return;
      const d = (typeof duration === 'number' && Number.isFinite(duration) && duration > 0) ? duration : 0.25;
      if (uiCall('flashWhite', d)) return;
      flashWhiteInternal(d);
    },

    // 全屏红闪：优先 UI，UI 不可用时用内部覆盖层（玩家亡由 Entities 调用）
    flashRed(duration) {
      if (!built) return;
      const d = (typeof duration === 'number' && Number.isFinite(duration) && duration > 0) ? duration : 0.35;
      if (uiCall('flashRed', d)) return;
      flashRedInternal(d);
    },

    // 定时器生效：蓝色边缘渐晕 0.5s（§5），并启动期间雪花粒子
    freezeOverlay() {
      if (!built) return;
      if (!uiCall('freezeOverlay', 0.5)) {
        fzTotal = 0.5;
        fzT = 0.5;
        fzPeak = 1;
        setElOpacity(elFreeze, 0);
      }
      let dur = CONFIG.powerup.freezeTime;
      if (G && G.effects && typeof G.effects.freeze === 'number' && G.effects.freeze > 0) {
        dur = G.effects.freeze;
      }
      if (dur > snowRemain) snowRemain = dur;
      snowAcc = 0;
    },

    // 铁锹：砖→钢变换闪光 + 石屑
    shovelFlash(pos) {
      if (!built) return;
      readPos(pos, 0.8);
      const x = _x, y = _y, z = _z;
      addFlash(x, y, z, C.gold, 0.85, 0.16, 2.0, 0.9);
      addRing(x, 0.06, z, C.gold, 0.3, 1.6, 0.4, 0.8);
      for (let i = 0; i < K.shovel.debris; i++) {
        const a = Math.random() * TAU;
        const sp = UTILS.rand(1.0, 3.0);
        spawnD(
          x + UTILS.rand(-0.4, 0.4), y + UTILS.rand(-0.2, 0.4), z + UTILS.rand(-0.4, 0.4),
          Math.cos(a) * sp, UTILS.rand(1.5, 4.0), Math.sin(a) * sp,
          UTILS.rand(0.08, 0.16), K.debris.life,
          i % 2 === 0 ? C.brick : C.stone, 6,
        );
      }
      addLight(x, y + 0.4, z, C.gold, 14, 0.25);
    },

    // 通用冲击环
    ring(pos, opts) {
      if (!built) return;
      let hex = C.orange;
      let scale = 1;
      let duration = K.ring.duration;
      if (opts) {
        if (opts.color !== undefined) hex = opts.color;
        if (typeof opts.scale === 'number' && Number.isFinite(opts.scale) && opts.scale > 0) scale = opts.scale;
        if (typeof opts.duration === 'number' && Number.isFinite(opts.duration) && opts.duration > 0) duration = opts.duration;
      }
      readPos(pos, 0.05);
      addRing(_x, _y, _z, hex, 0.25 * scale, 1.8 * scale, duration, K.ring.opacity);
    },

    // 可选：两点间曳光线
    tracer(from, to, color) {
      if (!built) return;
      addTracer(from, to, color === undefined ? C.spark : color, 0.12);
    },
  };

  return api;
})();
