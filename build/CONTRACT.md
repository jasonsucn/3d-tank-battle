# BATTLE CITY 3D — 开发契约（所有模块必须遵守）

> 本文件是模块之间的唯一接口约定。**先读《坦克大战3D_Agent一次性开发规格书.md》相关章节，再读本文件，然后只写自己被分配的文件。**
> 规格书是需求上限；本契约是接口下限。两者冲突时以规格书为准，并在回报里说明。

## 0. 交付物与构建方式

- 最终交付：**单文件** `D:\DeepSeek Harness WorkSpace\3DTANK\battle-city-3d.html`（由 Lead 装配，队友不要写它）。
- 开发源码在 `D:\DeepSeek Harness WorkSpace\3DTANK\build\`：

```
build/
├── CONTRACT.md            本文件（Lead）
├── template.html          HTML 外壳，含 __CSS__ / __BODY__ / __SCRIPT__ 占位（Lead）
├── assemble.mjs           装配脚本：拼成 battle-city-3d.html（Lead）
├── parts/
│   ├── 00-imports.js      import 语句（Lead）
│   ├── 01-config.js       CONFIG / G（Lead）
│   ├── 02-utils.js        UTILS / DIRS（Lead）
│   ├── 10-audio.js        AudioSys（audio-dev）
│   ├── 11-textures.js     Tex（texture-dev）
│   ├── 12-materials.js    Mat（texture-dev）
│   ├── 13-models.js       Models（model-dev）
│   ├── 20-fx.js           FX（fx-dev）
│   ├── 30-world.js        World（Lead）
│   ├── 40-entities.js     Entities（Lead）
│   ├── 50-ai.js           AI（Lead）
│   ├── 60-levels.js       LEVELS（level-dev）
│   ├── 70-state.js        Game（Lead）
│   ├── 80-ui.js           UI（ui-dev）
│   ├── 90-input.js        Input（Lead）
│   └── 99-main.js         Main / bootstrap（Lead）
├── parts/ui.css           UI 样式（ui-dev）
└── parts/ui.html          UI DOM 结构（ui-dev）
```

- 所有 JS 分片按文件名顺序**原样拼接**进同一个 `<script type="module">`。因此：
  - 分片里**不要写 import / export**（import 只在 `00-imports.js`）；
  - 所有分片共享同一个模块作用域，`THREE` / `CONFIG` / `G` / `UTILS` / `DIRS` 以及前面分片的顶层 `const` 可直接用；
  - **只能声明分配给你的顶层名字**，内部辅助函数一律包在 IIFE / 函数体里，避免重名。分片之间禁止同名顶层变量。
- 自检：`node --check build\parts\你的文件.js` 必须通过。不要运行装配（Lead 负责）。
- 只改自己分到的文件。**不要**创建、删除、移动其它文件。

## 1. 全局禁令（规格书 §0/§8，验收 §9）

- 禁止 TODO / FIXME / 待实现 / 占位 / 简化版本 / 假数据 / console.log 冒充实现；交出去的东西必须真能用。
- 禁止外部素材（图片/音频/模型/字体文件）；贴图一律 Canvas 绘制，声音一律 Web Audio 合成。
- 中文注释，关键处标注规格书章节号，如 `// §5 敌坦克亡`。
- 运行期禁止 `new` 高频对象：粒子/碎片/浮字/环/闪光/动态光必须预分配池化（FX 模块）。
- 不写魔法数字：可调数值进 `CONFIG`（本文件已给定大部分，缺的加在对应模块内的局部常量并注释，不要改 CONFIG 结构）。
- 每个公开函数都要能承受空值/零向量，任何方向归一化前判断长度。

## 2. 坐标系、方向、单位（规格书 §2）

- 场地 26×26，中心原点；X 向右，Z 向屏幕下方，Y 向上。1 单位 = 原版半格。
- 单位格（cell）中心：`x = i - 12.5`，`z = j - 12.5`（i,j ∈ 0..25）；格边界在整数坐标。
- 块（block）13×13：块 (c,r) 覆盖单位 i=2c..2c+1、j=2r..2r+1，中心 `x=(c-6)*2, z=(r-6)*2`。
- 坦克 2×2，位于整数且**偶数**坐标时正好占一个块；转向吸附 `v = Math.round(v/2)*2`。
- 方向：

