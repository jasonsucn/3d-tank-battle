// ============================================================================
// 40-entities.js — 玩家/敌方坦克、子弹、道具、护盾、复活、坦克互撞（§2/§3/§5）
// ============================================================================
const Entities = (() => {
  const BULLET_POOL = 48;
  const bulletPool = [];
  const muzzleVec = new THREE.Vector3();
  let scene = null;
  let inited = false;

  // 青色菲涅尔护盾泡泡材质（玩家护盾 / 头盔）
  const shieldMat = new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(0x4adfff) },
      uTime: { value: 0 },
      uPulse: { value: 0 },
    },
    vertexShader: `
      varying vec3 vNormalW;
      varying vec3 vViewW;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vNormalW = normalize(mat3(modelMatrix) * normal);
        vViewW = normalize(cameraPosition - wp.xyz);
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: `
      uniform vec3 uColor;
      uniform float uTime;
      uniform float uPulse;
      varying vec3 vNormalW;
      varying vec3 vViewW;
      void main() {
        float fres = pow(1.0 - abs(dot(normalize(vNormalW), normalize(vViewW))), 2.2);
        float shimmer = 0.75 + 0.25 * sin(uTime * 6.0 + vNormalW.y * 3.0);
        float a = (0.16 + fres * 0.55) * shimmer + uPulse * fres;
        gl_FragColor = vec4(uColor * (0.7 + fres), a);
      }`,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });

  const bulletGeoCore = new THREE.SphereGeometry(CONFIG.bullet.radius, 8, 6);
  const trailGeo = new THREE.CylinderGeometry(0.05, 0.015, CONFIG.bullet.trailLength, 6, 1, true);
  trailGeo.rotateX(Math.PI / 2); // 沿 Z 轴
  trailGeo.translate(0, 0, CONFIG.bullet.trailLength / 2 + 0.1);

  function init(sceneRef) {
    if (inited) return;
    scene = sceneRef;
    for (let i = 0; i < BULLET_POOL; i++) {
      const group = new THREE.Group();
      const coreMat = new THREE.MeshBasicMaterial({ color: CONFIG.bullet.coreColor });
      const core = new THREE.Mesh(bulletGeoCore, coreMat);
      const trailMat = new THREE.MeshBasicMaterial({
        color: CONFIG.bullet.glowColor, transparent: true, opacity: 0.55,
        blending: THREE.AdditiveBlending, depthWrite: false,
      });
      const trail = new THREE.Mesh(trailGeo, trailMat);
      const glowMat = new THREE.SpriteMaterial({
        map: Tex.spark, color: CONFIG.bullet.glowColor, transparent: true,
        blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.9,
      });
      const glow = new THREE.Sprite(glowMat);
      glow.scale.set(1.0, 1.0, 1.0);
      group.add(core, trail, glow);
      group.visible = false;
      group.renderOrder = 5;
      scene.add(group);
      bulletPool.push({ group, core, trail, glow, coreMat, trailMat, glowMat, active: false });
    }
    inited = true;
  }

  // -------------------------------------------------------------------------
  // 实体工厂
  // -------------------------------------------------------------------------
  function makePlayer(index) {
    const block = CONFIG.player.spawnBlocks[index] || CONFIG.player.spawnBlocks[0];
    const x = (block.c - 6) * 2;
    const z = (block.r - 6) * 2;
    return {
      kind: 'player', type: 'player', index,
      x, z, dir: 'up', visualYaw: 0,
      model: null, alive: true,
      speed: CONFIG.player.speed,
      hp: 1, maxHp: 1,
      fireLevel: 0, fireTimer: 0,
      vel: 0, moving: false,
      spawning: 0, spawnTotal: 0,
      shield: 0, shieldTotal: 0,
      respawnTimer: 0, lives: CONFIG.player.lives,
      ice: false, dustTimer: 0, trailTimer: 0,
      shieldMesh: null, shieldPulse: 0,
      isPlayer: true,
    };
  }

  function makeEnemy(type, carrier) {
    const cfg = CONFIG.enemy;
    return {
      kind: 'enemy', type, index: -1,
      x: 0, z: 0, dir: 'down', visualYaw: Math.PI,
      model: null, alive: true,
      speed: cfg.speed[type],
      hp: cfg.hp[type], maxHp: cfg.hp[type],
      fireLevel: 0, fireTimer: UTILS.rand(0.4, 1.0),
      vel: 0, moving: false,
      spawning: 0, spawnTotal: 0,
      shield: 0, shieldTotal: 0,
      respawnTimer: 0, lives: 0,
      ice: false, dustTimer: 0, trailTimer: 0,
      carrier: !!carrier, glow: null,
      isPlayer: false,
      ai: {
        timer: 0.2, blocked: 0, alignTimer: 0,
        forceRandom: false, dead: false,
      },
    };
  }

  function attachModel(tank, model) {
    tank.model = model;
    model.group.position.set(tank.x, 0, tank.z);
    tank.visualYaw = DIRS[tank.dir].angle;
    model.group.rotation.y = tank.visualYaw;
    scene.add(model.group);
  }

  function detachModel(tank) {
    if (!tank.model) return;
    if (tank.model.group.parent) tank.model.group.parent.remove(tank.model.group);
    if (tank.shieldMesh && tank.shieldMesh.parent) tank.shieldMesh.parent.remove(tank.shieldMesh);
    tank.shieldMesh = null;
    if (tank.model.dispose) tank.model.dispose();
    tank.model = null;
  }

  // -------------------------------------------------------------------------
  // 生成 / 重置
  // -------------------------------------------------------------------------
  function reset() {
    for (const t of G.players) detachModel(t);
    for (const e of G.enemies) detachModel(e);
    G.players.length = 0;
    G.enemies.length = 0;
    G.player = null;
    for (const b of G.bullets) recycleBullet(b);
    G.bullets.length = 0;
    for (const p of G.powerups) {
      if (p.model && p.model.parent) p.model.parent.remove(p.model);
      if (p.model && p.model.dispose) p.model.dispose();
    }
    G.powerups.length = 0;
    grenadeQueue.length = 0;
  }

  function spawnPlayer(index) {
    const p = makePlayer(index);
    attachModel(p, Models.player());
    p.model.setFireLevel(p.fireLevel);
    createShieldMesh(p);
    G.players[index] = p;
    G.player = G.players.find((q) => q && q.alive) || p;
    return p;
  }

  function respawnPlayer(p) {
    if (p.alive) return;
    const block = CONFIG.player.spawnBlocks[p.index] || CONFIG.player.spawnBlocks[0];
    p.x = (block.c - 6) * 2;
    p.z = (block.r - 6) * 2;
    p.dir = 'up';
    p.visualYaw = 0;
    p.fireLevel = 0;
    p.fireTimer = 0;
    p.vel = 0;
    p.moving = false;
    p.alive = true;
    p.spawning = 0;
    p.ice = false;
    attachModel(p, Models.player());
    p.model.setFireLevel(0);
    p.shield = CONFIG.player.respawnShield;
    p.shieldTotal = CONFIG.player.respawnShield;
    createShieldMesh(p);
    FX.spawnBeam(new THREE.Vector3(p.x, 0, p.z));
    AudioSys.play('spawn');
  }

  function createShieldMesh(tank) {
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(1.45, 20, 14), shieldMat);
    mesh.position.y = 0.55;
    mesh.scale.set(1.15, 0.75, 1.15);
    mesh.visible = false;
    tank.model.group.add(mesh);
    tank.shieldMesh = mesh;
  }

  function spawnEnemy(type, carrier) {
    const e = makeEnemy(type, carrier);
    const point = pickSpawnPoint();
    if (!point) return null;
    e.x = point.x;
    e.z = point.z;
    e.dir = 'down';
    e.visualYaw = Math.PI;
    e.spawning = CONFIG.enemy.spawnBeam;
    e.spawnTotal = CONFIG.enemy.spawnBeam;
    attachModel(e, Models.enemy(type));
    e.model.setOpacity(0);
    if (e.maxHp > 1) e.model.setArmorHealth(e.hp, e.maxHp);
    if (carrier) {
      const glowMat = new THREE.SpriteMaterial({
        map: Tex.spark, color: 0xff4b3a, transparent: true,
        blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.85,
      });
      const glow = new THREE.Sprite(glowMat);
      glow.scale.set(1.6, 1.6, 1.6);
      glow.position.y = 1.35;
      e.model.group.add(glow);
      e.glow = glow;
    }
    G.enemies.push(e);
    FX.spawnBeam(new THREE.Vector3(e.x, 0, e.z));
    AudioSys.play('spawn');
    e.ai.timer = UTILS.rand(0.3, 0.8);
    return e;
  }

  function pickSpawnPoint() {
    const blocks = CONFIG.enemy.spawnBlocks;
    const start = G.level.spawnPointIndex || 0;
    for (let k = 0; k < blocks.length; k++) {
      const idx = (start + k) % blocks.length;
      const b = blocks[idx];
      const x = (b.c - 6) * 2;
      const z = (b.r - 6) * 2;
      if (!positionOccupied(x, z, null)) {
        G.level.spawnPointIndex = (idx + 1) % blocks.length;
        return { x, z };
      }
    }
    return null;
  }

  function positionOccupied(x, z, ignore) {
    for (const t of G.players.concat(G.enemies)) {
      if (!t || !t.alive || t === ignore || !t.model) continue;
      if (Math.abs(t.x - x) < 1.8 && Math.abs(t.z - z) < 1.8) return true;
    }
    return false;
  }

  // -------------------------------------------------------------------------
  // 子弹池
  // -------------------------------------------------------------------------
  function acquireBullet() {
    for (const slot of bulletPool) {
      if (!slot.active) {
        slot.active = true;
        slot.group.visible = true;
        return slot;
      }
    }
    return null;
  }

  function recycleBullet(bullet) {
    if (!bullet) return;
    bullet.alive = false;
    const slot = bullet.slot;
    if (slot) {
      slot.active = false;
      slot.group.visible = false;
    }
    if (bullet.slot) bullet.slot.bullet = null;
  }

  function fire(tank) {
    if (!tank || !tank.alive || !tank.model) return false;
    if (tank.spawning > 0) return false;
    if (tank.fireTimer > 0) return false;
    if (!tank.isPlayer && G.effects.freeze > 0) return false;
    const maxBullets = tank.isPlayer
      ? CONFIG.player.fire[tank.fireLevel].maxBullets
      : CONFIG.enemy.fire[tank.type].maxBullets;
    let active = 0;
    for (const b of G.bullets) {
      if (b.alive && b.owner === tank) active++;
    }
    if (active >= maxBullets) return false;
    const slot = acquireBullet();
    if (!slot) return false;

    const dir = DIRS[tank.dir];
    // 炮口世界坐标：按当前朝向解算，兼容不同车型的炮管长度（规格书 §4 模型）
    let mx = tank.x + dir.x * CONFIG.tank.muzzleOffset;
    let my = 0.56;
    let mz = tank.z + dir.z * CONFIG.tank.muzzleOffset;
    if (tank.model && tank.model.muzzle) {
      const g = tank.model.group;
      g.position.set(tank.x, 0, tank.z);
      g.rotation.y = dir.angle;
      g.updateWorldMatrix(true, true);
      tank.model.muzzle.getWorldPosition(muzzleVec);
      mx = muzzleVec.x;
      my = muzzleVec.y;
      mz = muzzleVec.z;
    }
    const bullet = {
      x: mx,
      z: mz,
      y: my,
      dir: tank.dir,
      speed: tank.isPlayer ? CONFIG.player.fire[tank.fireLevel].speed : CONFIG.enemy.fire[tank.type].speed,
      owner: tank,
      player: tank.isPlayer,
      breakSteel: tank.isPlayer && CONFIG.player.fire[tank.fireLevel].breakSteel,
      alive: true,
      life: 0,
      overWater: false,
      slot,
      trailPulse: 0,
    };
    slot.bullet = bullet;
    slot.group.position.set(bullet.x, bullet.y, bullet.z);
    slot.group.rotation.y = dir.angle;
    const glowColor = tank.isPlayer ? CONFIG.bullet.glowColor : CONFIG.bullet.enemyGlowColor;
    slot.coreMat.color.setHex(tank.isPlayer ? CONFIG.bullet.coreColor : 0xffc2a0);
    slot.trailMat.color.setHex(glowColor);
    slot.glowMat.color.setHex(glowColor);
    slot.glow.scale.set(1.1, 1.1, 1.1);
    G.bullets.push(bullet);

    tank.fireTimer = tank.isPlayer
      ? CONFIG.player.fire[tank.fireLevel].cooldown
      : UTILS.rand(CONFIG.enemy.fire[tank.type].cooldown[0], CONFIG.enemy.fire[tank.type].cooldown[1]);

    if (tank.model.recoil) tank.model.recoil();
    const muzzle = new THREE.Vector3(mx, my, mz);
    FX.muzzleFlash(muzzle, dir);
    FX.shake(CONFIG.fx.shake.fire);
    AudioSys.play('fire');
    return true;
  }

  // -------------------------------------------------------------------------
  // 坦克移动
  // -------------------------------------------------------------------------
  function tryTurn(tank, dir) {
    if (!dir || dir === tank.dir) return true;
    const prevX = tank.x;
    const prevZ = tank.z;
    const prevDir = tank.dir;
    tank.dir = dir;
    if (DIRS[dir].axis === 'z') {
      tank.x = UTILS.snapAxis(tank.x);
    } else {
      tank.z = UTILS.snapAxis(tank.z);
    }
    if (World.tankBlocked(tank.x, tank.z, CONFIG.tank.aabbHalf) || tankOverlapsOther(tank)) {
      tank.x = prevX;
      tank.z = prevZ;
      tank.dir = prevDir;
      return false;
    }
    return true;
  }

  function tankOverlapsOther(tank) {
    const all = G.players.concat(G.enemies);
    for (const other of all) {
      if (!other || other === tank || !other.alive || !other.model) continue;
      if (World.tankOverlap(tank.x, tank.z, other.x, other.z, CONFIG.tank.aabbHalf)) return true;
    }
    return false;
  }

  function moveTank(tank, dt, wantMove, dirOverride) {
    if (tank.spawning > 0 || !tank.alive) { tank.moving = false; tank.vel = 0; return; }
    if (dirOverride && dirOverride !== tank.dir) tryTurn(tank, dirOverride);
    const ice = World.isIceAt(tank.x, tank.z);
    tank.ice = ice;
    const target = wantMove ? tank.speed : 0;
    if (ice) {
      tank.vel = UTILS.lerp(tank.vel, target, UTILS.clamp01(2.5 * dt));
    } else {
      tank.vel = target;
    }
    if (Math.abs(tank.vel) < 0.02) {
      tank.vel = 0;
      tank.moving = false;
      return;
    }
    const d = DIRS[tank.dir];
    const nx = tank.x + d.x * tank.vel * dt;
    const nz = tank.z + d.z * tank.vel * dt;
    if (World.tankBlocked(nx, nz, CONFIG.tank.aabbHalf) || tankOverlapsOtherAt(tank, nx, nz)) {
      tank.vel = 0;
      tank.moving = false;
      if (!tank.isPlayer) onEnemyBlocked(tank);
      return;
    }
    tank.x = nx;
    tank.z = nz;
    tank.moving = true;
    if (!tank.isPlayer) tank.ai.blocked = 0;
  }

  function tankOverlapsOtherAt(tank, x, z) {
    const all = G.players.concat(G.enemies);
    for (const other of all) {
      if (!other || other === tank || !other.alive || !other.model) continue;
      if (World.tankOverlap(x, z, other.x, other.z, CONFIG.tank.aabbHalf)) return true;
    }
    return false;
  }

  function onEnemyBlocked(enemy) {
    enemy.ai.blocked += 1 / 60;
    enemy.ai.timer = 0;
    if (enemy.ai.blocked > CONFIG.enemy.blockedForceTurn) {
      enemy.ai.forceRandom = true;
      enemy.ai.blocked = 0;
    }
  }
  function resolveTankOverlaps() {
    const all = G.players.concat(G.enemies).filter((t) => t && t.alive && t.model);
    for (let a = 0; a < all.length; a++) {
      for (let b = a + 1; b < all.length; b++) {
        const A = all[a];
        const B = all[b];
        const dx = B.x - A.x;
        const dz = B.z - A.z;
        const ox = CONFIG.tank.aabbHalf * 2 - Math.abs(dx);
        const oz = CONFIG.tank.aabbHalf * 2 - Math.abs(dz);
        if (ox <= 0 || oz <= 0) continue;
        if (ox < oz) {
          const push = ox / 2 + 0.001;
          const sign = dx >= 0 ? 1 : -1;
          tryPush(A, -sign * push, 0);
          tryPush(B, sign * push, 0);
        } else {
          const push = oz / 2 + 0.001;
          const sign = dz >= 0 ? 1 : -1;
          tryPush(A, 0, -sign * push);
          tryPush(B, 0, sign * push);
        }
      }
    }
  }

  function tryPush(tank, dx, dz) {
    const nx = tank.x + dx;
    const nz = tank.z + dz;
    if (!World.tankBlocked(nx, nz, CONFIG.tank.aabbHalf)) {
      tank.x = nx;
      tank.z = nz;
    }
  }

  // -------------------------------------------------------------------------
  // 玩家更新
  // -------------------------------------------------------------------------
  function updatePlayers(dt) {
    for (const p of G.players) {
      if (!p) continue;
      if (!p.alive) {
        p.respawnTimer -= dt;
        if (p.respawnTimer <= 0 && p.lives > 0) {
          respawnPlayer(p);
        }
        continue;
      }
      if (p.fireTimer > 0) p.fireTimer -= dt;
      if (p.shield > 0) {
        p.shield = Math.max(0, p.shield - dt);
      }
      if (p.spawning > 0) {
        p.spawning = Math.max(0, p.spawning - dt);
        if (p.spawning === 0) p.model.setOpacity(1);
      }
      const intent = Input.playerIntent(p.index);
      moveTank(p, dt, intent.moving, intent.dir);
      if (intent.fire) fire(p);
      syncTankVisual(p, dt);
    }
    updateShieldVisual(dt);
  }

  function syncTankVisual(tank, dt) {
    if (!tank.model) return;
    const targetYaw = DIRS[tank.dir].angle;
    tank.visualYaw = UTILS.angleLerp(tank.visualYaw, targetYaw, 1 - Math.exp(-CONFIG.tank.turnDamp * dt));
    tank.model.group.rotation.y = tank.visualYaw;
    tank.model.group.position.set(tank.x, 0, tank.z);
    const signedSpeed = tank.moving ? tank.vel : 0;
    tank.model.update(dt, { speed: signedSpeed, moving: tank.moving, frozen: !tank.isPlayer && G.effects.freeze > 0 });
    if (tank.isPlayer) {
      // 护盾泡泡
    }
    // 扬尘 / 冰屑
    if (tank.moving) {
      tank.dustTimer -= dt;
      if (tank.dustTimer <= 0) {
        tank.dustTimer = CONFIG.fx.dustInterval;
        const d = DIRS[tank.dir];
        const px = tank.x - d.x * 0.55;
        const pz = tank.z - d.z * 0.55;
        if (World.isIceAt(tank.x, tank.z)) {
          FX.iceTrail(new THREE.Vector3(px, 0.12, pz), d);
        } else if (!World.isWaterAt(tank.x, tank.z)) {
          const themeColor = G.theme === 2 ? 0xe8f4ff : 0xc9a86a;
          FX.dust(new THREE.Vector3(px, 0.1, pz), themeColor);
        }
      }
    }
    // 携带者红白闪烁
    if (tank.glow) {
      const phase = Math.floor(G.time * 4) % 2;
      tank.glow.material.color.setHex(phase === 0 ? 0xff4b3a : 0xfff3d6);
      tank.glow.material.opacity = 0.55 + Math.sin(G.time * 8) * 0.25;
    }
  }

  function updateShieldVisual(dt) {
    shieldMat.uniforms.uTime.value += dt;
    for (const p of G.players) {
      if (!p || !p.shieldMesh) continue;
      const active = p.shield > 0;
      p.shieldMesh.visible = active;
      if (active) {
        p.shieldMesh.rotation.y += dt * 1.6;
        const pulse = 1 + Math.sin(G.time * 5.5) * 0.04;
        p.shieldMesh.scale.set(1.15 * pulse, 0.75 * pulse, 1.15 * pulse);
        if (p.shield < 1.2) p.shieldMesh.visible = Math.floor(p.shield * 8) % 2 === 0;
      }
    }
    shieldMat.uniforms.uPulse.value = Math.max(0, shieldMat.uniforms.uPulse.value - dt);
  }

  // -------------------------------------------------------------------------
  // 敌方更新
  // -------------------------------------------------------------------------
  function updateEnemies(dt) {
    const frozen = G.effects.freeze > 0;
    for (const e of G.enemies) {
      if (!e.alive) continue;
      if (e.spawning > 0) {
        e.spawning = Math.max(0, e.spawning - dt);
        e.model.setOpacity(1 - e.spawning / e.spawnTotal);
        if (e.spawning === 0) e.model.setOpacity(1);
        syncTankVisual(e, dt);
        continue;
      }
      if (e.fireTimer > 0) e.fireTimer -= dt;
      if (frozen) {
        e.model.setFrozen(true);
        e.moving = false;
        e.vel = 0;
        syncTankVisual(e, dt);
        continue;
      }
      e.model.setFrozen(false);
      const decision = AI.update(e, dt);
      moveTank(e, dt, true, null);
      if (decision && decision.fire) fire(e);
      syncTankVisual(e, dt);
    }
  }

  // -------------------------------------------------------------------------
  // 子弹更新
  // -------------------------------------------------------------------------
  function updateBullets(dt) {
    for (let i = 0; i < G.bullets.length; i++) {
      const b = G.bullets[i];
      if (!b.alive) continue;
      b.life += dt;
      if (b.life > CONFIG.bullet.maxLife) { recycleBullet(b); continue; }
      const d = DIRS[b.dir];
      const oldX = b.x;
      const oldZ = b.z;
      const nx = b.x + d.x * b.speed * dt;
      const nz = b.z + d.z * b.speed * dt;

      // 子弹互消（玩家 ↔ 敌方）
      let cancelled = false;
      for (const other of G.bullets) {
        if (other === b || !other.alive || other.player === b.player) continue;
        if (Math.hypot(other.x - nx, other.z - nz) < 0.42) {
          recycleBullet(b);
          recycleBullet(other);
          FX.bulletCancel(new THREE.Vector3((b.x + other.x) / 2, b.y, (b.z + other.z) / 2));
          AudioSys.play('bulletCancel');
          cancelled = true;
          break;
        }
      }
      if (cancelled) continue;

      // 命中坦克
      const hitTank = findBulletTankHit(b, nx, nz);
      if (hitTank) {
        handleTankHit(b, hitTank);
        recycleBullet(b);
        continue;
      }

      // 入水 / 出水涟漪
      const inWater = World.isWaterAt(nx, nz);
      if (inWater !== b.overWater) {
        b.overWater = inWater;
        FX.waterRipple(new THREE.Vector3(nx, CONFIG.field.waterHeight, nz));
      }

      // 命中地形
      const hit = World.bulletHit(oldX, oldZ, nx, nz, CONFIG.bullet.radius);
      if (hit.hit) {
        const impact = new THREE.Vector3(hit.x, 0.6, hit.z);
        const dmg = World.damageAt(hit, b.dir, b.breakSteel);
        if (dmg.result === 'brick') {
          FX.impactBrick(impact, d);
          AudioSys.play('hitBrick');
          FX.shake(CONFIG.fx.shake.brick);
        } else if (dmg.result === 'steel') {
          FX.impactSteel(impact, d);
          AudioSys.play('hitSteel');
          FX.shake(CONFIG.fx.shake.steel);
        } else if (dmg.result === 'steelBreak') {
          FX.impactSteel(impact, d);
          AudioSys.play('explosionSmall');
          FX.shake(CONFIG.fx.shake.steel);
        } else if (dmg.result === 'eagle') {
          onBaseDestroyed();
        } else if (dmg.result === 'boundary') {
          FX.impactSteel(impact, d);
        }
        recycleBullet(b);
        continue;
      }

      b.x = nx;
      b.z = nz;
      b.slot.group.position.set(b.x, b.y, b.z);
    }
    // 清理回收的子弹
    for (let i = G.bullets.length - 1; i >= 0; i--) {
      if (!G.bullets[i].alive) G.bullets.splice(i, 1);
    }
  }

  function findBulletTankHit(bullet, nx, nz) {
    const targets = bullet.player ? G.enemies : G.players;
    for (const t of targets) {
      if (!t || !t.alive || !t.model) continue;
      if (t.spawning > 0) continue; // 出生保护
      if (Math.abs(t.x - nx) < CONFIG.tank.half && Math.abs(t.z - nz) < CONFIG.tank.half) return t;
    }
    return null;
  }

  function handleTankHit(bullet, tank) {
    const point = new THREE.Vector3(bullet.x, 0.55, bullet.z);
    if (tank.isPlayer) {
      if (tank.shield > 0) {
        shieldMat.uniforms.uPulse.value = 0.8;
        FX.shieldHit(point);
        AudioSys.play('shieldHit');
        if (tank.shieldMesh) {
          tank.shieldMesh.scale.set(1.5, 1.0, 1.5);
        }
        return;
      }
      if (tank.spawning > 0) return;
      killPlayer(tank);
      return;
    }
    // 敌方
    tank.hp -= 1;
    tank.model.flash();
    if (tank.maxHp > 1) tank.model.setArmorHealth(Math.max(0, tank.hp), tank.maxHp);
    if (tank.hp > 0) {
      AudioSys.play('hitSteel');
      FX.impactSteel(point, DIRS[bullet.dir]);
      FX.shake(CONFIG.fx.shake.steel);
      return;
    }
    killEnemy(tank, { score: CONFIG.enemy.score[tank.type] });
  }

  // -------------------------------------------------------------------------
  // 死亡 / 得分 / 道具
  // -------------------------------------------------------------------------
  function killEnemy(enemy, opts) {
    if (!enemy.alive) return;
    enemy.alive = false;
    const pos = new THREE.Vector3(enemy.x, 0.4, enemy.z);
    FX.tankDeath(pos, { player: false, color: CONFIG.enemy.color[enemy.type], turretType: enemy.type });
    AudioSys.play('explosionSmall');
    FX.shake(CONFIG.fx.shake.enemyDeath);
    if (enemy.carrier) spawnPowerup(UTILS.choice(CONFIG.powerup.kinds), enemy.x, enemy.z);
    detachModel(enemy);
    G.level.killed++;
    G.stats.kills[enemy.type] = (G.stats.kills[enemy.type] || 0) + 1;
    if (opts && opts.score) {
      addScore(opts.score);
      FX.scoreText(new THREE.Vector3(enemy.x, 1.2, enemy.z), opts.score);
      AudioSys.play('tick');
    }
    Game.onEnemyKilled(enemy);
  }

  function killPlayer(player) {
    if (!player.alive) return;
    player.alive = false;
    player.fireLevel = 0;
    player.vel = 0;
    player.moving = false;
    const pos = new THREE.Vector3(player.x, 0.4, player.z);
    FX.tankDeath(pos, { player: true, color: CONFIG.colors.playerBody, turretType: 'player' });
    AudioSys.play('explosionBig');
    FX.shake(CONFIG.fx.shake.playerDeath);
    FX.flashRed(0.45);
    Game.slowmo(CONFIG.flow.slowmo.playerDeath.scale, CONFIG.flow.slowmo.playerDeath.time);
    detachModel(player);
    player.lives -= 1;
    player.respawnTimer = CONFIG.player.respawnDelay;
    player.shield = 0;
    if (player.lives <= 0) {
      Game.onPlayerOut(player);
    }
  }

  function onBaseDestroyed() {
    if (!World.isBaseAlive()) return;
    AudioSys.play('explosionBig');
    Game.onBaseDestroyed();
  }

  function addScore(v) {
    if (typeof Game !== 'undefined' && Game.addScore) Game.addScore(v);
    else G.score += v;
  }

  // -------------------------------------------------------------------------
  // 道具
  // -------------------------------------------------------------------------
  function spawnPowerup(kind, x, z) {
    const model = Models.powerup(kind);
    model.position.set(x, CONFIG.powerup.floatY, z);
    model.scale.setScalar(CONFIG.powerup.scale || 1);
    scene.add(model);
    const pu = {
      kind, x, z, model,
      timer: CONFIG.powerup.life,
      total: CONFIG.powerup.life,
      spin: Math.random() * Math.PI * 2,
      alive: true,
    };
    G.powerups.push(pu);
    FX.powerupSpawn(new THREE.Vector3(x, 0, z));
    AudioSys.play('powerupSpawn');
    FX.light(new THREE.Vector3(x, 1.2, z), CONFIG.powerup.color[kind], 1.4, 1.2);
    return pu;
  }

  function updatePowerups(dt) {
    for (let i = G.powerups.length - 1; i >= 0; i--) {
      const pu = G.powerups[i];
      if (!pu.alive) continue;
      pu.timer -= dt;
      if (pu.timer <= 0) {
        scene.remove(pu.model);
        if (pu.model.dispose) pu.model.dispose();
        G.powerups.splice(i, 1);
        continue;
      }
      pu.spin += dt * CONFIG.powerup.spinSpeed;
      pu.model.rotation.y = pu.spin;
      pu.model.position.y = CONFIG.powerup.floatY + Math.sin(G.time * CONFIG.powerup.bobSpeed + pu.spin) * CONFIG.powerup.bobHeight;
      if (pu.timer < CONFIG.powerup.blinkTime) {
        pu.model.visible = Math.floor(pu.timer * 6) % 2 === 0;
      }
      for (const p of G.players) {
        if (!p || !p.alive || !p.model) continue;
        if (Math.abs(p.x - pu.x) < 1.15 && Math.abs(p.z - pu.z) < 1.15) {
          applyPowerup(p, pu);
          pu.alive = false;
          scene.remove(pu.model);
          if (pu.model.dispose) pu.model.dispose();
          G.powerups.splice(i, 1);
          break;
        }
      }
    }
  }

  function applyPowerup(player, pu) {
    const kind = pu.kind;
    AudioSys.play('powerupPick');
    FX.powerupPickup(new THREE.Vector3(pu.x, 0.9, pu.z));
    FX.scoreText(new THREE.Vector3(pu.x, 1.4, pu.z), CONFIG.powerup.pickupScore);
    addScore(CONFIG.powerup.pickupScore);
    if (kind === 'star') {
      player.fireLevel = Math.min(CONFIG.player.maxFireLevel, player.fireLevel + 1);
      if (player.model) player.model.setFireLevel(player.fireLevel);
    } else if (kind === 'helmet') {
      player.shield = CONFIG.powerup.shieldTime;
      player.shieldTotal = CONFIG.powerup.shieldTime;
    } else if (kind === 'tank') {
      player.lives += 1;
      AudioSys.play('lifeUp');
    } else if (kind === 'timer') {
      Game.startFreeze(CONFIG.powerup.freezeTime);
      AudioSys.play('freeze');
    } else if (kind === 'shovel') {
      Game.startShovel(CONFIG.powerup.shovelTime);
      AudioSys.play('shovel');
    } else if (kind === 'grenade') {
      detonateAll();
      AudioSys.play('grenade');
    }
    if (typeof UI !== 'undefined' && UI.setHUD) UI.setHUD(buildHudState());
  }

  const grenadeQueue = [];
  function detonateAll() {
    const targets = G.enemies.filter((e) => e.alive && e.spawning <= 0);
    if (targets.length >= 8) {
      targets.forEach((e, i) => grenadeQueue.push({ enemy: e, t: i * CONFIG.powerup.grenadeChain }));
    } else {
      for (const e of targets) killEnemy(e, { score: 0 });
    }
  }

  function updateGrenades(dt) {
    for (let i = grenadeQueue.length - 1; i >= 0; i--) {
      const q = grenadeQueue[i];
      q.t -= dt;
      if (q.t <= 0) {
        if (q.enemy.alive) killEnemy(q.enemy, { score: 0 });
        grenadeQueue.splice(i, 1);
      }
    }
  }

  function buildHudState() {
    return {
      score: G.score,
      hiScore: G.hiScore,
      lives: G.players[0] ? G.players[0].lives : 0,
      livesP2: G.players[1] ? G.players[1].lives : 0,
      stage: G.stage,
      fireLevel: G.players[0] ? G.players[0].fireLevel : 0,
      mode: G.mode,
    };
  }

  function update(dt) {
    updatePlayers(dt);
    updateEnemies(dt);
    resolveTankOverlaps();
    updateBullets(dt);
    updateGrenades(dt);
    updatePowerups(dt);
    // 清理已死亡敌人
    for (let i = G.enemies.length - 1; i >= 0; i--) {
      if (!G.enemies[i].alive) G.enemies.splice(i, 1);
    }
  }

    return {
    init, reset, update, spawnPlayer, respawnPlayer, spawnEnemy, fire,
    killEnemy, killPlayer, spawnPowerup, applyPowerup, detonateAll,
    buildHudState, positionOccupied,
    get activeBulletCount() { return G.bullets.filter((b) => b.alive).length; },
  };
})();
