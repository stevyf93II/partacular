import * as THREE from 'three';
import { Document, PartMeta, PartTransform, identityTransform } from './core/document';
import { Viewport } from './viewport/viewport';
import { initUI } from './ui/ui';
import { parseFile, buildGroupGeometries, demoSoup, LoadedPart } from './geometry/loaders';
import { splitInWorker } from './geometry/splitClient';
import { repairFromStroke } from './geometry/repair';
import { cachedPickIndex, clearPickIndexes, forgetPickIndex, pickIndexFor } from './geometry/pickClient';
import { putGeometry, getGeometry, clearGeometries } from './geometry/store';
import { exportGLB, exportSTL, downloadBlob } from './geometry/exporters';
import { export3MFInWorker } from './geometry/printClient';
import { SEGMENTATION_CONFIG } from './geometry/segmentation.config.js';

export const PALETTE = [0x4da3ff, 0xffb347, 0x7ee081, 0xff7eb6, 0xb59bff, 0x6be2e0, 0xffd66b, 0xff8d6b, 0x9fd356, 0x62b6ff];

const doc = new Document();
const viewport = new Viewport(document.getElementById('app')!, doc);
// Debug/automation handle — lets tests drive the real app from the console.
// Exposed for the gesture suite. cachedPickIndex has to come from HERE rather
// than a fresh import: in dev, importing the module by path yields a separate
// instance with its own empty cache, so a test would never see the app's index.
(window as unknown as Record<string, unknown>).__partacular = { doc, viewport, cachedPickIndex };
let idSeq = 0;
const newId = () => `p${++idSeq}`;

const ui = initUI(doc, {
  onFile: f => loadFile(f).catch(err => ui.showToast(`Couldn't open that: ${err.message ?? err}`)),
  onDemo: () => loadDemo().catch(err => ui.showToast(String(err))),
  onRotate: () => viewport.rotateSelected45(),
  onDuplicate: () => duplicateSelected(),
  onRecolor: () => recolorSelected(),
  onExport: kind => doExport(kind).catch(err => ui.showToast(`Export failed: ${err.message ?? err}`)),
  onFit: () => viewport.fitCamera(),
  onTidy: () => tidy(),
  onBulkDelete: () => bulkDelete(),
  onBulkHide: () => bulkHide(),
  onBulkMerge: () => bulkMerge(),
  onSelectTiny: () => doc.selectMany(junkParts().map(m => m.id)),
  onRake: (deg, phase) => rake(deg, phase),
  onStanceTargets: () => (doc.selectedIds.size ? `${doc.selectedIds.size} selected part(s)` : 'whole model'),
  onDrop: () => dropToPlate(),
  onSplitToggle: () => splitOrMerge().catch(err => ui.showToast(String(err.message ?? err))),
  onCarve: () => startCarve(),
  onJoin: () => startJoin(),
  onPickTake: () => { takePickedPiece(); },
  onPickDelete: () => deletePickedPiece(),
  onPickColor: () => recolorPickedPiece(),
  onPickCancel: () => viewport.clearPick(),
  onPickStep: d => { const p = viewport.currentPick(); if (p) viewport.setPickLevel(p.level + d); },
});
let modelName = 'model';
let lastSplitUsed = false; // whether current parts came from the split pipeline

/** Self-describing artifacts: every export embeds the effective config that produced it. */
function provenance(): string {
  return JSON.stringify({
    app: 'partacular',
    segmentation: lastSplitUsed ? SEGMENTATION_CONFIG : null,
    exported: new Date().toISOString(),
  });
}

/** All visible parts baked into one world-space soup geometry. */
function bakeCurrentToSoup(): THREE.BufferGeometry | null {
  return bakeParts(doc.list().filter(m => m.visible));
}

/** Named parts baked into one world-space soup geometry.
 *  Uses DOCUMENT transforms only -- never the exploded display offset -- so
 *  joining two parts while the model is blown apart does not teleport them. */
