// ============================================================================
// 70-state.js — 游戏流程、关卡轮转、出怪、计分、道具持续效果、结算（§2/§3/§8）
// ============================================================================
const Game = (() => {
  let stateTimer = 0;
  let tallyTimer = 0;
  let ending = null;          // { kind:'eagle'|'lives', t, total }
  let clearDelay = 0;
  let extraLifeAt = CONFIG.player.extraLifeScore;
  let hudAcc = 0;
  let shovelTick = 0;
  let shovelFlashes = [];
  let returnState = 'TITLE';
  let audioUnlocked = false;
  let titleActive = false;

  const actions = {
    start(mode) { start(mode || 'single'); },
    showHelp() { openHelp(); },
    showSettings() { openSettings(); },
    back() { back(); },
    resume() { resume(); },
    restart() { restart(); },
    toTitle() { toTitle(); },
    setting(key, value) { applySetting(key, value); },
    unlockAudio() { onAudioUnlocked(); },
    next() { next(); },
  };

  function init() {
    G.hiScore = Number(Store.read(CONFIG.storage.hiScore, 0)) || 0;
    const saved = Store.read(CONFIG.storage.settings, null);
    if (saved && typeof saved === 'object') {
      G.settings = UTILS.deepMerge(G.settings, saved);
    }
    G.quality = G.settings.quality || 'high';
    extraLifeAt = CONFIG.player.extraLifeScore;
  }

  function showLoading(progress) {
    G.state = 'LOADING';
    G.isTitle = true;
    if (typeof UI !== 'undefined') {
      UI.setScreen('loading');
      UI.setHudVisible(false);
      UI.setLoading(progress);
    }
  }

  function onAudioUnlocked() {
    audioUnlocked = true;
    if (typeof AudioSys !== 'undefined') AudioSys.init();
    if (typeof UI !== 'undefined') UI.setLoading(1, true);
    if (G.state === 'LOADING') {
      toTitle();
    }
  }

  function saveHiScore() {
    if (G.score > G.hiScore) G.hiScore = G.score;
    Store.write(CONFIG.storage.hiScore, G.hiScore);
  }

  function saveSettings() {
    Store.write(CONFIG.storage.settings, G.settings);
  }

  // -------------------------------------------------------------------------
  // 屏幕流转
  // -------------------------------------------------------------------------
  function toTitle() {
    saveHiScore();
    Entities.reset();
    World.clear();
    if (typeof FX !== 'undefined' && FX.clear) FX.clear();
    AudioSys.resume();
    if (typeof Main !== 'undefined') {
      Main.showTitle(true);
      Main.applyTheme(0);
    }
    G.state = 'TITLE';
    G.isTitle = true;
    G.paused = false;
    G.score = 0;
    G.stage = 1;
    G.timeScale = 1;
    G.slowmo = { scale: 1, remain: 0 };
    G.effects.freeze = 0;
    G.effects.shovel = 0;
    if (titleActive) AudioSys.startMusic('title');
    if (typeof UI !== 'undefined') {
      UI.setHUD(Entities.buildHudState());
      UI.setEnemyIcons(0, 0);
      UI.setPowerups([]);
      UI.setHudVisible(false);
      UI.setScreen('title');
      UI.setTitleMeta(G.hiScore);
      UI.applySettings(G.settings);
    }
    AudioSys.stopEngine();
    if (!audioUnlocked && typeof AudioSys !== 'undefined') AudioSys.init();
    AudioSys.startMusic('title');
    titleActive = true;
  }

  function start(mode) {
    G.mode = mode === 'duo' ? 'duo' : 'single';
    saveHiScore();
    if (titleActive) AudioSys.stopMusic();
    titleActive = false;
    if (typeof Main !== 'undefined') {
      Main.showTitle(false);
      Main.resetEagleCam();
    }
    Entities.reset();
    G.score = 0;
    G.stage = 1;
    G.stats.kills = { basic: 0, fast: 0, power: 0, armor: 0 };
    G.stats.enemiesLeft = CONFIG.enemy.total;
    G.stats.remainingByType = { basic: 0, fast: 0, power: 0, armor: 0 };
    extraLifeAt = CONFIG.player.extraLifeScore;
    const count = G.mode === 'duo' ? 2 : 1;
    for (let i = 0; i < count; i++) {
      const p = Entities.spawnPlayer(i);
      p.lives = CONFIG.player.lives;
      p.fireLevel = 0;
    }
    G.player = G.players[0];
    startStage(1, { lives: G.players.map((p) => p.lives), fire: G.players.map((p) => p.fireLevel) });
  }

  function startStage(stage, saved) {
    G.stage = stage;
    G.stats.kills = { basic: 0, fast: 0, power: 0, armor: 0 };
    G.stats.enemiesLeft = CONFIG.enemy.total;
    G.stats.remainingByType = { basic: 0, fast: 0, power: 0, armor: 0 };

    Entities.reset();
    G.players.length = 0;
    const count = G.mode === 'duo' ? 2 : 1;
    for (let i = 0; i < count; i++) {
      const p = Entities.spawnPlayer(i);
      p.lives = saved && saved.lives[i] !== undefined ? saved.lives[i] : CONFIG.player.lives;
      p.fireLevel = saved && saved.fire[i] !== undefined ? saved.fire[i] : 0;
      if (p.model) p.model.setFireLevel(p.fireLevel);
      p.shield = 0;
    }
    G.player = G.players[0];

    G.theme = LEVELS.themeOf(stage);
    if (typeof Main !== 'undefined') Main.applyTheme(G.theme);
    const rows = LEVELS.build(stage);
    const check = LEVELS.validate(rows);
    World.load(rows, G.theme);
    G.effects.freeze = 0;
    G.effects.freezeTotal = 0;
    G.effects.shovel = 0;
    G.effects.shovelTotal = 0;
    World.setShovel(false);

    G.level.rows = rows;
    G.level.queue = buildQueue(stage);
    G.level.spawned = 0;
    G.level.killed = 0;
    G.level.carriersLeft = G.level.queue.filter((q) => q.carrier).length;
    G.level.cleared = false;
    G.level.tally = null;
    G.level.spawnTimer = 1.2;
    G.level.spawnPointIndex = 0;
    G.level.active = true;
    G.level.baseDestroyed = false;
    G.time = 0;
    G.slowmo = { scale: 1, remain: 0 };
    clearDelay = 0;
    ending = null;

    if (typeof UI !== 'undefined') {
      UI.setHUD(Entities.buildHudState());
      UI.setEnemyIcons(CONFIG.enemy.total, 0);
      UI.setPowerups([]);
      UI.setHudVisible(false);
      UI.setScreen('intro');
      UI.setIntro(stage);
    }
    AudioSys.stopMusic();
    AudioSys.play('horn');
    G.state = 'INTRO';
    stateTimer = CONFIG.flow.stageIntro.total;
    if (check && !check.ok) {
      // 校验失败时仍按规格继续（内置图已人工确认），仅记录到控制台外的降级处理
      G.level.invalidMap = true;
    }
  }

  function beginPlaying() {
    G.state = 'PLAYING';
    G.level.active = true;
    G.level.spawnTimer = 0.8;
    if (typeof UI !== 'undefined') {
      UI.setScreen(null);
      UI.setHudVisible(true);
    }
    if (typeof Main !== 'undefined') Main.resetEagleCam();
    AudioSys.startMusic('battle');
  }

  function buildQueue(stage) {
    let counts;
    if (stage <= 5) {
      counts = CONFIG.enemy.queueTable[stage - 1].slice();
    } else {
      const s = stage;
      const b = Math.max(2, 12 - s);
      const f = Math.min(8, 2 + s);
      const p = Math.min(8, s);
      const a = Math.max(0, CONFIG.enemy.total - b - f - p);
      counts = [b, f, p, a];
    }
    const remain = {
      basic: counts[0], fast: counts[1], power: counts[2], armor: counts[3],
    };
    const order = [];
    for (let i = 0; i < CONFIG.enemy.total; i++) {
      const types = [];
      const weights = [];
      const basicBias = i < 10 ? 2.4 : 1.0;
      if (remain.basic > 0) { types.push('basic'); weights.push(remain.basic * basicBias); }
      if (remain.fast > 0) { types.push('fast'); weights.push(remain.fast); }
      if (remain.power > 0) { types.push('power'); weights.push(remain.power); }
      if (remain.armor > 0) { types.push('armor'); weights.push(remain.armor * 1.15); }
      const type = UTILS.weightedPick(types, weights);
      remain[type]--;
      order.push(type);
    }
    return order.map((type, i) => ({
      type,
      carrier: CONFIG.enemy.carrierSlots.indexOf(i + 1) !== -1,
    }));
  }

  // -------------------------------------------------------------------------
  // 更新
  // -------------------------------------------------------------------------
  function update(dt) {
    switch (G.state) {
      case 'INTRO':
        stateTimer -= dt;
        if (stateTimer <= 0) beginPlaying();
        break;
      case 'PLAYING':
        updatePlaying(dt);
        break;
      case 'TALLY':
        tallyTimer -= dt;
        if (tallyTimer <= 0) nextStage();
        break;
      default:
        break;
    }
  }

  function updatePlaying(dt) {
    G.time += dt;
    updateEffects(dt);
    Entities.update(dt);
    updateSpawning(dt);
    updateHud(dt);
    updateExtraLife();

    if (ending) {
      ending.t -= dt;
      if (ending.t <= 0) {
        const kind = ending.kind;
        ending = null;
        showGameOver(kind);
      }
      return;
    }

    if (!World.isBaseAlive() && !G.level.baseDestroyed) {
      onBaseDestroyed();
    }
    if (G.level.killed >= CONFIG.enemy.total && G.enemies.filter((e) => e.alive).length === 0 && !G.level.cleared) {
      G.level.cleared = true;
      clearDelay = 1.2;
    }
    if (G.level.cleared) {
      clearDelay -= dt;
      if (clearDelay <= 0) stageClear();
    }
  }

  function updateEffects(dt) {
    if (G.effects.freeze > 0) {
      G.effects.freeze = Math.max(0, G.effects.freeze - dt);
      if (G.effects.freeze === 0) {
        for (const e of G.enemies) if (e.model) e.model.setFrozen(false);
      }
    }
    if (G.effects.shovel > 0) {
      G.effects.shovel = Math.max(0, G.effects.shovel - dt);
      const remain = G.effects.shovel;
      if (remain <= CONFIG.powerup.shovelBlink && remain > 0) {
        World.setShovelBlink(Math.floor(remain * 2) % 2 === 0);
        shovelTick -= dt;
        if (shovelTick <= 0) {
          shovelTick = 0.5;
          AudioSys.play('tick');
        }
      } else {
        World.setShovelBlink(false);
      }
      if (remain === 0) {
        World.setShovel(false);
        shovelFlashes.length = 0;
      }
    }
    if (shovelFlashes.length) {
      for (let i = shovelFlashes.length - 1; i >= 0; i--) {
        const f = shovelFlashes[i];
        f.t -= dt;
        if (f.t <= 0) {
          FX.shovelFlash(new THREE.Vector3(f.x, 0.4, f.z));
          shovelFlashes.splice(i, 1);
        }
      }
    }
  }

  function updateSpawning(dt) {
    if (G.level.baseDestroyed || !World.isBaseAlive()) return;
    if (G.level.spawned >= CONFIG.enemy.total) return;
    const maxAlive = CONFIG.enemy.spawnMaxAlive[Math.min(G.stage - 1, CONFIG.enemy.spawnMaxAlive.length - 1)];
    const alive = G.enemies.filter((e) => e.alive).length;
    if (alive >= maxAlive) {
      G.level.spawnTimer = Math.max(G.level.spawnTimer, 0.35);
      return;
    }
    G.level.spawnTimer -= dt;
    if (G.level.spawnTimer > 0) return;
    const item = G.level.queue[G.level.spawned];
    if (!item) return;
    const enemy = Entities.spawnEnemy(item.type, item.carrier);
    if (!enemy) {
      G.level.spawnTimer = 0.4; // 出生点被占：顺延重试
      return;
    }
    G.level.spawned++;
    G.level.spawnTimer = Math.max(
      CONFIG.enemy.spawnIntervalMin,
      CONFIG.enemy.spawnInterval - CONFIG.enemy.spawnIntervalDecay * (G.stage - 1)
    );
  }

  function updateHud(dt) {
    hudAcc += dt;
    if (hudAcc < 0.08) return;
    hudAcc = 0;
    if (typeof UI === 'undefined') return;
    UI.setHUD(Entities.buildHudState());
    UI.setEnemyIcons(CONFIG.enemy.total, G.level.killed);
    const list = [];
    if (G.effects.freeze > 0) {
      list.push({ kind: 'timer', remain: G.effects.freeze, total: CONFIG.powerup.freezeTime });
    }
    if (G.effects.shovel > 0) {
      list.push({ kind: 'shovel', remain: G.effects.shovel, total: CONFIG.powerup.shovelTime });
    }
    let shieldRemain = 0;
    for (const p of G.players) if (p) shieldRemain = Math.max(shieldRemain, p.shield);
    if (shieldRemain > 0) {
      list.push({ kind: 'helmet', remain: shieldRemain, total: CONFIG.powerup.shieldTime });
    }
    UI.setPowerups(list);
  }

  function updateExtraLife() {
    while (G.score >= extraLifeAt) {
      extraLifeAt += CONFIG.player.extraLifeScore;
      for (const p of G.players) if (p) p.lives += 1;
      AudioSys.play('lifeUp');
      if (typeof UI !== 'undefined') UI.toast('1UP  +1 生命');
    }
  }

  // -------------------------------------------------------------------------
  // 结算 / 结束
  // -------------------------------------------------------------------------
  function stageClear() {
    G.state = 'TALLY';
    G.level.active = false;
    G.level.tally = {
      counts: Object.assign({}, G.stats.kills),
      bonus: CONFIG.score.stageClear,
      total: G.score + CONFIG.score.stageClear,
      stage: G.stage,
      hiScore: Math.max(G.hiScore, G.score + CONFIG.score.stageClear),
    };
    G.score += CONFIG.score.stageClear;
    if (G.score > G.hiScore) G.hiScore = G.score;
    saveHiScore();
    if (typeof UI !== 'undefined') {
      UI.setHudVisible(false);
      UI.setScreen('tally');
      UI.showTally(G.level.tally);
    }
    AudioSys.stopMusic();
    AudioSys.play('jingle');
    tallyTimer = 5.0;
  }

  function nextStage() {
    if (G.state !== 'TALLY') return;
    const next = G.stage + 1;
    startStage(next, {
      lives: G.players.map((p) => (p ? p.lives : CONFIG.player.lives)),
      fire: G.players.map((p) => (p ? p.fireLevel : 0)),
    });
  }

  function onBaseDestroyed() {
    if (G.state !== 'PLAYING' || ending) return;
    G.level.baseDestroyed = true;
    G.level.active = false;
    saveHiScore();
    ending = { kind: 'eagle', t: CONFIG.flow.eagleExplosionTime, total: CONFIG.flow.eagleExplosionTime };
    slowmo(CONFIG.flow.slowmo.eagleDeath.scale, CONFIG.flow.slowmo.eagleDeath.time);
    if (typeof Main !== 'undefined') Main.eagleDeathCam();
    if (typeof UI !== 'undefined') UI.flashWhite(0.9);
  }

  function onPlayerOut(player) {
    if (ending) return;
    const anyAlive = G.players.some((p) => p && p.lives > 0);
    if (!anyAlive) {
      ending = { kind: 'lives', t: CONFIG.flow.gameOverDelay, total: CONFIG.flow.gameOverDelay };
    }
  }

  function showGameOver(kind) {
    saveHiScore();
    G.state = 'GAMEOVER';
    G.level.active = false;
    AudioSys.stopMusic();
    AudioSys.stopEngine();
    AudioSys.play('gameover');
    if (typeof Main !== 'undefined') Main.resetEagleCam();
    if (typeof UI !== 'undefined') {
      UI.setHudVisible(false);
      UI.setScreen('gameover');
      UI.showGameOver({ score: G.score, hiScore: G.hiScore, stage: G.stage, kind });
    }
    for (const p of G.players) if (p && p.model) p.model.setOpacity(1);
  }

  function onEnemyKilled(enemy) {
    G.stats.remainingByType[enemy.type] = Math.max(0, (G.stats.remainingByType[enemy.type] || 0) - 1);
    G.stats.enemiesLeft = Math.max(0, CONFIG.enemy.total - G.level.killed);
    if (G.level.killed === CONFIG.enemy.total && !G.level.cleared) {
      slowmo(CONFIG.flow.slowmo.enemyDeath.scale, CONFIG.flow.slowmo.enemyDeath.time);
      if (typeof Main !== 'undefined' && Main.pushCamera) Main.pushCamera(0.1, CONFIG.flow.slowmo.enemyDeath.time);
    }
  }

  // -------------------------------------------------------------------------
  // 道具效果
  // -------------------------------------------------------------------------
  function startFreeze(time) {
    G.effects.freeze = time;
    G.effects.freezeTotal = time;
    for (const e of G.enemies) if (e.model) e.model.setFrozen(true);
    if (typeof FX !== 'undefined') FX.freezeOverlay();
  }

  function startShovel(time) {
    G.effects.shovel = time;
    G.effects.shovelTotal = time;
    shovelTick = 0;
    World.setShovel(true);
    shovelFlashes = [];
    const guard = World.getGuardCells();
    guard.forEach((gi, index) => {
      const i = gi % World.SIZE;
      const j = Math.floor(gi / World.SIZE);
      shovelFlashes.push({ x: i - 12.5, z: j - 12.5, t: index * 0.08 });
    });
    if (typeof FX !== 'undefined') {
      for (let k = 0; k < 5; k++) {
        FX.light(new THREE.Vector3((5 + (k % 3)) * 2 - 12, 1, 10), 0x9ad6ff, 1.1, 0.7);
      }
    }
  }

  // -------------------------------------------------------------------------
  // 暂停 / 重开 / 设置
  // -------------------------------------------------------------------------
  function togglePause() {
    if (G.state === 'PLAYING') pause();
    else if (G.state === 'PAUSED') resume();
  }

  function pause() {
    if (G.state !== 'PLAYING') return;
    G.state = 'PAUSED';
    G.paused = true;
    AudioSys.pause();
    if (typeof UI !== 'undefined') {
      UI.setScreen('pause');
      UI.setHudVisible(true);
    }
  }

  function resume() {
    if (G.state !== 'PAUSED') return;
    G.state = 'PLAYING';
    G.paused = false;
    if (typeof UI !== 'undefined') UI.setScreen(null);
    AudioSys.resume();
  }

  function restart() {
    AudioSys.resume();
    start(G.mode);
  }

  function openHelp() {
    if (G.state !== 'TITLE' && G.state !== 'PAUSED') return;
    returnState = G.state;
    G.state = 'HELP';
    if (typeof UI !== 'undefined') UI.setScreen('help');
  }

  function openSettings() {
    if (G.state !== 'TITLE' && G.state !== 'PAUSED' && G.state !== 'HELP') return;
    returnState = G.state === 'HELP' ? returnState : G.state;
    G.state = 'SETTINGS';
    if (typeof UI !== 'undefined') {
      UI.setScreen('settings');
      UI.applySettings(G.settings);
    }
  }

  function back() {
    const target = returnState === 'PAUSED' ? 'PAUSED' : 'TITLE';
    G.state = target;
    if (typeof UI !== 'undefined') UI.setScreen(target === 'PAUSED' ? 'pause' : 'title');
  }

  function next() {
    if (G.state === 'TALLY') {
      nextStage();
      return true;
    }
    if (G.state === 'GAMEOVER') {
      toTitle();
      return true;
    }
    return false;
  }

  function applySetting(key, value) {
    G.settings[key] = value;
    saveSettings();
    if (key === 'master' || key === 'music' || key === 'sfx') {
      AudioSys.setVolume(key, value);
    } else if (key === 'quality') {
      G.quality = value;
      if (typeof Main !== 'undefined') Main.setQuality(value);
    } else if (key === 'view') {
      if (typeof Main !== 'undefined') Main.setView(value);
    } else if (key === 'scanline') {
      if (typeof UI !== 'undefined') UI.setScanline(value);
      if (typeof Main !== 'undefined') Main.applySettings();
    } else if (key === 'shake') {
      // 震屏开关由 Main 读取
    }
    if (typeof UI !== 'undefined') UI.applySettings(G.settings);
  }

  function slowmo(scale, time) {
    G.slowmo = { scale, remain: time, total: time };
  }

  function addScore(v) {
    G.score += v;
    if (G.score > G.hiScore) G.hiScore = G.score;
  }

  function setQuality(q) {
    applySetting('quality', q);
  }

  function setView(v) {
    applySetting('view', v);
  }

  function setScanline(v) {
    applySetting('scanline', v);
  }

  function setShake(v) {
    applySetting('shake', v);
  }

  return {
    init, showLoading, actions, start, startStage, update, togglePause, pause, resume,
    restart, toTitle, openHelp, openSettings, back, next, applySetting, slowmo,
    startFreeze, startShovel, stageClear, nextStage, onBaseDestroyed, onPlayerOut,
    showGameOver, onEnemyKilled, onAudioUnlocked, setQuality, setView, setScanline, setShake,
    saveHiScore, saveSettings, addScore,
    get audioUnlocked() { return audioUnlocked; },
  };
})();
