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
}

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

/** Cap group count: keep the biggest (cap-1) groups, merge the rest into one. Returns remapped result. */
export function capGroups(res: SplitResult, cap: number): SplitResult {
  if (res.groupCount <= cap) return res;
  const orderIdx = Array.from(res.groupTriCounts.keys())
    .sort((a, b) => res.groupTriCounts[b] - res.groupTriCounts[a]);
  const remap = new Uint32Array(res.groupCount);
  const newCounts = new Uint32Array(cap);
  for (let rank = 0; rank < res.groupCount; rank++) {
    const g = orderIdx[rank];
    const ng = rank < cap - 1 ? rank : cap - 1;
    remap[g] = ng;
  }
  const triGroup = new Uint32Array(res.triGroup.length);
  for (let t = 0; t < res.triGroup.length; t++) {
    const ng = remap[res.triGroup[t]];
    triGroup[t] = ng; newCounts[ng]++;
  }
  return { triGroup, groupCount: cap, groupTriCounts: newCounts };
}
