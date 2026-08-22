# Partacular

Touch-first 3D part editor. Drop in a model, it splits into parts, tap a part to edit it. Zero learning curve by design.

**Live:** https://partacular.com

## What it does

- Upload GLB / GLTF / OBJ / STL (or hit "Try the demo")
- **Touch any part of a fused model and it lifts out on its own** — see below
- Multi-mesh files use their named nodes as parts; single-mesh files are split by connected components in a web worker
- Tap a part to select (others dim; tap the same spot to cycle through stacked parts)
- Drag the selected part to move it (screen-parallel plane — finger up = up)
- Pinch to resize in place, twist to rotate; wheel over a part scales on desktop
- Explode slider blooms the model apart; Delete / Hide / Undo; ⟳ 45° precise rotate
- **Carve** — draw on a part: a closed loop lifts that region out, a line straight
  across cuts it in two
- **Join** — tap a second part to merge it into the selection

## Touch to select

Open a model, touch a part, and everything else drops away. No Split first, no
setup, no settings. Drag up or down (or Less/More) to take more or less, then
**Take piece** and it is a part you can drag, pinch, twist, recolour and print.

Measured on `reference/diablo.glb`, a 1,983,448-triangle fused AI car body,
against the accepted 25-part segmentation:

| touch | you get | |
|---|---|---|
| the door | 87,843 tris | 100% of the door, 5% spill |
| a wheel | 129,032 tris | 100% of the wheel, **0% spill** |
| the bodywork | 116,448 tris | a panel, with a ladder out to the whole body |

### Why this works when tuning never did

Segmenting a whole model up front forces every boundary in it to be decided
before anyone has touched anything, from parameters that must suit every model
at once. That is not achievable, and when it is wrong you get a "part" that is
**69% of a car** — which is what the accepted output does for the bodywork.

Touching inverts it. Nothing is decided until a finger lands, and then only
locally.

Two earlier attempts died against the real model and are worth recording:

1. **Flood across triangles from the touch, stopping at creases.** It snaps from
   407 triangles to the entire car between 15° and 20° — there is no threshold
   that gets the door. The reason is at the top of `segment.ts`: crease loops on
   AI meshes never close, so one leak floods everything. This is exactly why the
   file uses a watershed.
2. **Loosen the global merge threshold.** Fixes a synthetic two-lobe case and
   splits the real door into its inner and outer skin. See the `peanut` gap.

What does work is the pipeline's own **basins** — the watershed's intermediate
regions, closed by construction. Measured against the accepted output, **99% of
basins fall cleanly inside or outside a real part**, and the door is exactly 7
of them. The basins were never the problem; the merging that follows is.

So `pick.ts` keeps them, clusters them once into a **merge tree** ordered by how
strong the boundary between them is, and lets the finger choose the level.
Touching gives a chain of nested regions from "the basin I touched" out to
"everything"; dragging slides along it. Two rules do the rest:

- stop where boundary strength jumps — a part ends where the seam gets hard
- **never** cross a disconnected boundary automatically; a wheel sitting next to
  a body was never what a touch meant

`segment.ts` gained an optional `SegmentTrace` out-parameter to hand the basins
out. It is a pure observer — nothing reads it back — and the gate proves the
shipped fingerprint is unchanged (`3f34865dabf9`).

The analysis runs once per part in a worker (~17s on 2M triangles, instant
after) and is cached. Growing afterwards costs the size of the region, not the
model.

**Split is unchanged.** Before Split, a tap picks a piece; after Split, a tap
selects parts exactly as before. Merging back re-enables picking.

## Managing parts

**Parts** opens a list of everything in the model: colour, name, triangle count,
hidden state. Tapping a row **adds** it to the selection rather than replacing
it, because picking out twenty scraps to delete is the reason the list exists.
With a selection you get **Hide**, **Merge** and **Delete**, each one undoable in
a single step, plus **Select all / none / tiny**.

**Tidy** appears in the top bar only when there are parts too small to matter,
says how many, and clears them in one action. It never offers to delete the
largest part, and deleting every part is refused rather than leaving an empty
document.

