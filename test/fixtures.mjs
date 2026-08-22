// PROCEDURAL GATE FIXTURES — meshes with a known right answer, generated in code.
//
// The old gate locked segmentation to reference/diablo.glb: 49MB, not in git,
// so CI could only ever check the params half and the real output check ran on
// one machine. These fixtures are a few lines of maths, live in the repo, and
// have semantics a human can argue with:
//
//   peanut  -> two lobes meeting at a hard concave crease  => must split
//   ball    -> convex everywhere, no crease anywhere       => must NOT split
//   grooved -> one deep groove cut around a bar            => must split
//
// A pipeline that cannot separate two obviously-separate lobes, or that shatters
// a smooth sphere, is broken in a way no fingerprint hash would ever tell you.

/** Close a surface of revolution about the Z axis into a triangle soup. */
function revolve(profile, segZ, segTheta) {
  const tris = [];
  const at = (i, j) => {
    const { z, r } = profile(i / segZ);
    const a = (j / segTheta) * Math.PI * 2;
    return [Math.cos(a) * r, Math.sin(a) * r, z];
  };
  for (let i = 0; i < segZ; i++) {
    for (let j = 0; j < segTheta; j++) {
      const a = at(i, j), b = at(i + 1, j), c = at(i + 1, j + 1), d = at(i, j + 1);
      tris.push(a, c, b, a, d, c); // wound so normals point OUTWARD
    }
  }
  const out = new Float32Array(tris.length * 3);
  tris.forEach((p, i) => out.set(p, i * 3));
  assertOutward(out);
  return out;
}

/**
 * Reject inward-wound geometry loudly.
 *
 * Inverted normals make every concave crease read as convex, so a curvature
 * watershed sees one smooth blob and reports "1 part" -- a fixture bug that
 * looks exactly like a segmentation bug. Signed volume is positive only when
 * the surface is wound outward, so one number catches it.
 */
export function signedVolume(soup) {
  let v = 0;
  for (let i = 0; i < soup.length; i += 9) {
    v += (soup[i] * (soup[i+4] * soup[i+8] - soup[i+5] * soup[i+7])
        - soup[i+1] * (soup[i+3] * soup[i+8] - soup[i+5] * soup[i+6])
        + soup[i+2] * (soup[i+3] * soup[i+7] - soup[i+4] * soup[i+6])) / 6;
  }
  return v;
}

function assertOutward(soup) {
  const v = signedVolume(soup);
  if (!(v > 0)) throw new Error(`fixture is wound inward (signed volume ${v}) — normals would be inverted`);
}

/**
 * Two overlapping spheres of radius R centred at +/-d.
 *
 * Their union is a surface of revolution whose radius is the max of the two
 * sphere radii at each z. Where the spheres cross, that max has a corner: a
 * genuine sharp concave crease running right around the waist. That crease is
 * exactly what a curvature watershed is supposed to find.
 */
export function peanut(segZ = 400, segTheta = 400, R = 1, d = 0.62) {
  const zMax = d + R;
  const profile = t => {
    const z = -zMax + t * 2 * zMax;
    const r1 = R * R - (z - d) * (z - d);
    const r2 = R * R - (z + d) * (z + d);
    const r = Math.sqrt(Math.max(0, Math.max(r1, r2)));
    return { z, r };
  };
  return revolve(profile, segZ, segTheta);
}

/** One sphere. Convex everywhere — there is no honest place to cut it. */
export function ball(segZ = 400, segTheta = 400, R = 1) {
  const profile = t => {
    const z = -R + t * 2 * R;
    return { z, r: Math.sqrt(Math.max(0, R * R - z * z)) };
  };
  return revolve(profile, segZ, segTheta);
}

/**
 * A cylinder with one deep V groove cut around its middle.
 *
 * Unlike the peanut this has TWO concave creases close together (the groove's
 * two shoulders), which is where naive crease-cutting tends to produce a thin
 * ring region instead of two parts. The thinness filter should absorb it.
 */
export function grooved(segZ = 400, segTheta = 400, R = 1, depth = 0.45, width = 0.12) {
  const half = 1.4;
  const profile = t => {
    const z = -half + t * 2 * half;
    let r = R;
    if (Math.abs(z) < width) r = R - depth * (1 - Math.abs(z) / width);
    // flat end caps so the surface closes
    if (t < 0.02) r = R * (t / 0.02);
    if (t > 0.98) r = R * ((1 - t) / 0.02);
    return { z, r };
  };
  return revolve(profile, segZ, segTheta);
}

/**
 * A bar with a very SHALLOW dip around it (~8 degrees of dihedral).
 *
 * This is the counter-case, and it is the whole reason boundary-strength
 * merging exists: a gentle dent is a styling line, not a seam, and must not
 * become its own part. Any change to how boundary strength is measured has to
 * keep this at one part while still splitting the sharp cases.
 */
export function shallowDimple(segZ = 400, segTheta = 400, R = 1, depth = 0.02, width = 0.3) {
  const half = 1.4;
  const profile = t => {
    const z = -half + t * 2 * half;
    let r = R;
    if (Math.abs(z) < width) r = R - depth * (1 - Math.abs(z) / width);
    if (t < 0.02) r = R * (t / 0.02);
    if (t > 0.98) r = R * ((1 - t) / 0.02);
    return { z, r };
  };
  return revolve(profile, segZ, segTheta);
}

/**
 * A sphere whose vertices are snapped to a coarse grid — voxel-staircase noise.
 *
 * This is the risk guard for any change that makes merging LESS aggressive.
 * Scanned and AI-generated meshes are covered in sharp little facet edges that
 * are noise, not seams; normal smoothing exists to suppress them. If a boundary
 * measure starts treating that texture as structure, a scan shatters into
 * hundreds of pieces. One part is the only acceptable answer.
 */
export function noisyBall(segZ = 400, segTheta = 400, R = 1, step = R / 26) {
  const s = ball(segZ, segTheta, R);
  const out = new Float32Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = Math.round(s[i] / step) * step;
  return out;
}

/** Two far-apart balls: connected components alone must separate these. */
export function twoBalls(segZ = 200, segTheta = 200) {
  const a = ball(segZ, segTheta, 1);
  const b = ball(segZ, segTheta, 1);
  for (let i = 0; i < b.length; i += 3) b[i] += 6; // shift on X, no contact
  const out = new Float32Array(a.length + b.length);
  out.set(a, 0); out.set(b, a.length);
  return out;
}

export const FIXTURES = {
  peanut: { build: peanut, expect: { minParts: 2, maxParts: 4 }, why: 'two lobes joined at a concave crease' },
  ball: { build: ball, expect: { minParts: 1, maxParts: 1 }, why: 'convex everywhere, nothing to cut' },
  grooved: { build: grooved, expect: { minParts: 2, maxParts: 4 }, why: 'one deep groove around a bar' },
  shallowDimple: { build: shallowDimple, expect: { minParts: 1, maxParts: 1 }, why: 'a gentle styling dent is not a seam' },
  noisyBall: { build: noisyBall, expect: { minParts: 1, maxParts: 3 }, why: 'voxel-staircase texture is noise, not structure' },
  twoBalls: { build: twoBalls, expect: { minParts: 2, maxParts: 2 }, why: 'physically disconnected' },
};