function bakeParts(metas: PartMeta[]): THREE.BufferGeometry | null {
  if (metas.length === 0) return null;
  let total = 0;
  const baked: Float32Array[] = [];
  const q = new THREE.Quaternion(), yAxis = new THREE.Vector3(0, 1, 0), v = new THREE.Vector3();
  for (const meta of metas) {
    const geo = getGeometry(meta.id); if (!geo) continue;
    const t = meta.transform;
    const mtx = new THREE.Matrix4().compose(
      new THREE.Vector3(...t.position),
      q.fromArray(t.rotation),
      new THREE.Vector3(...t.scale),
    );
    const pos = geo.getAttribute('position') as THREE.BufferAttribute;
    const idx = geo.getIndex();
    const n = idx ? idx.count : pos.count;
    const out = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      v.fromBufferAttribute(pos, idx ? idx.getX(i) : i).applyMatrix4(mtx);
      out[i * 3] = v.x; out[i * 3 + 1] = v.y; out[i * 3 + 2] = v.z;
    }
    baked.push(out); total += out.length;
  }
  if (baked.length === 0) return null;
  const buf = new Float32Array(total);
  let off = 0; for (const b of baked) { buf.set(b, off); off += b.length; }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(buf, 3));
  return g;
}

/** Split (1 part -> components) or Merge (many parts -> 1). Models load whole; splitting is opt-in. */
async function splitOrMerge() {
  const soup = bakeCurrentToSoup();
  if (!soup) { ui.showToast('Nothing to split yet'); return; }
  if (doc.count() > 1) {
    installParts([{ name: modelName, geometry: soup }]);
    viewport.setPickEnabled(true);
    ui.showToast('Merged back to one piece — touch anywhere to pick a piece out');
  } else {
    ui.showToast('Splitting into parts…');
    await installSplit(soup, modelName);
    lastSplitUsed = true;
    viewport.setPickEnabled(false);
    const n = doc.count();
    ui.showToast(n > 1 ? `Split into ${n} parts` : 'This model is all one connected piece');
  }
}

/* -------------------------------------------------------------------- stance */

/**
 * Rake: tilt the model about its lateral axis so it sits nose-down or tail-up.
 *
 * This is a stance change, not a reshape. Every part keeps its geometry; the
 * whole assembly is rotated rigidly about one shared pivot, which is why each
 * part's POSITION is swung about that pivot as well as its own orientation
 * being turned. Rotating parts in place would pull the car apart.
 *
 * Absolute, not incremental: the slider always describes the angle away from
 * the stance the stroke started at, so dragging back to zero returns exactly
 * where it began instead of accumulating drift.
 */
const copyTransform = (t: PartTransform): PartTransform => ({
  position: [...t.position], rotation: [...t.rotation], scale: [...t.scale],
});

let rakeBaseline: Map<string, PartTransform> | null = null;
let rakeTargets: string[] = [];

function currentTargets(): string[] {
  return doc.selectedIds.size ? [...doc.selectedIds] : doc.list().map(m => m.id);
}

/** The horizontal axis to tilt ABOUT: across the model, not along it. */
function lateralAxis(ids: string[]): THREE.Vector3 {
  const box = new THREE.Box3();
  for (const id of ids) {
    const m = doc.get(id); const geo = getGeometry(id);
    if (!m || !geo) continue;
    if (!geo.boundingBox) geo.computeBoundingBox();
    const half = geo.boundingBox!.getSize(new THREE.Vector3())
      .multiply(new THREE.Vector3(...m.transform.scale)).multiplyScalar(0.5);
    const p = new THREE.Vector3(...m.transform.position);
    box.expandByPoint(p.clone().add(half));
    box.expandByPoint(p.clone().sub(half));
  }
  const size = box.getSize(new THREE.Vector3());
  // Longest horizontal extent is the length of the thing; tilt about the other.
  return size.x >= size.z ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0);
}

/**
 * The fulcrum: the true middle of the model, geometry included.
 *
 * Part ORIGINS alone are not the middle -- they cluster wherever the splitter
 * happened to centre each piece. Rocking about the real centre is what makes
 * one end drop by as much as the other rises.
 */
function rakePivot(ids: string[]): THREE.Vector3 {
  const box = new THREE.Box3();
  for (const id of ids) {
    const b = partWorldBox(id);
    if (b) box.union(b);
  }
  return box.isEmpty() ? new THREE.Vector3() : box.getCenter(new THREE.Vector3());
}

