// Thin worker shell around the single production pipeline (splitPipeline.smartSplit).
import { MeshoptSimplifier } from 'meshoptimizer';
import { smartSplit, assertPipelineConfig } from './splitPipeline.js';
import { SEGMENTATION_CONFIG } from './segmentation.config.js';

self.onmessage = async (e: MessageEvent) => {
  const { positions, index, jobId } = e.data as { positions: Float32Array; index: Uint32Array | null; jobId: number };
  try {
    // NO DEFAULTS ON TUNED KNOBS: throw immediately if any is absent.
    assertPipelineConfig(SEGMENTATION_CONFIG);
    await MeshoptSimplifier.ready;
    const res = smartSplit(MeshoptSimplifier, positions, index, SEGMENTATION_CONFIG);
    (self as unknown as Worker).postMessage(
      { jobId, ok: true, triGroup: res.triGroup, groupCount: res.groupCount, groupTriCounts: res.groupTriCounts,
        debrisGroup: res.debrisGroup ?? -1, debrisPieces: res.debrisPieces ?? 0 },
      [res.triGroup.buffer as ArrayBuffer]
    );
  } catch (err) {
    (self as unknown as Worker).postMessage({ jobId, ok: false, error: String(err) });
  }
};
