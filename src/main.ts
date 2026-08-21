import * as THREE from 'three';
import { Document, PartMeta, identityTransform } from './core/document';
import { Viewport } from './viewport/viewport';
import { initUI } from './ui/ui';
import { parseFile, buildGroupGeometries, demoSoup, LoadedPart } from './geometry/loaders';
import { splitInWorker } from './geometry/splitClient';
import { putGeometry, getGeometry, clearGeometries } from './geometry/store';
import { exportGLB, exportSTL, downloadBlob } from './geometry/exporters';

export const PALETTE = [0x4da3ff, 0xffb347, 0x7ee081, 0xff7eb6, 0xb59bff, 0x6be2e0, 0xffd66b, 0xff8d6b, 0x9fd356, 0x62b6ff];

const doc = new Document();
const viewport = new Viewport(document.getElementById('app')!, doc);
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
});

function duplicateSelected() {
  const sel = doc.selectedId; if (!sel) return;
  const src = doc.get(sel); const geo = getGeometry(sel);
  if (!src || !geo) return;
  const id = newId();
  putGeometry(id, geo); // geometry is shared between copies
  const t = identityTransform();
  const offset = Math.max(0.15 * Math.cbrt(src.triCount), 0.2) * src.transform.scale;
  t.position = [src.transform.position[0] + offset, src.transform.position[1], src.transform.position[2] + offset];
  t.rotationY = src.transform.rotationY; t.scale = src.transform.scale;
  doc.addParts([{ id, name: `${src.name} copy`, triCount: src.triCount, visible: true, color: src.color, transform: t }], true);
  doc.select(id);
}

function recolorSelected() {
  const sel = doc.selectedId; if (!sel) return;
  const m = doc.get(sel); if (!m) return;
  const i = PALETTE.indexOf(m.color);
  doc.setColor(sel, PALETTE[(i + 1) % PALETTE.length]);
}

async function doExport(kind: 'glb' | 'stl') {
  if (doc.count() === 0) { ui.showToast('Nothing to save yet'); return; }
  ui.showToast(`Building ${kind.toUpperCase()}…`);
  const blob = kind === 'glb' ? await exportGLB(doc) : exportSTL(doc);
  downloadBlob(blob, `partacular.${kind}`);
  ui.showToast(`Saved partacular.${kind}`);
}

async function loadFile(file: File) {
  ui.showToast(`Opening ${file.name}…`);
  const { parts, needsSplit } = await parseFile(file);
  if (parts.length === 0) throw new Error('no meshes found in file');
  if (needsSplit && parts.length === 1) {
    await installSplit(parts[0].geometry, parts[0].name);
  } else {
    installParts(parts);
  }
}

async function loadDemo() {
  ui.showToast('Building demo…');
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
  doc.addParts(metas);
  viewport.fitCamera();
}