/** World-space bounds of a part, with its rotation actually accounted for. */
function partWorldBox(id: string): THREE.Box3 | null {
  const m = doc.get(id); const geo = getGeometry(id);
  if (!m || !geo) return null;
  if (!geo.boundingBox) geo.computeBoundingBox();
  const mtx = new THREE.Matrix4().compose(
    new THREE.Vector3(...m.transform.position),
    new THREE.Quaternion().fromArray(m.transform.rotation),
    new THREE.Vector3(...m.transform.scale),
  );
  return geo.boundingBox!.clone().applyMatrix4(mtx);
}

/**
 * Sit whatever is selected — or the whole model — back down on the grid.
 *
 * Deliberately a separate action rather than something rake does for you. Rake
 * used to re-seat the model automatically, and that quietly cancelled half the
 * gesture: the end that had just dropped got shoved straight back up, so the
 * model only ever rose. Tilting and seating are two different intentions, and
 * the second one has to be asked for.
 *
 * Every target moves by the SAME lift, so a group lands on the plate without
 * coming apart. Dropping each part to zero independently would flatten the
 * model into a pancake.
 */
function dropToPlate() {
  const ids = currentTargets();
  if (!ids.length) { ui.showToast('Nothing to drop'); return; }

  const box = new THREE.Box3();
  for (const id of ids) {
    const b = partWorldBox(id);
    if (b) box.union(b);
  }
  if (box.isEmpty()) return;

  const lift = -box.min.y;
  if (Math.abs(lift) < 1e-6) { ui.showToast('Already sitting on the plate'); return; }

  doc.beginBatch();
  for (const id of ids) {
    const m = doc.get(id); if (!m) continue;
    const p = m.transform.position;
    doc.beginTransform(id);
    doc.updateTransform(id, { position: [p[0], p[1] + lift, p[2]] });
    doc.endTransform();
  }
  doc.endBatch();
  viewport.refreshModelBounds();
  const what = doc.selectedIds.size ? `${ids.length} part${ids.length > 1 ? 's' : ''}` : 'model';
  ui.showToast(`Dropped the ${what} onto the plate${lift < 0 ? '' : ' (lifted up to it)'}`);
}

function rake(deg: number, phase: 'start' | 'move' | 'end') {
  if (phase === 'start') {
    rakeTargets = currentTargets();
    rakeBaseline = new Map();
    for (const id of rakeTargets) {
      const m = doc.get(id);
      if (m) rakeBaseline.set(id, copyTransform(m.transform));
    }
    return;
  }
  const baseline = rakeBaseline;
  if (!baseline) return;

  const apply = () => {
    const axis = lateralAxis(rakeTargets);
    const pivot = rakePivot(rakeTargets);
    const rot = new THREE.Quaternion().setFromAxisAngle(axis, (deg * Math.PI) / 180);
    for (const id of rakeTargets) {
      const b = baseline.get(id); if (!b) continue;
      const p = new THREE.Vector3(...b.position).sub(pivot).applyQuaternion(rot).add(pivot);
      const q = new THREE.Quaternion().fromArray(b.rotation).premultiply(rot);
      doc.updateTransform(id, {
        position: [p.x, p.y, p.z],
        rotation: q.toArray() as [number, number, number, number],
      });
    }
    // Deliberately NOT re-seated on the grid. Lifting the model so nothing sits
    // below zero undoes half the gesture: the end that just dropped gets pushed
    // straight back up, so the model only ever rises and never rocks. Rake is a
    // lever about the middle -- one end down, the other up by the same amount.
  };

  if (phase === 'move') { apply(); viewport.refreshModelBounds(); return; }

  // Commit. beginTransform/endTransform only ever track ONE part, so the stroke
  // is replayed part by part: settle on the final pose, remember it, rewind that
  // part to where the stroke began, then move it again with recording on. All of
  // it inside one batch, so the whole stance change is a single undo.
  apply();
  const finals = new Map<string, PartTransform>();
  for (const id of rakeTargets) {
    const m = doc.get(id);
    if (m) finals.set(id, copyTransform(m.transform));
  }
  doc.beginBatch();
  for (const id of rakeTargets) {
    const b = baseline.get(id); const f = finals.get(id);
    if (!b || !f) continue;
    doc.updateTransform(id, { position: [...b.position], rotation: [...b.rotation] });
    doc.beginTransform(id);
    doc.updateTransform(id, { position: [...f.position], rotation: [...f.rotation] });
    doc.endTransform();
  }
  doc.endBatch();
  rakeBaseline = null;
  viewport.refreshModelBounds();
  if (deg !== 0) ui.showToast(`Raked ${deg.toFixed(1)}° — Undo puts it back`);
}

