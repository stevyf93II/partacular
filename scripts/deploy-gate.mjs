// DEPLOY GATE — mechanical, not judgment. Re-runs the SHIPPED code path
// (splitPipeline.smartSplit + segmentation.config.ts) on the reference model
// and diffs params AND output fingerprint against accepted.json.
// Nonzero exit on ANY mismatch; the deploy command chains on this exit code.
import fs from 'node:fs';
import { loadPipeline, readGLB, ground, fingerprint, sha256File } from './lib.mjs';

function fail(msg) { console.error('GATE FAIL:', msg); process.exit(1); }

if (!fs.existsSync('accepted.json')) fail('accepted.json missing — nothing has been accepted, nothing may deploy');
const accepted = JSON.parse(fs.readFileSync('accepted.json'));

const { smartSplit, SEGMENTATION_CONFIG, MeshoptSimplifier } = await loadPipeline();

// 1) params: shipped config must equal accepted params exactly
const a = accepted.params, b = SEGMENTATION_CONFIG;
const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
const diffs = [...keys].filter(k => a[k] !== b[k]).map(k => `${k}: accepted=${a[k]} shipped=${b[k]}`);
if (diffs.length) {
  console.error('GATE: shipped segmentation.config.ts does not match accepted.json:\n  ' + diffs.join('\n  '));
}

// GATE_LITE (CI): the 49MB reference model is not in git, so CI verifies the
// params half only — the full fingerprint gate runs locally before push.
if (process.env.GATE_LITE === '1') {
  if (diffs.length) fail('param mismatch (above)');
  console.error('GATE-LITE PASS (CI): shipped config matches accepted.json. Fingerprint check requires the local reference model — run `npm run gate` locally for the full gate.');
  process.exit(0);
}

if (!fs.existsSync(accepted.model)) fail(`reference model ${accepted.model} not present — cannot verify, cannot deploy`);
if (sha256File(accepted.model) !== accepted.modelSha256) fail('reference model sha256 differs from accepted.json — wrong model');

// 2) fingerprint: run the shipped path on the reference model regardless, so the
// report always shows what would actually ship
const { positions, index } = readGLB(accepted.model);
ground(positions);
console.error('GATE: running shipped pipeline on', accepted.model, '…');
const res = smartSplit(MeshoptSimplifier, positions, index, SEGMENTATION_CONFIG);
const fp = fingerprint(res, SEGMENTATION_CONFIG);
console.error(`GATE: shipped output: ${fp.partCount} parts, hash ${fp.hash.slice(0, 16)}…`);
console.error(`GATE: accepted:       ${accepted.fingerprint.partCount} parts, hash ${accepted.fingerprint.hash.slice(0, 16)}…`);

if (diffs.length) fail('param mismatch (above)');
if (fp.partCount !== accepted.fingerprint.partCount || fp.hash !== accepted.fingerprint.hash)
  fail('output fingerprint differs from accepted preview — shipped ≠ shown');
console.error('GATE PASS: shipped code path reproduces the accepted preview exactly.');
