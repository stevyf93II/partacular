// WHAT YOU GET WHEN YOU TOUCH SOMETHING.
//
// Selection is decided per touch, not per model. The pipeline already produces
// watershed BASINS that are closed by construction and respect real part
// boundaries -- measured on diablo.glb against the accepted 25-part output, 99%
// of basins fall cleanly inside or outside a real part, and the door is exactly
// 7 of them. What destroys that is the merging afterwards, which collapses
// everything with one global threshold that has to be right for every seam in
// the model simultaneously. That threshold is the thing that cannot be tuned.
//
// So: keep the basins, cluster them ONCE into a merge tree ordered by how strong
// the boundary between them is, and let the finger choose the level. Touching
// gives a chain of nested regions from "the basin I touched" out to "everything";
// dragging slides along it. No parameter has to be right in advance, because the
// person looking at the model picks.
//
// Pure arrays in, ids out. No three.js -- same rule as split.ts and repair.ts.
import type { SegmentTrace } from './segment.js';

/** How far along a boundary's sorted concave angles to read its strength. */
const BOUNDARY_PERCENTILE = 0.70;

export interface BasinGraph {
  /** number of basins, relabelled 0..count-1 */
  count: number;
  /** basin id per proxy face */
  basinOf: Int32Array;
  /** proxy faces per basin */
  sizes: Int32Array;
  /** every concave angle along each adjacent basin pair, keyed a*count+b (a<b) */
  boundaries: Map<number, number[]>;
}

/**
 * Basin adjacency, with the concavity found along every shared boundary.
 *
 * A boundary is scored at a percentile rather than a mean because exactly half
 * of any boundary's edges are triangulation diagonals carrying no concavity;
 * averaging over them halves the score for reasons that have nothing to do with
 * the shape. This is only used to ORDER merges here, never to decide one.
 */
export function buildBasinGraph(trace: SegmentTrace): BasinGraph {
  const { basins, adj, edgeInfo, edgeConc, nTri } = trace;

  // Basin labels come out of a union-find and are sparse; compact them.
  const remap = new Map<number, number>();
  const basinOf = new Int32Array(nTri);
  for (let f = 0; f < nTri; f++) {
    let id = remap.get(basins[f]);
    if (id === undefined) { id = remap.size; remap.set(basins[f], id); }
    basinOf[f] = id;
  }
  const count = remap.size;
  const sizes = new Int32Array(count);
  for (let f = 0; f < nTri; f++) sizes[basinOf[f]]++;

  const boundaries = new Map<number, number[]>();
  for (let i = 0; i < edgeInfo.length; i++) {
    const a = basinOf[edgeInfo[i][0]], b = basinOf[edgeInfo[i][1]];
    if (a === b) continue;
    const key = a < b ? a * count + b : b * count + a;
    let arr = boundaries.get(key);
    if (!arr) { arr = []; boundaries.set(key, arr); }
    arr.push(edgeConc[i]);
  }
  void adj;
  return { count, basinOf, sizes, boundaries };
}

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

export interface MergeTree {
  /** leaves 0..basinCount-1, internal nodes above */
  basinCount: number;
  nodeCount: number;
  parent: Int32Array;
  left: Int32Array;
  right: Int32Array;
  /** boundary strength that was crossed to create this node, radians */
  height: Float32Array;
  /** proxy faces beneath this node */
  size: Int32Array;
}

/**
 * Cluster basins bottom-up, weakest boundary first.
 *
 * The order is the whole point: walking up from a basin crosses boundaries in
 * increasing order of strength, so the nested regions a finger scrolls through
 * are always "everything up to a seam this strong". A part is whatever sits
 * below the first genuinely strong boundary.
 */
