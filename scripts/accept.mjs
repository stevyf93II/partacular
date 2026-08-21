// Steve accepted the current preview: lock the exact params + output fingerprint.
// Run ONLY after his explicit acceptance of preview-side/top.png from preview.mjs.
import fs from 'node:fs';
const meta = JSON.parse(fs.readFileSync('preview-meta.json'));
const accepted = {
  acceptedAt: new Date().toISOString(),
  model: meta.model,
  modelSha256: meta.modelSha256,
  params: meta.params,
  fingerprint: { partCount: meta.fingerprint.partCount, hash: meta.fingerprint.hash },
};
fs.writeFileSync('accepted.json', JSON.stringify(accepted, null, 2) + '\n');
console.log('accepted.json written:', accepted.fingerprint);