```js
DIRS = {
  up:    { x: 0,  z: -1, angle: 0,            axis: 'z' },
  right: { x: 1,  z: 0,  angle: -Math.PI / 2, axis: 'x' },
  down:  { x: 0,  z: 1,  angle: Math.PI,      axis: 'z' },
  left:  { x: -1, z: 0,  angle: Math.PI / 2,  axis: 'x' }
}
```

- 模型朝向：所有坦克/炮管模型**正面朝 -Z**，`group.rotation.y = DIRS[dir].angle` 即朝向该方向。
- 高度约定：砖 1.2、钢 1.4、树冠底 ≥1.6、冰板 0.04、水面 0.08、鹰底座约 0.9、坦克总高约 0.9。
- 出生块：玩家 (4,12)、(8,12)；敌方 (0,0)、(6,0)、(12,0)；鹰 (6,12)；护卫砖 (5,11)(6,11)(7,11)(5,12)(7,12)。
- 世界坐标工具（UTILS 提供）：`cellCenter(i)`、`blockCenter(c)`、`worldToCell(v)`。

## 3. 全局名字

除 `THREE`（import）外，以下顶层名字由 Lead 分片定义，所有模块**读取时机必须在调用时**（初始化函数里可以安全引用，因为那时已定义）：

- `CONFIG`：全部可调参数（见 `01-config.js`，字段名以该文件为准）。
- `G`：全局运行时对象（见 `01-config.js`）。
- `UTILS`：工具函数（见 `02-utils.js`）。
- `DIRS`：四方向常量。
- `AudioSys`、`Tex`、`Mat`、`Models`、`FX`、`LEVELS`、`UI`：各模块顶层对象。
- `World`、`Entities`、`AI`、`Game`、`Input`、`Main`：Lead 模块。

`G` 的关键字段（只读约定，除注明外不要写）：

```js
G = {
  state:'BOOT',      // LOADING/TITLE/HELP/SETTINGS/INTRO/PLAYING/PAUSED/TALLY/GAMEOVER
  mode:'single',     // 'single' | 'duo'
  stage:1, score:0, hiScore:0,
  theme:0,           // 0 白昼 1 黄昏 2 冰原 3 夜战
  time:0, timeScale:1, paused:false,
  renderer:null, scene:null, camera:null, composer:null,
  world:null, fx:null, titleStage:null,
  player:null, players:[], enemies:[], bullets:[], powerups:[],
  settings:{ master:80, music:60, sfx:80, quality:'high', view:'follow', scanline:true, shake:true },
  quality:'high',
  stats:{ enemiesLeft:0, remainingByType:{} },
}
```

## 4. AudioSys —— `build/parts/10-audio.js`（audio-dev）

Web Audio 全合成（规格书 §6）。顶层只允许 `const AudioSys = (() => { ... })();`。

```js
AudioSys = {
  init(),                         // 首次用户手势调用；创建/恢复 AudioContext 与总线；可重复调用，幂等
  ready,                          // boolean，音频是否可用
  muted,                          // boolean
  setVolume(kind, v),             // kind: 'master'|'music'|'sfx'，v 0..100（立即生效并平滑）
  setMuted(flag),
  play(name, opts),               // 音效；opts 可选 {volume, rate, detune, pan}；未解锁时静默返回
  startMusic(track),              // 'title' | 'battle'，切换/循环，重复调用同曲不重启
  stopMusic(),
  pause(),                        // 上下文 suspend（暂停/失焦）
  resume(),                       // 恢复
  startEngine(),                  // 玩家引擎循环启动
  stopEngine(),
  setEngine(moving, speedFactor), // 每帧/节流调用：moving 时音调 +12%、增益 .05，否则 .015
  update(dt)                      // 可选：帧回调，用于音乐压低恢复等；内部定时器自行管理
}
```

`play(name)` 必须实现的名称（全部，缺一不可）：

`fire, hitBrick, hitSteel, bulletCancel, explosionSmall, explosionBig, shieldHit, powerupSpawn, powerupPick, lifeUp, freeze, shovel, grenade, tick, spawn, horn, jingle, gameover, uiMove, uiSelect, pause`

- BGM 用规格书附录 B 乐谱（战斗 132BPM / 标题 96BPM / 号角 / Jingle / GAME OVER），lookahead 0.12s、30ms 定时器、16 分音符网格。
- `setInterval` 只允许出现在本文件（BGM 调度），并在注释里写明用途。
- 混音：master/music/sfx 三路 + compressor；爆炸时 musicGain 瞬压 30% 并 120ms 恢复；同帧同类 SFX >4 合并（参考 `CONFIG.audio.maxSameSfx`）。
- 音量值转换：`v/100` 后做感知曲线（如平方）避免过响；主输出必须压得住，不能爆音。

