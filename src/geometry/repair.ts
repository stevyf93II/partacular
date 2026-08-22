// REPAIR OPS — the human's correction pass over an automatic split.
//
// Why this exists: watershed segmentation of a fused mesh has no ground truth.
// "Where does the door end and the fender begin" is not a geometric fact, so no
// parameter set converges — tuning for one model degrades another, forever.
//
// The way out is to stop trying to be right and start being CORRECTABLE. Two
// gestures cover both directions of error:
//
//   over-segmented  (one thing became many)  -> merge
//   under-segmented (many things stayed one) -> lasso
//
// With these, segmentation quality stops being a release gate and becomes a
// starting guess. Getting persistDeg exactly right stops mattering.
//
// Pure arrays in, labels out. No three.js — same rule as split.ts, so this is
// node-testable and can move to a worker unchanged.
import { canonicalVertexIds } from './split.js';

/** Column-major 4x4, i.e. three.js Matrix4.elements. */
export type Mat4 = ArrayLike<number>;

export interface ProjectedTris {
  /** NDC centroid x per triangle */
  cx: Float32Array;
  /** NDC centroid y per triangle */
  cy: Float32Array;
  /** 1 if the triangle faces the camera, else 0 */
  front: Uint8Array;
  /** 1 if the triangle is in front of the near plane at all */
  valid: Uint8Array;
}

const vid = (index: Uint32Array | null, t: number, c: number) => (index ? index[t * 3 + c] : t * 3 + c);

/**
 * Project every triangle to normalized device coordinates.
 *
 * Facing is decided by the SIGN OF THE PROJECTED AREA rather than by comparing
 * a normal against a camera vector. That is how the GPU culls backfaces, and it
 * comes out right through any model matrix — rotation, non-uniform scale, even
 * a mirroring negative scale — with no inverse-transpose bookkeeping.
 */
export function projectTriangles(positions: Float32Array, index: Uint32Array | null, mvp: Mat4): ProjectedTris {
  const triCount = index ? index.length / 3 : positions.length / 9;
  const cx = new Float32Array(triCount);
  const cy = new Float32Array(triCount);
  const front = new Uint8Array(triCount);
  const valid = new Uint8Array(triCount);
  const xs = new Float64Array(3), ys = new Float64Array(3);

  for (let t = 0; t < triCount; t++) {
    let ok = true;
    for (let c = 0; c < 3; c++) {
      const v = vid(index, t, c) * 3;
      const x = positions[v], y = positions[v + 1], z = positions[v + 2];
      const w = mvp[3] * x + mvp[7] * y + mvp[11] * z + mvp[15];
      if (!(w > 1e-9)) { ok = false; break; } // at or behind the eye
      xs[c] = (mvp[0] * x + mvp[4] * y + mvp[8] * z + mvp[12]) / w;
      ys[c] = (mvp[1] * x + mvp[5] * y + mvp[9] * z + mvp[13]) / w;
    }
    if (!ok) continue;
    valid[t] = 1;
    cx[t] = (xs[0] + xs[1] + xs[2]) / 3;
    cy[t] = (ys[0] + ys[1] + ys[2]) / 3;
    // Positive signed area in a y-up frame == counter-clockwise == front face.
    const area = (xs[1] - xs[0]) * (ys[2] - ys[0]) - (xs[2] - xs[0]) * (ys[1] - ys[0]);
    front[t] = area > 0 ? 1 : 0;
  }
  return { cx, cy, front, valid };
}

/**
 * Thin a raw pointer stroke down to at most `max` points.
 *
 * A finger drag emits hundreds of samples; every one of them multiplies the
 * per-triangle cost of the point-in-polygon and nearest-segment tests. Uniform
 * decimation keeps the shape and bounds the work.
 */
export function simplifyStroke(stroke: Float32Array, max = 64): Float32Array {
  const n = stroke.length / 2;
  if (n <= max) return stroke;
  const out = new Float32Array(max * 2);
  for (let i = 0; i < max; i++) {
    const src = Math.round((i * (n - 1)) / (max - 1));
    out[i * 2] = stroke[src * 2];
    out[i * 2 + 1] = stroke[src * 2 + 1];
  }
  return out;
}

/**
 * Decide what the user meant by the shape they drew.
 *
 * A stroke that comes back near its own start is a lasso around a region. A
 * stroke that runs off somewhere else is a knife line across the part. Reading
 * the intent from the drawing means one gesture covers both, and the user never
 * has to pick a mode.
 */
