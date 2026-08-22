// Thin worker shell around the pick core (same pattern as split.worker).
//
// Building the basin graph means running the segmentation analysis once, which
// takes ~25s on a 2M-triangle model. That must never touch the main thread --
// the whole point of touch-to-select is that the app stays live.
import { MeshoptSimplifier } from 'meshoptimizer';
import { watershedSegment, SegmentTrace } from './segment.js';
import { SEGMENTATION_CONFIG } from './segmentation.config.js';
import { buildBasinGraph, buildMergeTree } from './pick.js';

self.onmessage = async (e: MessageEvent) => {
  const { jobId, positions, index } = e.data as {
    jobId: number; positions: Float32Array; index: Uint32Array | null;
  };
  try {
    await MeshoptSimplifier.ready;

    // watershedSegment wants a soup; build one and remember nothing else.
    const triCount = index ? index.length / 3 : positions.length / 9;
    const soup = new Float32Array(triCount * 9);
    for (let t = 0; t < triCount; t++) {
      for (let c = 0; c < 3; c++) {
        const v = (index ? index[t * 3 + c] : t * 3 + c) * 3;
        soup[t * 9 + c * 3] = positions[v];
        soup[t * 9 + c * 3 + 1] = positions[v + 1];
        soup[t * 9 + c * 3 + 2] = positions[v + 2];
      }
    }

    const trace: Partial<SegmentTrace> = {};
    watershedSegment(MeshoptSimplifier, soup, SEGMENTATION_CONFIG, trace);
    if (!trace.basins || !trace.proxyOf) throw new Error('segmentation produced no basins');

    const graph = buildBasinGraph(trace as SegmentTrace);
    const tree = buildMergeTree(graph);

    // Collapse proxy indirection now: the client only ever needs "which basin is
    // this triangle in", and one flat array beats two lookups per triangle.
    const basinOfTri = new Int32Array(triCount);
    for (let t = 0; t < triCount; t++) {
      const p = trace.proxyOf[t];
      basinOfTri[t] = p >= 0 ? graph.basinOf[p] : -1;
    }

    (self as unknown as Worker).postMessage({
      jobId, ok: true,
      basinOfTri,
      basinCount: graph.count,
      tree: {
        basinCount: tree.basinCount, nodeCount: tree.nodeCount,
        parent: tree.parent, left: tree.left, right: tree.right,
        height: tree.height, size: tree.size,
      },
    }, [
      basinOfTri.buffer as ArrayBuffer,
      tree.parent.buffer as ArrayBuffer, tree.left.buffer as ArrayBuffer,
      tree.right.buffer as ArrayBuffer, tree.height.buffer as ArrayBuffer,
      tree.size.buffer as ArrayBuffer,
    ]);
  } catch (err) {
    (self as unknown as Worker).postMessage({ jobId, ok: false, error: String(err) });
  }
};
