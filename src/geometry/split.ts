// Connected-components split over a triangle soup / indexed mesh.
// Pure arrays in, triangle-group labels out. No three.js dependency.

export interface SplitInput {
  positions: Float32Array;      // xyz per vertex
  index: Uint32Array | null;    // 3 per triangle, or null for soup (STL)
}

export interface SplitResult {
  triGroup: Uint32Array;        // group id per triangle
  groupCount: number;
  groupTriCounts: Uint32Array;  // triangles per group
  /** group holding everything too small to be a part, or -1 if there was none */
  debrisGroup?: number;
  /** how many separate scraps were swept into it */
  debrisPieces?: number;
}

/**
 * Fewer triangles than this cannot describe a solid anyone would print.
 *
 * Used together with the size test, not instead of it: the two catch different
 * junk. A dense speck fails the size test; a sliver spanning half the model in
 * one direction and nothing in the others fails this one.
 */
const ABSOLUTE_DEBRIS_FLOOR = 16;

class UnionFind {
  parent: Int32Array; rank: Uint8Array;
  constructor(n: number) {
    this.parent = new Int32Array(n); this.rank = new Uint8Array(n);
    for (let i = 0; i < n; i++) this.parent[i] = i;
  }
  find(x: number): number {
    let r = x;
    while (this.parent[r] !== r) r = this.parent[r];
    while (this.parent[x] !== r) { const nx = this.parent[x]; this.parent[x] = r; x = nx; }
    return r;
  }
  union(a: number, b: number) {
    const ra = this.find(a), rb = this.find(b);
    if (ra === rb) return;
    if (this.rank[ra] < this.rank[rb]) this.parent[ra] = rb;
    else if (this.rank[ra] > this.rank[rb]) this.parent[rb] = ra;
    else { this.parent[rb] = ra; this.rank[ra]++; }
  }
}

/** Dedup vertices by exact position so triangle soups (STL) connect. */
export function canonicalVertexIds(positions: Float32Array): Int32Array {
  const n = positions.length / 3;
  const canon = new Int32Array(n);
  const map = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    const key = positions[i * 3] + ',' + positions[i * 3 + 1] + ',' + positions[i * 3 + 2];
    const existing = map.get(key);
    if (existing === undefined) { map.set(key, i); canon[i] = i; }
    else canon[i] = existing;
  }
  return canon;
}

export function splitConnectedComponents(input: SplitInput): SplitResult {
  const { positions, index } = input;
  const vertCount = positions.length / 3;
  const triCount = index ? index.length / 3 : vertCount / 3;
  const canon = canonicalVertexIds(positions);
  const uf = new UnionFind(vertCount);
  const vid = (t: number, c: number) => index ? index[t * 3 + c] : t * 3 + c;
  for (let t = 0; t < triCount; t++) {
    const a = canon[vid(t, 0)], b = canon[vid(t, 1)], c = canon[vid(t, 2)];
    uf.union(a, b); uf.union(b, c);
  }
  const rootToGroup = new Map<number, number>();
  const triGroup = new Uint32Array(triCount);
  const counts: number[] = [];
  for (let t = 0; t < triCount; t++) {
    const root = uf.find(canon[vid(t, 0)]);
    let g = rootToGroup.get(root);
    if (g === undefined) { g = counts.length; rootToGroup.set(root, g); counts.push(0); }
    triGroup[t] = g; counts[g]++;
  }
  return { triGroup, groupCount: counts.length, groupTriCounts: Uint32Array.from(counts) };
}

/**
 * Keep the groups that are actually parts; sweep the rest into ONE.
 *
 * This used to cap by RANK -- keep the biggest `cap` groups, bucket the
 * remainder. On a mesh carrying hundreds of loose specks that is useless: the
 * "hundred biggest" groups are still ninety-nine specks, so the model arrives
 * as a hundred parts of which almost none can be pointed at, and clearing them
 * means deleting them one at a time.
 *
 * What decides now is how big a shell IS, not how many triangles it has.
 * Triangle count is the wrong test -- a speck can be dense and a whole car
 * panel can be coarse. A shell whose entire extent is under a fraction of the
 * model's own size cannot be seen, touched or printed, whatever it is made of.
 *
 * Everything below that joins one debris group, deletable in a single action
 * whether it holds three scraps or three hundred. Rank survives only as a
 * backstop for a model with more genuinely large shells than the cap allows.
 *
 * @param debrisFrac fraction of the model's diagonal below which a shell is debris
 */
