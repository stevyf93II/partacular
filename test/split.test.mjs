// Node test of the pure splitter. Builds a soup of 3 separated cubes + 1 floating triangle,
// expects 4 groups with correct triangle counts; then tests capGroups.
import { splitConnectedComponents, capGroups } from '../dist-test/split.js';

function cubeSoup(cx, cy, cz, s = 1) {
  const h = s / 2;
  const c = [[-h,-h,-h],[h,-h,-h],[h,h,-h],[-h,h,-h],[-h,-h,h],[h,-h,h],[h,h,h],[-h,h,h]]
    .map(([x,y,z]) => [x+cx, y+cy, z+cz]);
  const faces = [[0,1,2],[0,2,3],[4,6,5],[4,7,6],[0,4,5],[0,5,1],[1,5,6],[1,6,2],[2,6,7],[2,7,3],[3,7,4],[3,4,0]];
  const out = [];
  for (const [a,b,cc] of faces) out.push(...c[a], ...c[b], ...c[cc]);
  return out;
}

const soup = [
  ...cubeSoup(0,0,0), ...cubeSoup(5,0,0), ...cubeSoup(0,5,0),
  10,10,10, 11,10,10, 10,11,10, // lone triangle
];
const positions = new Float32Array(soup);
const res = splitConnectedComponents({ positions, index: null });

let fails = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
  if (!ok) fails++;
};

check('groupCount', res.groupCount, 4);
check('group sizes sorted', [...res.groupTriCounts].sort((a,b)=>b-a), [12,12,12,1]);
check('total tris', res.triGroup.length, 37);

// every triangle of the same cube must share a label
const label0 = res.triGroup[0];
check('cube0 consistent', [...res.triGroup.slice(0,12)].every(g => g === label0), true);

const capped = capGroups(res, 2);
check('capped count', capped.groupCount, 2);
check('capped sizes', [...capped.groupTriCounts].sort((a,b)=>b-a), [25,12]);
check('capped total', capped.groupTriCounts[0] + capped.groupTriCounts[1], 37);

process.exit(fails ? 1 : 0);
