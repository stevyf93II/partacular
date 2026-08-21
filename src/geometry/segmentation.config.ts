// THE shipped segmentation configuration — single source of truth.
// Every value here is a tuned knob: it exists in accepted.json too, and the
// deploy gate (scripts/deploy-gate.mjs) refuses to ship if this file, the
// lockfile, and the reference-model output disagree. Change a value here and
// the deploy gate fails until Steve accepts a new preview (scripts/accept.mjs).
import type { SegmentConfig } from './segment';

export interface PipelineConfig extends SegmentConfig {
  /** components larger than this triangle count get watershed-refined */
  refineAboveTris: number;
  /** hard cap on total parts */
  maxParts: number;
}

export const SEGMENTATION_CONFIG: PipelineConfig = {
  persistDeg: 10,
  minRegionFrac: 0.003,
  proxyTris: 150000,
  mergeStopDeg: 14,
  smoothIters: 3,
  thinnessFactor: 8,
  refineAboveTris: 300000,
  maxParts: 100,
};