export function strokeIntent(stroke: Float32Array): 'lasso' | 'cut' {
  const n = stroke.length / 2;
  if (n < 3) return 'cut';
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    minX = Math.min(minX, stroke[i * 2]); maxX = Math.max(maxX, stroke[i * 2]);
    minY = Math.min(minY, stroke[i * 2 + 1]); maxY = Math.max(maxY, stroke[i * 2 + 1]);
  }
  const extent = Math.hypot(maxX - minX, maxY - minY);
  if (extent < 1e-6) return 'cut';
  const gap = Math.hypot(stroke[0] - stroke[(n - 1) * 2], stroke[1] - stroke[(n - 1) * 2 + 1]);
  return gap < extent * 0.45 ? 'lasso' : 'cut';
}

/** Even-odd point-in-polygon. */
function inPolygon(px: number, py: number, poly: Float32Array): boolean {
  let insideFlag = false;
  const n = poly.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = poly[i * 2], yi = poly[i * 2 + 1];
    const xj = poly[j * 2], yj = poly[j * 2 + 1];
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) insideFlag = !insideFlag;
  }
  return insideFlag;
}

/**
 * Triangles the user lassoed: inside the loop and facing them.
 *
 * Front-facing is not a detail — circling a car door in screen space also
 * encircles the far side of the car behind it. Taking only the near skin is
 * what makes the gesture mean "this panel" instead of "this silhouette".
 */
export function lassoMask(p: ProjectedTris, loop: Float32Array, frontFacingOnly = true): Uint8Array {
  const triCount = p.cx.length;
  const mask = new Uint8Array(triCount);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < loop.length / 2; i++) {
    minX = Math.min(minX, loop[i * 2]); maxX = Math.max(maxX, loop[i * 2]);
    minY = Math.min(minY, loop[i * 2 + 1]); maxY = Math.max(maxY, loop[i * 2 + 1]);
  }
  for (let t = 0; t < triCount; t++) {
    if (!p.valid[t]) continue;
    if (frontFacingOnly && !p.front[t]) continue;
    const x = p.cx[t], y = p.cy[t];
    if (x < minX || x > maxX || y < minY || y > maxY) continue; // cheap reject first
    if (inPolygon(x, y, loop)) mask[t] = 1;
  }
  return mask;
}

/**
 * Triangles on one side of a drawn knife line.
 *
 * The polyline is treated as infinitely extended at both ends, so a stroke that
 * only crosses the visible part still partitions the whole of it.
 */
export function cutMask(p: ProjectedTris, line: Float32Array): Uint8Array {
  const triCount = p.cx.length;
  const mask = new Uint8Array(triCount);
  const segs = line.length / 2 - 1;
  if (segs < 1) return mask;
  for (let t = 0; t < triCount; t++) {
    if (!p.valid[t]) continue;
    const x = p.cx[t], y = p.cy[t];
    let bestD = Infinity, bestCross = 0;
    for (let s = 0; s < segs; s++) {
      const ax = line[s * 2], ay = line[s * 2 + 1];
      const bx = line[s * 2 + 2], by = line[s * 2 + 3];
      const dx = bx - ax, dy = by - ay;
      const len2 = dx * dx + dy * dy;
      if (len2 < 1e-18) continue;
      let u = ((x - ax) * dx + (y - ay) * dy) / len2;
      // Clamp only on the interior; the end segments run to infinity so points
      // beyond the drawn stroke still land on a definite side.
      if (s > 0 && u < 0) u = 0;
      if (s < segs - 1 && u > 1) u = 1;
      const px = ax + dx * u, py = ay + dy * u;
      const d = (x - px) * (x - px) + (y - py) * (y - py);
      if (d < bestD) { bestD = d; bestCross = dx * (y - ay) - dy * (x - ax); }
    }
    mask[t] = bestCross > 0 ? 1 : 0;
  }
  return mask;
}

export interface Adjacency { nb: Int32Array; count: Uint8Array; }

/** Face adjacency over welded vertices; up to three neighbours per triangle. */
export function faceAdjacency(positions: Float32Array, index: Uint32Array | null): Adjacency {
  const triCount = index ? index.length / 3 : positions.length / 9;
  const canon = canonicalVertexIds(positions);
  const keys = new Float64Array(triCount * 3);
  const owner = new Uint32Array(triCount * 3);
  for (let t = 0; t < triCount; t++) {
    for (let e = 0; e < 3; e++) {
      const v0 = canon[vid(index, t, e)], v1 = canon[vid(index, t, (e + 1) % 3)];
      keys[t * 3 + e] = (v0 < v1 ? v0 : v1) * 4294967296 + (v0 < v1 ? v1 : v0);
      owner[t * 3 + e] = t;
    }
  }
  const ord = [...Array(triCount * 3).keys()].sort((a, b) => keys[a] - keys[b]);
  const nb = new Int32Array(triCount * 3).fill(-1);
  const count = new Uint8Array(triCount);
  for (let i = 1; i < ord.length; i++) {
    if (keys[ord[i]] !== keys[ord[i - 1]]) continue;
    const f1 = owner[ord[i - 1]], f2 = owner[ord[i]];
    if (f1 === f2) continue;
    if (count[f1] < 3) nb[f1 * 3 + count[f1]++] = f2;
    if (count[f2] < 3) nb[f2 * 3 + count[f2]++] = f1;
  }
  return { nb, count };
}

