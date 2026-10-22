// ============================================================================
// 13-models.js — Models（规格书 §3/§4；契约 §6）
// 全部模型由程序化 BufferGeometry / 基础几何组合而成，flatShading 低多边形；
// 无外部模型、无外部贴图（贴图来自 Tex / Mat，见契约 §5）。
// 顶层只暴露 const Models（契约 §0/§6）。
//
// 朝向约定（契约 §2）：模型正面朝 -Z；group 原点 = 车底中心（y=0 触地）。
// 层级：group → body（车体/履带/轮组）、turret（炮塔）→ barrel（炮管）→ muzzle。
// 每个 TankModel 实例独立克隆全部材质与履带贴图，因此改色/透明/冻结/闪白互不影响。
// ============================================================================
const Models = (() => {
  // ---------------------------------------------------------------------------
  // 局部常量（契约 §1：可调数值集中声明，不做魔法数字）
  // ---------------------------------------------------------------------------
  const ENEMY_TYPES = ['basic', 'fast', 'power', 'armor'];
  const ALL_TYPES = ['player'].concat(ENEMY_TYPES);

  const RECOIL_OFFSET = (CONFIG.bullet && Number.isFinite(CONFIG.bullet.recoil))
    ? CONFIG.bullet.recoil : 0.18;                         // §2 炮管后坐 0.18
  const RECOIL_RETURN = (CONFIG.bullet && Number.isFinite(CONFIG.bullet.recoilReturn))
    ? CONFIG.bullet.recoilReturn : 6;                      // §2 以 6/s 回弹（指数回弹速率）
  const HIT_FLASH_TIME = 0.1;                              // §3 装甲车受击闪白 0.1s
  const ARMOR_FLASH_HZ = 9;                                // §3 装甲车 1 血时高频闪白（次/秒）
  const FREEZE_TINT = (CONFIG.enemy && Number.isFinite(CONFIG.enemy.freezeTint))
    ? CONFIG.enemy.freezeTint : 0.55;                      // §3 冻结时颜色乘 0.55 并深蓝化
  const SHADOW_DECAL_Y = 0.02;                             // §4 根部接触阴影 y=0.02
  const TRACK_UV_TILES = 6;                                // 履带纹理沿车长的重复次数
  const TRACK_SCROLL_GAIN = 0.85;                          // 履带 offset 视觉滚动系数
  const WHEEL_SEGMENTS = 8;                                // 轮组低多边形段数
  const HUB_SEGMENTS = 6;                                  // 轮毂段数
  const TORUS_TUBE_SEGMENTS = 3;                           // 火力环环管段数
  const TORUS_RADIAL_SEGMENTS = 10;                        // 火力环圆周段数
  const FIRE_RING_COLOR = 0xff9a2e;                        // §4 炮管橙色发光环
  const MAX_FIRE_LEVEL = 3;                                // §2 玩家火力等级 0..3
  const UV_SCALE = 0.5;                                    // 程序化面 UV 密度
  const HP_TO_ARMOR_INDEX_BASE = 4;                        // 装甲车 4 HP 对应第一段颜色

  // 装甲车血量颜色（§3；CONFIG 缺失时回退到规格书原始值）
  const ARMOR_COLORS = (CONFIG.enemy && Array.isArray(CONFIG.enemy.armorColors)
    && CONFIG.enemy.armorColors.length >= 3)
    ? CONFIG.enemy.armorColors.slice(0, 3)
    : ['#4f7d5c', '#b8a24a', '#cfd6dd'];

  const _tmpColor = new THREE.Color();

  // ---------------------------------------------------------------------------
  // 材质安全获取（Tex / Mat 由 texture-dev 实现；缺失时回退，避免运行时报错）
  // ---------------------------------------------------------------------------
  function makeStandard(colorValue, metalness, roughness) {
    const color = new THREE.Color(colorValue === undefined ? '#888888' : colorValue);
    return new THREE.MeshStandardMaterial({
      color, metalness: metalness === undefined ? 0.3 : metalness,
      roughness: roughness === undefined ? 0.55 : roughness,
      flatShading: true,
    });
  }

  function pickMaterial(base, colorValue, metalness, roughness) {
    if (base && base.isMaterial && typeof base.clone === 'function') return base;
    return makeStandard(colorValue, metalness, roughness);
  }

  function cloneSurface(base) {
    const mat = (base && base.isMaterial && typeof base.clone === 'function')
      ? base.clone()
      : makeStandard(0x888888, 0.3, 0.55);
    if ('flatShading' in mat) mat.flatShading = true;
    return mat;
  }

  function tuneMetal(mat, colorScale, metalness, roughness) {
    if (colorScale && mat.color) mat.color.multiplyScalar(colorScale);
    if (Number.isFinite(metalness)) mat.metalness = metalness;
    if (Number.isFinite(roughness)) mat.roughness = roughness;
    if ('flatShading' in mat) mat.flatShading = true;
    return mat;
  }

  function frozenHexOf(hex) {
    _tmpColor.setHex(hex).multiplyScalar(FREEZE_TINT);
    // §3 叠深蓝色调：压暗后抬高蓝通道
    _tmpColor.b = Math.min(1, _tmpColor.b * 1.55 + 0.10);
    _tmpColor.g = Math.min(1, _tmpColor.g * 1.05);
    return _tmpColor.getHex();
  }

  function scaledHexOf(hex, factor) {
    _tmpColor.setHex(hex).multiplyScalar(factor);
    return _tmpColor.getHex();
  }

  function makeRecord(mat, opts) {
    const o = opts || {};
    const baseHex = (mat.color && mat.color.isColor) ? mat.color.getHex() : 0xffffff;
    return {
      mat,
      baseHex,
      frozenHex: frozenHexOf(baseHex),
      baseOpacity: typeof mat.opacity === 'number' ? mat.opacity : 1,
      baseTransparent: !!mat.transparent,
      baseDepthWrite: mat.depthWrite !== false,
      baseEmissive: (mat.emissive && mat.emissive.isColor) ? mat.emissive.getHex() : 0,
      baseEmissiveIntensity: typeof mat.emissiveIntensity === 'number' ? mat.emissiveIntensity : 1,
      emissiveCapable: !!(mat.emissive && mat.emissive.isColor),
      tintable: o.tintable !== false,
      flashable: o.flashable !== false,
      armorScale: (o.armorScale === undefined || o.armorScale === null) ? null : o.armorScale,
    };
  }

  // ---------------------------------------------------------------------------
  // 几何工具：三角面累加器（自动修正绕序 + 生成平面法线 + 简易 UV）
  // ---------------------------------------------------------------------------
  class GeoAccum {
    constructor() {
      this.positions = [];
      this.uvs = [];
    }

    _pushVertex(p, nx, ny, nz) {
      this.positions.push(p[0], p[1], p[2]);
      // 按主法线轴做平面投影 UV（迷彩/金属纹理都有足够细节）
      const ax = Math.abs(nx), ay = Math.abs(ny), az = Math.abs(nz);
      let u, v;
      if (ay >= ax && ay >= az) {
        u = p[0]; v = p[2];
      } else if (ax >= az) {
        u = p[2]; v = p[1];
      } else {
        u = p[0]; v = p[1];
      }
      this.uvs.push(u * UV_SCALE, v * UV_SCALE);
    }

    tri(a, b, c, outward) {
      const abx = b[0] - a[0], aby = b[1] - a[1], abz = b[2] - a[2];
      const acx = c[0] - a[0], acy = c[1] - a[1], acz = c[2] - a[2];
      let nx = aby * acz - abz * acy;
      let ny = abz * acx - abx * acz;
      let nz = abx * acy - aby * acx;
      const len = Math.hypot(nx, ny, nz);
      if (len < 1e-8) return; // 退化三角形直接丢弃，避免 NaN 法线
      nx /= len; ny /= len; nz /= len;
      const ox = outward ? outward[0] : 0;
      const oy = outward ? outward[1] : 0;
      const oz = outward ? outward[2] : 0;
      if (nx * ox + ny * oy + nz * oz < 0) {
        const tmp = b; b = c; c = tmp;
        nx = -nx; ny = -ny; nz = -nz;
      }
      this._pushVertex(a, nx, ny, nz);
      this._pushVertex(b, nx, ny, nz);
      this._pushVertex(c, nx, ny, nz);
    }

    quad(a, b, c, d, outward) {
      this.tri(a, b, c, outward);
      this.tri(a, c, d, outward);
    }

    build() {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(this.positions.slice(), 3));
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(this.uvs.slice(), 2));
      geo.computeVertexNormals();
      geo.computeBoundingSphere();
      return geo;
    }
  }

  // 合并多个几何（统一为非索引三角形，重算法线；临时几何销毁，返回值归调用者）
  function mergeGeos(list) {
    const positions = [];
    const uvs = [];
    const disposeList = [];
    const seen = new Set();
    for (let i = 0; i < list.length; i++) {
      let g = list[i];
      if (!g || seen.has(g)) continue;
      seen.add(g);
      disposeList.push(g);
      if (g.index) {
        const nonIndexed = g.toNonIndexed();
        disposeList.push(nonIndexed);
        g = nonIndexed;
      }
      const pos = g.getAttribute('position');
      if (!pos) continue;
      const uv = g.getAttribute('uv');
      for (let k = 0; k < pos.count; k++) {
        positions.push(pos.getX(k), pos.getY(k), pos.getZ(k));
        if (uv) uvs.push(uv.getX(k), uv.getY(k));
        else uvs.push(0, 0);
      }
    }
    for (let i = 0; i < disposeList.length; i++) disposeList[i].dispose();
    const out = new THREE.BufferGeometry();
    out.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    out.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    out.computeVertexNormals();
    out.computeBoundingSphere();
    return out;
  }

  function boxGeo(w, h, d, pos, rot) {
    const g = new THREE.BoxGeometry(w, h, d);
    if (rot) {
      if (rot[0]) g.rotateX(rot[0]);
      if (rot[1]) g.rotateY(rot[1]);
      if (rot[2]) g.rotateZ(rot[2]);
    }
    if (pos) g.translate(pos[0], pos[1], pos[2]);
    return g;
  }

  // 圆柱：默认沿 Y；rot 可把轴转到 X/Z
  function cylGeo(radiusTop, radiusBottom, height, seg, pos, rot) {
    const g = new THREE.CylinderGeometry(radiusTop, radiusBottom, height, seg, 1, false);
    if (rot) {
      if (rot[0]) g.rotateX(rot[0]);
      if (rot[1]) g.rotateY(rot[1]);
      if (rot[2]) g.rotateZ(rot[2]);
    }
    if (pos) g.translate(pos[0], pos[1], pos[2]);
    return g;
  }

  // 沿车头方向（-Z）的圆柱：底面中心在 z=0，另一端在 z=-len
  function cylZ(radius, len, seg, centerZ) {
    const g = new THREE.CylinderGeometry(radius, radius, len, seg, 1, false);
    g.rotateX(Math.PI / 2);
    g.translate(0, 0, centerZ);
    return g;
  }

  function chamferOutline(halfW, frontZ, backZ, chamfer) {
    const c = Math.min(chamfer, halfW * 0.85, (backZ - frontZ) * 0.24);
    return [
      [-halfW + c, frontZ],
      [halfW - c, frontZ],
      [halfW, frontZ + c],
      [halfW, backZ - c],
      [halfW - c, backZ],
      [-halfW + c, backZ],
      [-halfW, backZ - c],
      [-halfW, frontZ + c],
    ];
  }

  function to3D(outline, y) {
    const out = [];
    for (let i = 0; i < outline.length; i++) out.push([outline[i][0], y, outline[i][1]]);
    return out;
  }

  function centroid3D(points) {
    let x = 0, y = 0, z = 0;
    for (let i = 0; i < points.length; i++) {
      x += points[i][0]; y += points[i][1]; z += points[i][2];
    }
    const n = Math.max(1, points.length);
    return [x / n, y / n, z / n];
  }

  // 上下两个多边形环之间放样：侧面四边形 + 顶/底扇面封口
  function loftGeo(bottom, top) {
    const acc = new GeoAccum();
    const n = Math.min(bottom.length, top.length);
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const mx = (bottom[i][0] + bottom[j][0]) * 0.5;
      const mz = (bottom[i][2] + bottom[j][2]) * 0.5;
      acc.quad(bottom[i], bottom[j], top[j], top[i], [mx, 0, mz]);
    }
    const bc = centroid3D(bottom);
    const tc = centroid3D(top);
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      acc.tri(tc, top[i], top[j], [0, 1, 0]);
      acc.tri(bc, bottom[j], bottom[i], [0, -1, 0]);
    }
    return acc.build();
  }

  function hullGeometry(spec) {
    const h = spec.hull;
    const bottom = to3D(chamferOutline(h.hw, h.front, h.back, h.chamfer), h.bottom);
    const top = to3D(chamferOutline(
      Math.max(0.1, h.hw - h.topInset),
      h.front + h.frontInset,
      h.back - h.backInset,
      h.chamfer * 0.7
    ), h.top);
    return loftGeo(bottom, top);
  }

  function turretOutline(r, lenScale) {
    const l = lenScale || 1;
    return [
      [-0.46 * r, -1.00 * r * l],
      [0.46 * r, -1.00 * r * l],
      [0.86 * r, -0.55 * r * l],
      [0.92 * r, 0.25 * r * l],
      [0.58 * r, 0.82 * r * l],
      [-0.58 * r, 0.82 * r * l],
      [-0.92 * r, 0.25 * r * l],
      [-0.86 * r, -0.55 * r * l],
    ];
  }

  function turretLoftGeo(spec) {
    const t = spec.turret;
    const r = t.r;
    const l = t.lenScale || 1;
    const baseY = t.baseY === undefined ? 0.03 : t.baseY;
    const bottom = to3D(turretOutline(r, l), baseY);
    const top = to3D(turretOutline(r * t.topScale, l), t.h);
    return loftGeo(bottom, top);
  }

  function wheelGeometry(radius, width, doubleRow) {
    const parts = [];
    if (doubleRow) {
      // §3 装甲车双排轮：同一轴上的两排轮盘合并成一个可绕 X 自转的几何
      const discW = width * 0.38;
      parts.push(cylGeo(radius, radius, discW, WHEEL_SEGMENTS, [-width * 0.22, 0, 0], [0, 0, Math.PI / 2]));
      parts.push(cylGeo(radius, radius, discW, WHEEL_SEGMENTS, [width * 0.22, 0, 0], [0, 0, Math.PI / 2]));
      parts.push(cylGeo(radius * 0.34, radius * 0.34, width * 0.96, HUB_SEGMENTS, [0, 0, 0], [0, 0, Math.PI / 2]));
    } else {
      parts.push(cylGeo(radius, radius, width, WHEEL_SEGMENTS, [0, 0, 0], [0, 0, Math.PI / 2]));
      parts.push(cylGeo(radius * 0.38, radius * 0.38, width * 1.06, HUB_SEGMENTS, [0, 0, 0], [0, 0, Math.PI / 2]));
    }
    return mergeGeos(parts);
  }

  // 履带：八边形环状履带带（ExtrudeGeometry 环形轮廓），中间开放以露出负重轮
  // 这样从侧面看是连续的履带环，而不是四段分离的方块（§4 履带贴图滚动）
  function octagonPoints(halfLen, halfH, chamfer) {
    const c = Math.min(chamfer, halfLen * 0.55, halfH * 0.9);
    return [
      [-halfLen + c, -halfH], [halfLen - c, -halfH],
      [halfLen, -halfH + c], [halfLen, halfH - c],
      [halfLen - c, halfH], [-halfLen + c, halfH],
      [-halfLen, halfH - c], [-halfLen, -halfH + c],
    ];
  }

  function pathFromPoints(path, points) {
    for (let i = 0; i < points.length; i++) {
      if (i === 0) path.moveTo(points[i][0], points[i][1]);
      else path.lineTo(points[i][0], points[i][1]);
    }
    path.closePath();
  }

  function trackGeometry(spec) {
    const t = spec.track;
    const beltW = t.w * 0.72;
    const halfLen = t.len * 0.5;
    const halfH = t.h * 0.5;
    const thickness = Math.max(0.05, t.h * 0.17);
    const outer = octagonPoints(halfLen, halfH, t.h * 0.45);
    const inner = octagonPoints(
      Math.max(0.08, halfLen - thickness),
      Math.max(0.05, halfH - thickness),
      Math.max(0.01, t.h * 0.45 - thickness)
    );
    const shape = new THREE.Shape();
    pathFromPoints(shape, outer);
    const hole = new THREE.Path();
    pathFromPoints(hole, inner);
    shape.holes.push(hole);
    const geo = new THREE.ExtrudeGeometry(shape, {
      depth: beltW, steps: 1, bevelEnabled: false, curveSegments: 1,
    });
    // 轮廓的 X 轴原本对应车长方向，挤出方向对应履带宽度：转成世界坐标
    geo.rotateY(Math.PI / 2);
    geo.translate(-beltW * 0.5, 0, 0);
    applyTrackUV(geo, t);
    return geo;
  }

  // 履带 UV：v 沿车长，offset.y 滚动即履带贴图沿车体前后移动（契约 §5）
  function applyTrackUV(geo, track) {
    const pos = geo.getAttribute('position');
    const nor = geo.getAttribute('normal');
    const uv = geo.getAttribute('uv');
    if (!pos || !nor || !uv) return;
    const halfW = Math.max(0.0001, track.w * 0.5);
    const halfH = Math.max(0.0001, track.h * 0.5);
    const halfL = Math.max(0.0001, track.len * 0.5);
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      const ax = Math.abs(nor.getX(i)), ay = Math.abs(nor.getY(i)), az = Math.abs(nor.getZ(i));
      let u, v;
      if (ay >= ax && ay >= az) {
        u = x / halfW * 0.5 + 0.5;
        v = (z / halfL * 0.5 + 0.5) * TRACK_UV_TILES;
      } else if (az >= ax) {
        u = x / halfW * 0.5 + 0.5;
        v = (y / halfH * 0.5 + 0.5) * TRACK_UV_TILES * 0.5;
      } else {
        u = y / halfH * 0.5 + 0.5;
        v = (z / halfL * 0.5 + 0.5) * TRACK_UV_TILES;
      }
      uv.setXY(i, u, v);
    }
    uv.needsUpdate = true;
  }

  function barrelGeometry(spec) {
    const b = spec.barrel;
    const r = b.r;
    const len = b.len;
    const parts = [];
    parts.push(cylZ(r, len, 8, -len * 0.5));                     // 主炮管
    parts.push(cylZ(r * 1.5, 0.10, 8, -0.045));                  // 炮根套环
    if (b.style === 'sleeve') {
      parts.push(cylZ(r * 1.28, len * 0.26, 8, -len * 0.42));    // §4 玩家抽气套筒
      parts.push(cylZ(r * 1.72, 0.10, 8, -len + 0.05));          // 炮口套环
    } else if (b.style === 'double') {
      // §3 强化车双室制退器
      parts.push(cylZ(r * 1.92, 0.08, 6, -len + 0.045));
      parts.push(cylZ(r * 1.92, 0.08, 6, -len + 0.20));
      parts.push(cylZ(r * 1.18, 0.08, 6, -len + 0.122));
    } else if (b.style === 'brake') {
      parts.push(cylZ(r * 1.85, 0.11, 8, -len + 0.055));         // §3 装甲车炮口制退器
    } else if (b.style === 'thin') {
      parts.push(cylZ(r * 1.42, 0.06, 8, -len + 0.03));          // §3 快速车细炮口
    } else {
      parts.push(cylZ(r * 1.48, 0.07, 8, -len + 0.035));         // §3 基础车短管炮口
    }
    return mergeGeos(parts);
  }

  // ---------------------------------------------------------------------------
  // 五类战车参数（尺寸与 2×2 格匹配；§3 轮廓差异全部落在这些参数上）
  // ---------------------------------------------------------------------------
  const SPECS = {
    player: {
      hull: {
        hw: 0.58, front: -0.84, back: 0.84, bottom: 0.14, top: 0.50,
        chamfer: 0.16, topInset: 0.05, frontInset: 0.20, backInset: 0.11,
      },
      track: { x: 0.68, w: 0.28, h: 0.40, len: 1.86 },
      wheels: [{ z: -0.62 }, { z: 0 }, { z: 0.62 }],
      wheelRadius: 0.155,
      doubleWheels: false,
      turret: { style: 'chamfer', y: 0.50, z: -0.03, r: 0.40, h: 0.26, topScale: 0.74, lenScale: 1.08, baseY: 0.03 },
      barrel: { relY: 0.10, relZ: -0.20, len: 0.86, r: 0.052, style: 'sleeve' },
      star: { y: 0.266, z: -0.02, size: 0.28 },
      shadow: { w: 1.96, d: 2.04 },
      fireRings: true,
    },
    basic: {
      hull: {
        hw: 0.50, front: -0.66, back: 0.66, bottom: 0.12, top: 0.42,
        chamfer: 0.16, topInset: 0.055, frontInset: 0.16, backInset: 0.10,
      },
      track: { x: 0.60, w: 0.26, h: 0.34, len: 1.46 },
      wheels: [{ z: -0.42 }, { z: 0 }, { z: 0.42 }],
      wheelRadius: 0.13,
      doubleWheels: false,
      turret: { style: 'dome', y: 0.42, z: -0.01, r: 0.30, h: 0.20, topScale: 0.9, lenScale: 1.0, baseY: 0.03 },
      barrel: { relY: 0.10, relZ: -0.16, len: 0.68, r: 0.045, style: 'short' },
      star: null,
      shadow: { w: 1.68, d: 1.66 },
      fireRings: false,
    },
    fast: {
      hull: {
        hw: 0.42, front: -0.94, back: 0.94, bottom: 0.12, top: 0.38,
        chamfer: 0.14, topInset: 0.05, frontInset: 0.24, backInset: 0.22,
      },
      track: { x: 0.52, w: 0.20, h: 0.30, len: 1.98 },
      wheels: [{ z: -0.66 }, { z: 0 }, { z: 0.66 }],
      wheelRadius: 0.115,
      doubleWheels: false,
      turret: { style: 'chamfer', y: 0.38, z: 0.0, r: 0.28, h: 0.14, topScale: 0.68, lenScale: 1.25, baseY: 0.025 },
      barrel: { relY: 0.12, relZ: -0.14, len: 0.82, r: 0.038, style: 'thin' },
      star: null,
      shadow: { w: 1.46, d: 2.20 },
      fireRings: false,
    },
    power: {
      hull: {
        hw: 0.56, front: -0.84, back: 0.84, bottom: 0.14, top: 0.48,
        chamfer: 0.18, topInset: 0.06, frontInset: 0.20, backInset: 0.12,
      },
      track: { x: 0.68, w: 0.28, h: 0.38, len: 1.72 },
      wheels: [{ z: -0.55 }, { z: 0 }, { z: 0.55 }],
      wheelRadius: 0.145,
      doubleWheels: false,
      turret: { style: 'chamfer', y: 0.48, z: -0.01, r: 0.38, h: 0.24, topScale: 0.76, lenScale: 1.12, baseY: 0.03 },
      barrel: { relY: 0.11, relZ: -0.22, len: 1.02, r: 0.050, style: 'double' },
      star: null,
      shadow: { w: 1.94, d: 1.94 },
      fireRings: false,
    },
    armor: {
      hull: {
        hw: 0.66, front: -0.86, back: 0.86, bottom: 0.16, top: 0.54,
        chamfer: 0.20, topInset: 0.07, frontInset: 0.18, backInset: 0.14,
      },
      track: { x: 0.78, w: 0.30, h: 0.44, len: 1.82 },
      wheels: [{ z: -0.66 }, { z: -0.22 }, { z: 0.22 }, { z: 0.66 }],
      wheelRadius: 0.155,
      doubleWheels: true,
      turret: { style: 'chamfer', y: 0.54, z: -0.02, r: 0.46, h: 0.25, topScale: 0.80, lenScale: 1.05, baseY: 0.03 },
      barrel: { relY: 0.11, relZ: -0.18, len: 0.88, r: 0.055, style: 'brake' },
      star: null,
      shadow: { w: 2.06, d: 2.00 },
      fireRings: false,
    },
  };

  // ---------------------------------------------------------------------------
  // 车体细节：不同车型的差异（§3 轮廓表）
  // ---------------------------------------------------------------------------
  function buildChassisParts(spec, type) {
    const body = [];
    const accent = [];
    const dark = [];
    const t = spec.track;
    const h = spec.hull;
    const side = [-1, 1];

    body.push(hullGeometry(spec));

    if (type === 'player') {
      // §4 侧裙 + 挡泥板 + 排气罐（侧裙分两段，露出中段履带/负重轮）
      for (let i = 0; i < side.length; i++) {
        const s = side[i];
        const skirtX = s * (t.x + t.w * 0.5 + 0.02);
        const fenderX = s * (t.x + t.w * 0.22);
        body.push(boxGeo(0.055, 0.17, t.len * 0.32, [skirtX, t.h * 0.5 + 0.085, -t.len * 0.25]));
        body.push(boxGeo(0.055, 0.17, t.len * 0.32, [skirtX, t.h * 0.5 + 0.085, t.len * 0.25]));
        accent.push(boxGeo(t.w * 0.48, 0.028, t.len * 0.34, [fenderX, t.h + 0.018, -t.len * 0.25]));
        accent.push(boxGeo(t.w * 0.48, 0.028, t.len * 0.34, [fenderX, t.h + 0.018, t.len * 0.25]));
        dark.push(boxGeo(0.07, 0.08, 0.14, [s * (t.x - 0.02), t.h + 0.03, -t.len * 0.40]));
      }
      accent.push(boxGeo(1.0, 0.035, 0.30, [0, h.top + 0.012, h.front + 0.24], [-0.20, 0, 0]));
      for (let i = 0; i < 2; i++) {
        const s = i === 0 ? -1 : 1;
        dark.push(cylGeo(0.065, 0.065, 0.34, 8, [s * 0.34, h.top + 0.085, 0.56], [Math.PI / 2, 0, 0]));
        dark.push(cylGeo(0.075, 0.075, 0.05, 8, [s * 0.34, h.top + 0.085, 0.39], [Math.PI / 2, 0, 0]));
      }
      for (let i = 0; i < 3; i++) {
        dark.push(boxGeo(0.44, 0.02, 0.05, [0, h.top + 0.015, 0.54 + i * 0.075]));
      }
    } else if (type === 'basic') {
      // §3 小型基础车：小挡泥板 + 车头灯 + 尾部格栅
      for (let i = 0; i < side.length; i++) {
        const s = side[i];
        accent.push(boxGeo(t.w * 0.42, 0.022, t.len * 0.80, [s * t.x, t.h + 0.012, 0]));
        accent.push(boxGeo(0.075, 0.06, 0.05, [s * 0.24, h.top + 0.035, h.front + 0.20]));
        dark.push(boxGeo(0.06, 0.05, 0.12, [s * (t.x + 0.01), h.top + 0.03, t.len * 0.34]));
      }
      accent.push(boxGeo(0.66, 0.03, 0.20, [0, h.top + 0.01, h.front + 0.18], [-0.18, 0, 0]));
      for (let i = 0; i < 2; i++) {
        dark.push(boxGeo(0.32, 0.018, 0.05, [0, h.top + 0.012, 0.34 + i * 0.075]));
      }
    } else if (type === 'fast') {
      // §3 快速车：窄长车身、双小履带、散热格栅
      for (let i = 0; i < side.length; i++) {
        const s = side[i];
        body.push(boxGeo(0.04, 0.12, t.len * 0.88, [s * (t.x + t.w * 0.5 + 0.012), t.h * 0.5 + 0.09, 0]));
        accent.push(boxGeo(t.w * 0.46, 0.02, t.len * 0.90, [s * t.x, t.h + 0.01, 0]));
        dark.push(boxGeo(0.03, 0.07, 0.50, [s * (h.hw + 0.006), h.top - 0.10, 0.08]));
        dark.push(cylGeo(0.032, 0.032, 0.18, 6, [s * 0.20, h.top + 0.095, 0.60], [Math.PI / 2, 0, 0]));
      }
      for (let i = 0; i < 4; i++) {
        dark.push(boxGeo(0.48, 0.016, 0.045, [0, h.top + 0.012, 0.30 + i * 0.085]));
      }
      accent.push(boxGeo(0.72, 0.03, 0.24, [0, h.top + 0.012, h.front + 0.28], [-0.24, 0, 0]));
    } else if (type === 'power') {
      // §3 强化车：侧裙、车头附加装甲、后甲板油桶
      for (let i = 0; i < side.length; i++) {
        const s = side[i];
        body.push(boxGeo(0.05, 0.17, t.len * 0.78, [s * (t.x + t.w * 0.5 + 0.018), t.h * 0.5 + 0.09, 0]));
        accent.push(boxGeo(t.w * 0.50, 0.028, t.len * 0.86, [s * (t.x + t.w * 0.16), t.h + 0.018, 0]));
        dark.push(cylGeo(0.085, 0.085, 0.32, 8, [s * 0.30, h.top + 0.10, 0.52], [Math.PI / 2, 0, 0]));
        dark.push(cylGeo(0.095, 0.095, 0.04, 8, [s * 0.30, h.top + 0.10, 0.37], [Math.PI / 2, 0, 0]));
      }
      accent.push(boxGeo(0.88, 0.04, 0.28, [0, h.top + 0.015, h.front + 0.23], [-0.22, 0, 0]));
      for (let i = 0; i < 3; i++) {
        dark.push(boxGeo(0.42, 0.018, 0.05, [0, h.top + 0.012, 0.48 + i * 0.07]));
      }
    } else {
      // §3 装甲车：加宽车体 + 每侧 2 块侧挂装甲（共 4 板）+ 双排轮
      for (let i = 0; i < side.length; i++) {
        const s = side[i];
        const plateX = s * (t.x + t.w * 0.5 + 0.045);
        accent.push(boxGeo(0.055, 0.34, 0.52, [plateX, t.h * 0.5 + 0.10, -0.38], [0, 0, s * 0.05]));
        accent.push(boxGeo(0.055, 0.34, 0.52, [plateX, t.h * 0.5 + 0.10, 0.38], [0, 0, s * 0.05]));
        accent.push(boxGeo(t.w * 0.52, 0.032, t.len * 0.86, [s * (t.x + t.w * 0.16), t.h + 0.02, 0]));
        body.push(boxGeo(0.05, 0.16, t.len * 0.76, [s * (t.x + t.w * 0.5 + 0.015), t.h * 0.5 + 0.08, 0]));
        dark.push(cylGeo(0.075, 0.075, 0.32, 8, [s * 0.34, h.top + 0.09, 0.58], [Math.PI / 2, 0, 0]));
      }
      accent.push(boxGeo(1.18, 0.05, 0.32, [0, h.top + 0.018, h.front + 0.22], [-0.20, 0, 0]));
      for (let i = 0; i < 3; i++) {
        dark.push(boxGeo(0.54, 0.02, 0.05, [0, h.top + 0.015, 0.52 + i * 0.075]));
      }
    }
    return { body, accent, dark };
  }

  // ---------------------------------------------------------------------------
  // 炮塔细节：切角铸造炮塔 / 基础车圆润炮塔（§3/§4）
  // ---------------------------------------------------------------------------
  function buildTurretParts(spec, type) {
    const t = spec.turret;
    const r = t.r;
    const h = t.h;
    const l = t.lenScale || 1;
    const parts = [];

    if (t.style === 'dome') {
      // §3 基础车：小型圆润炮塔
      parts.push(cylGeo(r * 0.98, r * 1.02, 0.055, 8, [0, t.baseY + 0.028, 0]));
      const dome = new THREE.SphereGeometry(r, 8, 5, 0, Math.PI * 2, 0, Math.PI / 2);
      dome.scale(1, h / r, 1);
      dome.translate(0, t.baseY, 0);
      parts.push(dome);
      parts.push(cylGeo(r * 0.24, r * 0.27, 0.055, 8, [r * 0.26, t.baseY + h + 0.02, r * 0.18]));
      parts.push(cylGeo(r * 0.20, r * 0.20, 0.018, 8, [r * 0.26, t.baseY + h + 0.052, r * 0.18]));
      parts.push(boxGeo(r * 0.62, 0.075, r * 0.30, [0, t.baseY + h * 0.42, r * 0.72]));
    } else {
      // §4 切角炮塔：八边形放样 + 炮盾 + 指挥塔 + 舱盖 + 尾部储物箱
      parts.push(turretLoftGeo(spec));
      parts.push(cylGeo(r * 1.01, r * 1.03, 0.055, 8, [0, t.baseY + 0.02, 0]));
      parts.push(boxGeo(r * 0.74, h * 0.62, r * 0.40, [0, h * 0.42, -r * l * 0.92]));
      parts.push(cylGeo(r * 0.27, r * 0.30, 0.075, 8, [r * 0.28, h + 0.02, r * l * 0.28]));
      parts.push(cylGeo(r * 0.22, r * 0.22, 0.018, 8, [r * 0.28, h + 0.064, r * l * 0.28]));
      parts.push(boxGeo(r * 0.62, 0.085, r * 0.34, [0, h * 0.50, r * l * 0.70]));

      if (type === 'player' || type === 'power') {
        // §4 玩家天线（短）：竖直低多边形细杆
        parts.push(cylGeo(0.010, 0.010, 0.14, 4, [-r * 0.62, h + 0.09, r * l * 0.30], [0, 0, 0.14]));
      }
      if (type === 'power') {
        // §3 强化车弹舱：炮塔尾部的方形弹药仓
        parts.push(boxGeo(r * 1.18, h * 0.58, r * 0.62, [0, h * 0.32, r * l * 0.95]));
        parts.push(boxGeo(r * 0.28, 0.06, r * 0.20, [r * 0.34, h * 0.66, r * l * 0.18]));
      }
      if (type === 'armor') {
        // §3 装甲车：炮塔两侧附加装甲块
        parts.push(boxGeo(r * 0.18, h * 0.66, r * 0.52, [r * 0.94, h * 0.42, -r * 0.10], [0, -0.12, 0]));
        parts.push(boxGeo(r * 0.18, h * 0.66, r * 0.52, [-r * 0.94, h * 0.42, -r * 0.10], [0, 0.12, 0]));
        parts.push(boxGeo(r * 0.58, 0.06, r * 0.30, [0, h + 0.012, -r * 0.04]));
      }
      if (type === 'fast') {
        // §3 快速车：炮塔尾部散热口
        parts.push(boxGeo(r * 0.54, 0.035, r * 0.26, [0, h * 0.55, r * l * 0.86]));
        parts.push(boxGeo(r * 0.22, 0.05, r * 0.18, [r * 0.24, h + 0.015, -r * 0.28]));
      }
    }
    return mergeGeos(parts);
  }

  // ---------------------------------------------------------------------------
  // 模板缓存：加载时一次性生成全部几何（规格书 §8：LOADING 期预构建）
  // ---------------------------------------------------------------------------
  const TEMPLATES = {};

  function buildTemplate(type) {
    const spec = SPECS[type];
    const chassis = buildChassisParts(spec, type);
    const wheelPositions = [];
    for (let sideIndex = 0; sideIndex < 2; sideIndex++) {
      const s = sideIndex === 0 ? -1 : 1;
      for (let i = 0; i < spec.wheels.length; i++) {
        wheelPositions.push({ x: s * spec.track.x, y: spec.track.h * 0.5, z: spec.wheels[i].z });
      }
    }
    const trackGeo = trackGeometry(spec);
    const wheelGeo = wheelGeometry(spec.wheelRadius, spec.track.w * 0.92, spec.doubleWheels);
    const turretGeo = buildTurretParts(spec, type);
    const barrelGeo = barrelGeometry(spec);
    const fireRings = [];
    if (spec.fireRings) {
      const positions = [-spec.barrel.len * 0.40, -spec.barrel.len * 0.55, -spec.barrel.len * 0.70];
      for (let i = 0; i < positions.length && i < MAX_FIRE_LEVEL; i++) fireRings.push(positions[i]);
    }
    const ringRadius = spec.barrel.r * 2.05;
    const fireRingGeo = spec.fireRings
      ? new THREE.TorusGeometry(ringRadius, Math.max(0.014, spec.barrel.r * 0.30), TORUS_TUBE_SEGMENTS, TORUS_RADIAL_SEGMENTS)
      : null;
    const shadowGeo = new THREE.PlaneGeometry(spec.shadow.w, spec.shadow.d);
    shadowGeo.rotateX(-Math.PI / 2);

    const faceCount =
      sumTriCount(chassis.body) +
      sumTriCount(chassis.accent) +
      sumTriCount(chassis.dark) +
      triCount(turretGeo) +
      triCount(barrelGeo) +
      spec.wheels.length * 2 * triCount(wheelGeo) +
      2 * triCount(trackGeo) +
      2 + // 接触阴影贴花
      (spec.star ? 2 : 0) + // 玩家五角星贴花
      (fireRingGeo ? MAX_FIRE_LEVEL * triCount(fireRingGeo) : 0);

    const template = {
      bodyGeo: mergeGeos(chassis.body),
      accentGeo: chassis.accent.length ? mergeGeos(chassis.accent) : null,
      darkGeo: chassis.dark.length ? mergeGeos(chassis.dark) : null,
      turretGeo,
      barrelGeo,
      wheelGeo,
      trackGeo,
      shadowGeo,
      fireRingGeo,
      fireRings,
      wheelPositions,
      star: spec.star,
      faceCount,
    };
    return template;
  }

  function triCount(geo) {
    if (!geo) return 0;
    const index = geo.getIndex();
    if (index) return Math.floor(index.count / 3);
    const pos = geo.getAttribute('position');
    return pos ? Math.floor(pos.count / 3) : 0;
  }

  function sumTriCount(list) {
    let total = 0;
    for (let i = 0; i < list.length; i++) total += triCount(list[i]);
    return total;
  }

  for (let i = 0; i < ALL_TYPES.length; i++) TEMPLATES[ALL_TYPES[i]] = buildTemplate(ALL_TYPES[i]);

  // ---------------------------------------------------------------------------
  // 材质实例化（每台车独立克隆；§4 材质参数由 Mat 提供）
  // ---------------------------------------------------------------------------
  function baseBodyMaterial(type) {
    if (type === 'player') {
      return pickMaterial(Mat.playerBody, CONFIG.colors.playerBody, 0.25, 0.60);
    }
    const enemyBody = Mat.enemyBody && Mat.enemyBody[type];
    return pickMaterial(enemyBody, CONFIG.enemy.color[type], 0.30, 0.55);
  }

  function baseTurretMaterial(type) {
    if (type === 'player') {
      return pickMaterial(Mat.playerTurret, CONFIG.colors.playerBody, 0.25, 0.60);
    }
    const enemyBody = Mat.enemyBody && Mat.enemyBody[type];
    return pickMaterial(enemyBody, CONFIG.enemy.color[type], 0.30, 0.55);
  }

  function baseTrackMaterial() {
    return pickMaterial(Mat.track, CONFIG.colors.playerTrack, 0.55, 0.90);
  }

  function cloneTrackMap(trackMat) {
    if (trackMat.map && trackMat.map.isTexture) {
      const map = trackMat.map.clone();
      map.wrapS = THREE.RepeatWrapping;
      map.wrapT = THREE.RepeatWrapping;
      map.offset.set(0, 0);
      map.needsUpdate = true;
      trackMat.map = map;
      return map;
    }
    if (typeof Tex !== 'undefined' && Tex && Tex.track && Tex.track.isTexture) {
      const map = Tex.track.clone();
      map.wrapS = THREE.RepeatWrapping;
      map.wrapT = THREE.RepeatWrapping;
      map.offset.set(0, 0);
      map.needsUpdate = true;
      trackMat.map = map;
      if (trackMat.color) trackMat.color.setHex(0xffffff);
      return map;
    }
    return null;
  }

  function createTankMaterials(type) {
    const isPlayer = type === 'player';
    const body = cloneSurface(baseBodyMaterial(type));
    const turret = cloneSurface(baseTurretMaterial(type));
    const barrel = tuneMetal(cloneSurface(baseTurretMaterial(type)), 0.82, 0.55, 0.40);
    let accent;
    if (isPlayer) {
      accent = cloneSurface(pickMaterial(Mat.playerAccent, CONFIG.colors.playerAccent, 0.20, 0.55));
    } else {
      accent = cloneSurface(baseBodyMaterial(type));
      if (type === 'armor') {
        // 装甲车侧挂钢板保持中性钢灰色，不随车体血量变色
        if (accent.color) accent.color.setHex(0x7b848d);
        accent.metalness = 0.70;
        accent.roughness = 0.38;
      } else if (accent.color) {
        accent.color.multiplyScalar(1.18);
      }
    }
    const track = cloneSurface(baseTrackMaterial());
    const trackTexture = cloneTrackMap(track);
    const dark = tuneMetal(cloneSurface(baseTrackMaterial()), 1.0, 0.62, 0.50);
    dark.map = null;
    if (dark.color) dark.color.setHex(0x2f2d2a);
    // 负重轮比履带略亮，才能从履带环开口里看出来（低多边形金属感）
    const wheel = tuneMetal(cloneSurface(baseTrackMaterial()), 1.0, 0.68, 0.52);
    wheel.map = null;
    if (wheel.color) wheel.color.setHex(0x5a564e);

    // §4 玩家白色五角星贴花
    let star = null;
    let starUseTexture = false;
    if (isPlayer) {
      const starTex = (typeof Tex !== 'undefined' && Tex && Tex.star) ? Tex.star : null;
      const starBase = (Mat && Mat.playerStar && Mat.playerStar.isMaterial) ? Mat.playerStar : null;
      if (starBase) {
        star = starBase.clone();
        if (!star.map && starTex) star.map = starTex;
        starUseTexture = !!star.map;
        star.transparent = starUseTexture;
        star.depthWrite = false;
      } else if (starTex) {
        starUseTexture = true;
        star = new THREE.MeshBasicMaterial({
          map: starTex, color: 0xffffff, transparent: true, depthWrite: false,
          polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
        });
      } else {
        star = new THREE.MeshBasicMaterial({
          color: 0xffffff, transparent: false, depthWrite: false,
          polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
        });
      }
    }

    // §4 接触阴影贴花
    let shadow;
    const shadowBase = (Mat && Mat.decalShadow && Mat.decalShadow.isMaterial) ? Mat.decalShadow : null;
    if (shadowBase) {
      shadow = shadowBase.clone();
      shadow.transparent = true;
      shadow.depthWrite = false;
    } else {
      shadow = new THREE.MeshBasicMaterial({
        color: 0x000000, transparent: true, opacity: 0.32, depthWrite: false,
      });
    }
    if (!shadow.map && typeof Tex !== 'undefined' && Tex && Tex.decalShadow) {
      shadow.map = Tex.decalShadow;
      if (shadow.color) shadow.color.setHex(0xffffff);
    }
    shadow.polygonOffset = true;
    shadow.polygonOffsetFactor = -1;
    shadow.polygonOffsetUnits = -1;

    // §4 玩家炮管橙色发光环材质
    let fire = null;
    if (isPlayer) {
      fire = new THREE.MeshBasicMaterial({
        color: FIRE_RING_COLOR, transparent: true, opacity: 0.95,
        blending: THREE.NormalBlending, depthWrite: false,
        side: THREE.DoubleSide, toneMapped: false,
      });
    }

    return { body, turret, barrel, accent, track, trackTexture, dark, wheel, star, starUseTexture, shadow, fire };
  }

  // ---------------------------------------------------------------------------
  // 状态应用：冻结 / 闪白 / 装甲血量 / 透明度
  // ---------------------------------------------------------------------------
  function applyTankColors(tank) {
    const hit = tank._hitFlash > 0;
    const lowArmor = tank.type === 'armor' && tank._armorHp <= 1;
    const blinkWhite = lowArmor && (Math.floor(tank._time * ARMOR_FLASH_HZ) % 2 === 0);
    for (let i = 0; i < tank._records.length; i++) {
      const rec = tank._records[i];
      if (!rec.tintable && !rec.flashable) continue;
      let hex = tank._frozen ? rec.frozenHex : rec.baseHex;
      let white = false;
      if (hit && rec.flashable) white = true;
      if (blinkWhite && rec.armorScale !== null) white = true;
      if (white) hex = 0xffffff;
      if (rec.mat.color && rec.mat.color.isColor) rec.mat.color.setHex(hex);
      if (rec.emissiveCapable) {
        if (white) {
          rec.mat.emissive.setHex(0xffffff);
          rec.mat.emissiveIntensity = 1.25;
        } else {
          rec.mat.emissive.setHex(rec.baseEmissive);
          rec.mat.emissiveIntensity = rec.baseEmissiveIntensity;
        }
      }
    }
  }

  function applyTankOpacity(tank, opacity) {
    for (let i = 0; i < tank._records.length; i++) {
      const rec = tank._records[i];
      const mat = rec.mat;
      mat.opacity = rec.baseOpacity * opacity;
      const wantTransparent = rec.baseTransparent || opacity < 0.999;
      if (mat.transparent !== wantTransparent) {
        mat.transparent = wantTransparent;
        mat.needsUpdate = true;
      }
      mat.depthWrite = opacity < 0.999 ? false : rec.baseDepthWrite;
    }
  }

  function starShapeGeometry(size) {
    const shape = new THREE.Shape();
    const outer = size * 0.5;
    const inner = outer * 0.42;
    for (let i = 0; i < 10; i++) {
      const radius = (i % 2 === 0) ? outer : inner;
      const angle = -Math.PI / 2 + i * Math.PI / 5;
      const x = Math.cos(angle) * radius;
      const y = Math.sin(angle) * radius;
      if (i === 0) shape.moveTo(x, y);
      else shape.lineTo(x, y);
    }
    shape.closePath();
    const geo = new THREE.ShapeGeometry(shape);
    geo.rotateX(-Math.PI / 2);
    return geo;
  }

  // ---------------------------------------------------------------------------
  // TankModel 工厂（契约 §6）
  // ---------------------------------------------------------------------------
  function createTank(type) {
    const key = (ALL_TYPES.indexOf(type) >= 0) ? type : 'basic';
    const spec = SPECS[key];
    const template = TEMPLATES[key];
    const mats = createTankMaterials(key);

    const group = new THREE.Group();
    group.name = 'tank-' + key;
    group.userData.type = key;
    const body = new THREE.Group();
    body.name = 'body';
    group.add(body);

    // 车体 / 附加色块 / 深色件（按材质合并，控制 draw call）
    if (template.bodyGeo) {
      const mesh = new THREE.Mesh(template.bodyGeo.clone(), mats.body);
      mesh.castShadow = true; mesh.receiveShadow = true;
      body.add(mesh);
    }
    if (template.accentGeo) {
      const mesh = new THREE.Mesh(template.accentGeo.clone(), mats.accent);
      mesh.castShadow = true; mesh.receiveShadow = true;
      body.add(mesh);
    }
    if (template.darkGeo) {
      const mesh = new THREE.Mesh(template.darkGeo.clone(), mats.dark);
      mesh.castShadow = true; mesh.receiveShadow = true;
      body.add(mesh);
    }

    // 左右履带（共享同一份几何与同一份履带贴图，offset 同步滚动）
    const trackGeo = template.trackGeo.clone();
    const trackBaseY = spec.track.h * 0.5; // 履带下沿 y=0，group 原点即触地中心
    const trackLeft = new THREE.Mesh(trackGeo, mats.track);
    trackLeft.position.set(-spec.track.x, trackBaseY, 0);
    trackLeft.castShadow = true; trackLeft.receiveShadow = true;
    body.add(trackLeft);
    const trackRight = new THREE.Mesh(trackGeo, mats.track);
    trackRight.position.set(spec.track.x, trackBaseY, 0);
    trackRight.castShadow = true; trackRight.receiveShadow = true;
    body.add(trackRight);

    // 负重轮（共享同一份轮几何；update 中按速度自转）
    const wheelGeo = template.wheelGeo.clone();
    const wheels = [];
    for (let i = 0; i < template.wheelPositions.length; i++) {
      const p = template.wheelPositions[i];
      const wheel = new THREE.Mesh(wheelGeo, mats.wheel);
      wheel.position.set(p.x, p.y, p.z);
      wheel.castShadow = true; wheel.receiveShadow = true;
      body.add(wheel);
      wheels.push(wheel);
    }

    // 炮塔
    const turret = new THREE.Group();
    turret.name = 'turret';
    turret.position.set(0, spec.turret.y, spec.turret.z);
    group.add(turret);
    const turretMesh = new THREE.Mesh(template.turretGeo.clone(), mats.turret);
    turretMesh.castShadow = true; turretMesh.receiveShadow = true;
    turret.add(turretMesh);

    // §4 玩家白色五角星贴花（贴花随炮塔旋转）
    if (template.star) {
      const starGeo = mats.starUseTexture
        ? (function () {
          const g = new THREE.PlaneGeometry(template.star.size, template.star.size);
          g.rotateX(-Math.PI / 2);
          return g;
        })()
        : starShapeGeometry(template.star.size);
      const starMesh = new THREE.Mesh(starGeo, mats.star);
      starMesh.position.set(0, template.star.y, template.star.z);
      starMesh.castShadow = false; starMesh.receiveShadow = false;
      starMesh.renderOrder = 1;
      turret.add(starMesh);
    }

    // 炮管组（后坐位移只作用于该组；muzzle 取实际炮口世界坐标）
    const barrel = new THREE.Group();
    barrel.name = 'barrel';
    barrel.position.set(0, spec.barrel.relY, spec.barrel.relZ);
    turret.add(barrel);
    const barrelMesh = new THREE.Mesh(template.barrelGeo.clone(), mats.barrel);
    barrelMesh.castShadow = true; barrelMesh.receiveShadow = true;
    barrel.add(barrelMesh);
    const muzzle = new THREE.Object3D();
    muzzle.name = 'muzzle';
    muzzle.position.set(0, 0, -spec.barrel.len);
    barrel.add(muzzle);

    // §4 炮管 0..3 圈橙色发光环（玩家专属；敌人恒 0）
    const fireRings = [];
    if (mats.fire && template.fireRingGeo) {
      const ringGeo = template.fireRingGeo.clone();
      for (let i = 0; i < template.fireRings.length; i++) {
        const ring = new THREE.Mesh(ringGeo, mats.fire);
        ring.position.z = template.fireRings[i];
        ring.visible = false;
        ring.castShadow = false; ring.receiveShadow = false;
        ring.renderOrder = 2;
        barrel.add(ring);
        fireRings.push(ring);
      }
    }

    // §4 根部接触阴影贴花
    const shadow = new THREE.Mesh(template.shadowGeo.clone(), mats.shadow);
    shadow.position.y = SHADOW_DECAL_Y;
    shadow.castShadow = false; shadow.receiveShadow = false;
    shadow.renderOrder = 1;
    group.add(shadow);

    // 材质记录表（克隆后的材质才能在这里安全改色/透明/闪白）
    const records = [];
    records.push(makeRecord(mats.body, { armorScale: key === 'armor' ? 1 : null }));
    records.push(makeRecord(mats.turret, { armorScale: key === 'armor' ? 1 : null }));
    records.push(makeRecord(mats.accent, {}));
    records.push(makeRecord(mats.dark, {}));
    records.push(makeRecord(mats.wheel, {}));
    records.push(makeRecord(mats.track, {}));
    records.push(makeRecord(mats.barrel, { armorScale: key === 'armor' ? 0.78 : null }));
    records.push(makeRecord(mats.shadow, { tintable: false, flashable: false }));
    if (mats.star) records.push(makeRecord(mats.star, { tintable: false, flashable: false }));
    if (mats.fire) records.push(makeRecord(mats.fire, { tintable: false, flashable: false }));

    const model = {
      group,
      body,
      turret,
      barrel,
      muzzle,
      tracks: [trackLeft, trackRight],
      wheels,
      type: key,
      fireLevel: 0,
      faceCount: template.faceCount,

      _records: records,
      _mats: mats,
      _trackTexture: mats.trackTexture,
      _trackScrollScale: TRACK_UV_TILES * TRACK_SCROLL_GAIN / Math.max(0.001, spec.track.len),
      _wheelRadius: Math.max(0.001, spec.wheelRadius),
      _barrelBaseZ: spec.barrel.relZ,
      _recoil: 0,
      _hitFlash: 0,
      _frozen: false,
      _opacity: 1,
      _time: 0,
      _armorHp: key === 'armor' ? 4 : 0,
      _armorMax: key === 'armor' ? 4 : 0,
      _fireRings: fireRings,
      disposed: false,
    };

    // ---- 契约 §6 方法 -------------------------------------------------------
    model.setFireLevel = function (n) {
      const level = Math.max(0, Math.min(MAX_FIRE_LEVEL, Math.round(Number(n) || 0)));
      model.fireLevel = level;
      for (let i = 0; i < fireRings.length; i++) {
        const ring = fireRings[i];
        ring.visible = i < level;
        if (ring.visible) ring.scale.setScalar(1);
      }
    };

    model.recoil = function () {
      model._recoil = RECOIL_OFFSET;
      barrel.position.z = model._barrelBaseZ + model._recoil;
    };

    model.setArmorHealth = function (hp, max) {
      const value = Number.isFinite(hp) ? Math.max(0, Math.round(hp)) : 0;
      model._armorHp = value;
      model._armorMax = Number.isFinite(max) ? Math.max(1, Math.round(max)) : 4;
      if (model.type !== 'armor') return;
      const index = Math.max(0, Math.min(ARMOR_COLORS.length - 1, HP_TO_ARMOR_INDEX_BASE - value));
      const base = new THREE.Color(ARMOR_COLORS[index]).getHex();
      for (let i = 0; i < records.length; i++) {
        const rec = records[i];
        if (rec.armorScale === null) continue;
        rec.baseHex = scaledHexOf(base, rec.armorScale);
        rec.frozenHex = frozenHexOf(rec.baseHex);
      }
      applyTankColors(model);
    };

    model.setFrozen = function (on) {
      const next = !!on;
      if (model._frozen === next) return;
      model._frozen = next;
      applyTankColors(model);
    };

    model.flash = function () {
      model._hitFlash = HIT_FLASH_TIME;
      applyTankColors(model);
    };

    model.setOpacity = function (a) {
      const value = Number.isFinite(a) ? Math.max(0, Math.min(1, a)) : 1;
      model._opacity = value;
      applyTankOpacity(model, value);
      group.visible = value > 0.001;
    };

    model.update = function (dt, opts) {
      if (model.disposed) return;
      const step = Number.isFinite(dt) ? Math.max(0, Math.min(0.1, dt)) : 0;
      const o = opts || {};
      model._time += step;

      // 冻结状态允许由实体每帧通过 opts 同步（与 setFrozen 等价，已同态时零开销）
      if (typeof o.frozen === 'boolean' && model._frozen !== o.frozen) {
        model.setFrozen(o.frozen);
      }

      // §3 受击闪白计时
      if (model._hitFlash > 0) {
        model._hitFlash = Math.max(0, model._hitFlash - step);
        applyTankColors(model);
      } else if (model.type === 'armor' && model._armorHp <= 1) {
        // 1 血高频闪白：颜色按 ARMOR_FLASH_HZ 交替
        applyTankColors(model);
      }

      // §2 后坐回弹：指数衰减 6/s（与帧率无关）
      if (model._recoil > 0) {
        model._recoil *= Math.exp(-RECOIL_RETURN * step);
        if (model._recoil < 0.0005) model._recoil = 0;
        barrel.position.z = model._barrelBaseZ + model._recoil;
      }

      // §4 履带贴图滚动 + 轮组自转（速度正负决定方向；冻结时不动）
      const moving = !!o.moving && !model._frozen;
      const speed = Number.isFinite(o.speed) ? o.speed : 0;
      if (moving && Math.abs(speed) > 0.0001) {
        for (let i = 0; i < wheels.length; i++) {
          wheels[i].rotation.x -= (speed / model._wheelRadius) * step;
        }
        if (mats.trackTexture) {
          let offset = mats.trackTexture.offset.y - speed * step * model._trackScrollScale;
          offset %= 1;
          if (offset < 0) offset += 1;
          mats.trackTexture.offset.y = offset;
        }
      }

      // §4 玩家火力环发光脉动（只做缩放，不抢材质 opacity）
      for (let i = 0; i < fireRings.length; i++) {
        const ring = fireRings[i];
        if (ring.visible) ring.scale.setScalar(1 + Math.sin(model._time * 7 + i * 1.7) * 0.06);
      }
    };

    model.dispose = function () {
      if (model.disposed) return;
      model.disposed = true;
      if (mats.trackTexture) {
        mats.trackTexture.dispose();
        mats.trackTexture = null;
      }
      disposeObjectTree(group);
      group.visible = false;
    };

    // 初始状态：隐形火力环为 0 圈，材质颜色按基础色应用一次
    model.setFireLevel(0);
    applyTankColors(model);
    return model;
  }

  // ---------------------------------------------------------------------------
  // 通用释放：几何/材质去重销毁；贴图由各模型显式处理（共享贴图不销毁）
  // ---------------------------------------------------------------------------
  function disposeObjectTree(root) {
    if (!root) return;
    const geometries = new Set();
    const materials = new Set();
    root.traverse(function (obj) {
      if (obj.geometry && obj.geometry.isBufferGeometry) geometries.add(obj.geometry);
      if (obj.material) {
        if (Array.isArray(obj.material)) {
          for (let i = 0; i < obj.material.length; i++) materials.add(obj.material[i]);
        } else {
          materials.add(obj.material);
        }
      }
    });
    geometries.forEach(function (g) { g.dispose(); });
    materials.forEach(function (m) { if (m && typeof m.dispose === 'function') m.dispose(); });
    if (root.parent) root.parent.remove(root);
    if (typeof root.clear === 'function') root.clear();
  }

  // ---------------------------------------------------------------------------
  // 炮塔残骸（§5 敌坦克亡：炮塔弹起抛物线落地；契约 §6）
  // ---------------------------------------------------------------------------
  function createTurretDebris(type) {
    const key = (ALL_TYPES.indexOf(type) >= 0) ? type : 'basic';
    const spec = SPECS[key];
    const template = TEMPLATES[key];
    const group = new THREE.Group();
    group.name = 'turret-debris-' + key;

    const turretMat = tuneMetal(cloneSurface(baseTurretMaterial(key)), 0.92, 0.40, 0.50);
    const barrelMat = tuneMetal(cloneSurface(baseTurretMaterial(key)), 0.76, 0.60, 0.40);
    const turretMesh = new THREE.Mesh(template.turretGeo.clone(), turretMat);
    turretMesh.castShadow = true; turretMesh.receiveShadow = true;
    group.add(turretMesh);
    const barrel = new THREE.Group();
    barrel.position.set(0, spec.barrel.relY, spec.barrel.relZ);
    group.add(barrel);
    const barrelMesh = new THREE.Mesh(template.barrelGeo.clone(), barrelMat);
    barrelMesh.castShadow = true; barrelMesh.receiveShadow = true;
    barrel.add(barrelMesh);

    let starMesh = null;
    if (key === 'player' && template.star) {
      const starTex = (typeof Tex !== 'undefined' && Tex && Tex.star) ? Tex.star : null;
      const starMat = starTex
        ? new THREE.MeshBasicMaterial({
          map: starTex, color: 0xffffff, transparent: true, depthWrite: false,
          polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
        })
        : new THREE.MeshBasicMaterial({ color: 0xffffff });
      const starGeo = starTex
        ? (function () {
          const g = new THREE.PlaneGeometry(template.star.size, template.star.size);
          g.rotateX(-Math.PI / 2);
          return g;
        })()
        : starShapeGeometry(template.star.size);
      starMesh = new THREE.Mesh(starGeo, starMat);
      starMesh.position.set(0, template.star.y, template.star.z);
      starMesh.castShadow = false; starMesh.receiveShadow = false;
      group.add(starMesh);
    }

    let disposed = false;
    group.dispose = function () {
      if (disposed) return;
      disposed = true;
      disposeObjectTree(group);
    };
    group.userData.type = key;
    return group;
  }

  // ---------------------------------------------------------------------------
  // 鹰徽（§4：两级深灰石基座 + 低模金鹰，原点地面、面向 +Z）
  // ---------------------------------------------------------------------------
  let eagleGeometryCache = null;
  let eagleGroupCache = null; // 鹰徽每关复用同一实例，避免换关重复创建材质/几何

  function buildEagleGeometries() {
    if (eagleGeometryCache) return eagleGeometryCache;

    // 石基座：两级切角石台 + 四角石墩
    const stoneParts = [];
    const tier1 = chamferOutline(0.82, -0.82, 0.82, 0.18);
    stoneParts.push(loftGeo(to3D(tier1, 0.0), to3D(tier1, 0.38)));
    const tier2 = chamferOutline(0.60, -0.60, 0.60, 0.14);
    stoneParts.push(loftGeo(to3D(tier2, 0.38), to3D(tier2, 0.74)));
    for (let i = 0; i < 4; i++) {
      const sx = i < 2 ? -1 : 1;
      const sz = (i % 2 === 0) ? -1 : 1;
      stoneParts.push(boxGeo(0.18, 0.10, 0.18, [sx * 0.64, 0.43, sz * 0.64]));
    }
    const stoneGeo = mergeGeos(stoneParts);

    // 金鹰：栖木环 + 双爪 + 锥形躯干 + 头/喙 + 弯折双翼 + 尾羽
    const goldParts = [];
    const perch = new THREE.TorusGeometry(0.30, 0.038, 4, 14);
    perch.rotateX(Math.PI / 2);
    perch.translate(0, 0.80, 0);
    goldParts.push(perch);
    for (let i = 0; i < 2; i++) {
      const s = i === 0 ? -1 : 1;
      goldParts.push(cylGeo(0.028, 0.036, 0.14, 5, [s * 0.10, 0.79, 0.0]));
      goldParts.push(cylGeo(0.036, 0.028, 0.10, 5, [s * 0.10, 1.00, 0.0]));
    }
    goldParts.push(cylGeo(0.055, 0.16, 0.52, 6, [0, 1.14, 0]));
    const head = new THREE.IcosahedronGeometry(0.105, 0);
    head.translate(0, 1.42, 0.02);
    goldParts.push(head);
    const beak = new THREE.ConeGeometry(0.045, 0.15, 4);
    beak.rotateX(Math.PI / 2);
    beak.translate(0, 1.41, 0.13);
    goldParts.push(beak);

    const wingAcc = new GeoAccum();
    for (let i = 0; i < 2; i++) {
      const s = i === 0 ? -1 : 1;
      const a = [s * 0.08, 1.24, 0.10];
      const b = [s * 0.42, 1.40, 0.00];
      const c = [s * 0.48, 1.36, -0.26];
      const d = [s * 0.10, 1.18, -0.14];
      const e = [s * 0.82, 1.12, -0.24];
      const f = [s * 0.74, 1.05, -0.42];
      wingAcc.quad(a, b, c, d, [0, 1, 0]);
      wingAcc.quad(b, e, f, c, [0, 1, 0]);
      // 翼尖羽毛缺口
      wingAcc.tri(e, f, [s * 0.62, 1.20, -0.24], [0, 1, 0]);
    }
    goldParts.push(wingAcc.build());

    const tailAcc = new GeoAccum();
    tailAcc.tri([0, 1.06, -0.12], [0.16, 0.94, -0.40], [-0.16, 0.94, -0.40], [0, -0.3, -1]);
    tailAcc.tri([0.16, 0.94, -0.40], [0.24, 1.02, -0.30], [0, 1.06, -0.12], [0, 0, 1]);
    tailAcc.tri([-0.16, 0.94, -0.40], [0, 1.06, -0.12], [-0.24, 1.02, -0.30], [0, 0, 1]);
    goldParts.push(tailAcc.build());

    eagleGeometryCache = { stoneGeo: mergeGeos(stoneParts), goldGeo: mergeGeos(goldParts) };
    return eagleGeometryCache;
  }

  function createEagle() {
    if (eagleGroupCache) return eagleGroupCache;
    const group = new THREE.Group();
    group.name = 'eagle';
    const cache = buildEagleGeometries();

    const stoneMat = tuneMetal(
      cloneSurface(pickMaterial(Mat.eagleStone, 0x4a4f55, 0.10, 0.85)), 1.0, 0.15, 0.85
    );
    const goldMat = tuneMetal(
      cloneSurface(pickMaterial(Mat.eagleGold, 0xe8b64c, 0.85, 0.30)), 1.0, 0.85, 0.30
    );
    goldMat.side = THREE.DoubleSide;
    if (goldMat.emissive && goldMat.emissive.isColor) {
      if (goldMat.emissive.getHex() === 0) goldMat.emissive.setHex(0x6b4a12);
      goldMat.emissiveIntensity = Math.max(0.45, goldMat.emissiveIntensity || 0);
    }

    const stone = new THREE.Mesh(cache.stoneGeo.clone(), stoneMat);
    stone.castShadow = true; stone.receiveShadow = true;
    group.add(stone);
    const gold = new THREE.Mesh(cache.goldGeo.clone(), goldMat);
    gold.castShadow = true; gold.receiveShadow = true;
    group.add(gold);

    // 接触阴影贴花（可选存在，与坦克共用 Mat.decalShadow）
    let shadowMat = null;
    if (Mat && Mat.decalShadow && Mat.decalShadow.isMaterial) {
      shadowMat = Mat.decalShadow.clone();
      shadowMat.transparent = true;
      shadowMat.depthWrite = false;
      shadowMat.polygonOffset = true;
      shadowMat.polygonOffsetFactor = -1;
    } else if (typeof Tex !== 'undefined' && Tex && Tex.decalShadow) {
      shadowMat = new THREE.MeshBasicMaterial({
        map: Tex.decalShadow, transparent: true, opacity: 0.5,
        depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1,
      });
    }
    if (shadowMat) {
      const shadowGeo = new THREE.PlaneGeometry(2.15, 2.15);
      shadowGeo.rotateX(-Math.PI / 2);
      const shadow = new THREE.Mesh(shadowGeo, shadowMat);
      shadow.position.y = SHADOW_DECAL_Y;
      shadow.castShadow = false; shadow.receiveShadow = false;
      shadow.renderOrder = 1;
      group.add(shadow);
    }

    let disposed = false;
    group.dispose = function () {
      if (disposed) return;
      disposed = true;
      if (eagleGroupCache === group) eagleGroupCache = null;
      disposeObjectTree(group);
    };
    eagleGroupCache = group;
    return group;
  }

  // ---------------------------------------------------------------------------
  // 道具面板（§2/§4：128×256 面板 + 底部光环；不内置浮动/旋转，实体负责）
  // ---------------------------------------------------------------------------
  const POWERUP_KINDS = ['star', 'grenade', 'helmet', 'timer', 'shovel', 'tank'];
  const POWERUP_PANEL_W = 0.86;
  const POWERUP_PANEL_H = 1.72;
  const POWERUP_HALO_Y = -0.95;

  function panelGeometry(w, h) {
    const front = new THREE.PlaneGeometry(w, h);
    front.translate(0, 0, 0.012);
    const back = new THREE.PlaneGeometry(w, h);
    back.rotateY(Math.PI);
    back.translate(0, 0, -0.012);
    return mergeGeos([front, back]);
  }

  function createPowerup(kind) {
    const key = POWERUP_KINDS.indexOf(kind) >= 0 ? kind : 'star';
    const group = new THREE.Group();
    group.name = 'powerup-' + key;
    group.userData.kind = key;

    const panelTex = (typeof Tex !== 'undefined' && Tex && Tex.panel) ? Tex.panel[key] : null;
    const panelColor = (CONFIG.powerup && CONFIG.powerup.color && CONFIG.powerup.color[key] !== undefined)
      ? CONFIG.powerup.color[key] : 0xffd23f;
    // §4 道具面板：优先克隆 Mat.powerupBase 模板并把面板贴图挂到 map/emissiveMap
    let panelMat;
    const panelBase = (Mat && Mat.powerupBase && Mat.powerupBase.isMaterial) ? Mat.powerupBase : null;
    if (panelBase) {
      panelMat = panelBase.clone();
      panelMat.map = panelTex || null;
      if (panelMat.emissiveMap !== undefined) panelMat.emissiveMap = panelTex || null;
      if (panelTex) {
        panelMat.color.setHex(0xffffff);
        panelMat.emissiveIntensity = Math.max(0.35, panelMat.emissiveIntensity || 0);
      } else {
        panelMat.color.setHex(panelColor);
        if (panelMat.emissive && panelMat.emissive.isColor) panelMat.emissive.setHex(panelColor);
        panelMat.emissiveIntensity = 0.4;
      }
      panelMat.transparent = true;
      panelMat.depthWrite = false;
      panelMat.needsUpdate = true;
    } else {
      panelMat = new THREE.MeshBasicMaterial({
        color: panelTex ? 0xffffff : panelColor,
        transparent: true,
        depthWrite: false,
        side: THREE.FrontSide,
        toneMapped: false,
      });
      if (panelTex) panelMat.map = panelTex;
    }
    const panel = new THREE.Mesh(panelGeometry(POWERUP_PANEL_W, POWERUP_PANEL_H), panelMat);
    panel.renderOrder = 2;
    panel.castShadow = false;
    panel.receiveShadow = false;
    group.add(panel);

    // 底部光环：材质来自 Mat.powerupRing（§4），缺失时用高饱和加法混合光环兜底
    let haloMat;
    if (Mat && Mat.powerupRing && Mat.powerupRing.isMaterial) {
      haloMat = Mat.powerupRing.clone();
      haloMat.transparent = true;
      haloMat.depthWrite = false;
    } else {
      haloMat = new THREE.MeshBasicMaterial({
        color: panelColor, transparent: true, opacity: 0.85,
        blending: THREE.AdditiveBlending, depthWrite: false,
        side: THREE.DoubleSide, toneMapped: false,
      });
    }
    const haloGeo = new THREE.RingGeometry(0.30, 0.62, 24);
    haloGeo.rotateX(-Math.PI / 2);
    const halo = new THREE.Mesh(haloGeo, haloMat);
    halo.position.y = POWERUP_HALO_Y;
    halo.renderOrder = 2;
    halo.castShadow = false;
    halo.receiveShadow = false;
    group.add(halo);

    let disposed = false;
    group.dispose = function () {
      if (disposed) return;
      disposed = true;
      disposeObjectTree(group);
    };
    return group;
  }

  // ---------------------------------------------------------------------------
  // 公开 API（契约 §6）
  // ---------------------------------------------------------------------------
  return {
    player() {
      return createTank('player');
    },
    enemy(type) {
      return createTank(ENEMY_TYPES.indexOf(type) >= 0 ? type : 'basic');
    },
    eagle() {
      return createEagle();
    },
    powerup(kind) {
      return createPowerup(kind);
    },
    turretDebris(type) {
      return createTurretDebris(type);
    },
  };
})();