/* -------------------------------------------------------------- bulk actions */

/** Delete everything selected, as ONE undoable action. */
function bulkDelete() {
  const ids = [...doc.selectedIds];
  if (!ids.length) return;
  if (ids.length >= doc.count()) {
    ui.showToast('That is every part — keep at least one');
    return;
  }
  const tris = ids.reduce((s, id) => s + (doc.get(id)?.triCount ?? 0), 0);
  doc.beginBatch();
  for (const id of ids) doc.deletePart(id);
  doc.endBatch();
  viewport.refreshModelBounds();
  refreshTidy();
  ui.showToast(`Deleted ${ids.length} part${ids.length > 1 ? 's' : ''} (${tris.toLocaleString()} triangles) — Undo brings them back`);
}

/** Hide everything selected, as ONE undoable action. */
function bulkHide() {
  const ids = [...doc.selectedIds];
  if (!ids.length) return;
  doc.beginBatch();
  for (const id of ids) doc.setVisible(id, false);
  doc.endBatch();
  ui.showToast(`Hid ${ids.length} part${ids.length > 1 ? 's' : ''}`);
}

/** Fuse everything selected into one part, as ONE undoable action. */
function bulkMerge() {
  const ids = [...doc.selectedIds];
  if (ids.length < 2) return;
  const metas = ids.map(id => doc.get(id)).filter(Boolean) as PartMeta[];
  const soup = bakeParts(metas);
  if (!soup) return;
  soup.computeBoundingBox();
  const c = soup.boundingBox!.getCenter(new THREE.Vector3());
  soup.translate(-c.x, -c.y, -c.z);
  soup.computeBoundingBox();
  soup.computeVertexNormals();
  const nid = newId();
  putGeometry(nid, soup);
  const t = identityTransform();
  t.position = [c.x, c.y, c.z];
  const keepName = metas.reduce((a, b) => (b.triCount > a.triCount ? b : a)).name;
  doc.beginBatch();
  for (const id of ids) doc.deletePart(id);
  doc.addParts([{
    id: nid, name: keepName, triCount: soup.getAttribute('position').count / 3,
    visible: true, color: metas[0].color, transform: t,
  }], true);
  doc.endBatch();
  doc.select(nid);
  viewport.refreshModelBounds();
  refreshTidy();
  ui.showToast(`Merged ${ids.length} parts into one`);
}

/* ------------------------------------------------------------------- tidy up */

/**
 * A part small enough that it is scenery, not something anyone will point at.
 *
 * Judged on physical size relative to the whole model rather than on triangle
 * count: a speck can be dense and a flat panel can be coarse. Kept generous on
 * purpose -- Tidy is one button and one undo, so it is better to leave a
 * borderline part alone than to eat something real.
 */
const TIDY_FRACTION = 0.02;

function junkParts(): PartMeta[] {
  const metas = doc.list();
  if (metas.length < 2) return [];
  const box = new THREE.Box3();
  const spans = new Map<string, number>();
  let modelSpan = 0;
  const whole = new THREE.Box3();
  for (const m of metas) {
    const geo = getGeometry(m.id);
    if (!geo) continue;
    if (!geo.boundingBox) geo.computeBoundingBox();
    const size = geo.boundingBox!.getSize(new THREE.Vector3())
      .multiply(new THREE.Vector3(...m.transform.scale));
    spans.set(m.id, size.length());
    const p = new THREE.Vector3(...m.transform.position);
    whole.expandByPoint(p.clone().add(size.clone().multiplyScalar(0.5)));
    whole.expandByPoint(p.clone().sub(size.clone().multiplyScalar(0.5)));
  }
  modelSpan = whole.getSize(new THREE.Vector3()).length() || 1;
  void box;
  const cutoff = modelSpan * TIDY_FRACTION;
  // Never offer to delete everything: the biggest part is always safe.
  const biggest = metas.reduce((a, b) => (b.triCount > a.triCount ? b : a));
  return metas.filter(m => m !== biggest && (spans.get(m.id) ?? Infinity) < cutoff);
}

