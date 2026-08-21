import * as THREE from 'three';
import { Document, PartMeta, identityTransform } from './core/document';
import { Viewport } from './viewport/viewport';
import { initUI } from './ui/ui';
import { parseFile, buildGroupGeometries, demoSoup, LoadedPart } from './geometry/loaders';
import { splitInWorker } from './geometry/splitClient';
import { putGeometry, getGeometry, clearGeometries } from './geometry/store';
import { exportGLB, exportSTL, downloadBlob } from './geometry/exporters';
import { export3MFInWorker } from './geometry/printClient';

export const PALETTE = [0x4da3ff, 0xffb347, 0x7ee081, 0xff7eb6, 0xb59bff, 0x6be2e0, 0xffd66b, 0xff8d6b, 0x9fd356, 0x62b6ff];

const doc = new Document();
const viewport = new Viewport(document.getElementById('app')!, doc);
// Debug/automation handle — lets tests drive the real app from the console.
(window as unknown as Record<string, unknown>).__partacular = { doc, viewport };
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
  onSplitToggle: () => splitOrMerge().catch(err => ui.showToast(String(err.message ?? err))),
});
let modelName = 'model';

/** All visible parts baked into one world-space soup geometry. */
function bakeCurrentToSoup(): THREE.BufferGeometry | null {
  const metas = doc.list().filter(m => m.visible);
  if (metas.length === 0) return null;
  let total = 0;
  const baked: Float32Array[] = [];
  const q = new THREE.Quaternion(), yAxis = new THREE.Vector3(0, 1, 0), v = new THREE.Vector3();
  for (const meta of metas) {
    const geo = getGeometry(meta.id); if (!geo) continue;
    const t = meta.transform;
    const mtx = new THREE.Matrix4().compose(
      new THREE.Vector3(...t.position),
      q.setFromAxisAngle(yAxis, t.rotationY),
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
    ui.showToast('Merged back to one piece');
  } else {
    ui.showToast('Splitting into parts…');
    await installSplit(soup, modelName);
    const n = doc.count();
    ui.showToast(n > 1 ? `Split into ${n} parts` : 'This model is all one connected piece');
  }
}

function duplicateSelected() {
  const sel = doc.selectedId; if (!sel) return;
  const src = doc.get(sel); const geo = getGeometry(sel);
  if (!src || !geo) return;
  const id = newId();
  putGeometry(id, geo); // geometry is shared between copies
  const t = identityTransform();
  const offset = Math.max(0.15 * Math.cbrt(src.triCount), 0.2) * Math.max(...src.transform.scale);
  t.position = [src.transform.position[0] + offset, src.transform.position[1], src.transform.position[2] + offset];
  t.rotationY = src.transform.rotationY; t.scale = [...src.transform.scale];
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
    const res = await export3MFInWorker(doc);
    downloadBlob(res.blob, 'partacular.3mf');
    ui.showToast(res.failedNames.length === 0
      ? `Saved partacular.3mf — watertight, ${res.tris} triangles`
      : `Saved — ${res.failedNames.length} part(s) couldn't be sealed; your slicer may repair them`);
    return;
  }
  ui.showToast(`Building ${kind.toUpperCase()}…`);
  const blob = kind === 'glb' ? await exportGLB(doc) : exportSTL(doc);
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
    name: res.groupCount > 1 ? `${baseName} ${i + 1}` : baseName, geometry: g,
  }));
  installParts(loaded);
}

function installParts(parts: { name: string; geometry: THREE.BufferGeometry }[]) {
  doc.reset(); clearGeometries();
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
}

// PWA: service worker (network-first in sw.js, so fresh deploys always win when online).
if ('serviceWorker' in navigator && location.hostname !== 'localhost') {
  addEventListener('load', () => { navigator.serviceWorker.register('/sw.js').catch(() => {}); });
}
