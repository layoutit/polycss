# polycss-pointer-grab-prepared@0 / polycss-pointer-grab@0

Status: experimental executable codec/interpreter pair for `domformat@0` and
`polycss-3d@0`.

## Purpose and boundary

This contract maps bounded pointer/button/axis samples into prepared picking,
weighted deformation, rigid eye-follow, fitted solid-triangle transforms,
visibility, and cursor writes on fixed retained targets. It creates no nodes,
parses no source-game data, generates no topology, and runs no package code.

## Binding

The executable binding consumes, in exact order:

```text
axis.x axis.y button.hold pointer.positioned pointer.pressed pointer.x pointer.y
```

The defaults are zero axes, false booleans, and the exact source-centre pointer
coordinates `sourceWidth / 2` and `sourceHeight / 2`; `cursorInitial` equals
that same pair. Targets are ordered shapes and leaves plus a cursor layer and
distinct open/closed cursor nodes. Shape and leaf arrays exactly equal
playback's target arrays in the same order. Presentation source
width/height exactly equal its source viewport. Sinks are
exactly `style.transform` and `style.visibility`. Parameters are `initialFrame`
and `tickRateHz: 30`, which MUST equal playback's closed `tickRateHz`.
Pointer interaction requires playback, presentation with cursor targets, and
effects; those companion contracts are not optional in an interactive closure.
The three input types are closed to `boolean`, finite `float`, and nonnegative
`uint`; no string, object, event, expression, or dynamically typed input is
admitted.

## Packet

`data.packet` contains only:

- `version: 0` and `arithmetic: "ieee754-f32-per-operation"`;
- `input`: source viewport, ordered cursor bounds, initial cursor, signed stick
  range, deadzone/scale, distinct button masks, hit radius, cursor-visible
  ticks, horizontal mirror axis, and exact pointer quantization
  `trunc-toward-zero-then-clamp`;
- `animator`: explicit state ids, initial/eye frame, doze/sleep/wake bounds,
  loop count, and still timers for the fixed v0 graph;
- `source`: view/inverse-view matrices, camera position, projection scale and
  origin, displacement magnitude, eye gain/clamp, and spring constants;
- `triangle`: fixed `corner-bevel` kernel, basis epsilon `1e-9`, and fallback /
  shared-edge amounts;
- `objects.rotationMatrices`: row-major 4x4 matrices;
- `shapes.baseMatrices`: one row-major 4x4 matrix per shape target;
- one target-indexed leaf plan containing cyclic basis, canonical size, matrix
  decimals, seam mask, width, and height;
- unique ordered controls with explicit role, `grab` or `eye-follow` mode,
  source/screen positions, camera distance, attachments, and sparse closure.

A closure declares shape indices; four-column vertex rows
`[shape,sourceVertex,weightOffset,weightCount]`; base vertex positions; parallel
active/scalar/linear/base-translation weight tables; leaf indices; four-column
leaf rows `[leaf,p0Row,p1Row,p2Row]`; safe-visible leaves; and, only for
eye-follow, one rigid-root inverse matrix. Every index is bounded before
materialization.

## Arithmetic and input mirror

`f32` means IEEE-754 binary32 round-to-nearest, ties-to-even. Vector/matrix,
projection, spring, weight, and normalization operations round where the
reference interpreter invokes `f32`. Cursor resistance uses ECMAScript
`Math.trunc`; frame counters wrap as unsigned 32-bit values.

An absolute positioned pointer is finite, truncated toward zero, and clamped
to the declared X/Y cursor bounds before it replaces retained cursor state.
Grab defines `dragging`; its rising edge captures the drag origin. Stick axes
outside the deadzone add `stick * stickScale`, then truncate and clamp. Hold
publishes the declared hold bit.

For a declared horizontal mirror, display stick X and the already quantized and
clamped absolute pointer X are mirrored before source execution, including
asymmetric -128/127 endpoints. Published cursor X mirrors back. Quantization,
clamping, and mirroring are packet data, not adapter conventions.