function refreshTidy() {
  const btn = document.getElementById('tidybtn') as HTMLButtonElement;
  const junk = junkParts();
  btn.style.display = junk.length ? 'inline-block' : 'none';
  btn.textContent = junk.length ? `Tidy (${junk.length})` : 'Tidy';
}

/** Delete every part too small to matter, as ONE undoable action. */
function tidy() {
  const junk = junkParts();
  if (!junk.length) { ui.showToast('Nothing to tidy'); return; }
  const tris = junk.reduce((s, m) => s + m.triCount, 0);
  doc.beginBatch();
  for (const m of junk) doc.deletePart(m.id);
  doc.endBatch();
  refreshTidy();
  viewport.refreshModelBounds();
  ui.showToast(`Removed ${junk.length} tiny part${junk.length > 1 ? 's' : ''} (${tris.toLocaleString()} triangles) — Undo brings them back`);
}

doc.on(e => {
  if (e.type === 'parts-added' || e.type === 'part-removed' || e.type === 'reset') refreshTidy();
});

/* ---------------------------------------------------------- touch to select */

const pickbar = document.getElementById('pickbar')!;
const pickinfo = document.getElementById('pickinfo')!;

viewport.onPick = state => {
  if (!state) { pickbar.style.display = 'none'; return; }
  pickbar.style.display = 'flex';
  const levels = state.touch.ladder.order.length - 1;
  pickinfo.textContent =
    `${state.triangles.toLocaleString()} triangles  ·  ${state.level}/${levels}`;
  (document.getElementById('pickmore') as HTMLButtonElement).disabled = state.level >= levels;
  (document.getElementById('pickless') as HTMLButtonElement).disabled = state.level <= 0;
};

// The shape analysis behind touch-select runs once per part and is slow on a
// big model, so say what is happening rather than appearing to ignore the tap.
viewport.onPickPending = (_partId, ready) => {
  if (!ready) ui.showToast('Reading the shape — one moment, then touch again');
  else ui.showToast('Ready — touch any part of the model');
};

// Grabbing the lit piece and dragging pulls it out in the same motion.
viewport.onExtractRequest = () => takePickedPiece(true);

/** Cut the held selection out of the model entirely. */
function deletePickedPiece() {
  const id = takePickedPiece(true);
  if (!id) return;
  const m = doc.get(id);
  const tris = m ? m.triCount : 0;
  // Extraction and removal read as one action, so they undo as one.
  doc.beginBatch();
  doc.deletePart(id);
  doc.endBatch();
  viewport.refreshModelBounds();
  ui.showToast(`Deleted that piece (${tris.toLocaleString()} triangles) — Undo brings it back`);
}

/** Take the held selection out and give it the next colour. */
function recolorPickedPiece() {
  const id = takePickedPiece(true);
  if (!id) return;
  const m = doc.get(id);
  if (!m) return;
  doc.setColor(id, PALETTE[(PALETTE.indexOf(m.color) + 1) % PALETTE.length]);
}

/** Turn the held selection into its own part, ready to move. */
function takePickedPiece(quiet = false): string | null {
  const pk = viewport.currentPick();
  const mask = viewport.pickMask();
  if (!pk || !mask) return null;
  const src = doc.get(pk.partId);
  const geo = getGeometry(pk.partId);
  if (!src || !geo) return null;

  // maskToPartition speaks the same { triGroup, groupCount } language the split
  // pipeline does, so the piece is extracted by exactly the path a Carve uses.
  const triGroup = new Uint32Array(mask.length);
  let held = 0;
  for (let t = 0; t < mask.length; t++) { triGroup[t] = mask[t] ? 1 : 0; held += mask[t]; }
  if (held === 0 || held === mask.length) {
    if (!quiet) ui.showToast('That is the whole part — nothing to take out of it');
    return null;
  }
  viewport.clearPick();
  forgetPickIndex(pk.partId); // the geometry is about to change under it
  applyPartition(pk.partId, triGroup, 2, [`${src.name} rest`, 'Piece']);
  // applyPartition selects the first meta; the piece is the interesting one.
  const piece = doc.list().find(m => m.name === 'Piece');
  if (piece) doc.select(piece.id);
  if (!quiet) ui.showToast('Taken — drag it, pinch to resize, twist to turn');
  return piece ? piece.id : null;
}

