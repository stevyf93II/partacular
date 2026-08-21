// Watershed auto-segmentation of a fused triangle soup (pure core, node-testable).
// Pipeline: weld -> decimate (meshopt) -> smoothed face normals -> concave-dihedral
// curvature -> watershed flood with persistence merging -> absorb slivers ->
// transfer labels back to full-res triangles via a centroid grid.
//
// Why watershed: naive concave-crease cutting fails on AI meshes — crease loops
// never close, regions leak. Watershed basins are closed by construction.
// Proven on diablo.glb (1.59M-tri fused car body): door, window frames,
// interior separated cleanly at persist=10deg.
import { weldSoup, SimplifierLike } from './print';

export interface SegmentOptions {
  /** basins shallower than this (degrees of curvature relief) merge into deeper neighbors */
  persistDeg?: number;
  /** regions smaller than this fraction of the mesh get absorbed */
  minRegionFrac?: number;
  /** decimation target for the analysis proxy */
  proxyTris?: number;
}

/** Segment a triangle soup; returns per-triangle group labels (0..groupCount-1). */
export function watershedSegment(
  simplifier: SimplifierLike,
  soup: Float32Array,
  opts: SegmentOptions = {},
): { triGroup: Uint32Array; groupCount: number } {
  const persist = ((opts.persistDeg ?? 10) * Math.PI) / 180;
  const minFrac = opts.minRegionFrac ?? 0.003;
  const proxyTarget = opts.proxyTris ?? 150_000;
  const fullTris = soup.length / 9;

  // ---- analysis proxy: weld, then decimate if large ----
  const { positions: wp, indices: wi } = weldSoup(soup);
  let di = wi;
  if (fullTris > proxyTarget * 1.3) {
    const [idx] = simplifier.simplify(wi, wp, 3, proxyTarget * 3, 0.01, ['LockBorder']);
    di = idx;
  }
  const nTri = di.length / 3;
  if (nTri < 50) return { triGroup: new Uint32Array(fullTris), groupCount: 1 };

  // ---- face normals + centroids ----
  const fn = new Float32Array(nTri * 3);
  const cent = new Float32Array(nTri * 3);
  for (let k = 0; k < nTri; k++) {
    const a = di[k * 3] * 3, b = di[k * 3 + 1] * 3, c = di[k * 3 + 2] * 3;
    const ux = wp[b] - wp[a], uy = wp[b + 1] - wp[a + 1], uz = wp[b + 2] - wp[a + 2];
    const vx = wp[c] - wp[a], vy = wp[c + 1] - wp[a + 1], vz = wp[c + 2] - wp[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    fn[k * 3] = nx / l; fn[k * 3 + 1] = ny / l; fn[k * 3 + 2] = nz / l;
    cent[k * 3] = (wp[a] + wp[b] + wp[c]) / 3;
    cent[k * 3 + 1] = (wp[a + 1] + wp[b + 1] + wp[c + 1]) / 3;
    cent[k * 3 + 2] = (wp[a + 2] + wp[b + 2] + wp[c + 2]) / 3;
  }

  // ---- adjacency over shared edges ----
  const edge = new Map<number, number[]>();
  for (let k = 0; k < nTri; k++) for (let e = 0; e < 3; e++) {
    const v0 = di[k * 3 + e], v1 = di[k * 3 + (e + 1) % 3];
    const key = v0 < v1 ? v0 * 4294967296 + v1 : v1 * 4294967296 + v0;
    const arr = edge.get(key);
    if (arr) arr.push(k, v0, v1); else edge.set(key, [k, v0, v1]);
  }
  const adj: number[][] = Array.from({ length: nTri }, () => []);
  const edgeInfo: [number, number, number, number][] = [];
  for (const arr of edge.values()) {
    if (arr.length !== 6) continue;
    adj[arr[0]].push(arr[3]); adj[arr[3]].push(arr[0]);
    edgeInfo.push([arr[0], arr[3], arr[1], arr[2]]);
  }

  // ---- smooth normals (3 iterations) to suppress voxel-staircase noise ----
  let sn = fn;
  for (let it = 0; it < 3; it++) {
    const nx = new Float32Array(nTri * 3);
    for (let k = 0; k < nTri; k++) {
      let x = sn[k * 3] * 1.5, y = sn[k * 3 + 1] * 1.5, z = sn[k * 3 + 2] * 1.5;
      for (const g of adj[k]) { x += sn[g * 3]; y += sn[g * 3 + 1]; z += sn[g * 3 + 2]; }
      const l = Math.hypot(x, y, z) || 1;
      nx[k * 3] = x / l; nx[k * 3 + 1] = y / l; nx[k * 3 + 2] = z / l;
    }
    sn = nx;
  }

  // ---- per-face curvature: max concave dihedral (concave = (n1 x n2) . e < 0, e in f1 winding) ----
  const curv = new Float32Array(nTri);
  for (const [f1, f2, a0, a1] of edgeInfo) {
    const dot = Math.min(1, Math.max(-1, sn[f1 * 3] * sn[f2 * 3] + sn[f1 * 3 + 1] * sn[f2 * 3 + 1] + sn[f1 * 3 + 2] * sn[f2 * 3 + 2]));
    const ang = Math.acos(dot);
    const ex = wp[a1 * 3] - wp[a0 * 3], ey = wp[a1 * 3 + 1] - wp[a0 * 3 + 1], ez = wp[a1 * 3 + 2] - wp[a0 * 3 + 2];
    const cx = sn[f1 * 3 + 1] * sn[f2 * 3 + 2] - sn[f1 * 3 + 2] * sn[f2 * 3 + 1];
    const cy = sn[f1 * 3 + 2] * sn[f2 * 3] - sn[f1 * 3] * sn[f2 * 3 + 2];
    const cz = sn[f1 * 3] * sn[f2 * 3 + 1] - sn[f1 * 3 + 1] * sn[f2 * 3];
    if (cx * ex + cy * ey + cz * ez < 0) {
      if (ang > curv[f1]) curv[f1] = ang;
      if (ang > curv[f2]) curv[f2] = ang;
    }
  }

  // ---- watershed flood with persistence merging ----
  const order = [...Array(nTri).keys()].sort((a, b) => curv[a] - curv[b]);
  const label = new Int32Array(nTri).fill(-1);
  const parent: number[] = []; const birth: number[] = [];
  const find = (x: number): number => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  for (const f of order) {
    const nbr = new Set<number>();
    for (const g of adj[f]) if (label[g] !== -1) nbr.add(find(label[g]));
    if (nbr.size === 0) { const id = parent.length; parent.push(id); birth.push(curv[f]); label[f] = id; }
    else if (nbr.size === 1) label[f] = nbr.values().next().value!;
    else {
      const arr = [...nbr].sort((a, b) => birth[a] - birth[b]);
      const deep = arr[0];
      for (let i = 1; i < arr.length; i++) if (curv[f] - birth[arr[i]] < persist) parent[arr[i]] = deep;
      label[f] = deep;
    }
  }
  for (let k = 0; k < nTri; k++) label[k] = find(label[k]);

  // ---- absorb regions below min size into their dominant neighbor ----
  const size = new Map<number, number>();
  for (let k = 0; k < nTri; k++) size.set(label[k], (size.get(label[k]) || 0) + 1);
  const minSize = Math.max(200, nTri * minFrac);
  for (let pass = 0; pass < 12; pass++) {
    const nb = new Map<string, number>();
    for (let k = 0; k < nTri; k++) {
      if ((size.get(label[k]) || 0) >= minSize) continue;
      for (const g of adj[k]) if (label[g] !== label[k]) {
        const key = label[k] + ':' + label[g];
        nb.set(key, (nb.get(key) || 0) + 1);
      }
    }
    const tgt = new Map<number, [number, number]>();
    for (const [key, cnt] of nb) {
      const [ri, rg] = key.split(':').map(Number);
      const cur = tgt.get(ri);
      if (!cur || cnt > cur[1]) tgt.set(ri, [rg, cnt]);
    }
    if (!tgt.size) break;
    for (let k = 0; k < nTri; k++) {
      const tg = tgt.get(label[k]);
      if (tg) { size.set(label[k], size.get(label[k])! - 1); label[k] = tg[0]; size.set(tg[0], (size.get(tg[0]) || 0) + 1); }
    }
  }

  // ---- force-merge any leftover sub-min region into the spatially nearest big region ----
  // (decimation can leave disconnected proxy fragments that adjacency absorption never reaches)
  {
    const bigSet = new Set<number>();
    for (const [id, sz] of size) if (sz >= minSize) bigSet.add(id);
    if (bigSet.size > 0) {
      const bigFaces: number[] = [];
      for (let k = 0; k < nTri; k++) if (bigSet.has(label[k])) bigFaces.push(k);
      for (let k = 0; k < nTri; k++) {
        if (bigSet.has(label[k])) continue;
        let best = -1, bestD = Infinity;
        // sparse sampling of big faces is plenty at proxy density
        for (let i = 0; i < bigFaces.length; i += 7) {
          const p2 = bigFaces[i];
          const d = (cent[p2 * 3] - cent[k * 3]) ** 2 + (cent[p2 * 3 + 1] - cent[k * 3 + 1]) ** 2 + (cent[p2 * 3 + 2] - cent[k * 3 + 2]) ** 2;
          if (d < bestD) { bestD = d; best = p2; }
        }
        if (best >= 0) label[k] = label[best];
      }
    }
  }

  // ---- compact label ids ----
  const remap = new Map<number, number>();
  for (let k = 0; k < nTri; k++) if (!remap.has(label[k])) remap.set(label[k], remap.size);
  const groupCount = remap.size;

  // ---- transfer to full-res triangles via centroid grid over proxy centroids ----
  const triGroup = new Uint32Array(fullTris);
  if (di === wi) {
    for (let k = 0; k < fullTris; k++) triGroup[k] = remap.get(label[k])!;
    return { triGroup, groupCount };
  }
  // grid hash
  let mnx = 1e9, mny = 1e9, mnz = 1e9, mxx = -1e9, mxy = -1e9, mxz = -1e9;
  for (let k = 0; k < nTri; k++) {
    mnx = Math.min(mnx, cent[k * 3]); mxx = Math.max(mxx, cent[k * 3]);
    mny = Math.min(mny, cent[k * 3 + 1]); mxy = Math.max(mxy, cent[k * 3 + 1]);
    mnz = Math.min(mnz, cent[k * 3 + 2]); mxz = Math.max(mxz, cent[k * 3 + 2]);
  }
  const G = 96;
  const gx = (x: number) => Math.min(G - 1, Math.max(0, Math.floor(((x - mnx) / (mxx - mnx || 1)) * G)));
  const gy = (y: number) => Math.min(G - 1, Math.max(0, Math.floor(((y - mny) / (mxy - mny || 1)) * G)));
  const gz = (z: number) => Math.min(G - 1, Math.max(0, Math.floor(((z - mnz) / (mxz - mnz || 1)) * G)));
  const grid = new Map<number, number[]>();
  for (let k = 0; k < nTri; k++) {
    const key = (gx(cent[k * 3]) * G + gy(cent[k * 3 + 1])) * G + gz(cent[k * 3 + 2]);
    const arr = grid.get(key);
    if (arr) arr.push(k); else grid.set(key, [k]);
  }
  for (let k = 0; k < fullTris; k++) {
    const x = (soup[k * 9] + soup[k * 9 + 3] + soup[k * 9 + 6]) / 3;
    const y = (soup[k * 9 + 1] + soup[k * 9 + 4] + soup[k * 9 + 7]) / 3;
    const z = (soup[k * 9 + 2] + soup[k * 9 + 5] + soup[k * 9 + 8]) / 3;
    const cxg = gx(x), cyg = gy(y), czg = gz(z);
    let best = -1, bestD = Infinity;
    // ring search: expand until a cell with candidates is found
    let found = false;
    for (let ring = 0; ring < G && !found; ring++) {
      for (let dx = -ring; dx <= ring; dx++) for (let dy = -ring; dy <= ring; dy++) for (let dz = -ring; dz <= ring; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) !== ring) continue;
        const xx = cxg + dx, yy = cyg + dy, zz = czg + dz;
        if (xx < 0 || yy < 0 || zz < 0 || xx >= G || yy >= G || zz >= G) continue;
        const cell = grid.get((xx * G + yy) * G + zz);
        if (!cell) continue;
        for (const p of cell) {
          const d = (cent[p * 3] - x) ** 2 + (cent[p * 3 + 1] - y) ** 2 + (cent[p * 3 + 2] - z) ** 2;
          if (d < bestD) { bestD = d; best = p; }
        }
        found = true;
      }
      if (found && ring > 0) break; // one extra ring after first hit is enough at this density
    }
    triGroup[k] = best >= 0 ? remap.get(label[best])! : 0;
  }

  // ---- majority-vote smoothing at full res: the nearest-centroid transfer
  // speckles at region borders; specks would float when their part moves. ----
  {
    // face adjacency via sorted edge keys (typed arrays; Map would blow memory at 2M tris)
    const keys = new Float64Array(fullTris * 3);
    const owner = new Uint32Array(fullTris * 3);
    for (let k = 0; k < fullTris; k++) for (let e = 0; e < 3; e++) {
      const v0 = wi[k * 3 + e], v1 = wi[k * 3 + (e + 1) % 3];
      keys[k * 3 + e] = (v0 < v1 ? v0 : v1) * 4294967296 + (v0 < v1 ? v1 : v0);
      owner[k * 3 + e] = k;
    }
    const ord = [...Array(fullTris * 3).keys()].sort((a, b) => keys[a] - keys[b]);
    const nb = new Int32Array(fullTris * 3).fill(-1); // up to 3 neighbors per face
    const nbCount = new Uint8Array(fullTris);
    for (let i = 1; i < ord.length; i++) {
      if (keys[ord[i]] === keys[ord[i - 1]]) {
        const f1 = owner[ord[i - 1]], f2 = owner[ord[i]];
        if (f1 !== f2) {
          if (nbCount[f1] < 3) nb[f1 * 3 + nbCount[f1]++] = f2;
          if (nbCount[f2] < 3) nb[f2 * 3 + nbCount[f2]++] = f1;
        }
      }
    }
    for (let pass = 0; pass < 2; pass++) {
      const next = new Uint32Array(triGroup);
      for (let k = 0; k < fullTris; k++) {
        const l0 = triGroup[k];
        const ls: number[] = [];
        for (let e = 0; e < nbCount[k]; e++) ls.push(triGroup[nb[k * 3 + e]]);
        if (ls.length >= 2 && ls[0] !== l0 && (ls[0] === ls[1] || (ls.length === 3 && ls[0] === ls[2]))) next[k] = ls[0];
        else if (ls.length === 3 && ls[1] !== l0 && ls[1] === ls[2]) next[k] = ls[1];
      }
      triGroup.set(next);
    }
  }
  return { triGroup, groupCount };
}