export function capGroups(
  res: SplitResult,
  cap: number,
  debrisFrac = 0,
  mesh?: SplitInput,
  /**
   * A group already known to be debris from an earlier pass.
   *
   * Once scraps are swept together their combined bounding box spans the whole
   * model, so the size test stops recognising them. Without carrying the label
   * forward, a second pass hands the bucket back as if it were a real part.
   */
  knownDebris = -1,
): SplitResult {
  const totalTris = res.triGroup.length;
  const spans = debrisFrac > 0 && mesh ? groupSpans(res, mesh) : null;
  const modelSpan = spans ? spans.modelDiagonal : 0;
  const sizeFloor = modelSpan * debrisFrac;

  const keep: number[] = [];
  const debris: number[] = [];
  for (let g = 0; g < res.groupCount; g++) {
    const tooFewTriangles = debrisFrac > 0 && res.groupTriCounts[g] < ABSOLUTE_DEBRIS_FLOOR;
    const tooSmallToSee = spans ? spans.diagonals[g] < sizeFloor : false;
    if (g === knownDebris || tooFewTriangles || tooSmallToSee) debris.push(g); else keep.push(g);
  }
  keep.sort((a, b) => res.groupTriCounts[b] - res.groupTriCounts[a]);

  // Backstop: more big shells than the cap allows. The overflow is genuinely
  // large geometry, so it goes to debris only because there is nowhere else.
  if (keep.length > cap - (debris.length ? 1 : 0)) {
    const room = Math.max(1, cap - 1);
    for (const g of keep.splice(room)) debris.push(g);
  }
  if (keep.length === 0 && debris.length) keep.push(debris.pop()!); // never return nothing

  if (debris.length === 0 && keep.length === res.groupCount) return res;

  const groupCount = keep.length + (debris.length ? 1 : 0);
  const debrisGroup = debris.length ? keep.length : -1;
  const remap = new Uint32Array(res.groupCount).fill(debrisGroup >= 0 ? debrisGroup : 0);
  keep.forEach((g, i) => { remap[g] = i; });

  const triGroup = new Uint32Array(totalTris);
  const newCounts = new Uint32Array(groupCount);
  for (let t = 0; t < totalTris; t++) {
    const ng = remap[res.triGroup[t]];
    triGroup[t] = ng; newCounts[ng]++;
  }
  return {
    triGroup, groupCount, groupTriCounts: newCounts,
    debrisGroup, debrisPieces: debris.length,
  };
}

/** Bounding-box diagonal of every group, and of the whole mesh. */
function groupSpans(res: SplitResult, mesh: SplitInput): { diagonals: Float64Array; modelDiagonal: number } {
  const { positions, index } = mesh;
  const n = res.groupCount;
  const lo = new Float64Array(n * 3).fill(Infinity);
  const hi = new Float64Array(n * 3).fill(-Infinity);
  let mlo = [Infinity, Infinity, Infinity], mhi = [-Infinity, -Infinity, -Infinity];
  const triCount = res.triGroup.length;
  for (let t = 0; t < triCount; t++) {
    const g = res.triGroup[t];
    for (let c = 0; c < 3; c++) {
      const v = (index ? index[t * 3 + c] : t * 3 + c) * 3;
      for (let a = 0; a < 3; a++) {
        const p = positions[v + a];
        if (p < lo[g * 3 + a]) lo[g * 3 + a] = p;
        if (p > hi[g * 3 + a]) hi[g * 3 + a] = p;
        if (p < mlo[a]) mlo[a] = p;
        if (p > mhi[a]) mhi[a] = p;
      }
    }
  }
  const diagonals = new Float64Array(n);
  for (let g = 0; g < n; g++) {
    diagonals[g] = Math.hypot(
      hi[g * 3] - lo[g * 3], hi[g * 3 + 1] - lo[g * 3 + 1], hi[g * 3 + 2] - lo[g * 3 + 2]);
  }
  return {
    diagonals,
    modelDiagonal: Math.hypot(mhi[0] - mlo[0], mhi[1] - mlo[1], mhi[2] - mlo[2]) || 1,
  };
}
