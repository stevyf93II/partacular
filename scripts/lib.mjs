// Shared plumbing for preview / accept / deploy-gate. All three call the SAME
// production entry point (splitPipeline.smartSplit) — one call path, no harness.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';

export const GATE_BUILD = '.gate-build';
const SOURCES = ['src/geometry/split.ts', 'src/geometry/print.ts', 'src/geometry/segment.ts',
  'src/geometry/segmentation.config.ts', 'src/geometry/splitPipeline.ts'];

/** Compile the production geometry sources for node and import the entry point. */
export async function loadPipeline() {
  execSync(`npx tsc ${SOURCES.join(' ')} --outDir ${GATE_BUILD} --target es2022 --module es2022 --moduleResolution bundler --skipLibCheck --ignoreConfig`, { stdio: 'inherit' });
  const pipe = await import(path.resolve(GATE_BUILD, 'splitPipeline.js'));
  const cfgMod = await import(path.resolve(GATE_BUILD, 'segmentation.config.js'));
  const { MeshoptSimplifier } = await import('meshoptimizer');
  await MeshoptSimplifier.ready;
  return { smartSplit: pipe.smartSplit, SEGMENTATION_CONFIG: cfgMod.SEGMENTATION_CONFIG, MeshoptSimplifier };
}

/** Minimal GLB reader: positions + indices of the first primitive (the app's loaders handle the general case). */
export function readGLB(file) {
  const buf = fs.readFileSync(file);
  if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error('not a GLB');
  const jsonLen = buf.readUInt32LE(12);
  const j = JSON.parse(buf.subarray(20, 20 + jsonLen).toString());
  const binStart = 20 + jsonLen + 8;
  const prim = j.meshes[0].primitives[0];
  const acc = (ai) => {
    const a = j.accessors[ai], bv = j.bufferViews[a.bufferView];
    const off = binStart + (bv.byteOffset || 0) + (a.byteOffset || 0);
    return { a, off };
  };
  const p = acc(prim.attributes.POSITION);
  const positions = new Float32Array(p.a.count * 3);
  for (let i = 0; i < positions.length; i++) positions[i] = buf.readFloatLE(p.off + i * 4);
  let index = null;
  if (prim.indices !== undefined) {
    const ix = acc(prim.indices);
    index = new Uint32Array(ix.a.count);
    const u16 = ix.a.componentType === 5123;
    for (let i = 0; i < index.length; i++) index[i] = u16 ? buf.readUInt16LE(ix.off + i * 2) : buf.readUInt32LE(ix.off + i * 4);
  }
  return { positions, index };
}

/** Ground exactly like the app does before splitting (translation invariant, but be literal). */
export function ground(positions) {
  let minY = Infinity;
  for (let i = 1; i < positions.length; i += 3) minY = Math.min(minY, positions[i]);
  for (let i = 1; i < positions.length; i += 3) positions[i] -= minY;
  return positions;
}

/** Canonical fingerprint of a split result: parts sorted by (size desc, first-tri asc),
 *  triangles relabeled canonically, sha256 over the relabeled assignment + params. */
export function fingerprint(res, params) {
  const first = new Map(), size = new Map();
  for (let t = 0; t < res.triGroup.length; t++) {
    const g = res.triGroup[t];
    size.set(g, (size.get(g) || 0) + 1);
    if (!first.has(g)) first.set(g, t);
  }
  const orderIds = [...size.keys()].sort((a, b) => (size.get(b) - size.get(a)) || (first.get(a) - first.get(b)));
  const canon = new Map(orderIds.map((g, i) => [g, i]));
  const relabeled = new Uint32Array(res.triGroup.length);
  for (let t = 0; t < res.triGroup.length; t++) relabeled[t] = canon.get(res.triGroup[t]);
  const h = crypto.createHash('sha256');
  h.update(JSON.stringify(params));
  h.update(Buffer.from(relabeled.buffer));
  return { partCount: orderIds.length, sortedSizes: orderIds.map(g => size.get(g)), hash: h.digest('hex') };
}

export function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

