// ============================================================================
// 99-main.js — 渲染器/场景/相机/主题光影/后期/标题展台/主循环（规格书 §1/§4/§8）
// ============================================================================
window.__BC3D_BOOTED__ = true;

const Main = (() => {
  const STEP = 1 / 60;
  let renderer = null;
  let scene = null;
  let camera = null;
  let composer = null;
  let bloomPass = null;
  let crtPass = null;
  let fxaaPass = null;
  let outputPass = null;
  let sun = null;
  let hemi = null;
  let playerLight = null;
  let skyMesh = null;
  let skyUniforms = null;
  let stars = null;
  let titleGroup = null;
  let titleTank = null;
  let titleDust = null;
  let titleSpot = null;
  let titleRing = null;
  let viewMode = 'follow';
  let acc = 0;
  let lastTime = 0;
  let elapsed = 0;
  let eagleCamTime = 0;
  let titleYaw = 0;
  let camPush = 0;
  let camPushTime = 0;
  let fpsTime = 0;
  let fpsFrames = 0;
  let lowFpsTime = 0;
  let degradeShown = false;
  let booted = false;
  let fatalShown = false;
  let shadowSize = 2048;
  let engineStarted = false;

  const followCenter = new THREE.Vector3();
  const tmpVec = new THREE.Vector3();
  const camDesired = new THREE.Vector3();

  // -------------------------------------------------------------------------
  // 启动
  // -------------------------------------------------------------------------
  function boot() {
    if (booted) return;
    booted = true;
    if (!UTILS.hasWebGL()) {
      showFatal('当前浏览器/显卡不支持 WebGL，无法运行 3D 坦克大战。请更新浏览器或开启硬件加速后重试。');
      return;
    }
    try {
      Game.init();
      initRenderer();
      initScene();
      initLights();
      initSky();
      if (typeof Tex !== 'undefined' && Tex.init) Tex.init();
      initTitleStage();
      FX.init(scene);
      World.init(scene);
      Entities.init(scene);
      initComposer();
      Input.init();
      if (typeof UI !== 'undefined') {
        UI.init(Game.actions);
        UI.applySettings(G.settings);
        UI.setScanline(G.settings.scanline);
      }
      applyTheme(0);
      setQuality(G.settings.quality || 'high');
      setView(G.settings.view || 'follow');
      applyAudioSettings();
      applySettings();
      showTitle(true);
      Game.showLoading(1);
      bindResize();
      window.addEventListener('resize', onResize);
      requestAnimationFrame(loop);
    } catch (err) {
      showFatal('初始化失败：' + (err && err.message ? err.message : err));
      if (window.console && console.error) console.error(err);
    }
  }

  function initRenderer() {
    const canvas = document.getElementById('view');
    if (!canvas) throw new Error('缺少 canvas#view');
    renderer = new THREE.WebGLRenderer({
      canvas, antialias: false, alpha: false, powerPreference: 'high-performance',
      stencil: false,
    });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, CONFIG.quality[G.settings.quality || 'high'].pixelRatio));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = CONFIG.render.exposure;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.setClearColor(CONFIG.render.clearColor, 1);

    canvas.addEventListener('webglcontextlost', (ev) => {
      ev.preventDefault();
      showFatal('WebGL 上下文丢失。请刷新页面重新开始。');
    });
    canvas.addEventListener('webglcontextrestored', () => {
      hideFatal();
    });
  }

  function initScene() {
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0a0c10);
    camera = new THREE.PerspectiveCamera(CONFIG.camera.fov, window.innerWidth / window.innerHeight, CONFIG.camera.near, CONFIG.camera.far);
    camera.position.set(0, 30, 13.5);
    camera.lookAt(0, 0, 0);

    // 环境反射（RoomEnvironment 由 CDN addons 提供）
    const pmrem = new THREE.PMREMGenerator(renderer);
    pmrem.compileEquirectangularShader();
    const envRT = pmrem.fromScene(new RoomEnvironment(), 0.04);
    scene.environment = envRT.texture;
    pmrem.dispose();
  }

  function initLights() {
    sun = new THREE.DirectionalLight(0xffffff, 2.4);
    sun.position.set(14, 30, 10);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = -18;
    sun.shadow.camera.right = 18;
    sun.shadow.camera.top = 18;
    sun.shadow.camera.bottom = -18;
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 90;
    sun.shadow.bias = -0.0005;
    sun.shadow.normalBias = 0.02;
    scene.add(sun);
    scene.add(sun.target);

    hemi = new THREE.HemisphereLight(0x9db4ff, 0x3a2f2a, 0.6);
    scene.add(hemi);

    playerLight = new THREE.PointLight(0xffe6c0, 0.6, 8, 1.6);
    playerLight.position.set(0, 3, 0);
    scene.add(playerLight);
  }

  function initSky() {
    skyUniforms = {
      uTop: { value: new THREE.Color('#87b7e8') },
      uBottom: { value: new THREE.Color('#d8e8f5') },
    };
    const skyGeo = new THREE.SphereGeometry(170, 32, 20);
    const skyMat = new THREE.ShaderMaterial({
      uniforms: skyUniforms,
      vertexShader: `
        varying vec3 vPos;
        void main() {
          vPos = position;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: `
        uniform vec3 uTop;
        uniform vec3 uBottom;
        varying vec3 vPos;
        void main() {
          float h = clamp(normalize(vPos).y * 1.7, 0.0, 1.0);
          vec3 c = mix(uBottom, uTop, pow(h, 0.85));
          gl_FragColor = vec4(c, 1.0);
        }`,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
    });
    skyMesh = new THREE.Mesh(skyGeo, skyMat);
    skyMesh.renderOrder = -3;
    skyMesh.frustumCulled = false;
    scene.add(skyMesh);

    const starCount = 520;
    const pos = new Float32Array(starCount * 3);
    for (let i = 0; i < starCount; i++) {
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(Math.random() * 0.92 + 0.04);
      const r = 155;
      pos[i * 3] = Math.sin(phi) * Math.cos(theta) * r;
      pos[i * 3 + 1] = Math.abs(Math.cos(phi)) * r;
      pos[i * 3 + 2] = Math.sin(phi) * Math.sin(theta) * r;
    }
    const starGeo = new THREE.BufferGeometry();
    starGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const starMat = new THREE.PointsMaterial({
      color: 0xdfe8ff, size: 0.9, sizeAttenuation: true, transparent: true,
      opacity: 0.85, depthWrite: false,
    });
    stars = new THREE.Points(starGeo, starMat);
    stars.visible = false;
    stars.renderOrder = -2;
    scene.add(stars);
  }

  function initTitleStage() {
    titleGroup = new THREE.Group();
    titleGroup.visible = false;
    scene.add(titleGroup);

    const platformMat = new THREE.MeshStandardMaterial({
      color: 0x14171c, metalness: 0.65, roughness: 0.35,
    });
    const platform = new THREE.Mesh(new THREE.CylinderGeometry(5.2, 5.7, 0.7, 48), platformMat);
    platform.position.y = -0.35;
    platform.receiveShadow = true;
    titleGroup.add(platform);

    const ringMat = new THREE.MeshStandardMaterial({
      color: 0xe8b64c, metalness: 0.9, roughness: 0.25,
      emissive: 0x6b4a12, emissiveIntensity: 0.9,
    });
    titleRing = new THREE.Mesh(new THREE.TorusGeometry(5.35, 0.055, 10, 96), ringMat);
    titleRing.rotation.x = -Math.PI / 2;
    titleRing.position.y = 0.01;
    titleGroup.add(titleRing);

    titleTank = Models.player();
    titleTank.group.position.set(0, 0.02, 0);
    titleTank.group.scale.set(1.35, 1.35, 1.35);
    titleTank.group.rotation.y = 0.5;
    titleGroup.add(titleTank.group);

    titleSpot = new THREE.SpotLight(0xffd9a0, 90, 60, 0.42, 0.6, 1.3);
    titleSpot.position.set(0, 15, 7);
    titleSpot.target.position.set(0, 0.8, 0);
    titleGroup.add(titleSpot);
    titleGroup.add(titleSpot.target);

    const dustGeo = new THREE.BufferGeometry();
    const count = 220;
    const arr = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.sqrt(Math.random()) * 5.6;
      arr[i * 3] = Math.cos(a) * r;
      arr[i * 3 + 1] = Math.random() * 6.5 + 0.2;
      arr[i * 3 + 2] = Math.sin(a) * r;
    }
    dustGeo.setAttribute('position', new THREE.BufferAttribute(arr, 3));
    const dustMat = new THREE.PointsMaterial({
      map: Tex.spark, color: 0xffd88a, size: 0.14, transparent: true,
      opacity: 0.5, depthWrite: false, blending: THREE.AdditiveBlending,
      sizeAttenuation: true,
    });
    titleDust = new THREE.Points(dustGeo, dustMat);
    titleGroup.add(titleDust);
  }

  function initComposer() {
    composer = new EffectComposer(renderer);
    composer.setPixelRatio ? composer.setPixelRatio(renderer.getPixelRatio()) : null;
    composer.setSize(window.innerWidth, window.innerHeight);

    const renderPass = new RenderPass(scene, camera);
    bloomPass = new UnrealBloomPass(
      new THREE.Vector2(window.innerWidth, window.innerHeight),
      CONFIG.post.bloom.strength,
      CONFIG.post.bloom.radius,
      CONFIG.post.bloom.threshold
    );
    crtPass = new ShaderPass(CRTShader());
    fxaaPass = new ShaderPass(FXAAShader);
    outputPass = new OutputPass();

    composer.addPass(renderPass);
    composer.addPass(bloomPass);
    composer.addPass(crtPass);
    composer.addPass(fxaaPass);
    composer.addPass(outputPass);
    updateFXAAResolution();
  }

  function CRTShader() {
    return {
      uniforms: {
        tDiffuse: { value: null },
        uScanline: { value: CONFIG.post.crt.scanline },
        uVignette: { value: CONFIG.post.crt.vignette },
        uAberration: { value: CONFIG.post.crt.aberration },
        uTime: { value: 0 },
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: `
        uniform sampler2D tDiffuse;
        uniform float uScanline;
        uniform float uVignette;
        uniform float uAberration;
        uniform float uTime;
        varying vec2 vUv;
        void main() {
          vec2 dir = vUv - 0.5;
          float r = texture2D(tDiffuse, vUv - dir * uAberration).r;
          float g = texture2D(tDiffuse, vUv).g;
          float b = texture2D(tDiffuse, vUv + dir * uAberration).b;
          vec3 col = vec3(r, g, b);
          float scan = 1.0 - uScanline * (0.5 + 0.5 * sin(vUv.y * 1200.0));
          col *= scan;
          float vig = smoothstep(0.92, 0.28, length(dir));
          col *= mix(1.0, vig, uVignette);
          float flicker = 0.992 + 0.008 * sin(uTime * 60.0);
          gl_FragColor = vec4(col * flicker, 1.0);
        }`,
    };
  }

  function updateFXAAResolution() {
    if (!fxaaPass) return;
    const pr = renderer.getPixelRatio();
    const w = window.innerWidth * pr;
    const h = window.innerHeight * pr;
    fxaaPass.material.uniforms.resolution.value.set(1 / w, 1 / h);
  }

  // -------------------------------------------------------------------------
  // 主题 / 画质 / 设置
  // -------------------------------------------------------------------------
  function applyTheme(index) {
    const t = CONFIG.themes[index] || CONFIG.themes[0];
    G.theme = index;
    if (G.isTitle) return;
    if (sun) {
      sun.color.set(t.sun);
      sun.intensity = t.sunIntensity;
      sun.position.set(t.sunPos[0], t.sunPos[1], t.sunPos[2]);
      sun.target.position.set(0, 0, 0);
    }
    if (hemi) {
      hemi.color.set(t.hemiSky);
      hemi.groundColor.set(t.hemiGround);
      hemi.intensity = 0.6 * (t.ambientBoost || 1);
    }
    if (skyUniforms) {
      skyUniforms.uTop.value.set(t.skyTop);
      skyUniforms.uBottom.value.set(t.skyBottom);
    }
    if (scene) {
      scene.background = new THREE.Color(t.skyBottom);
      if (t.fog) scene.fog = new THREE.FogExp2(t.fog.color, t.fog.density);
      else scene.fog = null;
    }
    if (stars) stars.visible = !!t.stars;
    if (playerLight) playerLight.visible = true;
  }

  function applyTitleTheme() {
    if (sun) {
      sun.intensity = 0.18;
      sun.color.set(0x8899bb);
      sun.position.set(8, 24, 10);
    }
    if (hemi) {
      hemi.intensity = 0.22;
      hemi.color.set(0x334466);
      hemi.groundColor.set(0x0a0c10);
    }
    if (skyUniforms) {
      skyUniforms.uTop.value.set('#05070c');
      skyUniforms.uBottom.value.set('#101623');
    }
    if (scene) {
      scene.background = new THREE.Color(0x05070c);
      scene.fog = null;
    }
    if (stars) stars.visible = true;
    if (playerLight) playerLight.visible = false;
  }

  function setQuality(q) {
    const cfg = CONFIG.quality[q] || CONFIG.quality.high;
    G.quality = q;
    G.settings.quality = q;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, cfg.pixelRatio));
    renderer.shadowMap.enabled = cfg.shadow > 0;
    if (sun) {
      sun.castShadow = cfg.shadow > 0;
      if (cfg.shadow > 0 && shadowSize !== cfg.shadow) {
        shadowSize = cfg.shadow;
        sun.shadow.mapSize.set(cfg.shadow, cfg.shadow);
        if (sun.shadow.map) {
          sun.shadow.map.dispose();
          sun.shadow.map = null;
        }
      }
    }
    if (typeof FX !== 'undefined' && FX.setQuality) FX.setQuality(q);
    if (composer) {
      if (composer.setPixelRatio) composer.setPixelRatio(renderer.getPixelRatio());
      composer.setSize(window.innerWidth, window.innerHeight);
    }
    updateFXAAResolution();
    onResize();
  }

  function setView(v) {
    viewMode = v === 'classic' ? 'classic' : 'follow';
    G.settings.view = viewMode;
  }

  function cycleView() {
    const next = viewMode === 'follow' ? 'classic' : 'follow';
    Game.applySetting('view', next);
    if (typeof UI !== 'undefined') UI.toast(next === 'follow' ? '视角：跟随' : '视角：经典俯视', 1200);
  }

  function applySettings() {
    if (crtPass) {
      crtPass.material.uniforms.uScanline.value = G.settings.scanline ? CONFIG.post.crt.scanline : 0;
      crtPass.material.uniforms.uVignette.value = CONFIG.post.crt.vignette;
      crtPass.material.uniforms.uAberration.value = CONFIG.post.crt.aberration;
    }
    if (typeof UI !== 'undefined') UI.setScanline(G.settings.scanline);
  }

  function applyAudioSettings() {
    if (typeof AudioSys === 'undefined') return;
    AudioSys.setVolume('master', G.settings.master);
    AudioSys.setVolume('music', G.settings.music);
    AudioSys.setVolume('sfx', G.settings.sfx);
  }

  // -------------------------------------------------------------------------
  // 标题展台
  // -------------------------------------------------------------------------
  function showTitle(on) {
    G.isTitle = !!on;
    if (titleGroup) titleGroup.visible = !!on;
    if (World && World.setVisible) World.setVisible(!on);
    if (on) applyTitleTheme();
    else resetEagleCam();
  }

  function animateTitle(dt) {
    titleYaw += dt * 0.28;
    if (titleTank) {
      titleTank.group.rotation.y = titleYaw;
      titleTank.update(dt, { speed: 0, moving: false, frozen: false });
    }
    if (titleRing) titleRing.rotation.z += dt * 0.12;
    if (titleDust) {
      titleDust.rotation.y += dt * 0.05;
      titleDust.position.y = Math.sin(elapsed * 0.5) * 0.18;
    }
  }

  function eagleDeathCam() {
    eagleCamTime = CONFIG.flow.eagleExplosionTime;
  }

  // 击毁末敌时的相机轻推（规格书 §4：推近 10% / 0.8s）
  function pushCamera(amount, time) {
    camPush = amount;
    camPushTime = time;
  }

  function resetEagleCam() {
    eagleCamTime = 0;
  }

  // -------------------------------------------------------------------------
  // 相机
  // -------------------------------------------------------------------------
  function updateCamera(dt) {
    if (!camera) return;
    if (camPushTime > 0) camPushTime = Math.max(0, camPushTime - dt);
    const pushScale = camPushTime > 0 ? (1 - UTILS.clamp(camPush, 0, 0.5)) : 1;
    if (G.isTitle) {
      const ang = elapsed * 0.16;
      camera.position.set(Math.sin(ang) * 8.4, 5.4 + Math.sin(elapsed * 0.3) * 0.35, Math.cos(ang) * 8.4);
      camera.lookAt(0, 1.35, 0);
      setFov(42, dt);
      return;
    }
    if (eagleCamTime > 0) {
      eagleCamTime -= dt;
      camDesired.set(0, 16.5, 23);
      camera.position.lerp(camDesired, 1 - Math.exp(-3 * dt));
      camera.lookAt(0, 0.6, 12);
      setFov(36, dt);
      applyShake(dt);
      return;
    }

    const player = getCameraPlayer();
    if (viewMode === 'classic') {
      camDesired.set(CONFIG.camera.classic.pos[0], CONFIG.camera.classic.pos[1], CONFIG.camera.classic.pos[2]);
      camera.position.lerp(camDesired, 1 - Math.exp(-6 * dt));
      camera.lookAt(0, 0, 0);
      setFov(CONFIG.camera.classic.fov, dt);
      applyShake(dt);
      return;
    }

    const px = player ? player.x : 0;
    const pz = player ? player.z : 0;
    const tx = UTILS.lerp(0, px, CONFIG.camera.follow.blend);
    const tz = UTILS.lerp(0, pz, CONFIG.camera.follow.blend);
    followCenter.x = UTILS.damp(followCenter.x, tx, CONFIG.camera.follow.damp, dt);
    followCenter.z = UTILS.damp(followCenter.z, tz, CONFIG.camera.follow.damp, dt);
    followCenter.y = 0;
    camDesired.set(
      followCenter.x,
      CONFIG.camera.follow.height * pushScale,
      followCenter.z + CONFIG.camera.follow.back * pushScale
    );
    camera.position.x = UTILS.damp(camera.position.x, camDesired.x, CONFIG.camera.follow.damp, dt);
    camera.position.y = UTILS.damp(camera.position.y, camDesired.y, CONFIG.camera.follow.damp, dt);
    camera.position.z = UTILS.damp(camera.position.z, camDesired.z, CONFIG.camera.follow.damp, dt);
    camera.lookAt(followCenter.x, 0, followCenter.z);
    setFov(CONFIG.camera.fov, dt);
    applyShake(dt);
  }

  function setFov(target, dt) {
    if (Math.abs(camera.fov - target) < 0.01) return;
    camera.fov = UTILS.damp(camera.fov, target, 6, dt);
    camera.updateProjectionMatrix();
  }

  function applyShake(dt) {
    if (!G.settings.shake) return;
    const trauma = FX && FX.trauma ? FX.trauma : 0;
    if (trauma <= 0.0001) return;
    const amp = trauma * trauma;
    const s = CONFIG.camera.shake;
    camera.position.x += Math.sin(elapsed * 43.7) * amp * s.maxOffset;
    camera.position.y += Math.cos(elapsed * 37.3) * amp * s.maxOffset * 0.6;
    camera.position.z += Math.sin(elapsed * 31.1) * amp * s.maxOffset * 0.5;
    camera.rotation.z += Math.sin(elapsed * 51.3) * amp * s.maxRoll;
  }

  function getCameraPlayer() {
    if (G.player && G.player.alive) return G.player;
    for (const p of G.players) if (p && p.alive) return p;
    return G.player || null;
  }

  function updatePlayerLight(dt) {
    if (!playerLight) return;
    const p = getCameraPlayer();
    if (!p) return;
    playerLight.position.set(p.x, 3.2, p.z);
    playerLight.intensity = 0.6 + (G.theme === 3 ? 0.25 : 0);
  }

  // -------------------------------------------------------------------------
  // 主循环
  // -------------------------------------------------------------------------
  function loop(now) {
    requestAnimationFrame(loop);
    if (!lastTime) lastTime = now;
    let realDt = (now - lastTime) / 1000;
    lastTime = now;
    if (!isFinite(realDt) || realDt < 0) realDt = 0;
    realDt = Math.min(realDt, 0.1);
    elapsed += realDt;

    if (G.slowmo.remain > 0) {
      G.slowmo.remain = Math.max(0, G.slowmo.remain - realDt);
    }
    G.timeScale = G.slowmo.remain > 0 ? G.slowmo.scale : 1;
    const simDt = realDt * G.timeScale;

    acc += simDt;
    let guard = 0;
    while (acc >= STEP && guard < 5) {
      acc -= STEP;
      guard++;
      Game.update(STEP);
    }
    if (guard >= 5) acc = 0;

    if (typeof World !== 'undefined' && World.update) World.update(simDt);
    if (typeof FX !== 'undefined' && FX.update) FX.update(simDt, camera);
    if (typeof AudioSys !== 'undefined' && AudioSys.update) AudioSys.update(realDt);
    updateEngineSound();

    if (crtPass) crtPass.material.uniforms.uTime.value = elapsed;
    updateCamera(realDt);
    updatePlayerLight(realDt);
    if (titleGroup && titleGroup.visible) animateTitle(realDt);
    if (stars && stars.visible) stars.rotation.y = elapsed * 0.005;

    render();
    monitorFps(realDt);
  }

  function updateEngineSound() {
    if (typeof AudioSys === 'undefined' || !AudioSys.setEngine) return;
    const p = getCameraPlayer();
    const active = G.state === 'PLAYING' && p && p.alive;
    if (active) {
      if (!engineStarted) {
        engineStarted = true;
        if (AudioSys.startEngine) AudioSys.startEngine();
      }
      const moving = !!p.moving;
      const factor = Math.min(1, Math.abs(p.vel) / CONFIG.player.speed);
      AudioSys.setEngine(moving, factor);
    } else if (engineStarted) {
      engineStarted = false;
      if (AudioSys.stopEngine) AudioSys.stopEngine();
    }
  }

  function render() {
    if (!renderer || !scene || !camera) return;
    const cfg = CONFIG.quality[G.quality] || CONFIG.quality.high;
    if (cfg.post && composer) {
      composer.render();
    } else {
      renderer.render(scene, camera);
    }
  }

  function monitorFps(dt) {
    fpsTime += dt;
    fpsFrames++;
    if (fpsTime >= 1) {
      const fps = fpsFrames / fpsTime;
      G.stats.fps = fps;
      fpsTime = 0;
      fpsFrames = 0;
      if (fps < CONFIG.quality.degradeFps) {
        lowFpsTime += 1;
        if (lowFpsTime >= CONFIG.quality.degradeTime && !degradeShown && G.quality !== 'low') {
          degradeShown = true;
          if (typeof UI !== 'undefined') UI.toast('帧率偏低，可在设置中降低画质', 3000);
        }
      } else {
        lowFpsTime = 0;
      }
    }
  }

  // -------------------------------------------------------------------------
  // 尺寸 / 错误
  // -------------------------------------------------------------------------
  function bindResize() {
    if (window.__bc3dResizeBound) return;
    window.__bc3dResizeBound = true;
  }

  function onResize() {
    if (!renderer || !camera) return;
    const w = window.innerWidth;
    const h = window.innerHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
    if (composer) {
      if (composer.setPixelRatio) composer.setPixelRatio(renderer.getPixelRatio());
      composer.setSize(w, h);
    }
    if (bloomPass) bloomPass.setSize(w, h);
    updateFXAAResolution();
  }

  function showFatal(message) {
    fatalShown = true;
    const el = document.getElementById('fatal-error');
    if (!el) return;
    const msg = el.querySelector('.fatal-msg');
    if (msg) msg.textContent = message;
    el.classList.add('show');
  }

  function hideFatal() {
    const el = document.getElementById('fatal-error');
    if (el) el.classList.remove('show');
  }

  return {
    boot, showTitle, applyTheme, setQuality, setView, cycleView, applySettings,
    applyAudioSettings, eagleDeathCam, resetEagleCam, onResize, pushCamera,
    get renderer() { return renderer; },
    get scene() { return scene; },
    get camera() { return camera; },
    get titleGroup() { return titleGroup; },
  };
})();

// 供开发者/自动化调试读取模块作用域内的对象（不影响游戏逻辑）
window.__BC3D__ = {
  G, CONFIG, Game, Main, Entities, World, FX, UI, AudioSys, LEVELS, Models, Tex, Mat, UTILS, Input, POWERUP_META, Store,
};

Main.boot();