### Debris

Split used to cap parts by RANK — keep the hundred biggest groups, bucket the
rest. On a mesh carrying hundreds of loose scraps, which is most scanned and
generated geometry, the hundred biggest are still ninety-nine specks, and
clearing them meant deleting them one at a time.

Size decides now, on two tests that catch different junk: a shell spanning less
than `debrisBelowFrac` of the model's own diagonal cannot be seen, touched or
printed however many triangles it has, and a shell under 16 triangles cannot
describe a solid however far it spreads. Everything below either joins one
debris part named for what it swept up — `Loose bits (37 pieces)`.

| Split | before | after |
|---|---|---|
| a room scan, 26k tris | ~100 parts | **16** |
| `diablo`, 2M tris | 25 | **16** |
| `colt`, 2M tris | 20 | **13** |

Triangle count alone was tried first and is the wrong test: a speck can be dense
and a car panel can be coarse. On `diablo` the real parts are byte-identical
either way — only the junk moved.

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
- `src/geometry/pick.ts` — basin graph + merge tree behind touch-to-select (pure)
- `src/geometry/pick.worker.ts` / `pickClient.ts` — the per-part index, off-thread and cached

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
63 checks, including touch-to-select and the parts list: a held piece is always a part of the
model rather than all of it, the drag ladder never shrinks as you pull outward,
taking a piece conserves every triangle and costs exactly one undo step, bulk
delete and bulk merge each cost one undo step, deleting every part is refused,
and the parts list never covers the Open/Save controls. The suite is stripped
from production builds by `import.meta.env.DEV`.

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

### Known gap: `peanut`, and why it is staying open

Two spheres meeting at a hard ~77 degree concave crease come back as **1 part**.
The watershed is not at fault -- it produces a clean 48620/48180 halving, and
boundary-strength merging then destroys it.

The cause is measured, not guessed. Instrumenting the merge decision gives:

```
label boundary spans z=[0.0074]     <- where the split line landed
sharp raw crease spans z=[0.0000]   <- where the crease actually is
boundary: n=439 zeros=219 (50%) mean=5.5 p50=11.0 max=17.4
```

Two dilutions, neither geometric: **exactly half of any boundary's edges are
triangulation diagonals** carrying no concavity, so the mean is halved by how the
mesh happened to be triangulated; and the watershed line settles beside its
crease rather than on it.

Reading that same field at a percentile instead of a mean fixes it. **It is still
not shipped**, because it was then measured against the real model:

| | accepted (mean) | percentile |
|---|---|---|
| parts | 25 | 30 |
| body | 1,369,030 | 1,237,807 + **sill 106,521** |
| **door** | **83,423 (whole)** | **42,639 + 40,784 (split)** |

Splitting the door into its inner and outer skin means touching the door hands
you half a door. That fails the one interaction the app exists for, so the
trade is not worth a synthetic fixture. Also measured: on diablo the percentile
*value* is irrelevant -- p50 through p70 give byte-identical output -- so this
cannot be tuned around. It is mean-or-percentile, and mean wins on the model
that matters.

Do not reopen this without `reference/diablo.glb` present, and look at the door
in `npm run preview` before believing any number.

### The bigger point

Part *count* is the wrong measure. What matters is whether touching a thing
gives you that thing, and by that measure the accepted output is not good
either: the largest part is **1,369,030 triangles, 69% of the whole car**.

That is what Touch to select answers, and it is why this gap can stay open. The
global segmentation no longer has to be right for touching a part to work.

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
- Phase 6 (shipped): Touch to select — basin merge tree, per-touch selection
- Phase 7 (shipped): parts list with multi-select, bulk delete/hide/merge, Tidy,
  and size-based debris bucketing
- Next: grow the corpus as real models expose new failures; carve currently
  partitions at triangle resolution (no re-triangulation across the cut), which
  is invisible on dense meshes and rough on coarse ones; the first touch on a
  big part waits on a ~17s worker pass that could start at load time instead

## Icons

`public/icons/` is generated, not committed: `npm i -D sharp && node scripts/gen-icons.mjs` (source: `icon.svg`).