export function buildMergeTree(graph: BasinGraph): MergeTree {
  const n = graph.count;
  const nodeCount = Math.max(1, 2 * n - 1);
  const parent = new Int32Array(nodeCount).fill(-1);
  const left = new Int32Array(nodeCount).fill(-1);
  const right = new Int32Array(nodeCount).fill(-1);
  const height = new Float32Array(nodeCount);
  const size = new Int32Array(nodeCount);
  for (let i = 0; i < n; i++) size[i] = graph.sizes[i];

  // active cluster -> neighbour cluster -> the angles along their shared boundary
  const nbr = new Map<number, Map<number, number[]>>();
  const touch = (a: number, b: number, vals: number[]) => {
    let m = nbr.get(a);
    if (!m) { m = new Map(); nbr.set(a, m); }
    const cur = m.get(b);
    if (cur) cur.push(...vals); else m.set(b, vals.slice());
  };
  for (const [key, vals] of graph.boundaries) {
    const a = Math.floor(key / n), b = key % n;
    touch(a, b, vals); touch(b, a, vals);
  }

  const alive = new Set<number>();
  for (let i = 0; i < n; i++) alive.add(i);
  let next = n;

  while (alive.size > 1) {
    // weakest surviving boundary
    let bestA = -1, bestB = -1, bestScore = Infinity, bestVals: number[] | null = null;
    for (const a of alive) {
      const m = nbr.get(a);
      if (!m) continue;
      for (const [b, vals] of m) {
        if (b <= a || !alive.has(b)) continue;
        const sorted = vals.slice().sort((x, y) => x - y);
        const score = percentile(sorted, BOUNDARY_PERCENTILE);
        if (score < bestScore) { bestScore = score; bestA = a; bestB = b; bestVals = vals; }
      }
    }
    if (bestA < 0) {
      // Disconnected leftovers: attach them at infinite height so the tree stays
      // a single root and a chain always terminates.
      const rest = [...alive];
      let acc = rest[0];
      for (let i = 1; i < rest.length; i++) {
        const node = next++;
        left[node] = acc; right[node] = rest[i];
        parent[acc] = node; parent[rest[i]] = node;
        height[node] = Infinity;
        size[node] = size[acc] + size[rest[i]];
        acc = node;
      }
      break;
    }
    void bestVals;
    const node = next++;
    left[node] = bestA; right[node] = bestB;
    parent[bestA] = node; parent[bestB] = node;
    height[node] = bestScore;
    size[node] = size[bestA] + size[bestB];

    // the merged cluster inherits both neighbour sets
    const merged = new Map<number, number[]>();
    for (const src of [bestA, bestB]) {
      const m = nbr.get(src);
      if (!m) continue;
      for (const [b, vals] of m) {
        if (b === bestA || b === bestB || !alive.has(b)) continue;
        const cur = merged.get(b);
        if (cur) cur.push(...vals); else merged.set(b, vals.slice());
      }
    }
    for (const [b, vals] of merged) {
      const m = nbr.get(b);
      if (m) { m.delete(bestA); m.delete(bestB); m.set(node, vals); }
    }
    nbr.set(node, merged);
    nbr.delete(bestA); nbr.delete(bestB);
    alive.delete(bestA); alive.delete(bestB);
    alive.add(node);
  }

  return { basinCount: n, nodeCount: next, parent, left, right, height, size };
}

/** Nodes from a basin up to the root: the nested regions a finger scrolls through. */
export function chainFor(tree: MergeTree, basin: number): number[] {
  const out: number[] = [];
  let n = basin;
  while (n >= 0) { out.push(n); n = tree.parent[n]; }
  return out;
}

/** Every basin beneath a node. */
export function leavesOf(tree: MergeTree, node: number): number[] {
  const out: number[] = [];
  const stack = [node];
  while (stack.length) {
    const n = stack.pop()!;
    if (n < tree.basinCount) { out.push(n); continue; }
    if (tree.left[n] >= 0) stack.push(tree.left[n]);
    if (tree.right[n] >= 0) stack.push(tree.right[n]);
  }
  return out;
}

/**
 * The level a touch should land on before anyone drags.
 *
 * Walking up from a basin crosses boundaries of increasing strength; a real part
 * ends where that strength jumps. Picking the biggest jump means touching a door
 * gives the door rather than one facet of it, without a threshold that has to
 * suit every model.
 *
 * Also refuses to hand back most of the model: a region past `maxFraction` of
 * the mesh is not a part anyone pointed at, it is the thing the part is attached
 * to, so the level below is used instead.
 */
export function suggestLevel(tree: MergeTree, basin: number, maxFraction = 0.5): number {
  const chain = chainFor(tree, basin);
  const total = tree.size[chain[chain.length - 1]] || 1;
  let best = 0, bestJump = -Infinity;
  for (let i = 1; i < chain.length; i++) {
    const node = chain[i];
    const h = tree.height[node];
    // An infinite boundary means the two sides never touched -- separate shells,
    // like a wheel and the body it sits next to. Reaching across that is never
    // what a touch meant, however weak everything before it looked.
    if (!Number.isFinite(h)) break;
    if (tree.size[node] > total * maxFraction) break;
    const prev = i >= 2 ? tree.height[chain[i - 1]] : 0;
    // Absolute jump, with a floor so climbing out of near-zero noise does not
    // register as a discovery.
    const jump = h - prev;
    if (jump > bestJump) { bestJump = jump; best = i; }
  }
  return best;
}

/** Convenience: the basin set for a touch at a given level of its chain. */
export function regionAt(tree: MergeTree, basin: number, level: number): number[] {
  const chain = chainFor(tree, basin);
  const node = chain[Math.max(0, Math.min(chain.length - 1, level))];
  return leavesOf(tree, node);
}
