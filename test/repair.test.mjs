// Node test of the pure repair ops (lasso / cut / patch cleanup).
// Build with:
//   npx tsc src/geometry/repair.ts src/geometry/split.ts --ignoreConfig \
//     --outDir dist-test --target es2022 --module esnext
import {
  projectTriangles, simplifyStroke, strokeIntent, lassoMask, cutMask,
  faceAdjacency, largestPatch, repairFromStroke,
} from '../dist-test/repair.js';

let fails = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
  if (!ok) fails++;
};
const near = (label, got, want, tol) => {
  const ok = Math.abs(got - want) <= tol;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}: got ${got} want ${want}+-${tol}`);
  if (!ok) fails++;
};

/** A flat grid of quads on the z=0 plane spanning [-1,1]^2, wound CCW toward +z. */
function grid(n) {
  const out = [];
  const at = (i, j) => [-1 + (2 * i) / n, -1 + (2 * j) / n, 0];
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const a = at(i, j), b = at(i + 1, j), c = at(i + 1, j + 1), d = at(i, j + 1);
    out.push(...a, ...b, ...c, ...a, ...c, ...d);
  }
  return new Float32Array(out);
}

// An orthographic-ish identity MVP: x,y pass through to NDC, w = 1.
const IDENTITY = new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]);

// ---- projection + facing ---------------------------------------------------
{
  const g = grid(4);
  const p = projectTriangles(g, null, IDENTITY);
  check('all triangles valid', [...p.valid].every(v => v === 1), true);
  check('CCW toward camera reads as front', [...p.front].every(v => v === 1), true);

  // Reverse the winding of every triangle: they must all read as back-facing.
  const flipped = new Float32Array(g);
  for (let t = 0; t < g.length / 9; t++) {
    for (let k = 0; k < 3; k++) { const tmp = flipped[t*9+3+k]; flipped[t*9+3+k] = flipped[t*9+6+k]; flipped[t*9+6+k] = tmp; }
  }
  const pf = projectTriangles(flipped, null, IDENTITY);
  check('reversed winding reads as back', [...pf.front].every(v => v === 0), true);

  // A mirroring model matrix must flip facing too — this is why facing comes
  // from projected area rather than from a normal vs camera-vector dot product.
  const MIRROR = new Float32Array([-1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]);
  const pm = projectTriangles(g, null, MIRROR);
  check('mirrored matrix flips facing', [...pm.front].every(v => v === 0), true);
}

// ---- stroke intent ---------------------------------------------------------
{
  const circle = [];
  for (let i = 0; i <= 24; i++) { const a = (i / 24) * Math.PI * 2; circle.push(Math.cos(a) * 0.5, Math.sin(a) * 0.5); }
  check('closed loop reads as lasso', strokeIntent(new Float32Array(circle)), 'lasso');
  check('straight stroke reads as cut', strokeIntent(new Float32Array([-1, 0, -0.3, 0, 0.3, 0, 1, 0])), 'cut');
  check('simplifyStroke caps length', simplifyStroke(new Float32Array(400), 64).length / 2, 64);
  check('simplifyStroke keeps short strokes', simplifyStroke(new Float32Array([0,0, 1,1]), 64).length / 2, 2);
}

// ---- lasso -----------------------------------------------------------------
{
  const g = grid(20);                      // 800 triangles over [-1,1]^2
  const p = projectTriangles(g, null, IDENTITY);
  // A square loop covering exactly the upper-right quadrant => ~1/4 of the area.
  const loop = new Float32Array([0.02, 0.02, 0.98, 0.02, 0.98, 0.98, 0.02, 0.98]);
  const mask = lassoMask(p, loop, true);
  const got = mask.reduce((s, v) => s + v, 0);
  near('lasso selects the quadrant', got / mask.length, 0.25, 0.03);

  // Facing filter: with every triangle back-facing, a lasso must select nothing.
  const flipped = new Float32Array(g);
  for (let t = 0; t < g.length / 9; t++) {
    for (let k = 0; k < 3; k++) { const tmp = flipped[t*9+3+k]; flipped[t*9+3+k] = flipped[t*9+6+k]; flipped[t*9+6+k] = tmp; }
  }
  const back = lassoMask(projectTriangles(flipped, null, IDENTITY), loop, true);
  check('lasso ignores back faces', back.reduce((s, v) => s + v, 0), 0);
}

// ---- cut -------------------------------------------------------------------
{
  const g = grid(20);
  const p = projectTriangles(g, null, IDENTITY);
  // A horizontal line through the middle should halve the sheet, and the stroke
  // is deliberately SHORTER than the sheet to prove the ends extend infinitely.
  const line = new Float32Array([-0.4, 0, 0.4, 0]);
  const mask = cutMask(p, line);
  const frac = mask.reduce((s, v) => s + v, 0) / mask.length;
  near('cut line halves the sheet', frac, 0.5, 0.02);
}

// ---- largest patch ---------------------------------------------------------
{
  const g = grid(10);
  const adj = faceAdjacency(g, null);
  check('interior triangles have 3 neighbours',
    [...adj.count].filter(c => c === 3).length > 0, true);

  // A mask of one big blob plus a lone far-away speck: the speck must be dropped.
  const mask = new Uint8Array(g.length / 9);
  for (let i = 0; i < 40; i++) mask[i] = 1;
  mask[mask.length - 1] = 1;
  const kept = largestPatch(mask, adj);
  check('speck dropped', kept[kept.length - 1], 0);
  check('blob survives', kept.reduce((s, v) => s + v, 0) > 20, true);
}

// ---- end to end ------------------------------------------------------------
{
  const g = grid(20);
  const circle = [];
  for (let i = 0; i <= 32; i++) { const a = (i / 32) * Math.PI * 2; circle.push(0.45 + Math.cos(a) * 0.35, 0.45 + Math.sin(a) * 0.35); }
  const res = repairFromStroke(g, null, IDENTITY, new Float32Array(circle));
  check('lasso stroke produces two groups', res && res.groupCount, 2);
  check('intent detected', res && res.intent, 'lasso');
  check('both sides non-empty', res && res.counts[0] > 0 && res.counts[1] > 0, true);
  check('labels cover every triangle', res && res.triGroup.length, g.length / 9);

  // A stroke that carves off almost nothing must be rejected, not shipped as a part.
  const tiny = new Float32Array([0.90, 0.90, 0.93, 0.90, 0.93, 0.93, 0.90, 0.93]);
  check('sliver rejected', repairFromStroke(g, null, IDENTITY, tiny), null);

  // Indexed input must behave identically to soup input.
  const idx = new Uint32Array(g.length / 3);
  for (let i = 0; i < idx.length; i++) idx[i] = i;
  const resIdx = repairFromStroke(g, idx, IDENTITY, new Float32Array(circle));
  check('indexed matches soup', resIdx && [...resIdx.counts], res && [...res.counts]);
}

console.log(fails ? `\n${fails} FAILURES` : '\nall repair tests passed');
process.exit(fails ? 1 : 0);
