# static-presentation@0

Status: experimental executable codec/interpreter contract for `domformat@0`
and `polycss-3d@0`.

## Purpose

This contract makes an optional host background, fixed source viewport,
perspective camera, scene base transform, fit policy, and optional cursor-layer
targets explicit.
Initial values are applied through `TREE`; resize/appearance publication uses
the fixed binding and packet. No producer-private layout helper is required.

## Packet

State data is `{ "packet": ... }`. The packet has `version: 0`, required
`camera`, and optional `background`.

Camera fields are:

```text
baseSceneTransform  safe local CSS transform
fitWidth            positive integer fit width
fitHeight           positive integer fit height
sourceWidth         positive integer source viewport width
sourceHeight        positive integer source viewport height
perspective         positive finite CSS pixel distance
```

When present, background fields are:

```text
resource  image resource id
opacity   finite number in 0..1
position  safe CSS background position
repeat    safe CSS background repeat
size      safe CSS background size
```

## Binding

The executable binding consumes exactly `viewport.height` then
`viewport.width`, both finite-float inputs with no package default. Targets are:

```text
host          $host (the viewer-owned profile mount surface, not the outer application container)
camera        stable camera node
cursorLayer   optional stable cursor owner
cursorStates  optional distinct stable open/closed cursor image nodes
```

Parameters repeat `fitWidth`, `fitHeight`, `sourceWidth`, and `sourceHeight` and
MUST equal the packet. Declared sinks always include `height`, `left`, `top`,
`transform`, and `width`. The five host background sinks appear exactly when
`background` is present. `visibility` appears exactly when the cursor target
pair is present. The cursor layer and cursor states MUST be declared together,
and pointer interaction requires them.

## Initial retained contract

Before mounting, validation cross-checks presentation against `TREE` and
resources:

- when background is present, its resource is an image and equals the mount
  `backgroundImage` resource binding, overlay syntax and opacity equal the
  packet, and mount background position/repeat/size equal the packet;
- when background is absent, those mount background bindings and layout styles
  are absent;
- the camera target declares `position: relative`, source-dimension width and
  height, packet perspective, and source-centred `perspectiveOrigin`, while
  omitting inline `transformOrigin` and `transformStyle`;
- when playback is present, its model target's base transform and binding
  parameter equal `baseSceneTransform`;
- when cursor targets are present, their layer exists and their open/closed
  states are distinct; pointer interaction requires and exactly matches them.

The mount applies the verified background object/package URL only when the
packet declares one. The camera and any cursor nodes are created once and
retain identity.

## Resize and appearance

Playback appearances supply an additional positive scale and vertical source
translation. For host viewport `(width,height)`:

```text
sourceScale = min(width / fitWidth, height / fitHeight)
scale = sourceScale * appearanceScale
camera.left = width/2 - sourceWidth*scale/2
camera.top = height/2 - sourceHeight*scale/2
             + appearanceTranslateY*sourceScale
camera.width = sourceWidth
camera.height = sourceHeight
camera.transform = scale(scale) when scale != 1
camera inline transform = unset when scale == 1
```

The trusted viewer recomputes this on resize and appearance change. It writes
only the declared camera sinks and does not rebuild any descendant.
If layout dimensions are not yet observable while the mount surface is
detached, the initial publication uses the declared `sourceWidth` and
`sourceHeight`; it never substitutes a hard-coded producer viewport.

Without playback, the presentation uses appearance scale `1` and translation
`0`, publishes source frame `1`, and schedules no clock. Its controller accepts
only `seek(1)`. The identity fit clears the camera's inline `transform`
property instead of publishing `transform: none`, leaving renderer base CSS in
control.

The playback scene transform is the packet's `baseSceneTransform` alone for an
empty prepared model transform, or that base followed by one space and the
prepared model transform.

## Cursor presentation

When present, the pointer-grab interpreter controls only the declared cursor
layer and open/closed cursor state targets. The static presentation contract
supplies their stable placement context; it does not infer control roles from
image order. Presentation without pointer interaction MAY omit all cursor
targets.

## Validation boundary

Unknown packet/target/parameter fields, unsafe CSS values, nonpositive
dimensions/perspective, resource-role mismatch, packet/binding/TREE mismatch,
noncanonical inputs/sinks, or missing/distinctness violations are fatal before
mounting.
