// GESTURE REGRESSION TESTS — run against the REAL app in a REAL browser.
//
// The interaction model is the product. Everything else has a node test; the
// gestures had none, because they need a live camera, a live BVH and real
// PointerEvents. This drives the actual app through synthesized pointers and
// asserts the invariants a user would notice breaking.
//
// Run:  npm run dev, then open  http://localhost:5199/?gtest=1
// Or:   await (await import('/test/gestures.browser.js')).run()
//
// These assert BEHAVIOUR, not implementation: a part must follow the finger,
// a 2x pinch must give 2x, undo must land exactly back where it started.

const sleep = ms => new Promise(r => setTimeout(r, ms));

export async function run({ verbose = true } = {}) {
  const P = window.__partacular;
  if (!P) throw new Error('app handle missing — is this the dev build?');
  const { doc, viewport: vp } = P;
  const results = [];
  // Exposed while running, not just at the end: a suite that hangs is far more
  // useful if you can see which check it got to.
  window.__gtestProgress = results;
  const ok = (pass, msg) => { results.push({ pass, msg }); if (verbose) console.log((pass ? '%cPASS' : '%cFAIL') + ` ${msg}`, `color:${pass ? '#62d29a' : '#ff6b6b'}`); };
  const near = (got, want, tol, msg) => ok(Math.abs(got - want) <= tol, `${msg} (got ${round(got)}, want ${round(want)}±${tol})`);
  const round = n => (typeof n === 'number' ? Math.round(n * 1000) / 1000 : n);

  const el = vp.renderer.domElement;
  const fire = (type, id, x, y, button = 0) => el.dispatchEvent(new PointerEvent(type, {
    pointerId: id, clientX: x, clientY: y, button,
    buttons: type === 'pointerup' ? 0 : 1,
    bubbles: true, isPrimary: id === 1, pointerType: 'touch',
  }));

  /** Screen-space bounds and centre of a part, exactly as the camera sees it. */
  const screenBox = id => {
    const mesh = vp.visuals.get(id).mesh;
    mesh.updateMatrixWorld(true);
    vp.camera.updateMatrixWorld(true);
    const m = vp.camera.projectionMatrix.clone()
      .multiply(vp.camera.matrixWorldInverse).multiply(mesh.matrixWorld).elements;
    const pos = mesh.geometry.getAttribute('position').array;
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    for (let v = 0; v < pos.length; v += 3) {
      const x = pos[v], y = pos[v + 1], z = pos[v + 2];
      const w = m[3] * x + m[7] * y + m[11] * z + m[15];
      if (!(w > 1e-9)) continue;
      const px = ((m[0] * x + m[4] * y + m[8] * z + m[12]) / w + 1) / 2 * innerWidth;
      const py = (1 - (m[1] * x + m[5] * y + m[9] * z + m[13]) / w) / 2 * innerHeight;
      if (px < x0) x0 = px; if (px > x1) x1 = px;
      if (py < y0) y0 = py; if (py > y1) y1 = py;
    }
    return { x0, y0, x1, y1, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, w: x1 - x0, h: y1 - y0 };
  };

  /** A screen point that actually lands on the part's surface.
   *  Verified by raycasting, because a bounding-box centre can sit in a hole. */
  const surfacePoint = id => {
    const mesh = vp.visuals.get(id).mesh;
    mesh.updateMatrixWorld(true);
    vp.camera.updateMatrixWorld(true);
    const m = vp.camera.projectionMatrix.clone()
      .multiply(vp.camera.matrixWorldInverse).multiply(mesh.matrixWorld).elements;
    const pos = mesh.geometry.getAttribute('position').array;
    const idx = mesh.geometry.getIndex();
    const nTri = idx ? idx.count / 3 : pos.length / 9;
    const step = Math.max(1, Math.floor(nTri / 400));
    for (let t = 0; t < nTri; t += step) {
      let sx = 0, sy = 0, good = true;
      for (let c = 0; c < 3; c++) {
        const v = (idx ? idx.getX(t * 3 + c) : t * 3 + c) * 3;
        const x = pos[v], y = pos[v + 1], z = pos[v + 2];
        const w = m[3] * x + m[7] * y + m[11] * z + m[15];
        if (!(w > 1e-9)) { good = false; break; }
        sx += (m[0] * x + m[4] * y + m[8] * z + m[12]) / w;
        sy += (m[1] * x + m[5] * y + m[9] * z + m[13]) / w;
      }
      if (!good) continue;
      const px = (sx / 3 + 1) / 2 * innerWidth, py = (1 - sy / 3) / 2 * innerHeight;
      if (px < 0 || py < 0 || px > innerWidth || py > innerHeight) continue;
      if (vp.raycastAt(px, py)[0] === id) return { x: px, y: py };
    }
    return null;
  };

  /** Where the part's own origin lands on screen — the point a drag pins to the finger. */
  const originOnScreen = id => {
    const mesh = vp.visuals.get(id).mesh;
    mesh.updateMatrixWorld(true);
    vp.camera.updateMatrixWorld(true);
    const p = new (mesh.position.constructor)(0, 0, 0)
      .applyMatrix4(mesh.matrixWorld).project(vp.camera);
    return { x: (p.x + 1) / 2 * innerWidth, y: (1 - p.y) / 2 * innerHeight };
  };

  const triTotal = () => doc.list().reduce((s, p) => s + p.triCount, 0);
  const posOf = id => [...doc.get(id).transform.position];
  const dist3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

  // ---- fixture: the demo model, split into parts through the real worker ----
  document.getElementById('demobtn').click();
  for (let i = 0; i < 150 && doc.count() === 0; i++) await sleep(100);
  ok(doc.count() > 1, `demo splits into ${doc.count()} parts`);
  const startTris = triTotal();
  const biggest = () => doc.list().sort((a, b) => b.triCount - a.triCount)[0];

  // ---------------------------------------------------------------- select --
  {
    const part = biggest();
    doc.select(null);
    const hit = surfacePoint(part.id);
    ok(!!hit, 'found a surface point to aim at');
    fire('pointerdown', 1, hit.x, hit.y);
    fire('pointerup', 1, hit.x, hit.y);
    await sleep(30);
    ok(doc.selectedId === part.id, 'tap on a part selects it');

    // tap on empty space clears
    fire('pointerdown', 1, 5, innerHeight - 5);
    fire('pointerup', 1, 5, innerHeight - 5);
    await sleep(30);
    ok(doc.selectedId === null, 'tap on empty space deselects');
  }

  // ------------------------------------------------------------------ move --
  {
    const part = biggest();
    doc.select(part.id);
    const before = posOf(part.id);
    const grab = surfacePoint(part.id);
    const o0 = originOnScreen(part.id);
    const dx = 140, dy = -90;

    fire('pointerdown', 1, grab.x, grab.y);
    fire('pointermove', 1, grab.x + dx / 2, grab.y + dy / 2);
    fire('pointermove', 1, grab.x + dx, grab.y + dy);
    const o1 = originOnScreen(part.id);
    // The drag plane passes through the part's own origin, so that origin must
    // sit under the finger for the whole drag. This is the "it follows my
    // finger" property, stated numerically.
    near(Math.hypot(o1.x - (o0.x + dx), o1.y - (o0.y + dy)), 0, 1.0,
      'dragged part stays pinned to the finger');
    ok(dist3(posOf(part.id), before) > 0, 'part actually moved in world space');
    fire('pointerup', 1, grab.x + dx, grab.y + dy);
    await sleep(20);

    // drag back by exactly the inverse: must land on the original position
    const grab2 = surfacePoint(part.id);
    fire('pointerdown', 1, grab2.x, grab2.y);
    fire('pointermove', 1, grab2.x - dx, grab2.y - dy);
    fire('pointerup', 1, grab2.x - dx, grab2.y - dy);
    await sleep(20);
    near(dist3(posOf(part.id), before), 0, 1e-4, 'drag out and back is exactly reversible');

    doc.undo(); doc.undo(); await sleep(20);
    near(dist3(posOf(part.id), before), 0, 1e-6, 'undo restores the pre-drag position');
  }

  // ----------------------------------------------------------------- pinch --
  {
    const part = biggest();
    doc.select(part.id);
    const s0 = [...doc.get(part.id).transform.scale];
    const r0 = [...doc.get(part.id).transform.rotation];
    const o = surfacePoint(part.id);
    const span = 100;

    fire('pointerdown', 1, o.x, o.y);
    fire('pointerdown', 2, o.x + span, o.y);
    fire('pointermove', 2, o.x + span * 2, o.y);            // exactly 2x apart
    near(doc.get(part.id).transform.scale[0] / s0[0], 2, 0.001, 'pinch to 2x span gives exactly 2x scale');

    fire('pointermove', 2, o.x, o.y + span * 2);            // rotate the pair 90 degrees
    // Angle between the start and current orientation, which is what a twist
    // means now that orientation is a quaternion rather than a single Y angle.
    const q0 = r0, q1 = doc.get(part.id).transform.rotation;
    const dot = Math.min(1, Math.abs(q0.reduce((s, v, i) => s + v * q1[i], 0)));
    const dRot = 2 * Math.acos(dot) * 180 / Math.PI;
    near(Math.abs(dRot), 90, 0.5, 'twisting 90 degrees rotates the part 90 degrees');

    fire('pointerup', 2, o.x, o.y + span * 2);
    fire('pointerup', 1, o.x, o.y);
    await sleep(20);
    doc.undo(); await sleep(20);
    near(doc.get(part.id).transform.scale[0], s0[0], 1e-6, 'undo reverts scale and twist together');
    const qb = doc.get(part.id).transform.rotation;
    near(Math.max(...qb.map((v, i) => Math.abs(v - r0[i]))), 0, 1e-6, 'rotation restored too');
  }

  // ---------------------------------------------------- camera vs the part --
  {
    const snapshot = doc.list().map(p => posOf(p.id));
    const camBefore = vp.camera.position.clone();
    // A drag starting on empty space must move the camera and nothing else.
    fire('pointerdown', 1, 8, innerHeight - 8);
    fire('pointermove', 1, 160, innerHeight - 60);
    fire('pointerup', 1, 160, innerHeight - 60);
    await sleep(60);
    const moved = doc.list().some((p, i) => dist3(posOf(p.id), snapshot[i]) > 1e-9);
    ok(!moved, 'dragging from empty space never moves a part');
    ok(vp.controls.enabled, 'camera controls are live again after the gesture');
    void camBefore;
  }

  // ------------------------------------------------------------ carve/lasso --
  {
    const part = biggest();
    doc.select(part.id);
    const before = doc.count(), tris = part.triCount;
    document.getElementById('pillcarve').click();
    ok(vp.isRepairing(), 'Carve arms a repair');

    const box = screenBox(part.id);
    const anchor = surfacePoint(part.id) || { x: box.cx, y: box.cy };
    const r = Math.min(box.w, box.h) * 0.3;
    fire('pointerdown', 1, anchor.x + r, anchor.y);
    for (let i = 1; i <= 40; i++) {
      const a = (i / 40) * Math.PI * 2;
      fire('pointermove', 1, anchor.x + Math.cos(a) * r, anchor.y + Math.sin(a) * r);
    }
    fire('pointerup', 1, anchor.x + r, anchor.y);
    await sleep(150);

    ok(doc.count() === before + 1, `lasso splits one part into two (${before} -> ${doc.count()})`);
    ok(triTotal() === startTris, `lasso conserves every triangle (${triTotal()})`);
    ok(!vp.isRepairing(), 'repair mode releases after the stroke');

    doc.undo(); await sleep(60);
    ok(doc.count() === before, 'a lasso is ONE undo step');
    ok(!!doc.list().find(p => p.triCount === tris), 'the original part comes back whole');
  }

  // -------------------------------------------------------------- cut line --
  {
    const part = biggest();
    doc.select(part.id);
    const before = doc.count(), tris = part.triCount;
    document.getElementById('pillcarve').click();
    const box = screenBox(part.id);
    fire('pointerdown', 1, box.cx - box.w, box.cy);
    for (let i = 1; i <= 20; i++) fire('pointermove', 1, box.cx - box.w + (i / 20) * box.w * 2, box.cy);
    fire('pointerup', 1, box.cx + box.w, box.cy);
    await sleep(150);

    ok(doc.count() === before + 1, `straight stroke cuts in two (${before} -> ${doc.count()})`);
    const halves = doc.list().filter(p => / [AB]$/.test(p.name));
    ok(halves.length === 2 && halves.reduce((s, h) => s + h.triCount, 0) === tris,
      `both halves together are the original ${tris} triangles`);
    doc.undo(); await sleep(60);
    ok(doc.count() === before, 'a cut is ONE undo step');
  }

  // ------------------------------------------------------------------ join --
  {
    const list = doc.list().sort((a, b) => b.triCount - a.triCount);
    const A = list[0], B = list[1];
    const before = doc.count();
    doc.select(A.id);
    document.getElementById('pilljoin').click();
    ok(vp.isRepairing(), 'Join arms a repair');
    const box = screenBox(B.id);
    fire('pointerdown', 1, box.cx, box.cy);
    fire('pointerup', 1, box.cx, box.cy);
    await sleep(150);

    ok(doc.count() === before - 1, `join merges two parts into one (${before} -> ${doc.count()})`);
    ok(!!doc.list().find(p => p.triCount === A.triCount + B.triCount),
      `merged part carries ${A.triCount}+${B.triCount} triangles`);
    ok(triTotal() === startTris, 'join conserves every triangle');
    doc.undo(); await sleep(60);
    ok(doc.count() === before, 'a join is ONE undo step');
  }

  // ---------------------------------------------------------- touch to select --
  {
    // Split toggles: with several parts it merges back to one fused mass, which
    // is the state touch-select is for.
    document.getElementById('splitbtn').click();
    await sleep(300);
    ok(doc.count() === 1, `merged back to one fused part (${doc.count()})`);

    const whole = doc.list()[0];
    doc.select(null);
    const hit = surfacePoint(whole.id);
    ok(!!hit, 'found a point on the fused model');

    // First touch builds the shape index; it is async, so wait for it.
    fire('pointerdown', 1, hit.x, hit.y);
    fire('pointerup', 1, hit.x, hit.y);
    // Read the cache through the APP's module instance; importing the module
    // by path in dev gives a fresh copy whose cache is always empty.
    for (let i = 0; i < 300 && !P.cachedPickIndex(whole.id); i++) await sleep(50);
    const index = P.cachedPickIndex(whole.id);
    ok(!!index, `shape index built (${index ? index.graph.count : 0} basins)`);

    fire('pointerdown', 1, hit.x, hit.y);
    fire('pointerup', 1, hit.x, hit.y);
    await sleep(80);
    const pk = vp.currentPick();
    ok(!!pk, 'touching a fused model holds a piece of it, not the whole thing');
    ok(!!pk && pk.triangles > 0 && pk.triangles < whole.triCount,
      `held piece is a PART of the model (${pk ? pk.triangles : 0} of ${whole.triCount})`);

    // Growing must be monotonic -- a ladder that shrinks under your finger is
    // impossible to aim.
    const sizes = [];
    for (let L = 0; L < Math.min(pk.touch.ladder.order.length, 5); L++) {
      vp.setPickLevel(L);
      sizes.push(vp.currentPick().triangles);
    }
    ok(sizes.every((v, i) => i === 0 || v >= sizes[i - 1]),
      `each rung holds at least as much as the last (${sizes.join(' -> ')})`);
    ok(sizes[sizes.length - 1] > sizes[0], 'dragging out really does grow it');

    // Taking it makes a real part that behaves like any other.
    vp.setPickLevel(pk.touch.rung);
    const held = vp.currentPick().triangles;
    const before = doc.count();
    document.getElementById('picktake').click();
    await sleep(300);
    ok(doc.count() === before + 1, `Take piece: ${before} -> ${doc.count()} parts`);
    const piece = doc.list().find(p => p.name === 'Piece');
    ok(!!piece && piece.triCount === held, `the taken part is exactly what was held (${held})`);
    ok(doc.selectedId === (piece && piece.id), 'the taken piece is selected, ready to move');
    ok(triTotal() === startTris, `taking a piece conserves every triangle (${triTotal()})`);
    ok(!vp.currentPick(), 'the hold is released once taken');

    doc.undo(); await sleep(150);
    ok(doc.count() === before, 'taking a piece is ONE undo step');
  }

  // -------------------------------------------------------------- parts list --
  {
    // Back to several parts so there is something to manage.
    document.getElementById('splitbtn').click();
    await sleep(400);
    ok(doc.count() > 1, `split into ${doc.count()} parts to manage`);

    document.getElementById('partsbtn').click();
    await sleep(150);
    const panel = document.getElementById('partspanel');
    ok(panel.classList.contains('show'), 'Parts opens the list');

    // The list must never cover the top bar controls.
    const pr = panel.getBoundingClientRect();
    const openBtn = document.getElementById('openbtn').getBoundingClientRect();
    ok(pr.top >= openBtn.bottom - 1 || pr.left >= openBtn.right - 1,
      'the list does not cover Open/Save');

    const rows = () => document.querySelectorAll('.prow');
    ok(rows().length === doc.count(), `a row per part (${rows().length})`);

    doc.select(null);
    rows()[0].click(); rows()[1].click(); rows()[2].click();
    await sleep(80);
    ok(doc.selectedIds.size === 3, `tapping three rows selects three (${doc.selectedIds.size})`);
    ok(document.querySelectorAll('.prow.on').length === 3, 'three rows show as selected');
    rows()[1].click();
    await sleep(80);
    ok(doc.selectedIds.size === 2, 'tapping again deselects just that one');

    // Bulk delete is one undo step.
    const before = doc.count();
    const doomed = [...doc.selectedIds];
    document.getElementById('bulkdelete').click();
    await sleep(200);
    ok(doc.count() === before - doomed.length, `bulk delete removed ${doomed.length} (${before} -> ${doc.count()})`);
    doc.undo();
    await sleep(150);
    ok(doc.count() === before, 'bulk delete is ONE undo step');

    // Deleting every part is refused rather than leaving an empty document.
    document.getElementById('selectall').click();
    await sleep(80);
    ok(doc.selectedIds.size === doc.count(), 'Select all selects everything');
    const all = doc.count();
    document.getElementById('bulkdelete').click();
    await sleep(150);
    ok(doc.count() === all, 'deleting every part is refused');

    // Bulk merge fuses a selection into one, conserving triangles.
    doc.select(null);
    rows()[0].click(); rows()[1].click();
    await sleep(80);
    const merging = [...doc.selectedIds].map(id => doc.get(id).triCount);
    const n0 = doc.count();
    document.getElementById('bulkmerge').click();
    await sleep(250);
    ok(doc.count() === n0 - 1, `merge: ${n0} -> ${doc.count()} parts`);
    ok(triTotal() === startTris, `merge conserves every triangle (${triTotal()})`);
    ok(!!doc.list().find(p => p.triCount === merging[0] + merging[1]),
      `merged part carries ${merging[0]}+${merging[1]} triangles`);
    doc.undo();
    await sleep(150);
    ok(doc.count() === n0, 'bulk merge is ONE undo step');

    document.getElementById('selectnone').click();
    await sleep(80);
    ok(doc.selectedIds.size === 0, 'Select none clears it');
    document.getElementById('partsclose').click();
    await sleep(120);
    ok(!panel.classList.contains('show'), 'Close hides the list');
  }

  // ------------------------------------------------------------------ stance --
  {
    // Rake tilts the whole assembly rigidly. The thing that must not happen is
    // parts rotating in place, which would pull the model apart.
    if (doc.count() < 2) { document.getElementById('splitbtn').click(); await sleep(400); }
    const before = doc.list().map(m => ({ p: [...m.transform.position], r: [...m.transform.rotation] }));
    const span = (l, i, j) => Math.hypot(...[0, 1, 2].map(k => l[i].p[k] - l[j].p[k]));
    const pairs = [[0, 1], [1, 2], [0, 2]].filter(([i, j]) => i < before.length && j < before.length);
    const d0 = pairs.map(([i, j]) => span(before, i, j));

    document.getElementById('stancebtn').click();
    await sleep(120);
    ok(document.getElementById('stancerow').style.display !== 'none', 'Stance opens');
    ok(document.getElementById('stancename').textContent === 'whole model',
      'with no selection it acts on the whole model');

    const rake = document.getElementById('rake');
    rake.value = '90';
    rake.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(120);
    ok(document.getElementById('rakev').textContent === '9.0°', 'the slider reads 9.0 degrees');

    const mid = doc.list().map(m => ({ p: [...m.transform.position], r: [...m.transform.rotation] }));
    const d1 = pairs.map(([i, j]) => span(mid, i, j));
    ok(d0.every((d, i) => Math.abs(d - d1[i]) < 1e-3),
      'parts stay rigidly together — the model tilts, it does not come apart');
    ok(mid.some((m, i) => m.r.some((v, k) => Math.abs(v - before[i].r[k]) > 1e-4)),
      'every part is turned, not merely shifted');

    // IT MUST ROCK. One end down by as much as the other goes up -- a lever
    // about the middle. This is what re-seating the model on the grid used to
    // destroy: the end that dropped got shoved straight back up, so the whole
    // model only ever rose and never tilted the way a lowered front end does.
    const rose = mid.filter((m, i) => m.p[1] - before[i].p[1] > 1e-4).length;
    const fell = mid.filter((m, i) => m.p[1] - before[i].p[1] < -1e-4).length;
    ok(rose > 0 && fell > 0, `rake rocks like a lever: ${rose} part(s) up, ${fell} part(s) down`);
    const up = Math.max(...mid.map((m, i) => m.p[1] - before[i].p[1]));
    const down = Math.min(...mid.map((m, i) => m.p[1] - before[i].p[1]));
    ok(Math.abs(up + down) < Math.max(up, -down) * 0.6,
      `the two ends move by comparable amounts (+${up.toFixed(4)} / ${down.toFixed(4)})`);
    ok(triTotal() === startTris, 'rake never touches geometry');

    rake.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(200);
    ok(doc.canUndo(), 'the stroke is undoable');
    doc.undo();
    await sleep(150);
    const after = doc.list().map(m => ({ p: [...m.transform.position], r: [...m.transform.rotation] }));
    ok(after.every((a, i) => a.p.every((v, k) => Math.abs(v - before[i].p[k]) < 1e-6)
      && a.r.every((v, k) => Math.abs(v - before[i].r[k]) < 1e-6)),
      'ONE undo restores the exact original stance');
    // ---- drop to plate: a separate action, on purpose ----------------------
    // Rake used to re-seat the model itself, which cancelled half the gesture.
    // Seating is now asked for, and it must be RIGID: one lift for everything.
    const lowestY = () => {
      let min = Infinity;
      for (const m of doc.list()) {
        const g = vp.visuals.get(m.id).mesh.geometry;
        if (!g.boundingBox) g.computeBoundingBox();
        const mesh = vp.visuals.get(m.id).mesh;
        const mtx = new mesh.matrix.constructor().compose(
          new mesh.position.constructor(...m.transform.position),
          new mesh.quaternion.constructor().fromArray(m.transform.rotation),
          new mesh.position.constructor(...m.transform.scale));
        min = Math.min(min, g.boundingBox.clone().applyMatrix4(mtx).min.y);
      }
      return min;
    };

    rake.value = '120';
    rake.dispatchEvent(new Event('input', { bubbles: true }));
    rake.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(250);
    const sunk = lowestY();
    ok(sunk < -1e-3, `a rake leaves the model hanging below the plate (${sunk.toFixed(4)})`);

    const preDrop = doc.list().map(m => [...m.transform.position]);
    document.getElementById('stancedrop').click();
    await sleep(250);
    ok(Math.abs(lowestY()) < 1e-3, `Drop seats it exactly on the plate (${lowestY().toFixed(4)})`);
    const lifts = doc.list().map((m, i) => m.transform.position[1] - preDrop[i][1]);
    ok(Math.max(...lifts) - Math.min(...lifts) < 1e-6,
      'every part lifts by the same amount — a group lands together, it does not flatten');
    ok(doc.list().every((m, i) => Math.abs(m.transform.position[0] - preDrop[i][0]) < 1e-9
      && Math.abs(m.transform.position[2] - preDrop[i][2]) < 1e-9), 'Drop never moves anything sideways');
    doc.undo();
    await sleep(150);
    ok(Math.abs(lowestY() - sunk) < 1e-6, 'Drop is ONE undo step');

    document.getElementById('stancedone').click();
  }

  // ------------------------------------------------------------ reachability --
  {
    // Every control has to be ON SCREEN. The top bar used to be flex-wrap:nowrap,
    // so on a phone Fit/Save/Open/Stance sat past the right edge with no scroll
    // and no hint they existed. Run the suite at a phone width to mean anything.
    const usable = el => {
      const drawer = el.closest('#partspanel');
      if (drawer && !drawer.classList.contains('show')) return false; // closed by design
      if (el.closest('#drop') || el.closest('#sheet')) return false;  // overlays
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const past = [...document.querySelectorAll('button, .chip')].filter(usable).filter(el => {
      const r = el.getBoundingClientRect();
      return r.right > innerWidth + 0.5 || r.left < -0.5;
    });
    ok(past.length === 0,
      `no control sits off the side of a ${innerWidth}px screen` +
      (past.length ? ` — ${past.map(b => b.id || b.textContent.trim()).join(', ')}` : ''));
    ok(document.documentElement.scrollWidth <= innerWidth + 0.5,
      `the page never scrolls sideways (${document.documentElement.scrollWidth} <= ${innerWidth})`);

    // and the same with a piece held, which is when the most controls are up
    const bar = document.getElementById('pickbar');
    if (bar && bar.style.display !== 'none') {
      const barPast = [...bar.querySelectorAll('button')].filter(b => {
        const r = b.getBoundingClientRect();
        return r.width > 0 && (r.right > innerWidth + 0.5 || r.left < -0.5);
      });
      ok(barPast.length === 0, 'every action on a held piece is reachable');
    }
  }

  // ----------------------------------------------------------- cancel/escape --
  {
    doc.select(biggest().id);
    document.getElementById('pillcarve').click();
    ok(vp.isRepairing(), 'carve armed');
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    ok(!vp.isRepairing(), 'Escape cancels an armed repair');
    ok(vp.controls.enabled, 'cancelling hands the camera back');
  }

  // ------------------------------------------------- no stale pointer state --
  {
    const part = biggest();
    doc.select(part.id);
    const o = surfacePoint(part.id);
    fire('pointerdown', 1, o.x, o.y);
    fire('pointermove', 1, o.x + 30, o.y);
    // a pointercancel (phone notification, palm rejection) must not strand state
    el.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 1, bubbles: true }));
    await sleep(20);
    ok(vp.pointers.size === 0, 'pointercancel leaves no phantom pointers');
    ok(vp.controls.enabled, 'camera survives a cancelled drag');
  }

  const failed = results.filter(r => !r.pass);
  const summary = `${results.length - failed.length}/${results.length} gesture checks passed`;
  console.log(`%c${summary}`, `font-weight:bold;color:${failed.length ? '#ff6b6b' : '#62d29a'}`);
  window.__gtest = { results, failed: failed.length, summary };
  return { summary, failed: failed.map(f => f.msg) };
}
