// Corpus runner: builds each entry, pushes it through THE shipped pipeline, and
// scores the result against a range. Shared by the deploy gate and by accept.
//
// The one call path rule is unchanged from the original gate: everything here
// goes through splitPipeline.smartSplit with segmentation.config.ts, so what is
// measured is exactly what ships. What changed is the yardstick -- a range over
// several models instead of an exact hash of one.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { loadPipeline, readGLB, ground, fingerprint } from './lib.mjs';
import { FIXTURES } from '../test/fixtures.mjs';

export function loadCorpus(file = 'corpus.json') {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** Part sizes, largest first. */
function partSizes(res) {
  const size = new Map();
  for (const g of res.triGroup) size.set(g, (size.get(g) || 0) + 1);
  return [...size.values()].sort((a, b) => b - a);
}

/** Stable hash of the label assignment — used ONLY to prove determinism. */
function labelHash(res) {
  return crypto.createHash('sha256').update(Buffer.from(res.triGroup.buffer)).digest('hex');
}

function score(entry, res, tris) {
  const sizes = partSizes(res);
  const e = entry.expect || {};
  const problems = [];
  if (e.minParts !== undefined && sizes.length < e.minParts) problems.push(`only ${sizes.length} parts, wanted at least ${e.minParts}`);
  if (e.maxParts !== undefined && sizes.length > e.maxParts) problems.push(`${sizes.length} parts, wanted at most ${e.maxParts}`);
  if (e.largestFractionMax !== undefined) {
    const frac = sizes[0] / tris;
    if (frac > e.largestFractionMax) problems.push(`biggest part is ${(frac * 100).toFixed(0)}% of the mesh, wanted under ${(e.largestFractionMax * 100).toFixed(0)}%`);
  }
  // A part of a handful of triangles is debris, not a part a person would name.
  const slivers = sizes.filter(s => s < Math.max(8, tris * 0.0002)).length;
  if (slivers > 0) problems.push(`${slivers} sliver part(s)`);
  return { sizes, problems, pass: problems.length === 0 };
}

/**
 * Run the whole corpus.
 * @param {object} opts
 * @param {boolean} opts.checkDeterminism run every entry twice and compare labels
 */
export async function runCorpus(opts = {}) {
  const corpus = loadCorpus(opts.file);
  const { smartSplit, SEGMENTATION_CONFIG, MeshoptSimplifier } = await loadPipeline();
  const rows = [];

  const run = (positions, index) => smartSplit(MeshoptSimplifier, positions, index, SEGMENTATION_CONFIG);

  for (const entry of corpus.fixtures) {
    const fixture = FIXTURES[entry.name];
    if (!fixture) { rows.push({ ...entry, kind: 'fixture', missing: true }); continue; }
    const soup = fixture.build();
    const tris = soup.length / 9;
    const t0 = Date.now();
    const res = run(soup, null);
    const ms = Date.now() - t0;
    const row = { ...entry, kind: 'fixture', tris, ms, ...score(entry, res, tris), hash: labelHash(res) };
    if (opts.checkDeterminism) {
      row.deterministic = labelHash(run(fixture.build(), null)) === row.hash;
    }
    rows.push(row);
  }

  for (const entry of corpus.localModels || []) {
    if (!fs.existsSync(entry.path)) { rows.push({ ...entry, name: entry.path, kind: 'model', absent: true }); continue; }
    const { positions, index } = readGLB(entry.path);
    ground(positions);
    const tris = index ? index.length / 3 : positions.length / 9;
    const t0 = Date.now();
    const res = run(positions, index);
    const row = {
      ...entry, name: entry.path, kind: 'model', tris, ms: Date.now() - t0,
      ...score(entry, res, tris),
      fingerprint: fingerprint(res, SEGMENTATION_CONFIG),
    };
    rows.push(row);
  }

  return { rows, config: SEGMENTATION_CONFIG };
}

export function formatRow(r) {
  if (r.missing) return `  ${r.name.padEnd(12)} MISSING — no such fixture in test/fixtures.mjs`;
  if (r.absent) return `  ${r.name.padEnd(12)} not present locally — skipped`;
  const want = `${r.expect.minParts ?? '?'}-${r.expect.maxParts ?? '?'}`;
  const verdict = r.status === 'failing'
    ? (r.pass ? 'NOW PASSES' : 'known gap')
    : (r.pass ? 'PASS' : 'FAIL');
  const det = r.deterministic === false ? '  NON-DETERMINISTIC' : '';
  return `  ${r.name.padEnd(12)} ${String(r.tris).padStart(8)} tris  ${String(r.sizes.length).padStart(3)} parts` +
    `  [want ${want}]  ${verdict.padEnd(10)} ${String(r.ms).padStart(5)}ms` +
    `  ${r.sizes.slice(0, 4).join('/')}${det}` +
    (r.problems.length ? `\n      ${r.problems.join('; ')}` : '');
}
