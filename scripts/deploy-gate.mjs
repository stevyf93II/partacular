// DEPLOY GATE — mechanical, not judgment.
//
// Runs THE shipped code path (splitPipeline.smartSplit + segmentation.config.ts)
// over a corpus of models and checks each result against a RANGE.
//
// What changed from the single-model fingerprint gate, and why:
//
//   * The old gate hashed the per-triangle labels of ONE model (reference/diablo.glb)
//     and failed on any difference. That forbids every change: tuning that helps a
//     second model necessarily moves the first model's hash, and with one model in
//     the lockfile there was no way to weigh the trade -- only to see that something
//     moved. The machinery built to stop thrashing became the thing preventing
//     improvement.
//
//   * That model is 49MB and not in git, so CI ran GATE_LITE and checked only that
//     two copies of the same numbers matched each other. No output was ever verified
//     on the build machine.
//
//   * The corpus is generated in code (test/fixtures.mjs), so it is in git, runs
//     everywhere, and each entry has semantics a human can argue with: a peanut must
//     split, a sphere must not.
//
// What is still guaranteed: ONE call path. The gate, the preview and the app all
// enter through smartSplit with the shipped config, so what is measured is what
// ships. Determinism is still checked exactly -- same input twice, same labels.
import fs from 'node:fs';
import { runCorpus, formatRow } from './corpus.mjs';

function fail(msg) { console.error('\nGATE FAIL: ' + msg); process.exit(1); }

const strict = process.env.GATE_STRICT === '1';
const { rows, config } = await runCorpus({ checkDeterminism: true });

console.error('\nCORPUS GATE — shipped pipeline over ' + rows.length + ' entries');
console.error('config: ' + JSON.stringify(config) + '\n');
for (const r of rows) console.error(formatRow(r));

const active = rows.filter(r => !r.missing && !r.absent);
const required = active.filter(r => r.status === 'required');
const brokenRequired = required.filter(r => !r.pass);
const nondeterministic = active.filter(r => r.deterministic === false);
const improved = active.filter(r => r.status === 'failing' && r.pass);
const knownGaps = active.filter(r => r.status === 'failing' && !r.pass);
const missing = rows.filter(r => r.missing);

console.error('');
if (improved.length) {
  console.error('IMPROVED: ' + improved.map(r => r.name).join(', ') +
    ' now meet their expectation. Set status to "required" in corpus.json to lock this in.');
}
if (knownGaps.length) {
  console.error('KNOWN GAPS (tracked, not blocking): ' + knownGaps.map(r => r.name).join(', '));
}

// ---- optional: the original reference model, when it happens to be present ----
const model = rows.find(r => r.kind === 'model' && !r.absent);
if (model && fs.existsSync('accepted.json')) {
  const accepted = JSON.parse(fs.readFileSync('accepted.json', 'utf8'));
  if (accepted.fingerprint) {
    const same = model.fingerprint.hash === accepted.fingerprint.hash;
    console.error(`\nreference fingerprint: ${model.fingerprint.partCount} parts ` +
      `${model.fingerprint.hash.slice(0, 12)} vs accepted ${accepted.fingerprint.partCount} parts ` +
      `${accepted.fingerprint.hash.slice(0, 12)} — ${same ? 'identical' : 'CHANGED'}`);
    // Reported, not fatal by default: the corpus ranges are the real guard now, and
    // this hash's job is to tell you something moved. GATE_STRICT=1 restores the old
    // blocking behaviour for a release where you want output frozen exactly.
    if (!same && strict) fail('reference fingerprint changed and GATE_STRICT=1');
  }
}

if (missing.length) fail('corpus.json names fixtures that do not exist: ' + missing.map(r => r.name).join(', '));
if (nondeterministic.length) fail('same input produced different labels twice: ' + nondeterministic.map(r => r.name).join(', '));
if (brokenRequired.length) {
  fail('required corpus entries regressed:\n  ' +
    brokenRequired.map(r => `${r.name}: ${r.problems.join('; ')}`).join('\n  '));
}

console.error(`\nGATE PASS: ${required.length} required entries within range, ` +
  `${active.length} deterministic${knownGaps.length ? `, ${knownGaps.length} known gap(s) tracked` : ''}.`);
