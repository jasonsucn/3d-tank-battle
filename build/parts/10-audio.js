// ============================================================================
// 10-audio.js — AudioSys：Web Audio 全合成音频系统（规格书 §6 / 契约 §4）
// 零外部音频文件，全部声音由振荡器、白噪声与滤波器实时合成。
// 顶层只暴露 AudioSys；所有辅助实现封装在本 IIFE 内，避免与其他分片重名。
// ============================================================================
const AudioSys = (() => {
  'use strict';

  // ---------------------------------------------------------------------------
  // 配置读取与本地常量（可调数值优先来自 CONFIG.audio；缺少时用注释兜底值）
  // ---------------------------------------------------------------------------
  const A = (typeof CONFIG !== 'undefined' && CONFIG.audio) ? CONFIG.audio : {};

  function numberOr(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  const FALLBACK_VOLUMES = { master: 80, music: 60, sfx: 80 };          // §6 三路默认音量
  const VOLUME_EXP = { master: 1.5, music: 2, sfx: 2 };                 // 感知曲线：分路平方，主路 1.5 次
  const VOLUME_SMOOTH = 0.035;                                          // 音量变化平滑时间（秒）
  const MUTE_SMOOTH = 0.012;                                            // 静音切换平滑时间（秒）
  const NOISE_SECONDS = 2;                                              // 预生成白噪声长度（秒）
  const EPS = 0.0001;                                                   // 指数包络的安全非零尾值
  const LOOKAHEAD = numberOr(A.bgmLookahead, 0.12);                     // §6 音序器前瞻窗口
  const TIMER_MS = numberOr(A.bgmTimer, 0.03) * 1000;                   // §6 30ms 调度定时器
  const SAME_SFX_WINDOW = numberOr(A.sameSfxWindow, 0.05);              // §6 同类音效合并窗口
  const MAX_SAME_SFX = numberOr(A.maxSameSfx, 4);                       // §6 同窗同类音效上限
  const DUCK_AMOUNT = numberOr(A.duck && A.duck.amount, 0.30);          // §6 爆炸时音乐瞬压到 30%
  const DUCK_HOLD = numberOr(A.duck && A.duck.hold, 0.12);              // §6 120ms 恢复
  const GAMEOVER_DRONE = 4;                                             // 附录 B.5 三角波 A1 缓衰 4s
  const STEPS_PER_BAR = 16;                                             // §6 十六分音符网格
  const LEAD_FILTER_HZ = 3000;                                          // §6 方波主旋律低通 3kHz
  const LEAD_FILTER_Q = 0.7;
  const COMPRESSOR = { threshold: -14, knee: 12, ratio: 10, attack: 0.002, release: 0.25 };

  const ENGINE = {
    baseHz: numberOr(A.engine && A.engine.baseHz, 50),
    lowpass: numberOr(A.engine && A.engine.lowpass, 240),
    idleGain: numberOr(A.engine && A.engine.idleGain, 0.015),
    moveGain: numberOr(A.engine && A.engine.moveGain, 0.05),
    pitch: numberOr(A.engine && A.engine.pitch, 1.12),
  };

  const BPM = {
    battle: numberOr(A.bpm && A.bpm.battle, 132),
    title: numberOr(A.bpm && A.bpm.title, 96),
    horn: numberOr(A.bpm && A.bpm.horn, 140),
    jingle: numberOr(A.bpm && A.bpm.jingle, 132),
    gameover: numberOr(A.bpm && A.bpm.gameover, 90),
  };

  // 各声部基准增益：统一在此调平，配方时值按 §6 表。
  const MIX = {
    lead: 0.16,      // 方波主旋律（再经 3kHz 低通柔化）
    bass: 0.20,      // 三角波贝斯
    kick: 0.34,      // 底鼓
    snare: 0.13,     // 军鼓
    hat: 0.045,      // 踩镲
    drone: 0.20,     // GAME OVER 低频长音
  };

  const NOTE_SEMITONES = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  const SEMITONES_PER_OCTAVE = 12;
  const A4_MIDI = 69;
  const A4_HZ = 440;
  const NOTE_NAME_RE = /^([A-G])([#b]?)(-?\d)$/;

  // ---------------------------------------------------------------------------
  // 运行状态与音频节点
  // ---------------------------------------------------------------------------
  const state = {
    ready: false,
    muted: false,
    volumes: {
      master: numberOr(A.master, FALLBACK_VOLUMES.master),
      music: numberOr(A.music, FALLBACK_VOLUMES.music),
      sfx: numberOr(A.sfx, FALLBACK_VOLUMES.sfx),
    },
    volumesTouched: { master: false, music: false, sfx: false },
    desiredTrack: null,     // 期望播放的循环曲（用户最后指定）
    activeTrack: null,      // 正在音序的循环曲
    step: 0,                // 当前 16 分音符步
    nextTime: 0,            // 下一音符的 AudioContext 时间
    duckActive: false,
    duckRemain: 0,
    musicBase: 0,
    suspended: false,       // 由 pause()/resume() 维护，避免重复 init() 误恢复暂停中的音频
    engineWanted: false,
    engineMoving: false,
    engineSpeed: 1,
  };

  let ctx = null;
  let masterGain = null;
  let sfxGain = null;
  let musicGain = null;
  let compressor = null;
  let leadFilter = null;
  let bassBus = null;
  let drumBus = null;
  let noiseBuffer = null;
  let schedulerId = null;
  let engine = null;                          // { osc, filter, gain }
  let lastEngineApply = 0;                    // 引擎参数节流：避免每帧堆积自动化事件
  const musicVoices = [];                     // 循环曲已排程声部，切曲/暂停时可立即停掉
  const recentSfx = Object.create(null);      // 同类音效合并窗口记录

  // ---------------------------------------------------------------------------
  // 基础工具
  // ---------------------------------------------------------------------------
  function clamp(v, a, b) {
    return UTILS.clamp(v, a, b);
  }

  function currentTime() {
    return ctx ? ctx.currentTime : 0;
  }

  function realNowSeconds() {
    if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
      return performance.now() / 1000;
    }
    return Date.now() / 1000;
  }

  function volumeCurve(kind, value) {
    const normalized = clamp(value, 0, 100) / 100;
    return Math.pow(normalized, VOLUME_EXP[kind] || 2);
  }

  // 平滑设置 AudioParam（音量滑杆/静音用；未解锁时不会执行）
  function setParam(param, target, smooth, timeConstant) {
    if (!param || !ctx) return;
    const t = ctx.currentTime;
    try {
      param.cancelScheduledValues(t);
      if (smooth) param.setTargetAtTime(target, t, timeConstant || VOLUME_SMOOTH);
      else param.setValueAtTime(target, t);
    } catch (e) { /* 参数自动化失败时保持原值，不抛到主循环 */ }
  }

  function applyMasterVolume(smooth) {
    if (!masterGain) return;
    const target = state.muted ? 0 : volumeCurve('master', state.volumes.master);
    setParam(masterGain.gain, target, smooth, state.muted ? MUTE_SMOOTH : VOLUME_SMOOTH);
  }

  function applySfxVolume(smooth) {
    if (!sfxGain) return;
    setParam(sfxGain.gain, volumeCurve('sfx', state.volumes.sfx), smooth);
  }

  function applyMusicVolume(smooth) {
    if (!musicGain) return;
    const target = state.duckActive ? state.musicBase * DUCK_AMOUNT : state.musicBase;
    setParam(musicGain.gain, target, smooth);
  }

  // ---------------------------------------------------------------------------
  // 音频图：sfxGain + musicGain → masterGain → DynamicsCompressor → destination
  // ---------------------------------------------------------------------------
  function buildGraph() {
    masterGain = ctx.createGain();
    sfxGain = ctx.createGain();
    musicGain = ctx.createGain();
    compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = COMPRESSOR.threshold;
    compressor.knee.value = COMPRESSOR.knee;
    compressor.ratio.value = COMPRESSOR.ratio;
    compressor.attack.value = COMPRESSOR.attack;
    compressor.release.value = COMPRESSOR.release;

    // BGM 通道：方波主旋律先过低通，贝斯和鼓各走自己的子总线（§6）
    leadFilter = ctx.createBiquadFilter();
    leadFilter.type = 'lowpass';
    leadFilter.frequency.value = LEAD_FILTER_HZ;
    leadFilter.Q.value = LEAD_FILTER_Q;
    bassBus = ctx.createGain();
    drumBus = ctx.createGain();

    sfxGain.connect(masterGain);
    musicGain.connect(masterGain);
    leadFilter.connect(musicGain);
    bassBus.connect(musicGain);
    drumBus.connect(musicGain);
    masterGain.connect(compressor);
    compressor.connect(ctx.destination);

    // 首次建立总线时直接赋初值（此时还没有声音，不会产生爆音）
    state.musicBase = volumeCurve('music', state.volumes.music);
    musicGain.gain.value = state.musicBase;
    sfxGain.gain.value = volumeCurve('sfx', state.volumes.sfx);
    masterGain.gain.value = state.muted ? 0 : volumeCurve('master', state.volumes.master);
  }

  // 从 G.settings（Game 持久化）读取尚未被本模块显式设置过的音量；
  // 这样刷新页面后主/乐/效三路音量仍然保留（§6）。
  function seedVolumes() {
    const settings = (typeof G !== 'undefined' && G.settings) ? G.settings : {};
    const configVolumes = (A.volumes && typeof A.volumes === 'object') ? A.volumes : {};
    const kinds = ['master', 'music', 'sfx'];
    for (let i = 0; i < kinds.length; i++) {
      const kind = kinds[i];
      if (state.volumesTouched[kind]) continue;
      const fromSettings = Number(settings[kind]);
      const fromConfig = Number(configVolumes[kind]);
      let value = FALLBACK_VOLUMES[kind];
      if (Number.isFinite(fromSettings)) value = fromSettings;
      else if (Number.isFinite(fromConfig)) value = fromConfig;
      state.volumes[kind] = clamp(value, 0, 100);
    }
  }

  function buildNoiseBuffer() {
    const length = Math.max(1, Math.floor(ctx.sampleRate * NOISE_SECONDS));
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
    return buffer;
  }

  function getNoiseBuffer() {
    if (!noiseBuffer) noiseBuffer = buildNoiseBuffer();
    return noiseBuffer;
  }

  // ---------------------------------------------------------------------------
  // 初始化 / 恢复 / 暂停
  // ---------------------------------------------------------------------------
  function resumeContext() {
    if (!ctx) return;
    let promise = null;
    try {
      promise = ctx.resume();
    } catch (e) {
      promise = null;
    }
    if (promise && typeof promise.then === 'function') {
      promise.then(() => {
        if (!state.ready || state.suspended) return;
        try {
          ensureLoopPlaying();
          if (state.engineWanted) startEngineActual();
        } catch (e) { /* 恢复失败时等待下一次手势，不产生未处理异常 */ }
      }).catch(() => { /* 用户尚未授权/浏览器拒绝自动播放时静默等待下一次手势 */ });
    }
    if (ctx.state === 'running' && !state.suspended) {
      ensureLoopPlaying();
      if (state.engineWanted) startEngineActual();
    }
  }

  function init() {
    // 幂等：已初始化时只做恢复与补启动；若处于游戏暂停状态则保持挂起
    if (ctx && state.ready) {
      if (!state.suspended) resumeContext();
      return true;
    }

    const AudioCtor = (typeof window !== 'undefined')
      ? (window.AudioContext || window.webkitAudioContext)
      : null;
    if (!AudioCtor) return false;

    let created = null;
    try {
      created = new AudioCtor({ latencyHint: 'interactive' });
    } catch (e) {
      try {
        created = new AudioCtor();
      } catch (e2) {
        created = null;
      }
    }
    if (!created) return false;

    ctx = created;
    try {
      seedVolumes();
      buildGraph();
      noiseBuffer = buildNoiseBuffer();
      state.ready = true;
    } catch (e) {
      state.ready = false;
      try { ctx.close(); } catch (e2) { /* 创建失败后清理，避免悬挂上下文 */ }
      ctx = null;
      masterGain = null;
      sfxGain = null;
      musicGain = null;
      compressor = null;
      leadFilter = null;
      bassBus = null;
      drumBus = null;
      noiseBuffer = null;
      return false;
    }

    if (!state.suspended) {
      resumeContext();
    } else {
      try {
        const suspendedPromise = ctx.suspend();
        if (suspendedPromise && typeof suspendedPromise.catch === 'function') suspendedPromise.catch(() => {});
      } catch (e) { /* 新上下文保持挂起，等待 resume() */ }
    }
    return true;
  }

  function pause() {
    stopScheduler();
    stopLoopVoices();
    state.suspended = true;
    if (!ctx) return;
    try {
      const promise = ctx.suspend();
      if (promise && typeof promise.catch === 'function') promise.catch(() => {});
    } catch (e) { /* 已经 suspended/closed 时静默 */ }
  }

  function resume() {
    state.suspended = false;
    if (!ctx) return;
    resumeContext();
  }

  // ---------------------------------------------------------------------------
  // 音效节点工厂
  // ---------------------------------------------------------------------------
  function makeSfxOutput(opts) {
    let panner = null;
    if (opts.pan !== 0) {
      try {
        panner = ctx.createStereoPanner();
        panner.pan.value = opts.pan;
        panner.connect(sfxGain);
      } catch (e) {
        panner = null;
      }
    }
    return { dest: panner || sfxGain, panner, pending: 0 };
  }

  function registerSfxSource(play, src, nodes) {
    play.pending += 1;
    src.onended = () => {
      for (let i = 0; i < nodes.length; i++) {
        try { nodes[i].disconnect(); } catch (e) { /* 已断开时静默 */ }
      }
      play.pending -= 1;
      if (play.pending <= 0 && play.panner) {
        try { play.panner.disconnect(); } catch (e) { /* 已断开时静默 */ }
        play.panner = null;
      }
    };
  }

  function sfxTone(play, type, f0, f1, when, dur, peak, opts, attack) {
    const osc = ctx.createOscillator();
    osc.type = type;
    const rate = opts.rate;
    osc.frequency.setValueAtTime(Math.max(20, f0 * rate), when);
    if (f1 != null) osc.frequency.exponentialRampToValueAtTime(Math.max(20, f1 * rate), when + dur);
    if (opts.detune !== 0) osc.detune.value = opts.detune;

    const gain = ctx.createGain();
    const level = Math.max(EPS, peak * opts.volume);
    const atk = Math.max(0.001, Math.min(attack != null ? attack : 0.004, dur * 0.5));
    gain.gain.setValueAtTime(EPS, when);
    gain.gain.linearRampToValueAtTime(level, when + atk);
    gain.gain.exponentialRampToValueAtTime(EPS, when + dur);

    osc.connect(gain);
    gain.connect(play.dest);
    osc.start(when);
    osc.stop(when + dur + 0.02);
    registerSfxSource(play, osc, [osc, gain]);
  }

  function sfxNoise(play, when, dur, peak, opts, type, f0, f1, q, attack) {
    const src = ctx.createBufferSource();
    const buffer = getNoiseBuffer();
    src.buffer = buffer;

    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.setValueAtTime(Math.max(20, f0), when);
    if (f1 != null) filter.frequency.exponentialRampToValueAtTime(Math.max(20, f1), when + dur);
    filter.Q.value = q;

    const gain = ctx.createGain();
    const level = Math.max(EPS, peak * opts.volume);
    const atk = Math.max(0.001, Math.min(attack != null ? attack : 0.003, dur * 0.9));
    gain.gain.setValueAtTime(EPS, when);
    gain.gain.linearRampToValueAtTime(level, when + atk);
    gain.gain.exponentialRampToValueAtTime(EPS, when + dur);

    src.connect(filter);
    filter.connect(gain);
    gain.connect(play.dest);

    const offset = Math.random() * Math.max(0, buffer.duration - dur - 0.05);
    src.start(when, offset, dur + 0.02);
    src.stop(when + dur + 0.03);
    registerSfxSource(play, src, [src, filter, gain]);
  }

  // ---------------------------------------------------------------------------
  // 引擎循环：锯齿 50Hz + lowpass 240Hz（§6）
  // ---------------------------------------------------------------------------
  function engineRate() {
    if (!state.engineMoving) return 1;
    // 满速时严格 +12%；speedFactor 仅在 0..1 范围内造成 ±2% 的细微音高变化
    const sf = Math.min(1, Math.max(0, state.engineSpeed));
    const wobble = 1 + (sf - 1) * 0.02;
    return ENGINE.pitch * wobble;
  }

  function applyEngineTone() {
    if (!engine || !ctx) return;
    const t = ctx.currentTime;
    try {
      engine.osc.frequency.setTargetAtTime(ENGINE.baseHz * engineRate(), t, 0.08);
      engine.gain.gain.setTargetAtTime(state.engineMoving ? ENGINE.moveGain : ENGINE.idleGain, t, 0.05);
    } catch (e) { /* 上下文关闭时静默 */ }
  }

  function startEngineActual() {
    if (!ctx || !state.ready || state.suspended || engine || ctx.state !== 'running') return;
    try {
      const t = ctx.currentTime;
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(ENGINE.baseHz * engineRate(), t);

      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = ENGINE.lowpass;
      filter.Q.value = 0.8;

      const gain = ctx.createGain();
      gain.gain.setValueAtTime(EPS, t);
      gain.gain.linearRampToValueAtTime(
        state.engineMoving ? ENGINE.moveGain : ENGINE.idleGain,
        t + 0.12
      );

      osc.connect(filter);
      filter.connect(gain);
      gain.connect(sfxGain);
      osc.start(t);
      engine = { osc, filter, gain };
      lastEngineApply = t;
    } catch (e) {
      engine = null;
    }
  }

  function startEngine() {
    state.engineWanted = true;
    if (!ctx || !state.ready || ctx.state !== 'running') return;
    startEngineActual();
  }

  function stopEngine() {
    state.engineWanted = false;
    lastEngineApply = 0;
    if (!engine) return;
    const old = engine;
    engine = null;
    if (!ctx) return;
    const t = ctx.currentTime;
    try {
      old.gain.gain.cancelScheduledValues(t);
      old.gain.gain.setTargetAtTime(EPS, t, 0.03);
      old.osc.stop(t + 0.12);
    } catch (e) { /* 已停止时静默 */ }
    old.osc.onended = () => {
      try { old.osc.disconnect(); } catch (e) {}
      try { old.filter.disconnect(); } catch (e) {}
      try { old.gain.disconnect(); } catch (e) {}
    };
  }

  function setEngine(moving, speedFactor) {
    const nextMoving = !!moving;
    const nextSpeed = (typeof speedFactor === 'number' && Number.isFinite(speedFactor))
      ? clamp(speedFactor, 0, 1.5)
      : 1;
    const changed = nextMoving !== state.engineMoving
      || (nextMoving && Math.abs(nextSpeed - state.engineSpeed) > 0.05);
    state.engineMoving = nextMoving;
    state.engineSpeed = nextSpeed;
    if (!ctx || !engine || ctx.state !== 'running') return;
    const t = ctx.currentTime;
    if (!changed && t - lastEngineApply < 0.08) return;   // 节流：状态变化或每 80ms 最多更新一次
    lastEngineApply = t;
    applyEngineTone();
  }

  // ---------------------------------------------------------------------------
  // BGM 乐谱（附录 B）：'-' 休止，'|' 分小节，音名支持 #/b
  // ---------------------------------------------------------------------------
  function noteToFreq(name) {
    const match = NOTE_NAME_RE.exec(String(name));
    if (!match) return 0;
    let semitone = NOTE_SEMITONES[match[1]];
    if (match[2] === '#') semitone += 1;
    else if (match[2] === 'b') semitone -= 1;
    const octave = parseInt(match[3], 10);
    const midi = SEMITONES_PER_OCTAVE * (octave + 1) + semitone;
    return A4_HZ * Math.pow(2, (midi - A4_MIDI) / SEMITONES_PER_OCTAVE);
  }

  // 把一行乐谱编译成按 16 分音符步索引的事件表
  function compileVoice(text, stepSize) {
    const bars = String(text || '').split('|');
    const totalSteps = bars.length * STEPS_PER_BAR;
    const notes = new Array(totalSteps).fill(null);
    for (let b = 0; b < bars.length; b++) {
      const tokens = bars[b].trim().split(/\s+/).filter((token) => token.length > 0);
      for (let i = 0; i < tokens.length; i++) {
        const step = i * stepSize;
        if (step >= STEPS_PER_BAR) break;
        const token = tokens[i];
        if (token === '-') continue;
        const freq = noteToFreq(token);
        if (freq > 0) {
          notes[b * STEPS_PER_BAR + step] = { freq, steps: stepSize };
        }
      }
    }
    return { notes, totalSteps };
  }

  // 附录 B 原谱：LEAD 按八分音符写（每小节 8 个记号，stepSize=2），
  // BASS 按四分音符写（每小节 4 个记号，stepSize=4）；标题曲贝斯是两小节型重复。
  const TRACK_DEFS = {
    battle: {
      bpm: BPM.battle,
      leadStep: 2,
      bassStep: 4,
      lead:
        'A4 C5 E5 C5 A4 C5 E5 A5 | G4 B4 D5 B4 G4 B4 D5 G5 | ' +
        'F4 A4 C5 A4 F4 A4 C5 F5 | E4 G#4 B4 G#4 E4 G#4 B4 E5 | ' +
        'A4 C5 E5 C5 A4 C5 E5 A5 | G4 B4 D5 B4 G4 B4 D5 G5 | ' +
        'F4 A4 C5 A4 D5 C5 B4 G4 | A4 - E5 - A5 - - -',
      bass:
        'A2 A2 A2 A2 | G2 G2 G2 G2 | F2 F2 F2 F2 | E2 E2 B2 B2 | ' +
        'A2 A2 A2 A2 | G2 G2 G2 G2 | F2 F2 G2 G2 | A2 E2 A2 - -',
      drums: 'battle',
    },
    title: {
      bpm: BPM.title,
      leadStep: 2,
      bassStep: 2,
      lead:
        'D5 F5 A5 F5 D5 F5 A5 C6 | Bb5 A5 G5 F5 E5 C5 A4 C5 | ' +
        'D5 F5 A5 F5 D5 F5 A5 C6 | E5 - C5 - A4 - - -',
      bass:
        'D2 - D3 - Bb1 - Bb2 - | F2 - F3 - A1 - A2 - | ' +
        'D2 - D3 - Bb1 - Bb2 - | F2 - F3 - A1 - A2 -',
      drums: 'title',
    },
    horn: {
      bpm: BPM.horn,
      leadStep: 1,
      lead: 'G4 G4 C5 - D5 E5 F5 - E5 - - - - - - -',
      drums: 'horn',
    },
    jingle: {
      bpm: BPM.jingle,
      leadStep: 2,
      lead: 'C5 E5 G5 C6 - G5 E5 G5 | A5 - - - - - - -',
    },
    gameover: {
      bpm: BPM.gameover,
      leadStep: 2,
      lead: 'E4 - C4 - A3 - E3 - - - - - - - - -',
      drone: { note: 'A1', dur: GAMEOVER_DRONE },
    },
  };

  const DRUM_PATTERNS = {
    // 每小节 K h S h K h S h（§附录 B.1），位置为十六分音符步
    battle: { kicks: [0, 8], snares: [4, 12], hats: [2, 6, 10, 14], level: 1 },
    // 标题曲弱鼓（§附录 B.2）
    title: { kicks: [0], snares: [8], hats: [4, 12], level: 0.38 },
  };

  const TRACKS = (() => {
    const compiled = {};
    const names = Object.keys(TRACK_DEFS);
    for (let i = 0; i < names.length; i++) {
      const name = names[i];
      const def = TRACK_DEFS[name];
      const lead = compileVoice(def.lead, def.leadStep);
      const bass = def.bass ? compileVoice(def.bass, def.bassStep) : null;
      const totalSteps = Math.max(lead.totalSteps, bass ? bass.totalSteps : 0);
      compiled[name] = {
        bpm: def.bpm,
        lead,
        bass,
        drums: def.drums || null,
        drone: def.drone || null,
        totalSteps,
      };
    }
    return compiled;
  })();

  // ---------------------------------------------------------------------------
  // BGM 声部与鼓合成
  // ---------------------------------------------------------------------------
  function registerMusicSource(src, nodes, endTime, bucket) {
    if (bucket) bucket.push({ src, nodes, endTime });
    src.onended = () => {
      for (let i = 0; i < nodes.length; i++) {
        try { nodes[i].disconnect(); } catch (e) { /* 已断开时静默 */ }
      }
    };
  }

  function musicTone(wave, freq, when, dur, peak, dest, bucket) {
    const osc = ctx.createOscillator();
    osc.type = wave;
    osc.frequency.setValueAtTime(Math.max(20, freq), when);

    const gain = ctx.createGain();
    const attack = Math.min(0.008, dur * 0.25);
    const release = Math.min(0.04, dur * 0.35);
    const sustainAt = Math.max(when + attack, when + dur - release);
    gain.gain.setValueAtTime(EPS, when);
    gain.gain.linearRampToValueAtTime(peak, when + attack);
    gain.gain.setValueAtTime(peak, sustainAt);
    gain.gain.exponentialRampToValueAtTime(EPS, when + dur);

    osc.connect(gain);
    gain.connect(dest);
    osc.start(when);
    osc.stop(when + dur + 0.03);
    registerMusicSource(osc, [osc, gain], when + dur + 0.06, bucket);
  }

  function musicNoise(when, dur, peak, type, f0, f1, q, dest, attack, bucket) {
    const src = ctx.createBufferSource();
    const buffer = getNoiseBuffer();
    src.buffer = buffer;

    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.setValueAtTime(Math.max(20, f0), when);
    if (f1 != null) filter.frequency.exponentialRampToValueAtTime(Math.max(20, f1), when + dur);
    filter.Q.value = q;

    const gain = ctx.createGain();
    const atk = Math.max(0.001, Math.min(attack != null ? attack : 0.002, dur * 0.9));
    gain.gain.setValueAtTime(EPS, when);
    gain.gain.linearRampToValueAtTime(peak, when + atk);
    gain.gain.exponentialRampToValueAtTime(EPS, when + dur);

    src.connect(filter);
    filter.connect(gain);
    gain.connect(dest);
    const offset = Math.random() * Math.max(0, buffer.duration - dur - 0.05);
    src.start(when, offset, dur + 0.02);
    src.stop(when + dur + 0.03);
    registerMusicSource(src, [src, filter, gain], when + dur + 0.06, bucket);
  }

  function drumKick(when, peak, bucket) {
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(150, when);
    osc.frequency.exponentialRampToValueAtTime(45, when + 0.12);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(EPS, when);
    gain.gain.linearRampToValueAtTime(peak, when + 0.003);
    gain.gain.exponentialRampToValueAtTime(EPS, when + 0.18);

    osc.connect(gain);
    gain.connect(drumBus);
    osc.start(when);
    osc.stop(when + 0.2);
    registerMusicSource(osc, [osc, gain], when + 0.23, bucket);
  }

  function drumSnare(when, peak, dur, bucket) {
    musicNoise(when, dur, peak, 'bandpass', 1800, null, 0.9, drumBus, 0.002, bucket);
  }

  function drumHat(when, peak, bucket) {
    musicNoise(when, 0.045, peak, 'highpass', 6000, null, 0.7, drumBus, 0.001, bucket);
  }

  function scheduleDrums(kind, when, step, bucket) {
    const pattern = DRUM_PATTERNS[kind];
    if (!pattern) return;
    const slot = step % STEPS_PER_BAR;
    const level = pattern.level;
    if (pattern.kicks.indexOf(slot) !== -1) drumKick(when, MIX.kick * level, bucket);
    if (pattern.snares.indexOf(slot) !== -1) drumSnare(when, MIX.snare * level, 0.12, bucket);
    if (pattern.hats.indexOf(slot) !== -1) drumHat(when, MIX.hat * level, bucket);
  }

  // 单次排入一个 16 分音符循环步
  function scheduleLoopStep(track, step, when, stepDur, bucket) {
    const lead = track.lead.notes[step];
    if (lead) {
      musicTone('square', lead.freq, when, stepDur * lead.steps * 0.85, MIX.lead, leadFilter, bucket);
    }
    if (track.bass) {
      const bass = track.bass.notes[step];
      if (bass) {
        musicTone('triangle', bass.freq, when, stepDur * bass.steps * 0.9, MIX.bass, bassBus, bucket);
      }
    }
    if (track.drums) scheduleDrums(track.drums, when, step, bucket);
  }

  // ---------------------------------------------------------------------------
  // BGM 调度器（唯一允许出现 setInterval 的位置，规格书 §6）
  // ---------------------------------------------------------------------------
  function pruneMusicVoices() {
    if (!ctx) return;
    const now = ctx.currentTime;
    for (let i = musicVoices.length - 1; i >= 0; i--) {
      if (musicVoices[i].endTime < now - 0.25) musicVoices.splice(i, 1);
    }
  }

  function schedulerTick() {
    if (!ctx || !state.ready || !state.activeTrack) return;
    if (ctx.state !== 'running' || state.suspended) return;
    const track = TRACKS[state.activeTrack];
    if (!track) return;

    try {
      const stepDur = 60 / track.bpm / 4;   // 十六分音符时长
      const now = ctx.currentTime;
      // 标签页被节流后若落后过多，直接跳到当前时刻，避免一次性补发造成爆音
      if (state.nextTime < now - 0.2) state.nextTime = now + 0.05;

      let guard = 0;
      while (state.nextTime < now + LOOKAHEAD && guard < 32) {
        scheduleLoopStep(track, state.step, state.nextTime, stepDur, musicVoices);
        state.step = (state.step + 1) % track.totalSteps;
        state.nextTime += stepDur;
        guard += 1;
      }
      pruneMusicVoices();
    } catch (e) {
      // 节点创建异常时停止本轮调度，避免定时器持续抛出控制台错误
      stopScheduler();
    }
  }

  function startScheduler() {
    if (schedulerId !== null) return;
    // 用途：BGM 音序器定时器（30ms 轮询 + 0.12s 前瞻，规格书 §6）。
    schedulerId = setInterval(schedulerTick, TIMER_MS);
    schedulerTick();
  }

  function stopScheduler() {
    if (schedulerId !== null) {
      clearInterval(schedulerId);
      schedulerId = null;
    }
  }

  function stopLoopVoices() {
    const t = currentTime();
    for (let i = 0; i < musicVoices.length; i++) {
      const voice = musicVoices[i];
      try { voice.src.stop(t); } catch (e) { /* 已经结束时静默 */ }
      for (let j = 0; j < voice.nodes.length; j++) {
        try { voice.nodes[j].disconnect(); } catch (e) { /* 已经断开时静默 */ }
      }
    }
    musicVoices.length = 0;
  }

  function ensureLoopPlaying() {
    if (!ctx || !state.ready || state.suspended) return;
    const wanted = state.desiredTrack;
    if (!wanted) return;
    if (ctx.state !== 'running') return;

    try {
      if (state.activeTrack !== wanted) {
        stopScheduler();
        stopLoopVoices();
        state.activeTrack = wanted;
        state.step = 0;
      } else if (schedulerId !== null) {
        return;   // 同一首正在循环：重复调用不重启
      }

      state.nextTime = ctx.currentTime + 0.06;
      startScheduler();
    } catch (e) {
      stopScheduler();
    }
  }

  function startMusic(track) {
    if (track !== 'battle' && track !== 'title') return;
    state.desiredTrack = track;
    if (!ctx || !state.ready) return;
    ensureLoopPlaying();
  }

  function stopMusic() {
    state.desiredTrack = null;
    state.activeTrack = null;
    state.step = 0;
    stopScheduler();
    stopLoopVoices();
  }

  // ---------------------------------------------------------------------------
  // 一次性乐谱：号角 / Jingle / GAME OVER（附录 B.3–B.5）
  // ---------------------------------------------------------------------------
  function playScore(name, when, opts) {
    const track = TRACKS[name];
    if (!track) return;
    const start = Math.max(when, ctx.currentTime + 0.01);
    const stepDur = 60 / track.bpm / 4;
    const volume = opts.volume;

    for (let step = 0; step < track.totalSteps; step++) {
      const at = start + step * stepDur;
      const lead = track.lead.notes[step];
      if (lead) {
        musicTone('square', lead.freq, at, stepDur * lead.steps * 0.9, MIX.lead * volume, leadFilter, null);
      }
      if (track.bass) {
        const bass = track.bass.notes[step];
        if (bass) {
          musicTone('triangle', bass.freq, at, stepDur * bass.steps * 0.9, MIX.bass * volume, bassBus, null);
        }
      }
    }

    // B.3：十六分军鼓滚奏渐强，最后一步收重音
    if (track.drums === 'horn') {
      const hits = track.totalSteps;
      for (let i = 0; i < hits; i++) {
        const at = start + i * stepDur;
        const progress = i / Math.max(1, hits - 1);
        const accent = (i === hits - 1) ? 1.8 : 1;
        drumSnare(at, MIX.snare * volume * (0.35 + 0.65 * progress) * accent, 0.07, null);
      }
      drumKick(start, MIX.kick * volume * 0.7, null);
      drumKick(start + (hits - 1) * stepDur, MIX.kick * volume * 1.2, null);
    }

    // B.5：三角波 A1 全音符长音缓衰 4s
    if (track.drone) {
      const freq = noteToFreq(track.drone.note) || 55;
      const droneOsc = ctx.createOscillator();
      droneOsc.type = 'triangle';
      droneOsc.frequency.setValueAtTime(freq, start);
      const droneGain = ctx.createGain();
      droneGain.gain.setValueAtTime(EPS, start);
      droneGain.gain.linearRampToValueAtTime(MIX.drone * volume, start + 0.04);
      droneGain.gain.exponentialRampToValueAtTime(EPS, start + track.drone.dur);
      droneOsc.connect(droneGain);
      droneGain.connect(bassBus);
      droneOsc.start(start);
      droneOsc.stop(start + track.drone.dur + 0.05);
      registerMusicSource(droneOsc, [droneOsc, droneGain], start + track.drone.dur + 0.1, null);
    }
  }

  // ---------------------------------------------------------------------------
  // 音效配方（严格对应规格书 §6 表）
  // ---------------------------------------------------------------------------
  const SFX = {
    fire(when, opts) {
      const play = makeSfxOutput(opts);
      sfxTone(play, 'square', 880, 220, when, 0.08, 0.22, opts, 0.002);
      sfxNoise(play, when, 0.03, 0.18, opts, 'highpass', 1600, null, 0.7, 0.001);
    },
    hitBrick(when, opts) {
      const play = makeSfxOutput(opts);
      sfxNoise(play, when, 0.1, 0.35, opts, 'lowpass', 700, 300, 0.9, 0.003);
      sfxTone(play, 'sine', 120, null, when, 0.12, 0.28, opts, 0.003);
    },
    hitSteel(when, opts) {
      const play = makeSfxOutput(opts);
      sfxTone(play, 'square', 1046, null, when, 0.15, 0.1, opts, 0.002);
      sfxTone(play, 'square', 1568, null, when, 0.15, 0.09, opts, 0.002);
    },
    bulletCancel(when, opts) {
      const play = makeSfxOutput(opts);
      sfxNoise(play, when, 0.04, 0.22, opts, 'highpass', 2500, null, 0.8, 0.001);
      sfxTone(play, 'square', 2000, null, when, 0.015, 0.12, opts, 0.001);
    },
    explosionSmall(when, opts) {
      const play = makeSfxOutput(opts);
      sfxNoise(play, when, 0.45, 0.5, opts, 'lowpass', 3000, 150, 0.8, 0.004);
      sfxTone(play, 'sine', 150, 40, when, 0.45, 0.35, opts, 0.004);
      duckMusic();
    },
    explosionBig(when, opts) {
      const play = makeSfxOutput(opts);
      // 主爆 0.9s：噪声低通扫频 + 正弦 60→30Hz
      sfxNoise(play, when, 0.9, 0.55, opts, 'lowpass', 3000, 120, 0.8, 0.005);
      sfxTone(play, 'sine', 60, 30, when, 0.9, 0.42, opts, 0.005);
      // 两次延迟 120ms 的副爆
      sfxNoise(play, when + 0.12, 0.38, 0.3, opts, 'lowpass', 2200, 140, 0.8, 0.004);
      sfxTone(play, 'sine', 120, 48, when + 0.12, 0.36, 0.24, opts, 0.004);
      sfxNoise(play, when + 0.24, 0.32, 0.22, opts, 'lowpass', 1800, 110, 0.8, 0.004);
      sfxTone(play, 'sine', 96, 38, when + 0.24, 0.3, 0.18, opts, 0.004);
      duckMusic();
    },
    shieldHit(when, opts) {
      const play = makeSfxOutput(opts);
      // 300Hz 载波被 30Hz 调制 0.15s
      const carrier = ctx.createOscillator();
      carrier.type = 'sine';
      carrier.frequency.setValueAtTime(300, when);
      const mod = ctx.createOscillator();
      mod.type = 'sine';
      mod.frequency.setValueAtTime(30, when);
      const modGain = ctx.createGain();
      modGain.gain.value = 0.05;
      const amp = ctx.createGain();
      amp.gain.value = 0.12;
      const env = ctx.createGain();
      env.gain.setValueAtTime(EPS, when);
      env.gain.linearRampToValueAtTime(Math.max(EPS, opts.volume), when + 0.004);
      env.gain.exponentialRampToValueAtTime(EPS, when + 0.15);
      mod.connect(modGain);
      modGain.connect(amp.gain);
      carrier.connect(amp);
      amp.connect(env);
      env.connect(play.dest);
      carrier.start(when);
      mod.start(when);
      carrier.stop(when + 0.17);
      mod.stop(when + 0.17);
      registerSfxSource(play, carrier, [carrier, mod, modGain, amp, env]);
    },
    powerupSpawn(when, opts) {
      const play = makeSfxOutput(opts);
      // 方波琶音 C5 → G5 → E6，各 60ms
      sfxTone(play, 'square', 523.25, null, when, 0.07, 0.12, opts, 0.002);
      sfxTone(play, 'square', 783.99, null, when + 0.06, 0.07, 0.12, opts, 0.002);
      sfxTone(play, 'square', 1318.51, null, when + 0.12, 0.08, 0.12, opts, 0.002);
    },
    powerupPick(when, opts) {
      const play = makeSfxOutput(opts);
      // E5 → C6 双音跳 + 高频闪烁噪声
      sfxTone(play, 'square', 659.25, null, when, 0.08, 0.14, opts, 0.002);
      sfxTone(play, 'square', 1046.5, null, when + 0.07, 0.16, 0.14, opts, 0.002);
      sfxNoise(play, when + 0.02, 0.12, 0.1, opts, 'highpass', 6000, null, 0.7, 0.002);
    },
    lifeUp(when, opts) {
      const play = makeSfxOutput(opts);
      const notes = [523.25, 659.25, 783.99, 1046.5, 1318.51, 1567.98];
      for (let i = 0; i < notes.length; i++) {
        sfxTone(play, 'square', notes[i], null, when + i * 0.045, 0.06, 0.12, opts, 0.002);
      }
    },
    freeze(when, opts) {
      const play = makeSfxOutput(opts);
      // 方波滑音 1200→300Hz / 0.5s + 高频微光噪声
      sfxTone(play, 'square', 1200, 300, when, 0.5, 0.15, opts, 0.004);
      sfxNoise(play, when, 0.5, 0.06, opts, 'highpass', 6000, null, 0.7, 0.02);
    },
    shovel(when, opts) {
      const play = makeSfxOutput(opts);
      // 4 连方波 700Hz / 30ms，间隔 90ms + 石料摩擦噪声
      for (let i = 0; i < 4; i++) {
        sfxTone(play, 'square', 700, null, when + i * 0.09, 0.03, 0.13, opts, 0.001);
      }
      sfxNoise(play, when, 0.36, 0.1, opts, 'bandpass', 1400, 900, 1.2, 0.01);
    },
    grenade(when, opts) {
      const play = makeSfxOutput(opts);
      // 三连降调爆炸，音量递减
      for (let i = 0; i < 3; i++) {
        const at = when + i * 0.2;
        const scale = 1 - i * 0.25;
        const lowpass = 2600 - i * 500;
        sfxNoise(play, at, 0.34 + i * 0.05, 0.45 * scale, opts, 'lowpass', lowpass, 130, 0.8, 0.003);
        sfxTone(play, 'sine', 130 - i * 20, 42, at, 0.38, 0.3 * scale, opts, 0.003);
      }
      duckMusic();
    },
    tick(when, opts) {
      const play = makeSfxOutput(opts);
      sfxTone(play, 'square', 2000, null, when, 0.015, 0.1, opts, 0.001);
    },
    spawn(when, opts) {
      const play = makeSfxOutput(opts);
      // 上滑扫频噪声 0.6s 渐强
      sfxNoise(play, when, 0.6, 0.28, opts, 'bandpass', 200, 2200, 1.4, 0.45);
    },
    horn(when, opts) {
      playScore('horn', when, opts);
    },
    jingle(when, opts) {
      playScore('jingle', when, opts);
    },
    gameover(when, opts) {
      playScore('gameover', when, opts);
    },
    uiMove(when, opts) {
      const play = makeSfxOutput(opts);
      sfxTone(play, 'square', 620, 700, when, 0.05, 0.07, opts, 0.002);
    },
    uiSelect(when, opts) {
      const play = makeSfxOutput(opts);
      sfxTone(play, 'square', 660, null, when, 0.06, 0.1, opts, 0.002);
      sfxTone(play, 'square', 990, null, when + 0.05, 0.09, 0.1, opts, 0.002);
    },
    pause(when, opts) {
      const play = makeSfxOutput(opts);
      sfxTone(play, 'square', 520, 260, when, 0.14, 0.1, opts, 0.004);
    },
  };

  // ---------------------------------------------------------------------------
  // 音乐压低（§6：爆炸时瞬压 30%，120ms 恢复）
  // ---------------------------------------------------------------------------
  function duckMusic() {
    if (!ctx || !state.ready || !musicGain) return;
    state.duckActive = true;
    state.duckRemain = 0.01 + DUCK_HOLD;
    const t = ctx.currentTime;
    const base = state.musicBase;
    const target = base * DUCK_AMOUNT;
    const param = musicGain.gain;
    try {
      if (typeof param.cancelAndHoldAtTime === 'function') param.cancelAndHoldAtTime(t);
      else {
        param.cancelScheduledValues(t);
        param.setValueAtTime(param.value, t);
      }
      param.linearRampToValueAtTime(target, t + 0.01);
      param.linearRampToValueAtTime(base, t + 0.01 + DUCK_HOLD);
    } catch (e) {
      // 自动化失败时由 update() 的帧级兜底恢复
    }
  }

  // ---------------------------------------------------------------------------
  // 对外 API 用到的内部实现
  // ---------------------------------------------------------------------------
  function normalizeOptions(opts) {
    const o = opts || {};
    return {
      volume: (typeof o.volume === 'number' && Number.isFinite(o.volume))
        ? clamp(o.volume, 0, 2) : 1,
      rate: (typeof o.rate === 'number' && Number.isFinite(o.rate))
        ? clamp(o.rate, 0.25, 4) : 1,
      detune: (typeof o.detune === 'number' && Number.isFinite(o.detune))
        ? clamp(o.detune, -2400, 2400) : 0,
      pan: (typeof o.pan === 'number' && Number.isFinite(o.pan))
        ? clamp(o.pan, -1, 1) : 0,
    };
  }

  // 同类音效在 SAME_SFX_WINDOW 窗口内超过 MAX_SAME_SFX 个声部后合并丢弃
  function allowSameSfx(name) {
    const t = realNowSeconds();
    const entry = recentSfx[name];
    if (!entry || t - entry.start > SAME_SFX_WINDOW) {
      recentSfx[name] = { start: t, count: 1 };
      return true;
    }
    entry.count += 1;
    return entry.count <= MAX_SAME_SFX;
  }

  function setVolume(kind, value) {
    if (kind !== 'master' && kind !== 'music' && kind !== 'sfx') return;
    const v = Number(value);
    if (!Number.isFinite(v)) return;
    state.volumes[kind] = clamp(v, 0, 100);
    state.volumesTouched[kind] = true;
    if (!ctx || !state.ready) return;
    if (kind === 'master') {
      applyMasterVolume(true);
    } else if (kind === 'music') {
      state.musicBase = volumeCurve('music', state.volumes.music);
      applyMusicVolume(true);
    } else {
      applySfxVolume(true);
    }
  }

  function setMuted(flag) {
    state.muted = !!flag;
    if (!ctx || !state.ready) return;
    applyMasterVolume(true);
  }

  function play(name, opts) {
    if (!ctx || !state.ready || state.muted) return;
    if (ctx.state !== 'running') return;   // 未解锁/暂停期间静默丢弃
    if (!Object.prototype.hasOwnProperty.call(SFX, name)) return;
    if (!allowSameSfx(name)) return;
    const normalized = normalizeOptions(opts);
    try {
      SFX[name](ctx.currentTime + 0.002, normalized);
    } catch (e) {
      // 单个音效合成异常不得打断游戏主循环，也不向控制台输出
    }
  }

  function update(dt) {
    if (!ctx || !state.ready) return;

    // 音乐压低恢复的帧级兜底：正常情况下由 AudioParam 自动化在 120ms 内完成
    if (state.duckActive) {
      const delta = (typeof dt === 'number' && Number.isFinite(dt) && dt > 0) ? dt : (1 / 60);
      state.duckRemain -= delta;
      if (state.duckRemain <= 0) {
        state.duckActive = false;
        if (ctx.state === 'running') {
          setParam(musicGain.gain, state.musicBase, true, 0.02);
        }
      }
    }

    // 从暂停/后台恢复后，若还有期望曲目或引擎未启动，补启动（幂等）
    if (!state.suspended) {
      if (state.desiredTrack && schedulerId === null && ctx.state === 'running') {
        ensureLoopPlaying();
      }
      if (state.engineWanted && !engine && ctx.state === 'running') {
        startEngineActual();
      }
    }
  }

  // ---------------------------------------------------------------------------
  // 公开接口（契约 §4）
  // ---------------------------------------------------------------------------
  return {
    init,
    get ready() { return !!(ctx && state.ready); },
    get muted() { return state.muted; },
    setVolume,
    setMuted,
    play,
    startMusic,
    stopMusic,
    pause,
    resume,
    startEngine,
    stopEngine,
    setEngine,
    update,
  };
})();
