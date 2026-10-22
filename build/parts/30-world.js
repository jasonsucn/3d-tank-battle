// ============================================================================
// 30-world.js — 场地地形、碰撞、砖/钢破坏、水/树/冰、鹰徽、铁锹（规格书 §2/§4/§5）
// 顶层只暴露 World。所有地形按 26×26 单位格维护，渲染用 InstancedMesh。
// ============================================================================
const World = (() => {
  const SIZE = 26;
  const CELLS = SIZE * SIZE;
  const HALF = 13;

  let scene = null;
  let root = null;
  let ground = null;
  let brickMesh = null;
  let steelMesh = null;
  let iceMesh = null;
  let treeTrunkMesh = null;
  let treeCrownMesh = null;
  let waterMesh = null;
  let waterUniforms = null;
  let eagleGroup = null;

  const tiles = new Uint8Array(CELLS);      // 原始地形
  const guardSet = new Set();               // 护卫墙单位格索引
  const base = { alive: true, x: 0, z: 12 };
  const shovel = { active: false, blink: false };

  const dummy = new THREE.Object3D();
  const tmpMat = new THREE.Matrix4();
  const tmpColor = new THREE.Color();
  const WATER_CAP = 676;
  const TREE_CAP = 169;
  const CROWN_PER_TREE = 3;

  let mapRows = null;
  let waterTime = 0;
  let guardBlockList = [];
  const guardBlocks = [
    { c: 5, r: 11 }, { c: 6, r: 11 }, { c: 7, r: 11 },
    { c: 5, r: 12 }, { c: 7, r: 12 },
  ];

  const idx = (i, j) => j * SIZE + i;
  const inBounds = (i, j) => i >= 0 && j >= 0 && i < SIZE && j < SIZE;

  function isGuardCell(i, j) {
    if (!inBounds(i, j)) return false;
    return guardSet.has(idx(i, j));
  }

  // 铁锹生效时，护卫墙的砖按钢处理（碰撞/子弹）；被 3 级火力打穿后变空
  function effectiveTile(i, j) {
    if (!inBounds(i, j)) return -1;
    const t = tiles[idx(i, j)];
    if (shovel.active && t === TILES.BRICK && guardSet.has(idx(i, j))) return TILES.STEEL;
    return t;
  }

  function cellCenterX(i) { return i - 12.5; }
  function cellCenterZ(j) { return j - 12.5; }

  // -------------------------------------------------------------------------
  // 初始化 / 场地
  // -------------------------------------------------------------------------
  function init(sceneRef) {
    scene = sceneRef;
    root = new THREE.Group();
    root.name = 'world';
    scene.add(root);

    const groundGeo = new THREE.PlaneGeometry(SIZE, SIZE, 1, 1);
    groundGeo.rotateX(-Math.PI / 2);
    ground = new THREE.Mesh(groundGeo, Mat.ground);
    ground.receiveShadow = true;
    ground.position.y = 0;
    root.add(ground);

    // 边界外的暗色底座，让场地边缘干净（不可见碰撞墙仍由碰撞函数保证）
    const skirtMat = new THREE.MeshStandardMaterial({ color: 0x0d0c0b, roughness: 1, metalness: 0 });
    const skirtGeo = new THREE.PlaneGeometry(120, 120);
    skirtGeo.rotateX(-Math.PI / 2);
    const skirt = new THREE.Mesh(skirtGeo, skirtMat);
    skirt.position.y = -0.06;
    skirt.receiveShadow = true;
    root.add(skirt);

    return World;
  }

  function parseRows(rows) {
    if (!Array.isArray(rows) || rows.length !== CONFIG.field.blocks) {
      throw new Error('地图行数不是 13');
    }
    tiles.fill(TILES.EMPTY);
    guardSet.clear();
    for (let r = 0; r < CONFIG.field.blocks; r++) {
      const line = rows[r];
      if (typeof line !== 'string' || line.length !== CONFIG.field.blocks) {
        throw new Error('地图第 ' + (r + 1) + ' 行长度不是 13');
      }
      for (let c = 0; c < CONFIG.field.blocks; c++) {
        const ch = line[c];
        const t = TILE_CHARS[ch];
        if (t === undefined) throw new Error('地图未知字符: ' + ch);
        for (let dj = 0; dj < 2; dj++) {
          for (let di = 0; di < 2; di++) {
            tiles[idx(c * 2 + di, r * 2 + dj)] = t;
          }
        }
      }
    }
    guardBlockList = guardBlocks;
    for (const b of guardBlockList) {
      for (let dj = 0; dj < 2; dj++) {
        for (let di = 0; di < 2; di++) {
          guardSet.add(idx(b.c * 2 + di, b.r * 2 + dj));
        }
      }
    }
  }

  function disposeMesh(mesh) {
    if (!mesh) return;
    if (mesh.parent) mesh.parent.remove(mesh);
    if (mesh.geometry) mesh.geometry.dispose();
    if (mesh.material && mesh.material !== Mat.ground && mesh.material.map && mesh.material.userData && mesh.material.userData.ownedMap) {
      mesh.material.map.dispose();
    }
  }

  function clearBuilt() {
    for (const m of [brickMesh, steelMesh, iceMesh, treeTrunkMesh, treeCrownMesh, waterMesh, eagleGroup]) {
      if (!m) continue;
      if (m.parent) m.parent.remove(m);
      if (m.geometry) m.geometry.dispose();
      if (m.isInstancedMesh && m.dispose) m.dispose();
    }
    brickMesh = steelMesh = iceMesh = waterMesh = null;
    treeTrunkMesh = treeCrownMesh = null;
    eagleGroup = null;
  }

  function load(rows, theme) {
    clearBuilt();
    mapRows = rows.slice();
    parseRows(rows);
    shovel.active = false;
    shovel.blink = false;
    base.alive = true;
    base.x = 0;
    base.z = 12;

    // ---- 实例化瓦片层（容量按整场 676）----
    const brickGeo = new THREE.BoxGeometry(1, CONFIG.field.brickHeight, 1);
    brickMesh = new THREE.InstancedMesh(brickGeo, Mat.brick, CELLS);
    brickMesh.castShadow = true;
    brickMesh.receiveShadow = true;
    brickMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    brickMesh.frustumCulled = false;

    const steelGeo = new THREE.BoxGeometry(1, CONFIG.field.steelHeight, 1);
    steelMesh = new THREE.InstancedMesh(steelGeo, Mat.steel, CELLS);
    steelMesh.castShadow = true;
    steelMesh.receiveShadow = true;
    steelMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    steelMesh.frustumCulled = false;

    const iceGeo = new THREE.PlaneGeometry(1, 1);
    iceGeo.rotateX(-Math.PI / 2);
    iceMesh = new THREE.InstancedMesh(iceGeo, Mat.ice, CELLS);
    iceMesh.receiveShadow = true;
    iceMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    iceMesh.frustumCulled = false;

    root.add(brickMesh, steelMesh, iceMesh);

    // ---- 树（按块，冠底 ≥1.6 遮挡坦克）----
    const trunkGeo = new THREE.BoxGeometry(0.24, 2.1, 0.24);
    trunkGeo.translate(0, 1.05, 0);
    treeTrunkMesh = new THREE.InstancedMesh(trunkGeo, Mat.treeTrunk, TREE_CAP);
    treeTrunkMesh.castShadow = true;
    treeTrunkMesh.receiveShadow = true;
    treeTrunkMesh.frustumCulled = false;

    const crownGeo = new THREE.ConeGeometry(1.32, 1.1, 7, 1);
    treeCrownMesh = new THREE.InstancedMesh(crownGeo, Mat.treeCrown, TREE_CAP * CROWN_PER_TREE);
    treeCrownMesh.castShadow = true;
    treeCrownMesh.receiveShadow = true;
    treeCrownMesh.frustumCulled = false;
    root.add(treeTrunkMesh, treeCrownMesh);

    buildWater();
    buildTrees();
    refreshTiles();
    buildEagle();

    // 主题：冰原关地面略提亮，夜战压低（材质共享，做一次颜色系数）
    if (Mat.ground) {
      const tint = theme === 2 ? 0xffffff : (theme === 3 ? 0x8a8a92 : 0xffffff);
      Mat.ground.color.set(tint);
    }

    return World;
  }

  function buildWater() {
    const SUB = 2; // 每个水格细分 2×2（0.5 单位），保证顶点正弦波有足够分辨率
    let cellCount = 0;
    for (let j = 0; j < SIZE; j++) {
      for (let i = 0; i < SIZE; i++) {
        if (tiles[idx(i, j)] === TILES.WATER) cellCount++;
      }
    }
    if (!cellCount) return;

    const quadCount = cellCount * SUB * SUB;
    const pos = new Float32Array(quadCount * 4 * 3);
    const uv = new Float32Array(quadCount * 4 * 2);
    const norm = new Float32Array(quadCount * 4 * 3);
    const indices = new Uint32Array(quadCount * 6);
    let vo = 0;
    let io = 0;
    let n = 0;
    const step = 1 / SUB;
    for (let j = 0; j < SIZE; j++) {
      for (let i = 0; i < SIZE; i++) {
        if (tiles[idx(i, j)] !== TILES.WATER) continue;
        const baseX = cellCenterX(i) - 0.5;
        const baseZ = cellCenterZ(j) - 0.5;
        for (let sy = 0; sy < SUB; sy++) {
          for (let sx = 0; sx < SUB; sx++) {
            const x0 = baseX + sx * step;
            const x1 = x0 + step;
            const z0 = baseZ + sy * step;
            const z1 = z0 + step;
            const b = n * 4;
            // 四个顶点（y=0，整体 mesh 抬高到水面高度）
            pos[vo++] = x0; pos[vo++] = 0; pos[vo++] = z0;
            pos[vo++] = x1; pos[vo++] = 0; pos[vo++] = z0;
            pos[vo++] = x1; pos[vo++] = 0; pos[vo++] = z1;
            pos[vo++] = x0; pos[vo++] = 0; pos[vo++] = z1;
            for (let k = 0; k < 4; k++) {
              const uBase = n * 8 + k * 2;
              const nBase = n * 12 + k * 3;
              uv[uBase] = k === 1 || k === 2 ? 1 : 0;
              uv[uBase + 1] = k >= 2 ? 1 : 0;
              norm[nBase] = 0;
              norm[nBase + 1] = 1;
              norm[nBase + 2] = 0;
            }
            indices[io++] = b; indices[io++] = b + 2; indices[io++] = b + 1;
            indices[io++] = b; indices[io++] = b + 3; indices[io++] = b + 2;
            n++;
          }
        }
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setAttribute('normal', new THREE.BufferAttribute(norm, 3));
    geo.setIndex(new THREE.BufferAttribute(indices, 1));
    geo.computeBoundingSphere();

    waterMesh = new THREE.Mesh(geo, Mat.water);
    waterMesh.position.y = CONFIG.field.waterHeight;
    waterMesh.receiveShadow = false;
    waterMesh.renderOrder = 2;
    root.add(waterMesh);
    waterUniforms = Mat.water.uniforms || null;
  }

  function buildTrees() {
    const trees = [];
    for (let r = 0; r < CONFIG.field.blocks; r++) {
      for (let c = 0; c < CONFIG.field.blocks; c++) {
        // 块内任一格是树即视为该块有树（地图以块为单位编写）
        let hasTree = false;
        for (let dj = 0; dj < 2 && !hasTree; dj++) {
          for (let di = 0; di < 2; di++) {
            if (tiles[idx(c * 2 + di, r * 2 + dj)] === TILES.TREE) { hasTree = true; break; }
          }
        }
        if (hasTree) trees.push({ x: (c - 6) * 2, z: (r - 6) * 2 });
      }
    }
    let trunkCount = 0;
    let crownCount = 0;
    const layers = [
      { y: 2.15, s: 1.0, c: 0x1f5c2e },
      { y: 2.75, s: 0.78, c: 0x2e7d3f },
      { y: 3.25, s: 0.52, c: 0x256a35 },
    ];
    for (const t of trees) {
      if (trunkCount >= TREE_CAP) break;
      dummy.position.set(t.x, 0, t.z);
      dummy.rotation.set(0, Math.random() * Math.PI, 0);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      treeTrunkMesh.setMatrixAt(trunkCount, dummy.matrix);
      trunkCount++;

      for (let li = 0; li < layers.length; li++) {
        if (crownCount >= TREE_CAP * CROWN_PER_TREE) break;
        const L = layers[li];
        dummy.position.set(t.x, L.y, t.z);
        dummy.rotation.set(0, (li * 1.7) + Math.random() * 0.6, 0);
        dummy.scale.set(L.s, 1, L.s);
        dummy.updateMatrix();
        treeCrownMesh.setMatrixAt(crownCount, dummy.matrix);
        tmpColor.setHex(L.c);
        tmpColor.offsetHSL((Math.random() - 0.5) * 0.03, 0, (Math.random() - 0.5) * 0.06);
        treeCrownMesh.setColorAt(crownCount, tmpColor);
        crownCount++;
      }
    }
    treeTrunkMesh.count = trunkCount;
    treeCrownMesh.count = crownCount;
    treeTrunkMesh.instanceMatrix.needsUpdate = true;
    treeCrownMesh.instanceMatrix.needsUpdate = true;
    if (treeCrownMesh.instanceColor) treeCrownMesh.instanceColor.needsUpdate = true;
  }

  function refreshTiles() {
    if (!brickMesh || !steelMesh || !iceMesh) return;
    let nb = 0;
    let ns = 0;
    let ni = 0;
    for (let j = 0; j < SIZE; j++) {
      for (let i = 0; i < SIZE; i++) {
        const t = tiles[idx(i, j)];
        if (t === TILES.BRICK) {
          // 铁锹生效时护卫墙视觉上呈现为钢（或闪烁到砖）
          const guard = guardSet.has(idx(i, j));
          if (shovel.active && guard && !shovel.blink) continue;
          dummy.position.set(cellCenterX(i), CONFIG.field.brickHeight / 2, cellCenterZ(j));
          dummy.rotation.set(0, 0, 0);
          dummy.scale.set(1, 1, 1);
          dummy.updateMatrix();
          if (nb < CELLS) brickMesh.setMatrixAt(nb++, dummy.matrix);
        } else if (t === TILES.STEEL) {
          dummy.position.set(cellCenterX(i), CONFIG.field.steelHeight / 2, cellCenterZ(j));
          dummy.rotation.set(0, 0, 0);
          dummy.scale.set(1, 1, 1);
          dummy.updateMatrix();
          if (ns < CELLS) steelMesh.setMatrixAt(ns++, dummy.matrix);
        } else if (t === TILES.ICE) {
          dummy.position.set(cellCenterX(i), CONFIG.field.iceHeight, cellCenterZ(j));
          dummy.rotation.set(0, 0, 0);
          dummy.scale.set(1, 1, 1);
          dummy.updateMatrix();
          if (ni < CELLS) iceMesh.setMatrixAt(ni++, dummy.matrix);
        }
      }
    }
    // 铁锹钢墙：护卫墙的砖在生效期额外作为钢实例
    if (shovel.active) {
      for (const gi of guardSet) {
        if (tiles[gi] !== TILES.BRICK) continue;
        if (shovel.blink) continue;
        const i = gi % SIZE;
        const j = Math.floor(gi / SIZE);
        dummy.position.set(cellCenterX(i), CONFIG.field.steelHeight / 2, cellCenterZ(j));
        dummy.rotation.set(0, 0, 0);
        dummy.scale.set(1, 1, 1);
        dummy.updateMatrix();
        if (ns < CELLS) steelMesh.setMatrixAt(ns++, dummy.matrix);
      }
    }
    brickMesh.count = nb;
    steelMesh.count = ns;
    iceMesh.count = ni;
    brickMesh.instanceMatrix.needsUpdate = true;
    steelMesh.instanceMatrix.needsUpdate = true;
    iceMesh.instanceMatrix.needsUpdate = true;
  }

  function buildEagle() {
    eagleGroup = Models.eagle();
    eagleGroup.position.set(base.x, 0, base.z);
    eagleGroup.rotation.y = 0; // 面向 +Z（玩家侧）
    root.add(eagleGroup);
  }

  // -------------------------------------------------------------------------
  // 碰撞查询
  // -------------------------------------------------------------------------
  function tankBlocked(x, z, half) {
    const h = half === undefined ? 0.95 : half;
    if (x - h < -HALF || x + h > HALF || z - h < -HALF || z + h > HALF) return true;
    const i0 = Math.floor(x - h + HALF);
    const i1 = Math.floor(x + h + HALF - 1e-6);
    const j0 = Math.floor(z - h + HALF);
    const j1 = Math.floor(z + h + HALF - 1e-6);
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const t = effectiveTile(i, j);
        if (SOLID_FOR_TANK[t]) return true;
      }
    }
    return false;
  }

  // 与其它坦克的 AABB 重叠（半边 0.95，规格书 §2）
  function tankOverlap(x, z, otherX, otherZ, half) {
    const h = half === undefined ? 0.95 : half;
    return Math.abs(x - otherX) < h * 2 && Math.abs(z - otherZ) < h * 2;
  }

  function tileAtWorld(x, z) {
    const i = Math.floor(x + HALF);
    const j = Math.floor(z + HALF);
    if (!inBounds(i, j)) return -1;
    return effectiveTile(i, j);
  }

  function isIceAt(x, z) {
    const i = Math.floor(x + HALF);
    const j = Math.floor(z + HALF);
    return inBounds(i, j) && tiles[idx(i, j)] === TILES.ICE;
  }

  function isWaterAt(x, z) {
    const i = Math.floor(x + HALF);
    const j = Math.floor(z + HALF);
    return inBounds(i, j) && tiles[idx(i, j)] === TILES.WATER;
  }

  // 子弹扫掠：从 (x0,z0) 到 (x1,z1)，返回最先命中的可阻挡格
  function bulletHit(x0, z0, x1, z1, radius) {
    const dx = x1 - x0;
    const dz = z1 - z0;
    const dist = Math.hypot(dx, dz);
    const steps = Math.max(1, Math.ceil(dist / 0.18));
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      const x = x0 + dx * t;
      const z = z0 + dz * t;
      if (x <= -HALF || x >= HALF || z <= -HALF || z >= HALF) {
        return { hit: true, kind: 'boundary', x, z };
      }
      const i = Math.floor(x + HALF);
      const j = Math.floor(z + HALF);
      const tile = effectiveTile(i, j);
      if (tile === TILES.BRICK || tile === TILES.STEEL || tile === TILES.EAGLE) {
        return { hit: true, kind: tile === TILES.BRICK ? 'brick' : (tile === TILES.STEEL ? 'steel' : 'eagle'), i, j, x, z, tile };
      }
    }
    return { hit: false };
  }

  // 命中后处理：返回被破坏的格中心数组；'bounce' 表示弹开
  function damageAt(hit, dir, breakSteel) {
    if (!hit || !hit.hit) return { result: 'none', cells: [] };
    if (hit.kind === 'boundary') return { result: 'boundary', cells: [] };
    if (hit.kind === 'eagle') {
      destroyEagle();
      return { result: 'eagle', cells: [] };
    }
    if (hit.kind === 'brick') {
      const cells = destroyArea(hit.i, hit.j, dir, false);
      refreshTiles();
      return { result: 'brick', cells };
    }
    if (hit.kind === 'steel') {
      if (!breakSteel) return { result: 'steel', cells: [] };
      const cells = destroyArea(hit.i, hit.j, dir, true);
      refreshTiles();
      return { result: 'steelBreak', cells };
    }
    return { result: 'none', cells: [] };
  }

  // 破坏 2×1 单位（垂直于弹道方向取 2 格宽）
  function destroyArea(i, j, dir, onlySteel) {
    const cells = [];
    const axis = DIRS[dir] ? DIRS[dir].axis : 'z';
    const targets = [];
    if (axis === 'z') {
      const c = Math.floor(i / 2);
      targets.push([c * 2, j], [c * 2 + 1, j]);
    } else {
      const r = Math.floor(j / 2);
      targets.push([i, r * 2], [i, r * 2 + 1]);
    }
    for (const [ti, tj] of targets) {
      if (!inBounds(ti, tj)) continue;
      const t = tiles[idx(ti, tj)];
      if (t === TILES.EMPTY) continue;
      if (onlySteel) {
        if (effectiveTile(ti, tj) !== TILES.STEEL) continue;
      } else if (t !== TILES.BRICK) {
        continue;
      }
      tiles[idx(ti, tj)] = TILES.EMPTY;
      cells.push({ x: cellCenterX(ti), z: cellCenterZ(tj), i: ti, j: tj });
    }
    return cells;
  }

  function destroyEagle() {
    if (!base.alive) return;
    base.alive = false;
    if (eagleGroup) {
      root.remove(eagleGroup);
      eagleGroup = null;
    }
    if (FX && FX.baseDestroyed) FX.baseDestroyed(new THREE.Vector3(base.x, 0.4, base.z));
  }

  // 扇形/直线遮挡：AI 判断射击视线（砖/钢/鹰挡住）
  function lineBlocked(x0, z0, x1, z1) {
    const dist = Math.hypot(x1 - x0, z1 - z0);
    const steps = Math.max(1, Math.ceil(dist / 0.25));
    for (let s = 1; s < steps; s++) {
      const t = s / steps;
      const tile = tileAtWorld(x0 + (x1 - x0) * t, z0 + (z1 - z0) * t);
      if (tile === TILES.BRICK || tile === TILES.STEEL || tile === TILES.EAGLE) return true;
    }
    return false;
  }

  // -------------------------------------------------------------------------
  // 铁锹（护卫墙变钢 15s；末 3s 2Hz 闪烁；到期复原含被毁部分）
  // -------------------------------------------------------------------------
  function setShovel(on) {
    if (on) {
      // 生效时补齐被毁的护卫砖
      for (const gi of guardSet) tiles[gi] = TILES.BRICK;
      shovel.active = true;
      shovel.blink = false;
    } else {
      for (const gi of guardSet) tiles[gi] = TILES.BRICK;
      shovel.active = false;
      shovel.blink = false;
    }
    refreshTiles();
  }

  function setShovelBlink(blink) {
    if (!shovel.active) return;
    if (shovel.blink === blink) return;
    shovel.blink = !!blink;
    refreshTiles();
  }

  function update(dt) {
    waterTime += dt;
    if (waterUniforms && waterUniforms.uTime) waterUniforms.uTime.value = waterTime;
  }

  function clear() {
    clearBuilt();
    tiles.fill(TILES.EMPTY);
    guardSet.clear();
    base.alive = true;
    shovel.active = false;
    shovel.blink = false;
  }

  function setVisible(v) {
    if (root) root.visible = !!v;
  }

  function getTiles() { return tiles; }
  function getRows() { return mapRows ? mapRows.slice() : null; }
  function isBaseAlive() { return base.alive; }
  function getBase() { return base; }
  function getGuardCells() { return Array.from(guardSet); }
  function worldToCell(x, z) {
    return { i: Math.floor(x + HALF), j: Math.floor(z + HALF) };
  }

  const World = {
    init, load, clear, update, setVisible,
    tankBlocked, tankOverlap, tileAtWorld, bulletHit, damageAt,
    isIceAt, isWaterAt, lineBlocked,
    setShovel, setShovelBlink,
    destroyEagle, isBaseAlive, getBase, getTiles, getRows, getGuardCells, worldToCell,
    guardBlocks, SIZE,
    get shovelActive() { return shovel.active; },
  };
  return World;
})();
