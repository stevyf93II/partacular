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
  boundaries: Map<number, Float32Array>;
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

  const gathered = new Map<number, number[]>();
  for (let i = 0; i < edgeInfo.length; i++) {
    const a = basinOf[edgeInfo[i][0]], b = basinOf[edgeInfo[i][1]];
    if (a === b) continue;
    const key = a < b ? a * count + b : b * count + a;
    let arr = gathered.get(key);
    if (!arr) { arr = []; gathered.set(key, arr); }
    arr.push(edgeConc[i]);
  }
  const boundaries = new Map<number, Float32Array>();
  for (const [k, v] of gathered) boundaries.set(k, Float32Array.from(v));
  void adj;
  return { count, basinOf, sizes, boundaries };
}

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

export interface Ladder {
  /** the basin under the finger */
  seed: number;
  /** basins in the order they are absorbed; order[0] is the seed */
  order: Int32Array;
  /** boundary strength crossed to absorb order[i], radians; order[0] is 0 */
  strength: Float32Array;
  /** proxy faces held after i+1 basins */
  cumulative: Int32Array;
  /** rung a touch lands on before anyone drags */
  suggested: number;
}

/** Strength of a boundary from its concave angles. */
function strengthOf(angles: ArrayLike<number>): number {
  if (angles.length === 0) return Infinity;
  const sorted = Array.prototype.slice.call(angles).sort((a: number, b: number) => a - b) as number[];
  // A percentile, not a mean: half of any boundary's edges are triangulation
  // diagonals carrying no concavity, and averaging over them halves the score
  // for reasons that have nothing to do with the shape.
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * BOUNDARY_PERCENTILE))];
}

/**
 * Grow outward from one basin, absorbing ONE neighbour at a time.
 *
 * This replaced a global merge tree, which clustered the whole model bottom-up
 * and then read a chain out of it. The chain was useless to drag along: by the
 * time it reached the touched basin it was swallowing clusters formed elsewhere,
 * so three presses of More went from a fragment to most of the car.
 *
 * Growing locally means every rung is exactly one more neighbouring basin, in
 * order of how hard the boundary between it and the region already held is. The
 * ladder has as many rungs as there are basins, and each is a small step.
 */
export function buildLadder(graph: BasinGraph, seed: number): Ladder {
  const n = graph.count;
  const order: number[] = [seed];
  const strength: number[] = [0];
  const cumulative: number[] = [graph.sizes[seed] ?? 0];
  if (seed < 0 || seed >= n) {
    return {
      seed, order: Int32Array.from(order), strength: Float32Array.from(strength),
      cumulative: Int32Array.from(cumulative), suggested: 0,
    };
  }

  const inRegion = new Uint8Array(n);
  inRegion[seed] = 1;

  // frontier: neighbouring basin -> every angle along its boundary with the
  // region as a whole, which is what its strength has to be measured over.
  const frontier = new Map<number, number[]>();
  const addNeighbours = (b: number) => {
    for (let other = 0; other < n; other++) {
      if (other === b || inRegion[other]) continue;
      const key = b < other ? b * n + other : other * n + b;
      const angles = graph.boundaries.get(key);
      if (!angles) continue;
      let acc = frontier.get(other);
      if (!acc) { acc = []; frontier.set(other, acc); }
      for (let i = 0; i < angles.length; i++) acc.push(angles[i]);
    }
  };
  addNeighbours(seed);

  while (frontier.size) {
    // Weakest boundary first -- but never let one rung swallow the model.
    //
    // A small basin's weakest neighbour is very often the huge one it is
    // attached to, so pure weakest-first went 6% -> 32% in a single press and
    // most of the car within three. A rung that multiplies the selection
    // several times over is not a step, it is a leap, so oversized neighbours
    // wait until every smaller one has been taken. They are still reachable;
    // they just stop being rung one.
    const held = cumulative[cumulative.length - 1];
    const roomy = Math.max(held, 1) * 2;
    let best = -1, bestScore = Infinity;
    let anyBest = -1, anyScore = Infinity;
    for (const [b, angles] of frontier) {
      const sc = strengthOf(angles);
      if (sc < anyScore) { anyScore = sc; anyBest = b; }
      if ((graph.sizes[b] ?? 0) <= roomy && sc < bestScore) { bestScore = sc; best = b; }
    }
    if (best < 0) { best = anyBest; bestScore = anyScore; }
    if (best < 0) break;
    frontier.delete(best);
    inRegion[best] = 1;
    order.push(best);
    strength.push(bestScore);
    cumulative.push(cumulative[cumulative.length - 1] + (graph.sizes[best] ?? 0));
    addNeighbours(best);
  }

  const lad: Ladder = {
    seed,
    order: Int32Array.from(order),
    strength: Float32Array.from(strength),
    cumulative: Int32Array.from(cumulative),
    suggested: 0,
  };
  lad.suggested = suggestRung(lad, graph);
  return lad;
}

