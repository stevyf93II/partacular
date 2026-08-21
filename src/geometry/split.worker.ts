import { splitConnectedComponents, capGroups, SplitResult } from './split';
import { MeshoptSimplifier } from 'meshoptimizer';
import { watershedSegment } from './segment';

const MAX_PARTS = 100;
// Components bigger than this are fused blobs (AI meshes weld doors to bodies);
// refine them with watershed auto-segmentation.
const SMART_REFINE_ABOVE_TRIS = 300_000;

self.onmessage = async (e: MessageEvent) => {
  const { positions, index, jobId } = e.data as { positions: Float32Array; index: Uint32Array | null; jobId: number };
  try {
    let res: SplitResult = splitConnectedComponents({ positions, index });
    res = capGroups(res, MAX_PARTS);

    // ---- smart refine: watershed-segment each large fused component ----
    const triCount = res.triGroup.length;
    const sizes = new Map<number, number>();
    for (let t = 0; t < triCount; t++) sizes.set(res.triGroup[t], (sizes.get(res.triGroup[t]) || 0) + 1);
    const bigGroups = [...sizes.entries()].filter(([, s]) => s > SMART_REFINE_ABOVE_TRIS).map(([g]) => g);
    if (bigGroups.length > 0) {
      await MeshoptSimplifier.ready;
      const vid = (t: number, c: number) => (index ? index[t * 3 + c] : t * 3 + c);
      let nextGroup = res.groupCount;
      const newTriGroup = new Uint32Array(res.triGroup);
      for (const g of bigGroups) {
        // extract this component as a soup (remembering source triangles)
        const triIds: number[] = [];
        for (let t = 0; t < triCount; t++) if (res.triGroup[t] === g) triIds.push(t);
        const soup = new Float32Array(triIds.length * 9);
        for (let k = 0; k < triIds.length; k++) {
          for (let c = 0; c < 3; c++) {
            const v = vid(triIds[k], c) * 3;
            soup[k * 9 + c * 3] = positions[v];
            soup[k * 9 + c * 3 + 1] = positions[v + 1];
            soup[k * 9 + c * 3 + 2] = positions[v + 2];
          }
        }
        const seg = watershedSegment(MeshoptSimplifier, soup, {});
        if (seg.groupCount <= 1) continue;
        for (let k = 0; k < triIds.length; k++) {
          const sg = seg.triGroup[k];
          newTriGroup[triIds[k]] = sg === 0 ? g : nextGroup + sg - 1; // label 0 keeps original id
        }
        nextGroup += seg.groupCount - 1;
      }
      const counts = new Uint32Array(nextGroup);
      for (let t = 0; t < triCount; t++) counts[newTriGroup[t]]++;
      res = capGroups({ triGroup: newTriGroup, groupCount: nextGroup, groupTriCounts: counts }, MAX_PARTS);
    }

    (self as unknown as Worker).postMessage(
      { jobId, ok: true, triGroup: res.triGroup, groupCount: res.groupCount, groupTriCounts: res.groupTriCounts },
      [res.triGroup.buffer as ArrayBuffer]
    );
  } catch (err) {
    (self as unknown as Worker).postMessage({ jobId, ok: false, error: String(err) });
  }
};
