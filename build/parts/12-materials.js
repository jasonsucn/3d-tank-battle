// ============================================================================
// 12-materials.js — Mat：全部材质（规格书 §4 材质表；契约 §5）
// 顶层只声明 const Mat，辅助函数全部包在 IIFE 内。
// THREE r160：颜色空间统一用 colorSpace / SRGBColorSpace；不使用旧 encoding API。
// 本模块不在创建时依赖 renderer；scene.environment 由 Main 设置后材质自动生效。
// ============================================================================
const Mat = (() => {
  'use strict';

  const M = { enemyBody: {} };
  let built = false;

  // -------------------------------------------------------------------------
  // §4 水面：真实动画 ShaderMaterial —— 双正弦顶点位移 + 滚动伪法线高光 + 菲涅尔
  // uniforms.uTime 由 World 每帧写入；深 #1d4e8f → 亮 #2f7ec2，透明 0.86。
  // -------------------------------------------------------------------------
  const WATER_VERT = `
    uniform float uTime;
    uniform float uWaveAmp;

    varying vec3 vWorldPos;
    varying vec3 vViewDir;

    void main() {
      vec4 world = modelMatrix * vec4(position, 1.0);

      // 规格书 §4：顶点双正弦波（两组不同频率与速度）
      float w1 = sin(world.x * 1.35 + uTime * 1.40);
      float w2 = sin(world.z * 1.85 - uTime * 1.10);
      float wave = (w1 * 0.65 + w2 * 0.35) * uWaveAmp;

      // 沿世界法线位移；法线缺失时回退到 +Y，保证合并水面稳定
      vec3 wn = mat3(modelMatrix) * normal;
      float wl = length(wn);
      wn = wl > 0.0001 ? wn / wl : vec3(0.0, 1.0, 0.0);
      world.xyz += wn * wave;

      vWorldPos = world.xyz;
      vViewDir = cameraPosition - world.xyz;

      gl_Position = projectionMatrix * viewMatrix * world;
    }
  `;

  const WATER_FRAG = `
    uniform float uTime;
    uniform vec3 uDeep;
    uniform vec3 uShallow;
    uniform vec3 uSkyColor;
    uniform vec3 uSunDir;
    uniform vec3 uSunColor;
    uniform float uOpacity;

    varying vec3 vWorldPos;
    varying vec3 vViewDir;

    void main() {
      vec3 V = normalize(vViewDir);
      vec2 p = vWorldPos.xz;

      // 滚动伪法线：多组交叉余弦模拟细碎水面，不需要额外的法线贴图
      float nx = cos(p.x * 6.0 + uTime * 1.9) * 0.16
               + cos((p.x + p.y) * 11.0 - uTime * 1.4) * 0.10
               + cos(p.y * 3.0 + uTime * 0.8) * 0.06;
      float nz = cos(p.y * 5.0 - uTime * 1.6) * 0.16
               + cos((p.x - p.y) * 9.0 + uTime * 1.1) * 0.10
               + cos(p.x * 4.0 - uTime * 0.9) * 0.06;
      vec3 N = normalize(vec3(nx, 1.0, nz));

      // 深浅水色随缓慢波动混合（深 #1d4e8f → 亮 #2f7ec2）
      float tone = 0.5
                 + 0.26 * sin(p.x * 0.62 + uTime * 0.55)
                 + 0.16 * sin(p.y * 0.83 - uTime * 0.42)
                 + 0.08 * sin((p.x + p.y) * 1.7 + uTime * 0.9);
      tone = clamp(tone, 0.0, 1.0);
      vec3 base = mix(uDeep, uShallow, tone);

      // 波峰提亮 / 波谷压暗（vWorldPos.y 已含顶点双正弦位移，让起伏更立体）
      float crest = clamp((vWorldPos.y - 0.02) / 0.12, 0.0, 1.0);
      base *= 0.86 + 0.20 * crest;

      // 菲涅尔：掠射角反射天空色
      float fres = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 2.5);
      base = mix(base, uSkyColor, clamp(fres, 0.0, 1.0) * 0.35);

      // 太阳高光：窄而亮的水面反光，随滚动伪法线闪烁
      vec3 L = normalize(uSunDir);
      vec3 H = normalize(L + V);
      float ndh = max(dot(N, H), 0.0);
      float spec = pow(ndh, 160.0) * 2.2 + pow(ndh, 40.0) * 0.18;
      vec3 color = base + uSunColor * spec;

      // 极轻微的流动微光，避免大面积纯色（不做成白色光斑）
      color += uSkyColor * 0.03 * (0.5 + 0.5 * sin(p.x * 2.3 + p.y * 1.7 + uTime * 1.3));

      gl_FragColor = vec4(color, uOpacity);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }
  `;

  function build() {
    if (built) return;

    const T = (typeof Tex !== 'undefined' && Tex) ? Tex : null;
    if (T && typeof T.init === 'function') T.init();

    const C = (typeof CONFIG !== 'undefined' && CONFIG) ? CONFIG : {};
    const colors = C.colors || {};
    const bullet = C.bullet || {};
    const enemy = C.enemy || {};
    const enemyColors = enemy.color || {};

    const std = (params) => new THREE.MeshStandardMaterial(params);

    // -----------------------------------------------------------------------
    // 地形（§4）
    // -----------------------------------------------------------------------
    M.ground = std({
      name: 'Mat.ground',
      map: T ? T.ground : null,
      color: 0xffffff,
      metalness: 0.02,
      roughness: 0.96,
      dithering: true,
    });

    M.brick = std({
      name: 'Mat.brick',
      map: T ? T.brick : null,
      color: 0xffffff,
      metalness: 0.02,
      roughness: 0.95,          // §4 砖 r0.95
    });

    M.steel = std({
      name: 'Mat.steel',
      map: T ? T.steel : null,
      color: 0xffffff,
      metalness: 0.9,           // §4 钢 m0.9
      roughness: 0.35,          // §4 钢 r0.35
      envMapIntensity: 1.2,     // §4 钢 env1.2
    });

    M.ice = std({
      name: 'Mat.ice',
      map: T ? T.ice : null,
      color: 0xffffff,
      metalness: 0.1,           // §4 冰 m0.1
      roughness: 0.05,          // §4 冰 r0.05
      envMapIntensity: 2.0,     // §4 冰 env2.0
      dithering: true,
    });

    M.track = std({
      name: 'Mat.track',
      map: T ? T.track : null,
      color: 0x3d3a35,          // §4 履带 #3d3a35（贴图为浅灰，乘色后得到深色履带）
      metalness: 0.25,
      roughness: 0.9,           // §4 履带 r0.9
    });

    M.treeTrunk = std({
      name: 'Mat.treeTrunk',
      color: 0x4a3626,
      metalness: 0.0,
      roughness: 0.92,
      flatShading: true,
    });

    M.treeCrown = std({
      name: 'Mat.treeCrown',
      color: 0x2e7d3f,          // §4 树 #2e7d3f
      metalness: 0.0,
      roughness: 0.85,
      flatShading: true,        // §4 树 flatShading
    });

    // 额外提供深绿冠层，便于 Models 做 2–3 层树冠的明暗层次（规格书 §4 树 #1f5c2e）
    M.treeCrownDark = std({
      name: 'Mat.treeCrownDark',
      color: 0x1f5c2e,          // §4 树 #1f5c2e
      metalness: 0.0,
      roughness: 0.88,
      flatShading: true,
    });

    M.decalShadow = new THREE.MeshBasicMaterial({
      name: 'Mat.decalShadow',
      map: T ? T.decalShadow : null,
      color: 0xffffff,
      transparent: true,
      opacity: 0.62,
      depthWrite: false,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
      toneMapped: false,
    });

    // -----------------------------------------------------------------------
    // 玩家（§4：迷彩 m0.25 / r0.6）与敌方四型（m0.3 / r0.55）
    // -----------------------------------------------------------------------
    M.playerBody = std({
      name: 'Mat.playerBody',
      map: T ? T.camo : null,
      color: 0xffffff,
      metalness: 0.25,           // §4 玩家迷彩 m0.25
      roughness: 0.6,            // §4 玩家迷彩 r0.6
      flatShading: true,
    });

    M.playerTurret = std({
      name: 'Mat.playerTurret',
      map: T ? T.camoDark : null,
      color: 0xffffff,
      metalness: 0.25,
      roughness: 0.6,
      flatShading: true,
    });

    M.playerAccent = std({
      name: 'Mat.playerAccent',
      color: colors.playerAccent || '#ffcf5e',
      metalness: 0.35,
      roughness: 0.42,
      flatShading: true,
    });

    const enemyBase = {
      metalness: 0.3,            // §4 敌车 m0.3
      roughness: 0.55,           // §4 敌车 r0.55
      flatShading: true,
    };
    M.enemyBody.basic = std(Object.assign({ name: 'Mat.enemyBody.basic', color: enemyColors.basic || '#8f8f96' }, enemyBase));
    M.enemyBody.fast = std(Object.assign({ name: 'Mat.enemyBody.fast', color: enemyColors.fast || '#c9cdd4' }, enemyBase));
    M.enemyBody.power = std(Object.assign({ name: 'Mat.enemyBody.power', color: enemyColors.power || '#c96a3a' }, enemyBase));
    M.enemyBody.armor = std(Object.assign({ name: 'Mat.enemyBody.armor', color: enemyColors.armor || '#4f7d5c' }, enemyBase));

    // -----------------------------------------------------------------------
    // 鹰徽（§4：金 #e8b64c m0.85/r0.3/emissive #6b4a12；深灰石基座）
    // -----------------------------------------------------------------------
    M.eagleGold = std({
      name: 'Mat.eagleGold',
      color: 0xe8b64c,
      metalness: 0.85,           // §4 鹰金 m0.85
      roughness: 0.3,            // §4 鹰金 r0.3
      emissive: 0x6b4a12,        // §4 鹰金 emissive #6b4a12
      emissiveIntensity: 0.6,
      envMapIntensity: 1.15,
      flatShading: true,
    });

    M.eagleStone = std({
      name: 'Mat.eagleStone',
      color: 0x5c646d,
      metalness: 0.05,
      roughness: 0.95,
      flatShading: true,
    });

    // -----------------------------------------------------------------------
    // §5 特效材质
    // -----------------------------------------------------------------------
    // 单 Points 粒子：加法混合 + vertexColors + 透明 + 不写深度
    M.particle = new THREE.PointsMaterial({
      name: 'Mat.particle',
      map: T ? T.spark : null,
      color: 0xffffff,
      vertexColors: true,
      size: 0.32,
      sizeAttenuation: true,
      transparent: true,
      opacity: 1,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: true,
      toneMapped: false,
    });

    // 闪光精灵：加法混合
    M.flash = new THREE.SpriteMaterial({
      name: 'Mat.flash',
      map: T ? T.spark : null,
      color: 0xffe6b0,
      transparent: true,
      opacity: 0.95,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    });

    // 冲击环：MeshBasicMaterial 加法混合 + 双面
    M.ring = new THREE.MeshBasicMaterial({
      name: 'Mat.ring',
      map: T ? T.ring : null,
      color: 0xffffff,
      transparent: true,
      opacity: 0.9,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      depthWrite: false,
      toneMapped: false,
    });

    // 碎片 InstancedMesh：白色底，FX 用 instanceColor 逐块着色
    M.debrisMat = std({
      name: 'Mat.debrisMat',
      color: 0xffffff,
      metalness: 0.3,
      roughness: 0.78,
      flatShading: true,
    });

    // 烟雾精灵
    M.smokeMat = new THREE.SpriteMaterial({
      name: 'Mat.smokeMat',
      map: T ? T.smoke : null,
      color: 0x9a938a,
      transparent: true,
      opacity: 0.58,
      depthWrite: false,
      blending: THREE.NormalBlending,
    });

    // 备用：若 FX 的烟雾用 Points 而不是 Sprite，可直接使用这一材质
    M.smokePoints = new THREE.PointsMaterial({
      name: 'Mat.smokePoints',
      map: T ? T.smoke : null,
      color: 0x9a938a,
      vertexColors: true,
      size: 0.55,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
      blending: THREE.NormalBlending,
    });

    // 雪花粒子（定时器冻结期间使用，Normal 混合以保持柔和）
    M.snowMat = new THREE.PointsMaterial({
      name: 'Mat.snowMat',
      map: T ? T.snow : null,
      color: 0xffffff,
      vertexColors: true,
      size: 0.22,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0.85,
      blending: THREE.NormalBlending,
      depthWrite: false,
      toneMapped: false,
    });

    // -----------------------------------------------------------------------
    // §4 水：ShaderMaterial（uniforms.uTime 由 World 每帧推进）
    // -----------------------------------------------------------------------
    M.water = new THREE.ShaderMaterial({
      name: 'Mat.water',
      uniforms: {
        uTime: { value: 0 },
        uDeep: { value: new THREE.Color(0x1d4e8f) },
        uShallow: { value: new THREE.Color(0x2f7ec2) },
        uSkyColor: { value: new THREE.Color(0x6fa8d8) },
        uSunDir: { value: new THREE.Vector3(0.45, 0.82, 0.35).normalize() },
        uSunColor: { value: new THREE.Color(0xfff3d6) },
        uOpacity: { value: 0.86 },
        uWaveAmp: { value: 0.07 },
      },
      vertexShader: WATER_VERT,
      fragmentShader: WATER_FRAG,
      transparent: true,         // §4 透明 0.86（alpha 由 uOpacity 输出）
      opacity: 0.86,
      depthWrite: false,
      side: THREE.DoubleSide,
    });

    // -----------------------------------------------------------------------
    // 子弹（§2 发光弹体；bulletGlow 给 Sprite，bulletCore 给核心 Mesh）
    // -----------------------------------------------------------------------
    M.bulletGlow = new THREE.SpriteMaterial({
      name: 'Mat.bulletGlow',
      map: T ? T.spark : null,
      color: bullet.glowColor !== undefined ? bullet.glowColor : 0xffd27a,
      transparent: true,
      opacity: 0.95,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    });

    M.bulletCore = new THREE.MeshBasicMaterial({
      name: 'Mat.bulletCore',
      color: bullet.coreColor !== undefined ? bullet.coreColor : 0xfff6dd,
      toneMapped: false,
    });

    // 备用：若 Entities 用 Mesh 而非 Sprite 做光晕，可直接用这一材质
    M.bulletGlowMesh = new THREE.MeshBasicMaterial({
      name: 'Mat.bulletGlowMesh',
      map: T ? T.spark : null,
      color: bullet.glowColor !== undefined ? bullet.glowColor : 0xffd27a,
      transparent: true,
      opacity: 0.75,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      depthWrite: false,
      toneMapped: false,
    });

    // -----------------------------------------------------------------------
    // 道具（§2/§4）
    // powerupBase 是模板：Models.powerup 克隆后把 map / emissiveMap 设为 Tex.panel[kind]
    // -----------------------------------------------------------------------
    M.powerupBase = std({
      name: 'Mat.powerupBase',
      color: 0xffffff,
      metalness: 0.18,
      roughness: 0.42,
      emissive: 0xffffff,
      emissiveIntensity: 0.22,
      transparent: true,
      opacity: 1,
      alphaTest: 0.02,
      side: THREE.DoubleSide,
    });

    M.powerupRing = new THREE.MeshBasicMaterial({
      name: 'Mat.powerupRing',
      map: T ? T.ring : null,
      color: 0xffb02e,
      transparent: true,
      opacity: 0.85,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      depthWrite: false,
      toneMapped: false,
    });

    // 炮塔白色五角星贴花模板（Models 可按需使用，不强制）
    M.playerStar = new THREE.MeshBasicMaterial({
      name: 'Mat.playerStar',
      map: T ? T.star : null,
      color: 0xffffff,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
      toneMapped: false,
    });

    built = true;
  }

  const api = {
    // 幂等：LOADING 阶段可提前创建全部材质
    init() {
      build();
      return api;
    },
    get ground() { build(); return M.ground; },
    get brick() { build(); return M.brick; },
    get steel() { build(); return M.steel; },
    get ice() { build(); return M.ice; },
    get track() { build(); return M.track; },
    get treeTrunk() { build(); return M.treeTrunk; },
    get treeCrown() { build(); return M.treeCrown; },
    get treeCrownDark() { build(); return M.treeCrownDark; },
    get decalShadow() { build(); return M.decalShadow; },
    get playerBody() { build(); return M.playerBody; },
    get playerTurret() { build(); return M.playerTurret; },
    get playerAccent() { build(); return M.playerAccent; },
    get playerStar() { build(); return M.playerStar; },
    get enemyBody() { build(); return M.enemyBody; },
    get eagleGold() { build(); return M.eagleGold; },
    get eagleStone() { build(); return M.eagleStone; },
    get particle() { build(); return M.particle; },
    get flash() { build(); return M.flash; },
    get ring() { build(); return M.ring; },
    get debrisMat() { build(); return M.debrisMat; },
    get smokeMat() { build(); return M.smokeMat; },
    get smokePoints() { build(); return M.smokePoints; },
    get snowMat() { build(); return M.snowMat; },
    get water() { build(); return M.water; },
    get bulletGlow() { build(); return M.bulletGlow; },
    get bulletCore() { build(); return M.bulletCore; },
    get bulletGlowMesh() { build(); return M.bulletGlowMesh; },
    get powerupBase() { build(); return M.powerupBase; },
    get powerupRing() { build(); return M.powerupRing; },
  };
  return api;
})();
