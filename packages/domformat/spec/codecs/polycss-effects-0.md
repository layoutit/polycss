# polycss-effects-prepared@0 / polycss-effects@0

Status: experimental executable codec/interpreter pair for `domformat@0` and
`polycss-3d@0`.

## Purpose and boundary

This contract publishes prepared star sprites and deterministic fixed-pool
particles into declared retained DOM targets. It creates no nodes and executes
no package code. Star paths, exact transforms, sprite cells, emitter roles,
source stars, pool sizes, camera-baked biases, constants, and spawn tuples are
package data rather than producer-private conventions.

## Binding

The binding is executable and consumes, in exact order:

```text
interaction.grab-active interaction.grab-x interaction.grab-y
interaction.grab-z time.source-frame
```

Grab-active is boolean with default false; grab coordinates are floats with
default zero; source frame is uint. Targets contain an ordered star array and
one ordered fixed particle-target array per emitter. Sinks are exactly
`backgroundPosition`, `opacity`, `transform`, and `visibility` styles.

## Packet

`data.packet` contains only:

- `version: 0`, `arithmetic: "ieee754-f32-per-operation"`, and positive
  `frameCount`;
- three-value finite `biases.continuous` and `biases.grab` after camera-axis
  selection/multiplication;
- `particle.damping`, `gravityY`, and a nonempty integer
  `sparkleFrameTable`;
- `spawnStream.count` and exactly that many
  `[timeout,vx,vy,vz]` binary32 tuples;
- `stars[]`, each with `frameCount * 3` xyz positions, `frameCount` exact CSS
  transforms and frame indices, and one through the active `maxFrames` limit
  prepared background positions;
- `emitters[]`, each with explicit `grab` or `follow-star` mode, a valid
  `sourceStar` only for follow mode, positive `poolSize`, and background
  positions. An emitter has at most 256 background positions, matching the
  byte-sized sparkle-frame vocabulary.

Effects require executable playback. Packet and binding frame counts exactly
equal playback's frame count. Playback does not require effects. Target
cardinalities equal packet stars and pools.

## Arithmetic and formatting

`f32(x)` is IEEE-754 binary32 round-to-nearest, ties-to-even, equivalent to
ECMAScript `Math.fround`. Each formula below stores an `f32` result after every
shown operation. `cssNumber(x)` rounds with `Math.round(x * 1e6) / 1e6`, maps
negative zero to zero, and emits ECMAScript's shortest ordinary number string.

Particle transform is exactly:

```text
matrix3d(0,1,0,0,0,0,-1,0,1,0,0,0,
         cssNumber(z),cssNumber(x - 32),cssNumber(y + 64),1)
```

## Initial state

Source frame and shared spawn cursor are zero. Star positions, emitter
positions/velocities, and particle positions/velocities are zero. Emitter active
counts are zero; `armed` and `emitted` are false. Particle timeout is `-1` and
all particle slots are inactive/hidden. The `TREE` styles own initial paint; a
controller publishes a valid frame before presenting effects.

## Ordered publication

`publish(frame,grab)` accepts a 1-based frame and optional
`{active,x,y,z}`. It synchronously:

1. publishes stars in packet order, copying xyz, writing the exact transform,
   and selecting the declared sprite cell;
2. processes emitters in packet order;
3. stores the source frame.

All emitters share one spawn cursor. A spawn consumes one tuple and advances
the cursor modulo the declared count.

Given source position `(x,y,z)`, emitter state advances:

```text
emitter.x  = f32(x + emitter.vx)
emitter.y  = f32(y + emitter.vy)
emitter.z  = f32(z + emitter.vz)
emitter.vx = f32(emitter.vx * damping)
emitter.vy = f32(emitter.vy * damping)
emitter.vz = f32(emitter.vz * damping)
```

Spawning copies emitter position, assigns `timeout = f32(timeout)`, and assigns
velocity as `f32(tupleVelocity + selectedBias)` per component. It marks a slot
active and increments active count only if that slot was inactive.

Each active slot advances before paint:

```text
x = f32(x + vx); y = f32(y + vy); z = f32(z + vz)
vy = f32(vy + gravityY)
vx = f32(vx * damping); vy = f32(vy * damping); vz = f32(vz * damping)
oldTimeout = timeout; timeout = f32(timeout - 1)
if oldTimeout <= 0: deactivate and decrement active count
```

Inactive or nonpositive-timeout slots are hidden. Otherwise
`displayList = trunc(timeout)`; zero hides. A positive value selects
`sparkleFrameTable[displayList - 1]`, writes the exact transform, writes
`opacity = cssNumber(f32(timeout / 10))`, and becomes visible.

A follow-star emitter positions from its explicit star, spawns every inactive
slot using continuous bias, then advances its pool in slot order. A grab emitter
uses active grab coordinates or zero. Inactive grab clears `emitted`; an active
not-yet-emitted transition spawns every inactive slot with grab bias, then sets
`emitted`. If grab is inactive and active count is zero, it clears state and
returns. Repeated publication of one source frame is meaningful.

## Validation and lifecycle

Unknown fields, non-finite/binary32-overflowing numbers, invalid frame/table
cardinality, implicit roles, bad star references, timeout/sprite mismatch,
duplicate/missing targets, noncanonical inputs/sinks, and configured pool/spawn
excess are fatal. The interpreter allocates fixed state once. `destroy()` hides
fixed effect targets and releases interpreter-owned state without replacing
nodes.

Pointer picking and selected-transform production are separate
`polycss-pointer-grab@0` responsibilities; this codec consumes only declared
grab-active/xyz inputs.
