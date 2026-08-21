// THE production split pipeline — the ONLY entry point for splitting a model.
// The worker calls this; the preview script calls this; the deploy gate calls
// this. One call path (Steve directive 2026-08-21): a preview generated any
// other way must never be presented for acceptance.
import { splitConnectedComponents, capGroups, SplitResult } from './split.js';
import { watershedSegment, assertSegmentConfig, SimplifierLike } from './segment.js';
import type { PipelineConfig } from './segmentation.config.js';

export function assertPipelineConfig(cfg: Partial<PipelineConfig> | undefined): asserts cfg is PipelineConfig {
  assertSegmentConfig(cfg);
  const c = cfg as Partial<PipelineConfig>;
  for (const k of ['refineAboveTris', 'maxParts'] as const) {
    const v = c[k];
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`pipeline config missing tuned knob: ${k}`);
  }
}

export function smartSplit(
  simplifier: SimplifierLike,
  positions: Float32Array,
  index: Uint32Array | null,
  cfg: PipelineConfig,
): SplitResult {
  assertPipelineConfig(cfg);
  let res: SplitResult = splitConnectedComponents({ positions, index });
  res = capGroups(res, cfg.maxParts);

  const triCount = res.triGroup.length;
  const sizes = new Map<number, number>();
  for (let t = 0; t < triCount; t++) sizes.set(res.triGroup[t], (sizes.get(res.triGroup[t]) || 0) + 1);
  const bigGroups = [...sizes.entries()].filter(([, s]) => s > cfg.refineAboveTris).map(([g]) => g);
  if (bigGroups.length === 0) return res;

  const vid = (t: number, c: number) => (index ? index[t * 3 + c] : t * 3 + c);
  let nextGroup = res.groupCount;
  const newTriGroup = new Uint32Array(res.triGroup);
  for (const g of bigGroups) {
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
    const seg = watershedSegment(simplifier, soup, cfg);
    if (seg.groupCount <= 1) continue;
    for (let k = 0; k < triIds.length; k++) {
      const sg = seg.triGroup[k];
      newTriGroup[triIds[k]] = sg === 0 ? g : nextGroup + sg - 1; // label 0 keeps original id
    }
    nextGroup += seg.groupCount - 1;
  }
  const counts = new Uint32Array(nextGroup);
  for (let t = 0; t < triCount; t++) counts[newTriGroup[t]]++;
  return capGroups({ triGroup: newTriGroup, groupCount: nextGroup, groupTriCounts: counts }, cfg.maxParts);
}
