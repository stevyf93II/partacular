// Node test of the touch-to-select core: basin graph, merge tree, and the
// level a touch lands on.
//
// Build with:
//   npx tsc src/geometry/pick.ts src/geometry/segment.ts src/geometry/split.ts \
//     src/geometry/print.ts --ignoreConfig --outDir dist-test --target es2022 \
//     --module esnext --moduleResolution bundler --skipLibCheck
import {
  buildBasinGraph, buildMergeTree, chainFor, leavesOf, suggestLevel, regionAt,
} from '../dist-test/pick.js';

let fails = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
  if (!ok) fails++;
};
const deg = d => (d * Math.PI) / 180;

/**
 * Four basins in a row, with a strong seam down the middle:
 *
 *   A --2deg-- B --50deg-- C --2deg-- D
 *
 * A and B are one thing; C and D are another; the two halves are separate
 * things. Any sane clustering merges A+B and C+D before joining the halves.
 */
function rowTrace(joins) {
  const perBasin = 10;
  const nTri = 4 * perBasin;
  const basins = new Int32Array(nTri);
  for (let f = 0; f < nTri; f++) basins[f] = Math.floor(f / perBasin) * 7 + 3; // sparse ids on purpose
  const edgeInfo = [];
  const conc = [];
  for (const [a, b, angle] of joins) {
    for (let k = 0; k < 10; k++) {
      // alternate real crease edges with triangulation diagonals carrying zero,
      // exactly as a real boundary does
      edgeInfo.push([a * perBasin + k, b * perBasin + k, 0, 1]);
      conc.push(k % 2 === 0 ? angle : 0);
    }
  }
  return {
    nTri, basins, adj: [], edgeInfo,
    edgeConc: Float32Array.from(conc),
    proxyOf: new Int32Array(nTri),
  };
}

const trace = rowTrace([[0, 1, deg(2)], [1, 2, deg(50)], [2, 3, deg(2)]]);
const graph = buildBasinGraph(trace);

check('sparse basin ids are compacted', graph.count, 4);
check('every face keeps a basin', [...graph.sizes], [10, 10, 10, 10]);
check('three boundaries found', graph.boundaries.size, 3);

const tree = buildMergeTree(graph);
check('tree has 2n-1 nodes', tree.nodeCount, 7);

// A's chain: itself, then A+B, then everything.
const chain = chainFor(tree, 0);
check('chain reaches the root', chain.length, 3);
check('first step up from A is A+B',
  leavesOf(tree, chain[1]).sort(), [0, 1]);
check('second step takes the whole row',
  leavesOf(tree, chain[2]).sort(), [0, 1, 2, 3]);

// The strong seam must be the LAST thing crossed.
check('weak boundaries merge before the strong one',
  tree.height[chain[1]] < tree.height[chain[2]], true);
check('the strong seam is measured near 50 degrees',
  Math.round((tree.height[chain[2]] * 180) / Math.PI), 50);
// A mean over these boundaries would read 25 degrees, not 50: half of every
// boundary's edges are diagonals carrying no concavity at all.
check('percentile is not diluted by triangulation diagonals',
  Math.round((tree.height[chain[2]] * 180) / Math.PI) > 40, true);

check('a touch on A stops before the strong seam', suggestLevel(tree, 0), 1);
check('a touch on D stops before it too', suggestLevel(tree, 3), 1);
check('regionAt matches the chain', regionAt(tree, 0, 1).sort(), [0, 1]);
check('level clamps instead of throwing', regionAt(tree, 0, 99).sort(), [0, 1, 2, 3]);

// ---- disconnected basins must never be crossed automatically ----------------
{
  // A--B joined weakly; C--D joined weakly; the two pairs never touch.
  const t2 = rowTrace([[0, 1, deg(2)], [2, 3, deg(2)]]);
  const g2 = buildBasinGraph(t2);
  const tr2 = buildMergeTree(g2);
  const c2 = chainFor(tr2, 0);
  check('unconnected halves still share one root', c2.length, 3);
  // JSON.stringify(Infinity) is "null", so assert finiteness directly rather
  // than comparing the value -- otherwise NaN would pass this too.
  check('the join between them is not finite', Number.isFinite(tr2.height[c2[2]]), false);
  check('and it is specifically Infinity', tr2.height[c2[2]] === Infinity, true);
  check('a touch never reaches across a disconnected join', suggestLevel(tr2, 0), 1);
}

// ---- a single basin degrades gracefully -------------------------------------
{
  const one = { nTri: 4, basins: new Int32Array(4), adj: [], edgeInfo: [], edgeConc: new Float32Array(0), proxyOf: new Int32Array(4) };
  const g3 = buildBasinGraph(one);
  const t3 = buildMergeTree(g3);
  check('one basin -> one node', g3.count, 1);
  check('its chain is just itself', chainFor(t3, 0), [0]);
  check('suggestLevel stays in range', suggestLevel(t3, 0), 0);
}

console.log(fails ? `\n${fails} FAILURES` : '\nall pick tests passed');
process.exit(fails ? 1 : 0);