## 5. Tex / Mat —— `build/parts/11-textures.js`、`12-materials.js`（texture-dev）

顶层只允许 `const Tex = (() => { ... })();` 与 `const Mat = (() => { ... })();`。

```js
Tex = {
  init(),                    // 一次性创建全部 CanvasTexture（256²，sRGB，RepeatWrapping 视用途）
  ground, brick, steel, track, ice, camo, camoDark, spark, smoke, snow, ring, star,
  decalShadow,               // 径向渐变接触阴影
  panel: { star, grenade, helmet, timer, shovel, tank },  // 128×256 道具面板
  scoreAtlas?                // 可选：数字精灵，不用也行
}
Mat = {
  ground, brick, steel, ice, track, treeTrunk, treeCrown, decalShadow,
  playerBody, playerTurret, playerAccent,
  enemyBody: { basic, fast, power, armor },   // armor 由 Models 克隆后改色
  eagleGold, eagleStone,
  particle,    // PointsMaterial：加法混合、vertexColors、透明、depthWrite:false
  flash,       // SpriteMaterial：加法混合、透明
  ring,        // MeshBasicMaterial：加法混合、透明、双面
  debrisMat,   // 碎片 InstancedMesh 用
  smokeMat,    // 烟雾 Sprite/Points 用
  water,       // ShaderMaterial：双正弦波+伪法线高光+菲涅尔；uniforms: uTime
  bulletGlow, bulletCore,
  powerupBase, powerupRing,
}
```

- 材质参数严格按规格书 §4「材质」：玩家迷彩 m0.25/r0.6、敌车 m0.3/r0.55、履带 #3d3a35 r0.9、砖 r0.95、钢 m0.9/r0.35/env1.2、树 flatShading、鹰金 #e8b64c m0.85/r0.3/emissive #6b4a12、冰 m0.1/r0.05/env2.0。
- `Mat` 创建时不依赖 `scene.renderer`；`scene.environment` 由 Main 设置，材质会自动生效。
- `Mat.water` 的 ShaderMaterial 必须真实动画（顶点位移 + 高光 + 菲涅尔，深 #1d4e8f→亮 #2f7ec2，透明 0.86），`Mat.water.uniforms.uTime.value` 由 World 每帧推进。
- 贴图内容按 §4「贴图」：砖底 #b3552e+错缝缝 #6b3220+烧灼噪点；钢 #9aa3ad 拉丝+四角铆钉；地面 #1a1714 碎石+淡网格+轮胎痕/弹坑；玩家迷彩 #d8a028/#b07f1e/#8a6318；履带 4px 履齿条纹；冰 #bfe3ef 斜刮痕；粒子径向渐变白圆；道具面板深底高饱和图标（六种图标全画，形状可用 Canvas path，禁止依赖 emoji 字体）。
- 轨道贴图必须是竖向条纹并向 −Y 方向滚动（由 Models 改 offset）。

## 6. Models —— `build/parts/13-models.js`（model-dev）

顶层只允许 `const Models = (() => { ... })();`。所有模型程序化 BufferGeometry，flatShading 低多边形，单体 300–1500 面（规格书 §4）。

```js
Models = {
  player(),                    // -> TankModel（玩家黄色迷彩）
  enemy(type),                 // type: 'basic'|'fast'|'power'|'armor' -> TankModel
  eagle(),                     // -> THREE.Group（石基座+金鹰，原点在地面中心，朝 +Z 面向玩家）
  powerup(kind),               // kind: 'star'|'grenade'|'helmet'|'timer'|'shovel'|'tank' -> THREE.Group
  turretDebris(type),          // -> THREE.Group（被毁时弹起的炮塔组件，含炮管）
  setEnv(envMapIntensity)?     // 可选
}
```

`TankModel` 对象（每个实例独立克隆材质，允许改色/透明/闪烁）：

