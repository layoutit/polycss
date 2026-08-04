# polycss-surface-packed@0 / polycss-surface@0

Status: experimental executable codec/interpreter pair for `domformat@0` and
`polycss-3d@0`.

## Purpose

This codec publishes prepared texture-atlas Y positions and composed leaf
visibility for each playback source frame. It does not discover materials,
sample lighting, pack atlases, scan topology, or create nodes at runtime.

## Binding and coupling

The binding is executable, consumes exactly the `uint` input
`time.source-frame`, targets a unique ordered `leaves` array, and declares
exactly `style.backgroundPositionY` and `style.visibility`. It has no
parameters. Its targets exactly equal the playback leaf targets in the same
order.

The state is `{ "packet": ... }`. Packet `version` is 0 and `frameCount`
equals playback's binding frame count.

## Surface state packing

`packet.surface.faces` contains one target-indexed record:

```text
faceId       unique stable source face identity
sourceOrder  exact zero-based array index
stateOffset  contiguous offset into sourceFrameDeltas
stateCount   positive number of states
leafWidth    positive fitted leaf width
leafHeight   positive fitted leaf height
```

The state ranges partition `surface.statePacking.sourceFrameDeltas`, whose
length is exactly `stateCount`. For each face, begin `sourceFrame = 0`; its first
delta is exactly zero and each later delta is positive. Cumulative frames stay
within `0..frameCount-1`. A face's local state index is the last state whose
cumulative source frame is at most the zero-based requested frame.

The prepared CSS Y position for a state is `0` when its cumulative source frame
is zero, otherwise `-(sourceFrame * leafHeight)px`.

## Sequential lighting transitions

`packet.transitions.initialFrame` is exactly frame 1 and equals playback's
initial source frame.
`transitions.sequential` contains parallel `faceIndexDeltas` and
`stateIndexDeltas`, plus canonical base64 little-endian uint32 offsets.
Offsets has `frameCount + 1` entries, begins at zero, is nondecreasing, and ends
at the parallel-column length.

For each segment in offset order, reset `face = 0`; cumulatively add face deltas
to obtain a strictly increasing target list. Maintain a zero-initialized local
state index per face and cumulatively add the corresponding state delta. Every
result stays within that face's `stateCount`. Segment `n` represents the
sequential publication whose target frame is `n + 1`; segment zero therefore
represents the wrap to frame 1.

Materialization converts these deltas to parallel little-endian uint16 face and
state index tables while retaining the uint32 offsets.

Every sequential segment is semantic, not trusted acceleration data. For each
transition `fromFrame -> toFrame` (including `frameCount -> 1`), its visibility
faces exactly equal the XOR of the two canonical visibility rows. Its lighting
faces exactly equal the target-visible faces that were hidden in the source row
or whose scheduled local state changed, and each state entry is the canonical
target local state. Extra, omitted, or contradictory rows are invalid.

## Visibility schedule

`packet.visibility.initialFrame` equals the lighting initial frame.
`initialVisibleBitsBase64` is a canonical byte bitset of exactly
`ceil(leafCount/8)` bytes. Bit `i & 7` of byte `i >> 3` is leaf `i`; unused high
bits are zero.

Sequential visibility contains canonical base64 little-endian uint32 offsets
and uint16 face indices. Offsets has `frameCount + 1` entries and partitions the
face array. Each segment is strictly increasing. Starting from the initial
bitset, XOR each listed face to obtain the target frame row. A reader may
precompute all rows only when `leafCount * frameCount` is within the visibility
allocation limit.

## Noninteractive jumps

Lighting and visibility each declare the same unique `(fromFrame,toFrame)` jump
pairs. Frames are 1-based, in range, and different.

A lighting jump stores equal-length canonical base64 little-endian uint16 face
and local-state arrays, with strictly increasing faces and in-range states. A
visibility jump stores strictly increasing uint16 face indices to toggle.

Each declared jump MUST equal the same canonical comparison rule used for a
sequential transition. Matching lengths and in-range indices are insufficient:
a syntactically valid accelerator that contradicts its target frame is invalid.

Jumps are optional accelerators. When a requested nonsequential pair is absent,
the viewer derives the exact target by comparing the precomputed visibility row
and by binary-searching each currently visible face's state schedule. The
fallback is semantically identical, so jump presence is packaging/runtime cost,
not an implicit adapter rule.

## Publication and visibility composition

For target source frame `nextFrame`, a transition is sequential when it is the
current frame plus one, with `frameCount -> 1` wrapping. Use the sequential
segment or matching jump; otherwise use the fallback above.

Visibility publication toggles the prepared surface-visible bit. Final CSS
visibility for leaf `i` is:

```text
(surfaceVisible[i] OR interactionForcedVisible[i])
AND NOT interactionDegenerate[i]
```

Write `visible` or `hidden` only when the value changes. For each lighting row,
skip a currently surface-hidden face; otherwise write its prepared
`backgroundPositionY` and remember its applied local state. This separates
prepared culling, interaction safety visibility, and triangle degeneracy
without duplicating visibility in the playback packet.

Initial surface visibility is declared on the same leaf nodes in `TREE`.
Initial nonzero background positions are declared explicitly. A zero position
MAY be omitted because the CSS initial value of `background-position-y` is
semantically zero; if present it MUST be `0`, `0px`, or `0%`. The packet's
initial frame and state schedules MUST agree with those styles as a
cross-section invariant.

## Validation boundary

The validator rejects unknown fields, target/frame mismatch, more than 65,536
leaves, noncontiguous face/state ranges, invalid source-frame deltas, malformed
or noncanonical base64, truncated/wrong-width integer tables, bad offsets,
unsorted or out-of-range faces/states, mismatched jump pairs, nonzero unused
visibility bits, semantically incomplete or contradictory sequential/jump rows,
and configured state/change/visibility allocation excess.
