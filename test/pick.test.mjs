// Node test of the touch-to-select core: basin graph, growth ladder, and the
// rung a touch lands on.
//
// Build with `npm run build-tests`.
import { buildBasinGraph, buildLadder, basinsAt, suggestRung } from '../dist-test/pick.js';

let fails = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
  if (!ok) fails++;
};
const deg = d => (d * Math.PI) / 180;

/**
 * Basins in a row with a strong seam in the middle:
 *
 *   A --2deg-- B --50deg-- C --2deg-- D
 *
 * A and B are one thing, C and D another, and the halves are separate things.
 * `sizes` lets a basin be made deliberately huge to test that one rung cannot
 * swallow the model.
 */
function rowTrace(joins, perBasin = [10, 10, 10, 10]) {
  const offsets = [];
  let acc = 0;
  for (const n of perBasin) { offsets.push(acc); acc += n; }
  const nTri = acc;
  const basins = new Int32Array(nTri);
  for (let b = 0; b < perBasin.length; b++) {
    for (let i = 0; i < perBasin[b]; i++) basins[offsets[b] + i] = b * 7 + 3; // sparse ids on purpose
  }
  const edgeInfo = [];
  const conc = [];
  for (const [a, b, angle] of joins) {
    const n = Math.min(perBasin[a], perBasin[b], 10);
    for (let k = 0; k < n; k++) {
      edgeInfo.push([offsets[a] + k, offsets[b] + k, 0, 1]);
      // alternate real crease edges with triangulation diagonals carrying zero,
      // exactly as a real boundary does
      conc.push(k % 2 === 0 ? angle : 0);
    }
  }
  return { nTri, basins, adj: [], edgeInfo, edgeConc: Float32Array.from(conc), proxyOf: new Int32Array(nTri) };
}

const graph = buildBasinGraph(rowTrace([[0, 1, deg(2)], [1, 2, deg(50)], [2, 3, deg(2)]]));

check('sparse basin ids are compacted', graph.count, 4);
check('every face keeps a basin', [...graph.sizes], [10, 10, 10, 10]);
check('three boundaries found', graph.boundaries.size, 3);

const lad = buildLadder(graph, 0);
check('the ladder reaches every basin', lad.order.length, 4);
check('growth starts at the touched basin', lad.order[0], 0);
check('the weak neighbour is taken first', lad.order[1], 1);
check('one basin per rung', [...lad.cumulative], [10, 20, 30, 40]);
check('rung 1 holds exactly A and B', basinsAt(lad, 1).sort(), [0, 1]);
check('rung clamps instead of throwing', basinsAt(lad, 99).sort(), [0, 1, 2, 3]);

// The strong seam must be measured at its real angle, not halved by the
// triangulation diagonals that make up half of every boundary.
check('the strong seam reads near 50 degrees',
  Math.round((lad.strength[2] * 180) / Math.PI), 50);
check('a mean would have halved it', Math.round((lad.strength[2] * 180) / Math.PI) > 40, true);
check('weak boundaries come before the strong one', lad.strength[1] < lad.strength[2], true);

check('a touch on A stops before the strong seam', lad.suggested, 1);
check('a touch on D stops before it too', buildLadder(graph, 3).suggested, 1);

// ---- one rung must never swallow the model --------------------------------
{
  // A is tiny and its ONLY weak neighbour is enormous; a second small basin
  // hangs off it across a slightly stronger boundary.
  const g = buildBasinGraph(rowTrace(
    [[0, 1, deg(2)], [0, 2, deg(6)]],
    [10, 400, 10],
  ));
  const l = buildLadder(g, 0);
  check('the small neighbour is taken first despite a stronger boundary',
    l.order[1], 2);
  check('the huge one still arrives, just not on rung one', l.order[2], 1);
  check('no rung more than doubles what is held before the last resort',
    l.cumulative[1] <= l.cumulative[0] * 2, true);
}

// ---- disconnected basins are never crossed automatically -------------------
{
  const g = buildBasinGraph(rowTrace([[0, 1, deg(2)], [2, 3, deg(2)]]));
  const l = buildLadder(g, 0);
  check('growth stops at the edge of what it touches', l.order.length, 2);
  check('and the default stays inside it', l.suggested, 1);
}

// ---- a lone basin degrades gracefully --------------------------------------
{
  const g = buildBasinGraph({
    nTri: 4, basins: new Int32Array(4), adj: [], edgeInfo: [],
    edgeConc: new Float32Array(0), proxyOf: new Int32Array(4),
  });
  const l = buildLadder(g, 0);
  check('one basin -> one rung', l.order.length, 1);
  check('suggestRung stays in range', suggestRung(l, g), 0);
  check('basinsAt returns just it', basinsAt(l, 0), [0]);
}

console.log(fails ? `\n${fails} FAILURES` : '\nall pick tests passed');
process.exit(fails ? 1 : 0);