```js
{
  group,                    // THREE.Group，原点=车底中心，朝 -Z
  body, turret, barrel, muzzle,     // THREE.Object3D，muzzle 用于取炮口世界坐标
  tracks: [Mesh, Mesh],     // 左右履带
  wheels: [Mesh, ...],      // 负重轮
  type,                     // 'player'|'basic'|'fast'|'power'|'armor'
  setFireLevel(n),          // 0..3：炮管橙色发光环数量（玩家等级；敌人恒 0）
  recoil(),                 // 炮管后坐 0.18 并在 update 中以 6/s 回弹
  setArmorHealth(hp, max),  // 装甲车按血量 #4f7d5c→#b8a24a→#cfd6dd→高频闪白（其余类型忽略）
  setFrozen(on),            // 冻结：整车叠深蓝色调（材质 color 乘 0.55 蓝）
  flash(),                  // 受击闪白 0.1s（内部计时）
  setOpacity(a),            // 出生/复活渐变 0..1（整体材质 transparent）
  update(dt, { speed, moving, frozen }),  // 履带 offset 滚动（正负随进退）、轮子转、后坐回弹、闪烁计时
  dispose(),                // 释放几何/材质（本局内基本不调用，安全起见提供）
}
```

- 玩家模型：前后削角车体+履带轮组+切角炮塔+白色五角星贴花+炮管+侧裙/排气罐（§4 模型）。
- 敌方四型轮廓按 §3 表：basic 小圆润炮塔短管；fast 窄长车身双小履带+散热格栅；power 长炮管+双室制退器+弹舱；armor 加宽车体+侧挂 4 板+双排轮。
- `powerup(kind)`：128×256 面板用 `Tex.panel[kind]`、竖直悬浮姿态（面向镜头由实体每帧做 billboard 或旋转）、底部光环 mesh 用 `Mat.powerupRing`。不内置上下浮动，实体负责。
- 所有模型不得使用外部资源；尺寸与场地匹配（2×2 格）。

## 7. FX —— `build/parts/20-fx.js`（fx-dev）

顶层只允许 `const FX = (() => { ... })();`。全部对象池预分配（§5/§8），运行期零 new。

```js
FX = {
  init(scene),               // 创建粒子 Points / 碎片 InstancedMesh / 环 / 闪光 / 浮字 / 动态光池；可重复调用先清理
  update(dt, camera),        // 推进全部效果、回收池、更新 billboard 浮字
  setQuality(level),         // 'high'|'medium'|'low' 切换粒子容量（预先建够，激活子集）
  clear(),                   // 清场（换关/回标题）
  trauma,                    // number，相机震屏强度（Main 读取，衰减 1.8/s 在 update 里做）
  shake(amount),             // trauma += amount（砖 .04/钢 .08/敌爆 .18/玩家亡 .3/鹰毁 .5）
  explosion(pos, opts),      // opts { scale=1, big=false, color=0xffa040 }
  muzzleFlash(pos, dir),     // 火光精灵+火花+光池闪 60ms
  impactBrick(pos, dir),     // 砖屑×5+棕色尘雾
  impactSteel(pos, dir),     // 白橙火花扇形×10+金属碎片×2
  bulletCancel(pos),         // 十字火花×8
  tankDeath(pos, opts),      // opts { player=false, color, turretType='basic' }：白闪→炮塔弹起→火球×4+烟×12+碎片×8+冲击环+橙光+震
  spawnBeam(pos),            // 敌出生：竖直光柱收束 1s+双扩散环+上升粒子（由 Entities 控制实体淡入）
  powerupSpawn(pos),         // 光柱落地+金粒旋落
  powerupPickup(pos),        // 爆星×20
  shieldHit(pos),            // 泡泡脉冲+青色电纹粒子
  iceTrail(pos, dir),        // 冰晶屑
  dust(pos, color),          // 移动扬尘（一粒）
  waterRipple(pos),          // 入/出水涟漪环+水花
  baseDestroyed(pos),        // 金碎片×16+超大火球+三连冲击环+2.5s 六连爆+白闪（慢动作/震屏由 Game 处理）
  scoreText(pos, value),     // 3D 浮动分数（池 12）
  light(pos, color, intensity, life), // 借用 6 个动态 PointLight
  flashWhite(duration),      // 调 UI.flashWhite（若 UI 可用），否则内部 DOM
  freezeOverlay(),           // 调 UI（蓝色边缘渐晕）；UI 未定义时用 CSS 兜底
  shovelFlash(pos),          // 砖→钢变换闪光+石屑
  ring(pos, opts),           // 通用冲击环 opts {color, scale, duration}
  tracer(from, to, color)?   // 可选
}
```

