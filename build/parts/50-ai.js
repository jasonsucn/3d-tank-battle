// ============================================================================
// 50-ai.js — 敌方 AI（无 A*；直行/向基地/向玩家/随机，受阻重判）（规格书 §3）
// ============================================================================
const AI = (() => {
  const W = CONFIG.enemy.decisionWeights;

  function update(enemy, dt) {
    if (!enemy.alive || enemy.spawning > 0) return { fire: false };
    const ai = enemy.ai;
    ai.timer -= dt;
    ai.alignTimer -= dt;
    let fire = false;

    // 同轴射击：与玩家或鹰同轴、距离 <10、无遮挡时 60% 开火
    if (ai.alignTimer <= 0) {
      ai.alignTimer = 0.25;
      if (enemy.fireTimer <= 0 && alignedTarget(enemy)) {
        if (UTILS.chance(CONFIG.enemy.alignedFireChance)) fire = true;
      }
    }

    if (ai.timer <= 0) {
      chooseDirection(enemy);
      ai.timer = UTILS.rand(CONFIG.enemy.decision[0], CONFIG.enemy.decision[1]);
      if (UTILS.chance(CONFIG.enemy.fireChance)) fire = true;
    }
    return { fire };
  }

  function alignedTarget(enemy) {
    const d = DIRS[enemy.dir];
    const targets = [];
    for (const p of G.players) {
      if (p && p.alive && p.model) targets.push({ x: p.x, z: p.z });
    }
    const base = World.getBase();
    targets.push({ x: base.x, z: base.z });

    for (const t of targets) {
      const dx = t.x - enemy.x;
      const dz = t.z - enemy.z;
      const dist = Math.hypot(dx, dz);
      if (dist > CONFIG.enemy.alignedRange || dist < 0.2) continue;
      // 朝向必须大体指向目标
      if (d.axis === 'z') {
        if (Math.abs(dx) > CONFIG.enemy.alignedTolerance) continue;
        if (Math.sign(dz) !== Math.sign(d.z)) continue;
      } else {
        if (Math.abs(dz) > CONFIG.enemy.alignedTolerance) continue;
        if (Math.sign(dx) !== Math.sign(d.x)) continue;
      }
      if (World.lineBlocked(enemy.x, enemy.z, t.x, t.z)) continue;
      return true;
    }
    return false;
  }

  function chooseDirection(enemy) {
    const options = [];
    const weights = [];

    // 直行 40%
    options.push(enemy.dir);
    weights.push(W.straight);

    // 朝基地轴 25%
    const baseDir = axisToward(enemy.x, enemy.z, World.getBase().x, World.getBase().z);
    if (baseDir) { options.push(baseDir); weights.push(W.baseAxis); }

    // 朝最近玩家 15%
    const playerDir = dirTowardNearestPlayer(enemy);
    if (playerDir) { options.push(playerDir); weights.push(W.playerAxis); }

    // 随机 20%
    const randomDir = UTILS.choice(DIR_LIST);
    options.push(randomDir);
    weights.push(W.random);

    let chosen;
    if (enemy.ai.forceRandom) {
      chosen = randomDir;
      enemy.ai.forceRandom = false;
    } else {
      chosen = UTILS.weightedPick(options, weights);
    }
    enemy.dir = chosen;
  }

  function axisToward(x, z, tx, tz) {
    const dx = tx - x;
    const dz = tz - z;
    if (Math.abs(dx) < 1e-6 && Math.abs(dz) < 1e-6) return null;
    if (Math.abs(dx) > Math.abs(dz)) return dx > 0 ? 'right' : 'left';
    return dz > 0 ? 'down' : 'up';
  }

  function dirTowardNearestPlayer(enemy) {
    let best = null;
    let bestDist = Infinity;
    for (const p of G.players) {
      if (!p || !p.alive || !p.model) continue;
      const d = Math.abs(p.x - enemy.x) + Math.abs(p.z - enemy.z);
      if (d < bestDist) { bestDist = d; best = p; }
    }
    if (!best) return null;
    return axisToward(enemy.x, enemy.z, best.x, best.z);
  }

  return { update };
})();