/**
 * The rung a touch should land on.
 *
 * Growing crosses boundaries of rising strength, and a real part ends where
 * that strength jumps. Stop just before the biggest jump -- and never cross a
 * boundary that does not exist at all, which means the next basin is a separate
 * shell entirely, like a wheel beside the body it sits against.
 */
export function suggestRung(lad: Ladder, graph: BasinGraph, maxFraction = 0.5): number {
  let total = 0;
  for (let i = 0; i < graph.count; i++) total += graph.sizes[i];
  total = total || 1;

  let best = 0, bestJump = -Infinity;
  for (let i = 1; i < lad.order.length; i++) {
    const h = lad.strength[i];
    if (!Number.isFinite(h)) break;
    if (lad.cumulative[i] > total * maxFraction) break;
    const jump = h - lad.strength[i - 1];
    if (jump > bestJump) { bestJump = jump; best = i; }
  }
  return best;
}

/** The basins held at a given rung. */
export function basinsAt(lad: Ladder, rung: number): number[] {
  const r = Math.max(0, Math.min(lad.order.length - 1, rung));
  const out: number[] = [];
  for (let i = 0; i <= r; i++) out.push(lad.order[i]);
  return out;
}

/**
 * Clean the basin assignment the same way the pipeline cleans its own labels.
 *
 * Full-resolution triangles take their basin from the NEAREST proxy face, and
 * across a 13:1 decimation that speckles catastrophically: measured on a
 * 2M-triangle car, 36 basins arrived as 4,875 disconnected islands. A selection
 * built on that comes back full of holes, which is exactly what it looked like.
 *
 * Three stages, each doing work the previous cannot:
 *   majority vote   fixes single stray triangles          4875 -> 3687
 *   island absorb   fixes specks inside another region    3687 ->  176
 *   small sweep     fixes the rest, whatever their label   176 ->   59
 *
 * The sweep matters because absorption protects the LARGEST island of every
 * label, so two small islands of different labels sitting side by side keep
 * each other alive forever -- it oscillates instead of converging.
 *
 * Everything below is written against preallocated typed arrays and integer
 * indices. The obvious version -- a callback per triangle and a Map of Maps per
 * island -- ran 2M closure calls and 2M Map lookups per round over fifteen
 * rounds, and did not finish inside a minute on this model.
 */