- 粒子：单个 `Points`，加法混合，属性 position/color/size/life/velocity/gravity；容量取 `CONFIG.fx.particles[quality]`。
- 碎片：InstancedMesh 64，重力 −20、落地反弹 0.35、随机旋转、2s 缩小消失。
- 冲击波环 ×8、闪光精灵 ×8、浮动分数 ×12、动态光池 ×6 全部预分配循环复用；运行期不得 `new THREE.*` 或创建 DOM。
- `tankDeath` 的炮塔弹起可用 `Models.turretDebris(type)`（模块加载时预建 4 份缓存），抛物线落地后缩小消失。
- 所有位置参数是 `THREE.Vector3`（或 `{x,y,z}`，内部转）。
- 对 UI 的调用必须在 `typeof UI !== 'undefined'` 且 `UI.flashWhite` 存在时执行（顺序：FX 在 UI 之前定义）。

## 8. LEVELS —— `build/parts/60-levels.js`（level-dev）

顶层只允许 `const LEVELS = (() => { ... })();`。逐字实现规格书 §3 五张地图与随机图。

```js
LEVELS = {
  MAPS: [ [13 strings ×5] ],
  build(stage),          // 1..5 固定图；6+ 随机图。返回 13 个长度 13 的字符串数组
  random(stage),         // 按主题生成合法随机图（砖12–18/钢2–5/水0–8/树0–6/冰0–8 块）
  validate(rows),        // -> { ok:boolean, reasons:string[] }；开放= '.'/'T'/'I'
  themeOf(stage),        // -> 0..3（白昼/黄昏/冰原/夜战）用于 Main
  parse(rows),           // -> { grid: string[13][13], bricks:number, ... } 可选
  placeGuard(rows),      // 内置：确保鹰与五块护卫砖（随机图用）
}
```

- 五张地图逐字符照抄规格书（含 `.`、`B`、`S`、`W`、`T`、`I`、`E`），不得改写。
- 校验（§3）：五个出生块 (0,0)/(6,0)/(12,0)/(4,12)/(8,12) 必须 `.` 且洪泛连通（开放格 `.`/`T`/`I`）；至少一个开放格与护卫墙正交相邻。
- 随机图：出生点/鹰/护卫墙固定，其它按数量随机撒；生成后必须 `validate.ok === true` 才返回（失败重试，最多 50 次，否则回退地图 1）。
- 只依赖字符串与 CONFIG，不依赖 THREE。

## 9. UI —— `build/parts/80-ui.js` + `ui.css` + `ui.html`（ui-dev）

顶层只允许 `const UI = (() => { ... })();`。DOM 结构写 `ui.html`，样式写 `ui.css`，逻辑写 `80-ui.js`。规格书 §7 全套屏幕与 HUD 必须实现。

`ui.html` **必须包含**（Lead 的 template 会把它插入 `<body>`）：

```html
<canvas id="view"></canvas>
<div id="hud"> ... 左上 SCORE/HI-SCORE/火力 ★、右栏敌方图标/道具状态/生命/STAGE ... </div>
<div id="crt"></div>                                  <!-- 扫描线/暗角覆盖层 -->
<div id="flash-white"></div><div id="flash-red"></div>
<div id="toast"></div>
<section id="screen-loading" class="screen">...</section>
<section id="screen-title" class="screen">...</section>
<section id="screen-help" class="screen">...</section>
<section id="screen-settings" class="screen">...</section>
<section id="screen-intro" class="screen">...</section>
<section id="screen-pause" class="screen">...</section>
<section id="screen-tally" class="screen">...</section>
<section id="screen-gameover" class="screen">...</section>
```

```js
UI = {
  init(actions),      // actions = { start(mode), showHelp(), showSettings(), back(), resume(), restart(), toTitle(), setting(key,value), unlockAudio(), next() }
  setScreen(name),    // 'loading'|'title'|'help'|'settings'|'intro'|'pause'|'tally'|'gameover'|null
  setHudVisible(on),
  setHUD(h),          // { score, hiScore, lives, stage, fireLevel, mode, livesP2 }
  setEnemyIcons(total, killed),   // 20 个 SVG 小坦克，2 列；击杀即灭（=total-killed 剩余）
  setPowerups(list),  // [{ kind, remain, total }]，无则空数组；绘制图标+倒计时环
  setIntro(stage),    // 灰幕 0.8s → STAGE N 红字 1.2s → 幕开 0.8s（“灰幕/开合”用 CSS 动画）
  showTally(data),    // { counts:{basic,fast,power,armor}, bonus, total, hiScore }
  showGameOver(data), // { score, hiScore, stage }
  setLoading(progress),// 0..1，LOADING 屏幕进度；文案“按任意键开始”在音频解锁后显示（onUnlockAudio）
  flashWhite(duration), flashRed(duration),
  toast(text, ms),
  applySettings(s),   // 音量滑杆/画质/视角/扫描线/震屏勾选状态同步
  setScanline(on),
  key(e),             // 键盘事件路由（Enter/Escape/方向/确认），返回 true 表示已消费
  setTitleMeta(hiScore)
}
```