/** Replace one part with the pieces a repair produced. One undo step. */
function applyPartition(id: string, triGroup: Uint32Array, groupCount: number, names: string[]) {
  const src = doc.get(id); const geo = getGeometry(id);
  if (!src || !geo) return 0;
  const pieces = buildGroupGeometries(geo, triGroup, groupCount);
  const q = new THREE.Quaternion().fromArray(src.transform.rotation);
  const scale = new THREE.Vector3(...src.transform.scale);
  const metas: PartMeta[] = [];

  doc.beginBatch();
  doc.deletePart(id);
  pieces.forEach((g, i) => {
    if (g.getAttribute('position').count === 0) { g.dispose(); return; }
    // Re-pivot each piece on its own centre, then carry that centre out through
    // the parent's own rotation and scale so the piece does not visibly shift
    // at the moment it becomes a separate part.
    g.computeBoundingBox();
    const c = g.boundingBox!.getCenter(new THREE.Vector3());
    g.translate(-c.x, -c.y, -c.z);
    g.computeBoundingBox();
    const nid = newId();
    putGeometry(nid, g);
    const offset = c.clone().multiply(scale).applyQuaternion(q);
    const t = identityTransform();
    t.position = [
      src.transform.position[0] + offset.x,
      src.transform.position[1] + offset.y,
      src.transform.position[2] + offset.z,
    ];
    t.rotation = [...src.transform.rotation];
    t.scale = [...src.transform.scale];
    metas.push({
      id: nid, name: names[i] ?? `${src.name} ${i + 1}`,
      triCount: g.getAttribute('position').count / 3,
      visible: true, color: PALETTE[(doc.count() + i) % PALETTE.length], transform: t,
    });
  });
  doc.addParts(metas, true);
  doc.endBatch();
  doc.select(metas[0]?.id ?? null);
  viewport.refreshModelBounds();
  return metas.length;
}

/** Draw a loop to lift a region out, or a line to cut straight across. */
function startCarve() {
  const sel = doc.selectedId;
  if (!sel) { ui.showToast('Pick a part first, then Carve'); return; }
  ui.showToast('Draw around a piece to lift it out — or a line straight across to cut');
  viewport.beginLasso((stroke, mvp) => {
    const geo = getGeometry(sel);
    const src = doc.get(sel);
    if (!geo || !src) return;
    const pos = geo.getAttribute('position').array as Float32Array;
    const idx = geo.getIndex();
    const index = idx ? new Uint32Array(idx.array as ArrayLike<number>) : null;
    const res = repairFromStroke(pos, index, mvp, stroke);
    if (!res) { ui.showToast('That did not separate anything — try drawing right around the piece'); return; }
    const names = res.intent === 'lasso'
      ? [src.name, `${src.name} piece`]
      : [`${src.name} A`, `${src.name} B`];
    applyPartition(sel, res.triGroup, res.groupCount, names);
    ui.showToast(res.intent === 'lasso' ? 'Lifted that piece out' : 'Cut in two');
  });
}

