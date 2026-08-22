// Accept the current segmentation behaviour.
//
// Under the old single-model gate this froze one model's exact output hash, so
// "accept" meant "forbid all further change". Here it means the opposite: lock
// in improvements. Any corpus entry marked as a known gap that now meets its
// expectation is promoted to required, so it can never silently regress again.
//
// Run AFTER reviewing a preview -- this writes what the gate will enforce.
import fs from 'node:fs';
import { runCorpus, formatRow } from './corpus.mjs';

const file = 'corpus.json';
const corpus = JSON.parse(fs.readFileSync(file, 'utf8'));
const { rows } = await runCorpus({ checkDeterminism: false });

console.error('');
for (const r of rows) console.error(formatRow(r));

let promoted = 0;
for (const entry of corpus.fixtures) {
  const row = rows.find(r => r.name === entry.name && !r.missing);
  if (!row) continue;
  if (entry.status === 'failing' && row.pass) {
    entry.status = 'required';
    delete entry.note;
    promoted++;
    console.error(`\npromoted ${entry.name}: known gap -> required (it now passes, and must keep passing)`);
  }
}

if (promoted) {
  fs.writeFileSync(file, JSON.stringify(corpus, null, 2) + '\n');
  console.error(`\n${file} updated: ${promoted} entr${promoted === 1 ? 'y' : 'ies'} promoted.`);
} else {
  console.error('\nnothing to promote — no known gap started passing.');
}

// Refresh the reference-model record when that model is present, so the exact
// fingerprint stays available as a change notifier for whoever has the file.
const model = rows.find(r => r.kind === 'model' && !r.absent);
if (model && model.fingerprint) {
  const prev = fs.existsSync('accepted.json') ? JSON.parse(fs.readFileSync('accepted.json', 'utf8')) : {};
  fs.writeFileSync('accepted.json', JSON.stringify({
    ...prev,
    acceptedAt: new Date().toISOString(),
    model: model.path,
    fingerprint: { partCount: model.fingerprint.partCount, hash: model.fingerprint.hash },
  }, null, 2) + '\n');
  console.error(`accepted.json refreshed: ${model.fingerprint.partCount} parts`);
}
