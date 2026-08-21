// Official acceptance preview: runs THE production pipeline (splitPipeline.smartSplit)
// with THE shipped config (segmentation.config.ts) on a model, renders previews with
// the config embedded, prints the fingerprint. Only previews from this script may
// be presented for acceptance.
import fs from 'node:fs';
import { loadPipeline, readGLB, ground, fingerprint, renderPreview, sha256File } from './lib.mjs';

const model = process.argv[2] || 'reference/diablo.glb';
const outDir = process.argv[3] || '.';
const { smartSplit, SEGMENTATION_CONFIG, MeshoptSimplifier } = await loadPipeline();
const { positions, index } = readGLB(model);
ground(positions);
const t0 = Date.now();
const res = smartSplit(MeshoptSimplifier, positions, index, SEGMENTATION_CONFIG);
const fp = fingerprint(res, SEGMENTATION_CONFIG);
const cfgJson = JSON.stringify({ config: SEGMENTATION_CONFIG, model, modelSha256: sha256File(model), fingerprint: fp.hash });
await renderPreview(positions, index, res, `${outDir}/preview-side.png`, [2, 1, 0], cfgJson);
await renderPreview(positions, index, res, `${outDir}/preview-top.png`, [2, 0, 1], cfgJson);
const meta = { model, modelSha256: sha256File(model), params: SEGMENTATION_CONFIG, fingerprint: fp, ms: Date.now() - t0 };
fs.writeFileSync(`${outDir}/preview-meta.json`, JSON.stringify(meta, null, 2));
console.log(JSON.stringify({ partCount: fp.partCount, hash: fp.hash, ms: meta.ms, topSizes: fp.sortedSizes.slice(0, 8) }));