/** Merge the selection with whichever part the user taps next. */
function startJoin() {
  const sel = doc.selectedId;
  if (!sel) { ui.showToast('Pick a part first, then Join'); return; }
  ui.showToast('Now tap the part to join it to');
  viewport.beginMerge(otherId => {
    const a = doc.get(sel), b = doc.get(otherId);
    if (!a || !b) return;
    const soup = bakeParts([a, b]);
    if (!soup) return;
    soup.computeBoundingBox();
    const c = soup.boundingBox!.getCenter(new THREE.Vector3());
    soup.translate(-c.x, -c.y, -c.z);
    soup.computeBoundingBox();
    soup.computeVertexNormals();
    const nid = newId();
    putGeometry(nid, soup);
    const t = identityTransform();
    t.position = [c.x, c.y, c.z];
    doc.beginBatch();
    doc.deletePart(sel);
    doc.deletePart(otherId);
    doc.addParts([{
      id: nid, name: a.name, triCount: soup.getAttribute('position').count / 3,
      visible: true, color: a.color, transform: t,
    }], true);
    doc.endBatch();
    doc.select(nid);
    viewport.refreshModelBounds();
    ui.showToast(`Joined ${a.name} and ${b.name}`);
  });
}

// Escape always backs out of an armed repair.
window.addEventListener('keydown', (e: KeyboardEvent) => {
  if (e.key === 'Escape' && viewport.isRepairing()) {
    viewport.cancelRepair();
    ui.showToast('Cancelled');
  }
});

function duplicateSelected() {
  const sel = doc.selectedId; if (!sel) return;
  const src = doc.get(sel); const geo = getGeometry(sel);
  if (!src || !geo) return;
  const id = newId();
  putGeometry(id, geo); // geometry is shared between copies
  const t = identityTransform();
  const offset = Math.max(0.15 * Math.cbrt(src.triCount), 0.2) * Math.max(...src.transform.scale);
  t.position = [src.transform.position[0] + offset, src.transform.position[1], src.transform.position[2] + offset];
  t.rotation = [...src.transform.rotation]; t.scale = [...src.transform.scale];
  doc.addParts([{ id, name: `${src.name} copy`, triCount: src.triCount, visible: true, color: src.color, transform: t }], true);
  doc.select(id);
}

function recolorSelected() {
  const sel = doc.selectedId; if (!sel) return;
  const m = doc.get(sel); if (!m) return;
  const i = PALETTE.indexOf(m.color);
  doc.setColor(sel, PALETTE[(i + 1) % PALETTE.length]);
}

async function doExport(kind: 'glb' | 'stl' | '3mf') {
  if (doc.count() === 0) { ui.showToast('Nothing to save yet'); return; }
  if (kind === '3mf') {
    ui.showToast('Merging parts to a watertight solid…');
    const res = await export3MFInWorker(doc, provenance());
    downloadBlob(res.blob, 'partacular.3mf');
    ui.showToast(res.failedNames.length === 0
      ? `Saved partacular.3mf — watertight, ${res.tris} triangles`
      : `Saved — ${res.failedNames.length} part(s) couldn't be sealed; your slicer may repair them`);
    return;
  }
  ui.showToast(`Building ${kind.toUpperCase()}…`);
  const blob = kind === 'glb' ? await exportGLB(doc, provenance()) : exportSTL(doc, provenance());
  downloadBlob(blob, `partacular.${kind}`);
  ui.showToast(`Saved partacular.${kind}`);
}

async function loadFile(file: File) {
  ui.showToast(`Opening ${file.name}…`);
  const { parts } = await parseFile(file);
  if (parts.length === 0) throw new Error('no meshes found in file');
  modelName = file.name.replace(/\.[^.]+$/, '') || 'model';
  // Real files ALWAYS load as one piece — splitting is the user's call (Split button).
  if (parts.length === 1) {
    parts[0].name = modelName;
    installParts(parts);
    return;
  }
  const v = new THREE.Vector3();
  let total = 0;
  for (const p of parts) {
    const idx = p.geometry.getIndex();
    total += idx ? idx.count : p.geometry.getAttribute('position').count;
  }
  const buf = new Float32Array(total * 3);
  let off = 0;
  for (const p of parts) {
    const pos = p.geometry.getAttribute('position') as THREE.BufferAttribute;
    const idx = p.geometry.getIndex();
    const n = idx ? idx.count : pos.count;
    for (let i = 0; i < n; i++) {
      v.fromBufferAttribute(pos, idx ? idx.getX(i) : i);
      buf[off++] = v.x; buf[off++] = v.y; buf[off++] = v.z;
    }
    p.geometry.dispose();
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(buf, 3));
  ui.showToast('Preparing model…');
  await new Promise(r => setTimeout(r, 30)); // let the toast paint before the BVH build blocks
  installParts([{ name: modelName, geometry: g }]);
}