The browser adapter consumes host events in dispatch order. Mapped enabled
keydown/keyup events update idempotent key levels; primary left pointer down/up
updates a pointer-button level. Multiple positioned-pointer events before one
tick coalesce to the latest position, and that position is consumed exactly once
by the next sample. A positioned pointer suppresses stick movement for that
sample. Sample composition is always `stickX`, `stickY`, `pressed`, `hold`, then
`pointer`; unrelated or disabled key events and editable-target keydown events
are ignored. An editable-target keyup may clear a level already owned by the
mount, preventing a stuck key, but is not consumed with `preventDefault`.

## Animator and tick order

The trusted v0 animator has intro, doze, sleep, wake, converge, eye, and
exit-eye states. The topology is fixed; packet values supply frame/timer
boundaries. Eye state pins source frame to `eyeFrame`, refreshes its still timer
while dragging, and exits when the timer reaches zero.

The packet's `introState`, `dozeState`, `sleepState`, `wakeState`,
`convergeState`, `eyeState`, and `exitEyeState` fields are the seven fixed named
state roles. Their integer ids are unique; they do not create arbitrary states.
The complete guard vocabulary implemented by the trusted graph is:

```text
counter-exhausted(value == 0)
drag-active(control.dragging == 1)
drag-inactive(control.dragging == 0)
frame-after(frame > target)
frame-reached(frame == target)
```

Guard names are specification labels, not packet strings. A package cannot add
guards, transitions, actions, XPath, JavaScript-like expressions, or random
branches. Within doze, drag is tested first, frame increment second, loop wrap
third, and loop exhaustion last; a later transition in that order wins. Other
state branches follow the source order below, so the same state and sample
produce the same next state.

One tick performs, in order:

1. parse and mirror the input sample;
2. capture current source frame, then advance animator;
3. advance the previously active grab and spring;
4. pick/apply the new displacement for the next active grab;
5. publish the prior movement (or zero-offset first pick), preserving source
   draw order;
6. publish eye-follow controls in source order;
7. apply captured surface frame, forced visibility, sparse shape/leaf writes,
   selected output, and cursor state.

Repeated source frames still update spring, eye, cursor, geometry, and the
downstream grab-particle channel.

## Picking and spring

Only grab controls participate. A hit requires strict absolute X and Y distance
below `hitRadius`. Selection uses nearest camera distance; cursor snap uses the
last hit in source order. A moved control is projected from its current matrix;
otherwise use its prepared screen position/distance.

While selected, velocity is `offset * pickedResistance` and the grabbed flag is
set. After release without hold, each component is:

```text
velocity = f32((velocity - offset * releaseAcceleration) * velocityDecay)
```

The closed v0 spring domain is `pickedResistance` in `[-1,0)`,
`releaseAcceleration` in `(0,1]`, and `velocityDecay` in `(0,1)`. This keeps
selected and released motion convergent; zero or amplifying coefficients are
invalid. The validator evaluates the full bounded cursor displacement through
the inverse camera matrix, the selected-offset envelope, source-position sums,
and eye projection/magnitude operations using the declared binary32 order.

Snap to source position only when velocity and offset L1 norms are both
strictly below declared thresholds. Hold freezes velocity. Cursor resistance is
applied after movement and before the new displacement.

## Sparse publication and triangle fit

Fixed buffers are reused. For each referenced weight/component:

```text
translation  = f32(baseTranslation + (active ? grabOffset : 0))
contribution = f32(linearContribution + translation)
vertex       = f32(vertex + contribution * scalar)
```

Grab uses prepared base shape matrices. Eye-follow translates the attached
object rotation by clamped eye offset and multiplies by the rigid-root inverse.
Source row-major matrices reorder axes `[2,0,1,3]` into CSS `matrix3d`; exact
identity is the empty transform.