/**
 * Keep only the largest connected patch of a mask.
 *
 * A lasso inevitably catches stray front-facing scraps elsewhere in the model
 * that happen to fall inside the loop. Those would become floating debris
 * welded to the new part, so anything not touching the main patch is dropped.
 */
export function largestPatch(mask: Uint8Array, adj: Adjacency): Uint8Array {
  const n = mask.length;
  const comp = new Int32Array(n).fill(-1);
  const stack = new Int32Array(n);
  let bestId = -1, bestSize = 0, nextComp = 0;
  for (let seed = 0; seed < n; seed++) {
    if (!mask[seed] || comp[seed] !== -1) continue;
    const id = nextComp++;
    let size = 0, sp = 0;
    stack[sp++] = seed; comp[seed] = id;
    while (sp > 0) {
      const f = stack[--sp]; size++;
      for (let e = 0; e < adj.count[f]; e++) {
        const g = adj.nb[f * 3 + e];
        if (mask[g] && comp[g] === -1) { comp[g] = id; stack[sp++] = g; }
      }
    }
    if (size > bestSize) { bestSize = size; bestId = id; }
  }
  if (bestId < 0) return mask;
  const out = new Uint8Array(n);
  for (let t = 0; t < n; t++) if (comp[t] === bestId) out[t] = 1;
  return out;
}

/**
 * Smooth a mask's border by majority vote.
 *
 * Centroid-level tests speckle along the boundary, and a speckle becomes a
 * loose triangle floating in mid-air the moment the new part is dragged away.
 */
export function smoothMask(mask: Uint8Array, adj: Adjacency, passes = 2): Uint8Array {
  let cur = mask;
  for (let pass = 0; pass < passes; pass++) {
    const next = new Uint8Array(cur);
    for (let t = 0; t < cur.length; t++) {
      const n = adj.count[t];
      if (n < 2) continue;
      let same = 0;
      for (let e = 0; e < n; e++) if (cur[adj.nb[t * 3 + e]] === cur[t]) same++;
      if (same === 0) next[t] = cur[t] ? 0 : 1; // fully surrounded by the other side
    }
    cur = next;
  }
  return cur;
}

export interface PartitionResult { triGroup: Uint32Array; groupCount: number; counts: [number, number]; }

/** Mask -> the { triGroup, groupCount } shape the rest of the app already speaks. */
export function maskToPartition(mask: Uint8Array): PartitionResult {
  const triGroup = new Uint32Array(mask.length);
  let a = 0, b = 0;
  for (let t = 0; t < mask.length; t++) {
    if (mask[t]) { triGroup[t] = 1; b++; } else { triGroup[t] = 0; a++; }
  }
  return { triGroup, groupCount: 2, counts: [a, b] };
}

export interface RepairOptions {
  /** below this share of the part, the result is too small to be a real piece */
  minFraction?: number;
  frontFacingOnly?: boolean;
  smoothPasses?: number;
}

/**
 * The whole repair pass for one drawn stroke.
 *
 * Returns null when the stroke did not carve anything worth keeping, so the
 * caller can say so instead of silently producing an empty or absurd part.
 */
export function repairFromStroke(
  positions: Float32Array,
  index: Uint32Array | null,
  mvp: Mat4,
  rawStroke: Float32Array,
  opts: RepairOptions = {},
): (PartitionResult & { intent: 'lasso' | 'cut' }) | null {
  const minFraction = opts.minFraction ?? 0.002;
  const stroke = simplifyStroke(rawStroke);
  const intent = strokeIntent(stroke);
  const projected = projectTriangles(positions, index, mvp);

  let mask = intent === 'lasso'
    ? lassoMask(projected, stroke, opts.frontFacingOnly ?? true)
    : cutMask(projected, stroke);

  const adj = faceAdjacency(positions, index);
  mask = smoothMask(mask, adj, opts.smoothPasses ?? 2);
  // A cut is a partition of the whole part, so both sides are legitimate and
  // neither should be thinned to its largest island. A lasso names one region.
  if (intent === 'lasso') mask = largestPatch(mask, adj);

  const result = maskToPartition(mask);
  const total = mask.length;
  if (result.counts[0] < total * minFraction || result.counts[1] < total * minFraction) return null;
  return { ...result, intent };
}
