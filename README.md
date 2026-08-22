# Partacular

Touch-first 3D part editor. Drop in a model, it splits into parts, tap a part to edit it. Zero learning curve by design.

**Live:** https://partacular.com

## What it does

- Upload GLB / GLTF / OBJ / STL (or hit "Try the demo")
- Multi-mesh files use their named nodes as parts; single-mesh files are split by connected components in a web worker
- Tap a part to select (others dim; tap the same spot to cycle through stacked parts)
- Drag the selected part to move it (screen-parallel plane — finger up = up)
- Pinch to resize in place, twist to rotate; wheel over a part scales on desktop
- Explode slider blooms the model apart; Delete / Hide / Undo; ⟳ 45° precise rotate
- **Carve** — draw on a part: a closed loop lifts that region out, a line straight
  across cuts it in two
- **Join** — tap a second part to merge it into the selection

## Repair, not perfection

Auto-segmentation of a fused mesh has no ground truth. "Where does the door end
and the fender begin" is not a geometric fact, so no parameter set converges:
tuning for one model degrades another, forever.

Carve and Join are the way out. They cover both directions of error —

| the split was | you | fixed with |
|---|---|---|
| over-segmented (one thing became many) | tap, Join, tap | `Join` |
| under-segmented (many things stayed one) | draw round the piece | `Carve` |

— which means segmentation quality stops being a release gate and becomes a
starting guess. Getting `persistDeg` exactly right stops mattering.

`Carve` reads intent from the shape you drew: a stroke that returns near its own
start is a lasso around a region, anything else is a knife line. Lassoed
triangles are filtered to front-facing (circling a car door in screen space also
encircles the far side of the car) and then to the largest connected patch, so
stray scraps do not become floating debris. One carve or join is one undo step.

The maths lives in `src/geometry/repair.ts` — pure arrays in, labels out, no
three.js, same rule as `split.ts`.

## Architecture

- `src/core/` — plain-data document model + command undo. **Zero three.js imports allowed here, ever.**
- `src/geometry/` — loaders, pure splitter (`split.ts`, no three dependency), web worker, geometry store
- `src/viewport/` — renderer, camera, gesture router (tap/drag/pinch vs camera), selection styling
- `src/ui/` — DOM chrome: pill, explode slider, toasts
- `src/geometry/repair.ts` — lasso / cut / merge maths (pure, node-tested)

Every part's geometry is re-pivoted to its bounding-box center on import; the document transform carries position/rotationY/scale. Never leave pivots at the world origin.

## Dev

```bash
npm install
npm run dev     # local dev server
npm run build   # production build to dist/
npm test        # node tests: splitter, repair ops, print/3MF
npm run gate    # the segmentation corpus gate (see below)
```

### Gesture tests

The interaction model is the product, and it is the one thing node cannot test —
it needs a live camera, a live BVH and real `PointerEvent`s. So it runs in the
browser against the real app:

```bash
npm run dev
# then open http://localhost:5199/?gtest=1 and watch the console
```

It drives the actual app through synthesized pointers and asserts what a user
would notice breaking: a dragged part stays pinned to the finger to under a
pixel, a 2x pinch gives exactly 2x, a 90 degree twist gives exactly 90 degrees,
undo lands exactly back where it started, carve/join conserve every triangle and
cost exactly one undo step, and a `pointercancel` leaves no phantom pointers.
33 checks. The suite is stripped from production builds by `import.meta.env.DEV`.

## The segmentation gate

`npm run gate` runs the shipped pipeline (`splitPipeline.smartSplit` with
`segmentation.config.ts` — one call path, unchanged) over a corpus of models and
checks each against a **range**, then verifies determinism.

The corpus is generated in code (`test/fixtures.mjs`), so it lives in git and
runs everywhere, and every entry has semantics you can argue with:

| fixture | expects | why |
|---|---|---|
| `twoBalls` | exactly 2 | physically disconnected — components alone must split these |
| `ball` | exactly 1 | convex everywhere; splitting it means the threshold is chasing noise |
| `shallowDimple` | exactly 1 | a ~8° styling dent is not a seam — the case boundary merging exists for |
| `noisyBall` | 1–3 | voxel-staircase texture is noise; the guard against loosening merging |
| `grooved` | 2–4, balanced | a deep groove around a bar must give two halves, not a thin ring |
| `peanut` | 2–4 | two lobes at a ~77° concave crease — the most obvious split there is |

The corpus **pulls in both directions on purpose**. `peanut` and `grooved` must
split; `shallowDimple`, `noisyBall` and `ball` must not. A change that only ever
loosens merging passes half of these and shatters the other half.

`corpus.json` marks each entry `required` (the gate blocks on regression) or
`failing` (a known gap, reported loudly, never blocking). When a known gap starts
passing, the gate says so and `npm run accept` promotes it to `required`. The
ratchet points at quality: it can be locked in, never locked out.

### How boundary strength is measured

Boundary-strength merging used to score a region boundary by the **mean** concave
angle along it. That mean is halved by something with no geometric meaning:
**exactly half of any boundary's edges are triangulation diagonals** carrying no
concavity at all. On the two-lobe fixture a real 77° crease measured 5.5° as a
mean, and merged away under `mergeStopDeg=14`.

It is now read at the 70th percentile instead (`BOUNDARY_PERCENTILE` in
`segment.ts`). Measured safe band on the corpus at `mergeStopDeg=14`:

| percentile | result |
|---|---|
| p50 | `peanut` still merges away — under-splits |
| **p60–p75** | **every fixture correct** |
| p80+ | staircase noise reads as structure; `noisyBall` → 5 parts |
| p95 | `noisyBall` → 10 parts |

`0.70` sits mid-band with about ten points of margin either way. It is
deliberately **not** a tuned knob in `SegmentConfig` — promoting it would invite
exactly the per-model tuning this measurement was changed to avoid.

**Reach matters as much as the statistic.** Scoring per-*face* curvature, or
dilating it by one ring of neighbours, also fixes `peanut` — and shatters
`noisyBall` into 18 parts, because a max-of-a-max amplifies precisely the
staircase texture that normal smoothing exists to suppress. The measure stays on
the per-edge smoothed field. `noisyBall` exists to keep it there.

### What changed, and why

The previous gate hashed the per-triangle labels of one model
(`reference/diablo.glb`) and failed on any difference. That forbids all change:
tuning that helps a second model necessarily moves the first model's hash, and
with one model in the lockfile there is no way to weigh the trade — only to
observe that something moved. The machinery built to stop the thrashing became
the thing preventing improvement.

That model is also 49MB and not in git, so CI ran `GATE_LITE` and only checked
that two copies of the same numbers matched each other; no output was ever
verified on the build machine. The corpus removes the need for `GATE_LITE`
entirely — the real gate now runs in CI.

The exact reference fingerprint is still computed when the model happens to be
present, and reported as a change notifier. `GATE_STRICT=1` restores the old
blocking behaviour for a release where output should be frozen exactly.

Deploys to Netlify (site: partacular) — `netlify.toml` builds `npm run build`, publishes `dist/`.

## Roadmap

- Phase 3: duplicate, recolor, export GLB/STL
- Phase 4 (shipped): print path — Manifold merge to watertight, 3MF export, PWA install
- Phase 5 (shipped): Carve / Join repair gestures, corpus gate, gesture test suite
- Next: grow the corpus as real models expose new failures; carve currently
  partitions at triangle resolution (no re-triangulation across the cut), which
  is invisible on dense meshes and rough on coarse ones

## Icons

`public/icons/` is generated, not committed: `npm i -D sharp && node scripts/gen-icons.mjs` (source: `icon.svg`).
