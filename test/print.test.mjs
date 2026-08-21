// Node test of the pure print core: two overlapping cubes must union into one
// watertight solid; a broken open triangle must be carried as an unsealed object.
import Module from 'manifold-3d';
import { buildPrintFile } from '../dist-test/print.js';
import zlib from 'node:zlib';

function cubeSoup(cx, cy, cz, s = 1) {
  const h = s / 2;
  const c = [[-h,-h,-h],[h,-h,-h],[h,h,-h],[-h,h,-h],[-h,-h,h],[h,-h,h],[h,h,h],[-h,h,h]]
    .map(([x,y,z]) => [x+cx, y+cy, z+cz]);
  const faces = [[0,1,2],[0,2,3],[4,6,5],[4,7,6],[0,4,5],[0,5,1],[1,5,6],[1,6,2],[2,6,7],[2,7,3],[3,7,4],[3,4,0]];
  const out = [];
  for (const [a,b,cc] of faces) out.push(...c[a], ...c[b], ...c[cc]);
  return new Float32Array(out);
}

let pass = 0, fail = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

const api = await Module();
api.setup();

const res = buildPrintFile(api, [
  { name: 'cube A', positions: cubeSoup(0, 0, 0) },
  { name: 'cube B', positions: cubeSoup(0.5, 0, 0) },
  { name: 'broken', positions: new Float32Array([0,0,0, 1,0,0, 0,1,0]) },
], '{"test":"provenance"}');

check('merged solids', res.merged, 2);
check('failed names', res.failedNames, ['broken']);
check('merged tris > 12 (fused, not boxes side by side)', res.tris > 12, true);
check('zip signature', [res.data[0], res.data[1]], [0x50, 0x4b]);

// crack the zip open with node zlib (no unzip dep): find 3dmodel.model entry
const buf = Buffer.from(res.data);
function readEntry(name) {
  let o = 0;
  while (o < buf.length - 4) {
    if (buf.readUInt32LE(o) !== 0x04034b50) break;
    const method = buf.readUInt16LE(o + 8), csize = buf.readUInt32LE(o + 18);
    const nlen = buf.readUInt16LE(o + 26), elen = buf.readUInt16LE(o + 28);
    const ename = buf.subarray(o + 30, o + 30 + nlen).toString();
    const data = buf.subarray(o + 30 + nlen + elen, o + 30 + nlen + elen + csize);
    if (ename === name) return method === 8 ? zlib.inflateRawSync(data).toString() : data.toString();
    o += 30 + nlen + elen + csize;
  }
  return null;
}
const xml = readEntry('3D/3dmodel.model');
check('model entry present', xml !== null, true);
check('two objects in build', (xml.match(/<item objectid=/g) || []).length, 2);
check('unsealed object named', xml.includes('broken (unsealed)'), true);
check('unit is millimeter', xml.includes('unit="millimeter"'), true);
// Z-up sanity: cube A spans y in three -> z in 3MF; merged object must contain z="0.5"
check('z-up conversion applied', /z="0\.5"/.test(xml), true);
check('content types present', readEntry('[Content_Types].xml') !== null, true);
check('provenance metadata embedded', xml.includes('partacular:config') && xml.includes('&quot;test&quot;'), true);

console.log(fail === 0 ? 'ALL PASS' : `${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);