For each changed leaf row, source `(x,y,z)` maps to CSS `(z,x,y)`. The trusted
corner-bevel kernel uses the declared cyclic basis, normal, seam mask/bleed,
canonical size, width/height, and decimal rounding to produce one affine
`matrix3d`. Degenerate triangles are hidden. Final leaf visibility is composed
by the surface contract from surface, safe-visible, and degeneracy bits.

### Normative corner-bevel kernel

The preceding name is not an appeal to a producer helper. The complete v0
kernel is fixed here. Inputs to this kernel are already-bounded binary32 vertex
components, but the geometry below uses IEEE-754 binary64 operations in the
written order. `epsilon` is the packet's required exact `1e-9`; the raster-space
triangle basis size is the profile constant `32`.

After the `(x,y,z)` to `(z,x,y)` mapping, call the three points `p0`, `p1`, and
`p2`. Compute `e10 = p1 - p0`, `e20 = p2 - p0`, and:

```text
normal = -cross(e10,e20)
normalLength = hypot(normal.x,normal.y,normal.z)
```

Return degenerate when `normalLength <= epsilon`; otherwise divide `normal` by
that length. First try the leaf's declared cyclic basis `[a,b,c]`. If the
length of `p[b]-p[a]` is at most `epsilon`, retry once with the longest of edges
`0→1`, `1→2`, and `2→0`, using strict `>` comparisons in that order (ties keep
the earlier edge). If that retry also has no usable base, return degenerate.

For the selected basis, let `x = normalize(p[b]-p[a])`,
`apexX = dot(p[c]-p[a],x)`, `y = cross(normal,x)`, and
`height = normalLength / baseLength`. A height at most `epsilon` is degenerate.
Set `left = clamp(apexX,0,baseLength)` and `right = baseLength-left`. The local
triangle is the six-number array:

```text
[left,0, 0,height, left+right,height]
```

When `seamEdgeMask` is zero, expand all three edges by `fallbackAmount` using
the stable uniform expansion below. Otherwise, the local edges correspond to
the vertex pairs:

```text
[basis[2],basis[0]], [basis[0],basis[1]], [basis[1],basis[2]]
```

For a pair `(a,b)`, its source edge number is `a` when `(a+1)%3 == b`, `b` when
`(b+1)%3 == a`, and absent otherwise. Its local expansion amount is zero unless
that source-edge bit is set; a set edge uses `safeBleed(points,localEdge,
sharedEdgeAmount)`.

`safeBleed` returns zero for a nonpositive request or an edge length at most
`1e-3`. Otherwise its upper bounds are: half the smallest positive perpendicular
distance from that edge to every non-endpoint vertex; the positive projected
height of the preceding adjacent edge; and the positive projected height of the
following adjacent edge. Distances/heights at most `1e-3` are omitted. It
returns the request when no bound remains, otherwise the request clamped to the
smallest bound.

The general edge-offset operation is exact:

1. If the greatest amount is nonpositive, return the original points.
2. A polygon is convex only when every consecutive cross product has absolute
   value greater than `epsilon` and all signs agree. Its signed area is the
   shoelace sum divided by two.
3. For equal amounts on a nonconvex or zero-area polygon, move each vertex
   radially from the arithmetic-mean centre by that amount. For unequal amounts
   in that case, return the original points.
4. Otherwise offset each directed edge by
   `(outward*dy/length*amount, outward*-dx/length*amount)`, where `outward` is
   `1` for positive area and `-1` otherwise. Intersect each previous/current
   pair of infinite offset lines. A parallel intersection uses the same
   equal-amount radial fallback, or the unchanged polygon for unequal amounts.
5. Clamp each intersection's displacement from its source vertex to
   `max(2, 4*greatestAmount)`.