export function despeckle(basinOfTri: Int32Array, nb: Int32Array, nbCount: Uint8Array, basinCount: number) {
  const n = basinOfTri.length;

  // ---- majority vote: single stray triangles ----
  const next = new Int32Array(n);
  for (let pass = 0; pass < 2; pass++) {
    next.set(basinOfTri);
    for (let k = 0; k < n; k++) {
      const mine = basinOfTri[k];
      const c = nbCount[k];
      if (c < 2) continue;
      const a = basinOfTri[nb[k * 3]];
      const b = basinOfTri[nb[k * 3 + 1]];
      const d = c === 3 ? basinOfTri[nb[k * 3 + 2]] : -2;
      if (a !== mine && (a === b || a === d)) next[k] = a;
      else if (b !== mine && b === d) next[k] = b;
    }
    basinOfTri.set(next);
  }

  // Buffers reused by every round; allocating these fifteen times over is
  // hundreds of megabytes of churn on a model this size.
  const comp = new Int32Array(n);
  const stack = new Int32Array(n);
  const sizes = new Int32Array(n);      // indexed by island id, far fewer used
  const labels = new Int32Array(n);

  /** Flood the label field into islands. Returns how many there are. */
  const findIslands = (): number => {
    comp.fill(-1);
    let count = 0;
    for (let seed = 0; seed < n; seed++) {
      if (comp[seed] !== -1) continue;
      const id = count++;
      const lab = basinOfTri[seed];
      labels[id] = lab;
      let size = 0, sp = 0;
      stack[sp++] = seed;
      comp[seed] = id;
      while (sp > 0) {
        const f = stack[--sp];
        size++;
        const c = nbCount[f];
        for (let e = 0; e < c; e++) {
          const g = nb[f * 3 + e];
          if (comp[g] === -1 && basinOfTri[g] === lab) { comp[g] = id; stack[sp++] = g; }
        }
      }
      sizes[id] = size;
    }
    return count;
  };

  /**
   * Every island flagged in `doomed` adopts the label most common around its
   * border. `donorOk` decides which neighbours may donate -- without it two
   * doomed neighbours simply swap labels forever instead of converging.
   *
   * Votes go into a dense table indexed by (doomed island, label). Labels are
   * few, and only doomed islands need a row, so the table stays small even when
   * the field starts out as thousands of specks. An earlier version tallied
   * into a Map it cleared when the island id changed, which quietly did the
   * wrong thing: a flood does not visit an island's triangles contiguously.
   */
  const dense = new Int32Array(n);
  const rehome = (count: number, doomed: Uint8Array, donorOk: Uint8Array | null): number => {
    let rows = 0;
    for (let c = 0; c < count; c++) dense[c] = doomed[c] ? rows++ : -1;
    if (rows === 0) return 0;

    const table = new Int32Array(rows * basinCount);
    for (let k = 0; k < n; k++) {
      const row = dense[comp[k]];
      if (row < 0) continue;
      const c = comp[k];
      const nc = nbCount[k];
      for (let e = 0; e < nc; e++) {
        const g = nb[k * 3 + e];
        const gc = comp[g];
        if (gc === c) continue;
        if (donorOk && !donorOk[gc]) continue;
        table[row * basinCount + basinOfTri[g]]++;
      }
    }

    const winner = new Int32Array(rows).fill(-1);
    for (let r = 0; r < rows; r++) {
      let best = -1, bestN = 0;
      for (let l = 0; l < basinCount; l++) {
        const v = table[r * basinCount + l];
        if (v > bestN) { bestN = v; best = l; }
      }
      winner[r] = best;
    }

    let moved = 0;
    for (let k = 0; k < n; k++) {
      const row = dense[comp[k]];
      if (row < 0) continue;
      const lab = winner[row];
      if (lab >= 0 && lab !== basinOfTri[k]) { basinOfTri[k] = lab; moved++; }
    }
    return moved;
  };

  // ---- islands that are not the main body of their own label ----
  const doomed = new Uint8Array(n);
  const biggestOfLabel = new Int32Array(basinCount);
  for (let round = 0; round < 3; round++) {
    const count = findIslands();
    biggestOfLabel.fill(-1);
    for (let c = 0; c < count; c++) {
      const b = biggestOfLabel[labels[c]];
      if (b < 0 || sizes[c] > sizes[b]) biggestOfLabel[labels[c]] = c;
    }
    doomed.fill(0, 0, count);
    let any = 0;
    for (let c = 0; c < count; c++) {
      if (biggestOfLabel[labels[c]] !== c) { doomed[c] = 1; any++; }
    }
    if (!any || !rehome(count, doomed, null)) break;
  }

  // ---- anything still small, whatever its label ----
  const floor = Math.max(64, Math.floor(n * 0.0001));
  const survivor = new Uint8Array(n);
  for (let iter = 0; iter < 4; iter++) {
    const count = findIslands();
    doomed.fill(0, 0, count);
    survivor.fill(0, 0, count);
    let any = 0;
    for (let c = 0; c < count; c++) {
      if (sizes[c] < floor) { doomed[c] = 1; any++; } else survivor[c] = 1;
    }
    if (!any || !rehome(count, doomed, survivor)) break;
  }
}