async function loadDemo() {
  ui.showToast('Building demo…');
  modelName = 'demo';
  await installSplit(demoSoup(), 'demo');
}

/** Single fused geometry → worker split → parts. */
async function installSplit(geometry: THREE.BufferGeometry, baseName: string) {
  const res = await splitInWorker(geometry);
  const geos = buildGroupGeometries(geometry, res.triGroup, res.groupCount);
  geometry.dispose();
  const loaded: LoadedPart[] = geos.map((g, i) => ({
    // The debris bucket is named for what it is and for how much it swept up,
    // so clearing a hundred specks is one Delete rather than a hundred.
    name: res.debrisGroup === i
      ? `Loose bits (${res.debrisPieces} pieces)`
      : (res.groupCount > 1 ? `${baseName} ${i + 1}` : baseName),
    geometry: g,
  }));
  installParts(loaded);
}

function installParts(parts: { name: string; geometry: THREE.BufferGeometry }[]) {
  doc.reset(); clearGeometries(); clearPickIndexes();
  const metas: PartMeta[] = [];
  for (const p of parts) {
    const id = newId();
    p.geometry.computeBoundingBox();
    // Re-pivot: move geometry so its bounding-box center sits at the local origin,
    // and carry that center in the document transform. Scale/rotate then act about
    // the part's own middle instead of the world origin.
    const c = p.geometry.boundingBox!.getCenter(new THREE.Vector3());
    p.geometry.translate(-c.x, -c.y, -c.z);
    p.geometry.computeBoundingBox();
    if (!p.geometry.getAttribute('normal')) p.geometry.computeVertexNormals();
    putGeometry(id, p.geometry);
    const posCount = p.geometry.getAttribute('position').count;
    const triCount = p.geometry.getIndex() ? p.geometry.getIndex()!.count / 3 : posCount / 3;
    const t = identityTransform();
    t.position = [c.x, c.y, c.z];
    metas.push({ id, name: p.name, triCount, visible: true, color: PALETTE[metas.length % PALETTE.length], transform: t });
  }
  // Ground the model: rest its lowest point on the grid (y = 0).
  let minY = Infinity;
  for (let i = 0; i < parts.length; i++) {
    const bb = parts[i].geometry.boundingBox!;
    minY = Math.min(minY, metas[i].transform.position[1] + bb.min.y);
  }
  if (Number.isFinite(minY) && minY !== 0) for (const m of metas) m.transform.position[1] -= minY;
  doc.addParts(metas);
  viewport.fitCamera();
  const pickable = doc.count() === 1;
  viewport.setPickEnabled(pickable);

  // Warm the touch-select index now rather than on the first tap. The analysis
  // takes ~17s on a two-million-triangle model, and a tap that appears to do
  // nothing for that long reads as broken. Starting at load hides it behind the
  // time it takes someone to orient the camera; it runs in a worker either way.
  if (pickable) {
    const only = doc.list()[0];
    const geo = getGeometry(only.id);
    if (geo && only.triCount > 50_000) {
      ui.showToast(`Reading the shape of ${only.name} — look around meanwhile`);
      pickIndexFor(only.id, geo)
        .then(() => ui.showToast('Ready — touch any part to lift it out'))
        .catch(err => console.error('pick index failed', err));
    } else if (geo) {
      pickIndexFor(only.id, geo).catch(err => console.error('pick index failed', err));
    }
  }
}

// Gesture regression tests, dev only: http://localhost:5199/?gtest=1
// The computed path keeps the suite out of the production bundle.
if (import.meta.env.DEV && new URLSearchParams(location.search).has('gtest')) {
  const suite = '/test/gestures.browser.js';
  import(/* @vite-ignore */ suite)
    .then(m => m.run())
    .catch(err => console.error('gesture tests failed to load', err));
}

// PWA: service worker (network-first in sw.js, so fresh deploys always win when online).
if ('serviceWorker' in navigator && location.hostname !== 'localhost') {
  addEventListener('load', () => { navigator.serviceWorker.register('/sw.js').catch(() => {}); });
}