The mask-zero stable uniform expansion for `(left,right,height,amount)` first
falls back to the general equal-edge operation when amount is nonpositive,
`height` or `left+right` is at most `epsilon`, their sum with `amount` is
nonfinite, or either sloped-edge length is at most `epsilon`. Otherwise, with
`base = left+right`, `ll = hypot(left,height)`, and
`rl = hypot(right,height)`, calculate:

```text
llo = (-amount*height/ll, -amount*left/ll)
rlo = ( amount*height/rl, -amount*right/rl)
leftLine  = (left+llo.x, llo.y)
rightLine = (base+rlo.x, height+rlo.y)
determinant = -height*base
q = leftLine-rightLine
distance = (q.x*height + q.y*left) / determinant
apex = (rightLine.x-distance*right,
        rightLine.y-distance*height)
baseLeft  = (-amount*(left+ll)/height, height+amount)
baseRight = (base+amount*(right+rl)/height, height+amount)
```

Clamp the apex displacement from `(left,0)`, the base-left displacement from
`(0,height)`, and the base-right displacement from `(base,height)` to
`max(2,4*amount)`. These three points are the expanded six-number array.

For either expansion path, let:

```text
baseY       = (expanded[3]+expanded[5])/2
leftPixels  = expanded[0]-expanded[2]
rightPixels = expanded[4]-expanded[0]
heightPixels= baseY-expanded[1]
```

Any nonpositive or nonfinite dimension is degenerate on the declared-basis
attempt and triggers the same one-time longest-edge retry; failure there is
degenerate. Otherwise:

```text
baseWidth = leftPixels+rightPixels
xScale    = baseWidth/32
yXScale   = (rightPixels-leftPixels)/(2*32)
yYScale   = heightPixels/32
txX       = expanded[0]-left-baseWidth/2
txY       = expanded[1]
```

The twelve affine components are, in order, `x*xScale`,
`x*yXScale + y*yYScale`, `normal`, and
`p[c] + x*txX + y*txY`. They map to CSS as
`[v0,v1,v2,0,v3,v4,v5,0,v6,v7,v8,0,v9,v10,v11,1]`. Each component is decimal-rounded to
`matrixDecimals`; exact `0`, `1`, and `-1` retain those spellings and negative
zero becomes `0`. Insert zero fourth components and a final one to form CSS
`matrix3d` in the same 3-by-4 layout used by playback.

Finally, when leaf `width` or `height` differs from `canonicalSize`, parse that
matrix, multiply components 0..2 by `canonicalSize/width` and components 4..6
by `canonicalSize/height`, round all 16 components to
`10^max(6,min(12,matrixDecimals))`, convert with ECMAScript finite-number string
semantics, and normalize negative zero. This last fit, including the fixed
raster basis size of 32, is observable profile behavior.

## Lifecycle and output

The first tick starts at the binding initial frame. Fully idle input advances
the fixed eye → exit-eye → doze → sleep → wake graph; it is not reset each
tick. A new grab while a released spring is still settling resets the fixed
program and restores only remembered sparse rows. Returning to animation
restores those rows, clears forced/degenerate visibility, and restarts playback
without replacing nodes.

Selected output is source-ordered: a first pick returns its source-position
matrix; later ticks return movement computed before the newly sampled
displacement. Translation components feed effects grab xyz only while selected.

## Validation boundary

Unknown fields, non-finite/binary32-overflowing values, invalid states/timing,
unordered bounds, overlapping buttons, unsupported triangle declarations,
matrix/table truncation, noncyclic bases, bad/duplicate sparse indices,
mismatched parallel tables, implicit roles/modes/order, target/cardinality
mismatch, noncanonical inputs/sinks/defaults, and configured
control/object/vertex/weight/weight-reference/leaf-row excess are fatal before execution. An
unsupported or omitted pointer-quantization declaration is also fatal.
Animator frames must be positive and within playback's declared frame count,
and the interaction and playback tick rates must match.
Package-supplied guard/transition/expression fields are unknown and therefore
fatal; `Math.random()` and equivalent nondeterminism have no representation.
