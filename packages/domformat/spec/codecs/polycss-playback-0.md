# polycss-playback-packed@0 / polycss-playback@0

Status: experimental executable codec/interpreter pair for `domformat@0` and
`polycss-3d@0`.

## Purpose

This codec publishes a prepared model transform, shape transforms/visibility,
leaf transforms, and presentation appearance to an already-created retained
tree. Surface visibility and texture-lighting state are deliberately a separate
`polycss-surface@0` contract. Playback with one or more leaf targets requires
that surface contract; leafless playback does not.

The version-0 packet has no implicit lighting-row column or duplicate playback
leaf visibility. Source frame is the explicit surface input, and leaf visibility
is owned only by the surface/interaction visibility composition.

## Binding

The binding is executable, consumes exactly `time.tick`, and declares targets:

```text
model   one stable scene node
shapes  shapeCount stable nodes in source order
leaves  leafCount stable nodes in source order
```

Its sinks are exactly `style.transform` and `style.visibility`. Parameters are
`frameCount`, fixed `tickRateHz: 30`, and the safe CSS
`baseSceneTransform`. `time.tick` has type `uint`.

## State data

The state data has `packet` and `leafFit`. `leafFit` contains exactly one
`{canonicalSize}` positive-integer record per leaf.

The packet fields are:

```text
version       0
layout        delta-component-streams@0
shapeCount    target cardinality
leafCount     target cardinality, at most 65,536
appearances   [id, scale, translateY][]
timeline      {introTicks, loopTicks, frames}
initial       initial source/model/shape/leaf state
frameRows     one directly indexed row per source frame
shapeChanges  delta-coded shape/transform columns plus visibility
leafChanges   delta-coded leaf/transform columns
transforms    grouped 12-component affine transform streams
```

An appearance id is unique. Scale is positive and translation is finite.

## Delta tables

An initial transform column contains deltas. Starting at zero, add each delta
to obtain one transform-table index per target. Initial shape visibility is a
parallel zero/one column. Initial leaf state has transforms only.

Every frame row is the seven-integer tuple:

```text
[sourceFrame, appearance, modelTransform,
 shapeOffset, shapeCount, leafOffset, leafCount]
```

`sourceFrame` is its 1-based array index. `modelTransform` is `-1` for no
change, otherwise a transform-table index. Shape and leaf ranges partition
their complete change tables contiguously; no row may be skipped or referenced
twice.

Within each frame's shape range, reset `shape = 0` and add each `sources` delta.
Within each frame's leaf range, reset `leaf = 0` and add each `sources` delta.
The transform accumulator is separate for shapes and leaves, begins at zero,
and continues across all frames. Shape `visibility` is a parallel zero/one
column. Every expanded target and transform index is bounds-checked.

## Transform streams

`transforms.count` is the exact transform-table length. Every transform index
is owned by at least one model, shape, or leaf reference. Ownership is inferred
from initial state and then frame rows in order. A transform may be shared by
shapes; a fitted leaf transform cannot alias another ownership kind.

Scan transform indices from zero upward and group equal inferred owners in
first-owner order. `transforms.groups` has exactly one entry per resulting
owner. Each group contains:

```text
encoding  decimal-component-streams | source-milli-fitted-leaf
empty     strictly sorted group-row indices whose transform is the empty string
scales    12 nonnegative integer scales
columns   12 parallel columns, each with groupRows - empty.length values
```

For a zero scale, a column value is the component directly. For a positive
scale, cumulatively add integer deltas and divide each result by the scale.

For `decimal-component-streams`, the 12 decoded values become:

```text
matrix3d(v0,v1,v2,0,v3,v4,v5,0,v6,v7,v8,0,v9,v10,v11,1)
```

using the canonical decimal string of each decoded number.

`source-milli-fitted-leaf` is allowed only for a leaf owner and all scales are
exactly 1000. After delta expansion, each component is recovered as an integer
source milli-unit by `round(value * 1000)`. Divide the first nine components by
1000. Multiply components 0..2 by `canonicalSize / leafWidth` and components
3..5 by `canonicalSize / leafHeight`. Round those first six fitted components
with `cssNumber`; format components 6..11 as signed source milli-units without
redundant trailing zeros. Insert the same affine zero/one positions shown above.

For nonempty leaf targets, `leafWidth` and `leafHeight` come from the
same-index surface face, making the playback/surface cardinality and ordering a
required cross-contract invariant. A playback packet with `leafCount: 0` has
an empty `leafFit` array and MAY omit `polycss-surface@0` entirely.

## Timeline

`frames.length` is exactly `introTicks + loopTicks`, `loopTicks` is positive,
and every entry is in `1..frameCount`. `frames[0]` equals the initial source
frame. For nonnegative tick:

```text
index = tick < frames.length
  ? tick
  : introTicks + ((tick - introTicks) mod loopTicks)
sourceFrame = frames[index]
```

The controller begins at tick 0. `advance()` increments tick, resolves the
target source frame, and performs a sequential update or seek. The reference
mount scheduler calls `advance()` once every `1000 / tickRateHz` milliseconds.
When an animation frame spans multiple due ticks, it advances once per due tick
and increments the deadline by that fixed interval after each step; a dropped
animation frame therefore does not permanently slow playback.

## Publication

Initial shape/leaf transform tables and shape visibility are expanded into
fixed arrays. Initial DOM styles come from `TREE`; the controller publishes the
initial appearance and downstream effects on mount.

For a sequential frame row, in order:

1. If appearance changed, publish its camera fit.
2. If model transform is not `-1`, write the model transform. The empty
   transform means exactly `baseSceneTransform`; otherwise write
   `baseSceneTransform + " " + preparedTransform`. If the retained model's
   inline transform already equals that exact string, preserve it without a
   redundant assignment.
3. Apply shape changes in row order, writing transform and visible/hidden.
4. Apply leaf changes in row order, writing transform only.
5. When `polycss-surface@0` is present, publish the same 1-based source frame
   to it.

Appearance camera fit uses host width/height, falling back to the trusted
viewport option and then 320x240:

```text
sourceScale = min(width / fitWidth, height / fitHeight)
scale = sourceScale * appearance.scale
left = width/2 - sourceWidth*scale/2
top  = height/2 - sourceHeight*scale/2
camera width/height = sourceWidth/sourceHeight
camera transform = scale(scale) when scale != 1
camera inline transform = unset when scale == 1
```

`translateY * sourceScale` is added to `top`. CSS numbers use the profile's
six-decimal rounding and negative-zero normalization. Clearing the identity
inline transform preserves renderer base-CSS camera behavior; publishing
`transform: none` is not equivalent.

Seek advances frame rows forward with `frameCount -> 1` wrapping until the
target, without intermediate DOM writes; it then publishes the final model,
appearance, changed shapes/leaves in ascending target order, and surface frame.
This produces the same state as applying all intervening rows.

Interaction may temporarily replace declared shape/leaf transforms and force
leaf visibility. Restart seeks to the initial source frame, restores only the
declared modified target indices from the playback arrays, clears interaction
visibility state through the surface controller, and resets tick to zero.

## Validation boundary

The validator rejects unknown fields, bad versions/layouts, noncanonical input
or sink sets, target/count mismatch, invalid appearances/timeline, nonpartitioned
frame ranges, malformed delta references, transform aliases across incompatible
owners, unowned transforms, group/column/scale mismatch, unsafe CSS values, and
all configured allocation excess before transform materialization.