// ---- self-describing previews: embed the effective config as a PNG tEXt chunk ----
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
export function pngWithConfig(pngBuf, configJson) {
  const kw = Buffer.from('partacular-config\0' + configJson, 'latin1');
  const chunk = Buffer.alloc(12 + kw.length);
  chunk.writeUInt32BE(kw.length, 0);
  chunk.write('tEXt', 4, 'latin1');
  kw.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, 8 + kw.length)), 8 + kw.length);
  const iend = pngBuf.length - 12; // IEND chunk is always last 12 bytes
  return Buffer.concat([pngBuf.subarray(0, iend), chunk, pngBuf.subarray(iend)]);
}

const PAL = [[77,163,255],[255,179,71],[126,224,129],[255,126,182],[181,155,255],[107,226,224],[255,214,107],[255,141,107],[159,211,86],[98,182,255],[240,98,146],[129,199,132],[255,238,88],[121,134,203],[77,208,225],[255,112,67],[174,213,129],[244,143,177],[144,202,249],[255,183,77],[230,230,230],[190,120,80]];
export async function renderPreview(positions, index, res, out, axis, configJson) {
  const { PNG } = await import('pngjs');
  const triCount = res.triGroup.length;
  const W = 1400, H = 700;
  let mn = [1e9, 1e9, 1e9], mx = [-1e9, -1e9, -1e9];
  for (let v = 0; v < positions.length; v += 3) for (let d = 0; d < 3; d++) { mn[d] = Math.min(mn[d], positions[v + d]); mx[d] = Math.max(mx[d], positions[v + d]); }
  const [U, V, D] = axis;
  const s = Math.min((W - 40) / (mx[U] - mn[U]), (H - 40) / (mx[V] - mn[V]));
  const size = new Map();
  for (let t = 0; t < triCount; t++) size.set(res.triGroup[t], (size.get(res.triGroup[t]) || 0) + 1);
  const rank = new Map([...size.keys()].sort((a, b) => size.get(b) - size.get(a)).map((g, i) => [g, i]));
  const png = new PNG({ width: W, height: H });
  png.data.fill(16);
  for (let i = 3; i < png.data.length; i += 4) png.data[i] = 255;
  const depth = new Float32Array(W * H).fill(-1e9);
  const vid = (t, c) => (index ? index[t * 3 + c] : t * 3 + c);
  for (let k = 0; k < triCount; k++) {
    const col = PAL[rank.get(res.triGroup[k]) % PAL.length];
    const px = [], py = [], pd = [];
    for (let c = 0; c < 3; c++) {
      const v = vid(k, c) * 3;
      px.push(20 + (positions[v + U] - mn[U]) * s); py.push(H - 20 - (positions[v + V] - mn[V]) * s); pd.push(positions[v + D]);
    }
    const minx = Math.max(0, Math.floor(Math.min(...px))), maxx = Math.min(W - 1, Math.ceil(Math.max(...px)));
    const miny = Math.max(0, Math.floor(Math.min(...py))), maxy = Math.min(H - 1, Math.ceil(Math.max(...py)));
    const d = (pd[0] + pd[1] + pd[2]) / 3;
    const den = (py[1] - py[2]) * (px[0] - px[2]) + (px[2] - px[1]) * (py[0] - py[2]);
    if (Math.abs(den) < 1e-12) continue;
    for (let yy = miny; yy <= maxy; yy++) for (let xx = minx; xx <= maxx; xx++) {
      const l1 = ((py[1] - py[2]) * (xx - px[2]) + (px[2] - px[1]) * (yy - py[2])) / den;
      const l2 = ((py[2] - py[0]) * (xx - px[2]) + (px[0] - px[2]) * (yy - py[2])) / den;
      if (l1 < -0.001 || l2 < -0.001 || 1 - l1 - l2 < -0.001) continue;
      const o = yy * W + xx;
      if (d > depth[o]) { depth[o] = d; const p2 = o * 4; png.data[p2] = col[0]; png.data[p2 + 1] = col[1]; png.data[p2 + 2] = col[2]; }
    }
  }
  fs.writeFileSync(out, pngWithConfig(PNG.sync.write(png), configJson));
}