- 标题菜单：单人 / 双人 / 操作说明 / 设置；金色 ▶ 光标；HI-SCORE；标题 BGM 由 Game 播放，不归 UI。
- SETTINGS：主音量/音乐/音效三滑杆（0–100）、画质 高/中/低、视角 跟随/经典、扫描线开关、震屏开关、Esc 返回；改动即调用 `actions.setting(key,value)`（key: `master|music|sfx|quality|view|scanline|shake`）。
- HELP：键位表 + 六道具图鉴。
- PAUSED：继续/重开/设置/回标题，呼吸闪烁。
- TALLY：四类击杀逐个跳字 + `AudioSys.play('tick')`（UI 自己发），最后奖励 1000。
- GAME_OVER：红闪 + “GAME OVER” 自底升起。
- LOADING：初始屏幕；任意键/点击触发 `actions.unlockAudio()`，之后显示开始提示（实际开局由 Game 处理）。
- HUD 玻璃拟态、`pointer-events:none`；CSS 变量严格用规格书 §7 的 `:root`。
- 屏幕切换用 `.active` / `.hidden` 类（自己定义并在 CSS 保证只有当前屏可见）。
- 动画用 CSS transition/animation，不用 `setInterval`（倒计时环可用 requestAnimationFrame 或 Game 每帧传值）。
- 所有按钮必须真实绑定行为，禁止装饰性死按钮。
- 禁止用 emoji 作为图标（道具图标用 CSS/SVG/字符绘制；分数等字体带回退）。

## 10. Lead 模块（供调用参考）

```js
Game = {
  start(mode), pause(), resume(), restart(), toTitle(),
  startStage(stage), nextStage(), gameOver(),
  applySetting(key, value), setQuality(q), setView(v), setScanline(v), setShake(v)
}
Entities = {
  spawnPlayer(index), spawnEnemy(type, queueIndex, carrier), updateTanks(dt),
  updateBullets(dt), fire(playerOrEnemy), damageTank(tank, bullet), ...
}
World = {
  init(scene), load(rows, theme), clear(), update(dt),
  tankBlocked(x,z), bulletHit(from,to,opts), destroyEagle(), setShovel(on, remain),
  ...
}
```

具体签名以 Lead 编写为准，队友只要不调用它们即可（UI/Audio/Tex/Mat/Models/FX/LEVELS 相互之间只按本契约调用）。

## 11. 汇报格式（写给 Lead 的最终消息）

```
状态：完成 / 部分完成（原因）
文件：build/parts/xx.js（行数）
公开 API：逐条列出实际实现的（对照契约）
自检：node --check 结果
已知风险 / 未覆盖点：
需要 Lead 注意的接口假设：
```

不要在完成消息里吹嘘，不要虚报验证层级。

## 12. 参考：连入点速查

| 调用方 | 被调用 | 说明 |
|---|---|---|
| Game | AudioSys.startMusic/play/pause/resume/setVolume | 流程/设置 |
| Game | UI.setScreen/HUD/tally/gameover/intro | 屏幕状态 |
| Game | LEVELS.build/themeOf/validate | 关卡 |
| Game | World.load/clear | 地图 |
| Game | FX.clear/flashWhite | 换场 |
| World | Mat/Tex/Models.eagle | 地形视图 |
| Entities | Models.player/enemy/powerup、FX.*、AudioSys.* | 实体表现 |
| Entities | World.tankBlocked/bulletHit | 碰撞 |
| Main | FX.update、AudioSys.update、UI.setPowerups?（Game 调） | 帧循环 |
| Input | Game.pause/resume、Main.cycleView、AudioSys.setMuted、UI.key | 键位 |
| UI | AudioSys.play('uiMove'/'uiSelect') | 菜单音 |
| FX | Models.turretDebris、UI.flashWhite/flashRed | 死亡/闪屏 |
