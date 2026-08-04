# polycss-3d@0 profile

Status: experimental private alpha for `domformat@0`.

## 1. Conformance model

This profile describes a stable retained XHTML subtree, its closed CSS/resource
semantics, prepared state, and the exact DOM targets that a trusted viewer may
update. A conforming reader validates the entire contract before constructing
DOM. A conforming executable viewer implements only the fixed interpreters it
advertises and never evaluates package-supplied code.

Two viewers pass the profile's honesty test when, from the same package, they
can construct the same ordered stable subtree and publish the same prepared
updates without producer-private adapter knowledge.

## 2. Common identifiers and values

A stable id matches `[a-z][A-Za-z0-9._:/-]{0,127}` and contains neither `..`
nor `//`. Resource ids use the narrower grammar in the package spec. Class
tokens match `[A-Za-z_][A-Za-z0-9_-]{0,63}`. Data attributes match
`data-[a-z][a-z0-9._:-]{0,63}`.

Style values are strings no longer than 4096 code units. A local style value
MUST NOT contain CSS escapes, comments, declaration delimiters,
custom-property syntax, case-insensitive `url(`, `javascript:`, `expression(`,
`@import`, `var(`, `env(`, `attr(`, `paint(`, or a function outside the fixed
inline-safe vocabulary. Resource-backed URLs use typed bindings instead.

## 3. TREE version 0

`TREE` has exactly `version`, `mount`, and `nodes`.

### 3.1 Mount

`mount.behavior` is exactly `replace-children`. The format host is a
viewer-owned mount surface, not an embedding application's outer container. A
viewer removes all existing surface children before constructing nodes.
`mount.attributes` is an ordered array of unique two-string `[name,value]`
pairs. `mount.styles` and `mount.resourceStyles` are optional maps and default
to empty. The literal BIND target `$host` refers to this surface. The surface
is not a TREE node and has no package stable id.

An executable browser viewer either dedicates an isolated document to that
surface or creates one safe XHTML `div` inside the application container. The
reference viewer uses the latter and fixes these boundary declarations as
viewer-owned inline-important values after applying TREE mount data:

```text
display:block; position:relative; inset:0; width:100%; height:100%;
max-width:none; margin:0; padding:0; border:0; box-sizing:border-box;
overflow:hidden; contain:strict; isolation:isolate; transform:none;
z-index:auto; opacity:1; visibility:visible; pointer-events:auto
```

Package CSS cannot override that boundary. This makes fixed descendants and
other package paint remain inside the sized application container while
preserving the declared stable subtree beneath the surface.

Supported mount attributes are `alt`, `aria-hidden`, `class`, `decoding`,
`draggable`, `height`, `id`, `role`, `width`, and data attributes. Node-local
attributes use the same vocabulary except that `class` is forbidden because
node classes have the single canonical `classes` field. Values are at most
1024 code units. Event attributes, `srcdoc`, and a literal `style` attribute are
forbidden. `data-domformat-instance` and `data-domformat-mount-surface` are
reserved to the viewer and are forbidden on the mount and every package node.

Supported mount style properties are `backgroundColor`,
`backgroundPosition`, `backgroundRepeat`, `backgroundSize`, and optionally
`position` with the exact value `relative`. Resource-backed background image
remains typed as described below. Other layout, transform, containment,
stacking, visibility, opacity, overflow, and pointer-event declarations are
viewer-owned on the mount surface and invalid in `TREE.mount.styles`.

Supported node-local style properties are:

```text
backgroundColor backgroundPosition backgroundPositionY backgroundRepeat
backgroundSize borderBottomLeftRadius borderBottomRightRadius borderShape
borderTopLeftRadius borderTopRightRadius color cornerBottomLeftShape
cornerBottomRightShape cornerTopLeftShape cornerTopRightShape height left
objectFit objectPosition opacity perspective perspectiveOrigin position top
transform transformOrigin transformStyle visibility width
```

The fixed inline-safe function vocabulary is:

```text
abs acos asin atan atan2 calc clamp color color-mix cos exp hsl hsla hwb hypot
lab lch linear-gradient log matrix matrix3d max min mod oklab oklch polygon pow
radial-gradient rem rgb rgba rotate rotate3d rotatex rotatey rotatez round scale
scale3d scalex scaley scalez sign sin skew skewx skewy sqrt tan translate
translate3d translatex translatey translatez
```

### 3.2 Nodes

`nodes` is an ordered, parent-before-child construction plan. Each node has
exactly these fields (the empty maps/arrays MAY be omitted where noted by the
schema, but writers emit them consistently):

```text
index               canonical zero-based index
id                  unique stable id
parent              -1 for host child, otherwise an earlier node index
sibling             zero-based sibling order within that parent
namespace           http://www.w3.org/1999/xhtml
name                b | div | i | img | s | span | u
classes             unique class-token array
attributes          local string attribute map
styles              local style map
resourceAttributes  typed resource attribute map
resourceStyles      typed resource style map
```

An executable `polycss-surface@0` binding MAY have an empty `leaves` target
array when the retained document has no prepared surface leaves. Other binding
channels MUST resolve to at least one DOM target.

For every parent index, sibling values MUST be consecutive starting at zero.
The parent-before-child rule makes a cycle impossible. A viewer constructs each
node with `createElementNS(namespace,name)`, applies classes/attributes/styles,
and appends it to the host or already-created parent. The viewer keeps the node
object for the lifetime of the mounted package; prepared updates MUST NOT
replace it.

Every terminal node in version 0 is a generated visual leaf and MUST declare
the exact attribute `aria-hidden="true"`. This profile has no text nodes or
separately validated accessible alternate tree, so a terminal node without
that declaration is invalid rather than silently exposed as empty content.

The only resource attribute is `src`, and it MUST refer to an image resource.
The only resource style is `backgroundImage`, also bound to an image. Its value
is one of:

```json
{"resource":"image-id","syntax":"url"}
{"resource":"image-id","syntax":"overlay-url","overlayOpacity":0.75}
```

For `url`, the viewer writes `url(<resolved-object-or-package-url>)`. For
`overlay-url`, it writes a black linear-gradient overlay whose alpha is
`1 - overlayOpacity`, followed by the resource URL. `overlayOpacity` is a
finite number from zero through one and is present only for `overlay-url`.

An image resource is one static PNG or WebP image. Animated PNG (`acTL`,
`fcTL`, or `fdAT`) and animated WebP are invalid because animation is observable
state and MUST be represented by a declared prepared channel.

Every `RCRD` entry MUST be reachable from `TREE` resource attributes/styles,
`CSSB` stylesheet/token bindings, or the prepared presentation background.
Unused resource records are invalid. Version 0 has no generic binary resource
kind.

## 4. CSSB version 0

`CSSB.stylesheets` is a nonempty ordered array. Each entry contains exactly:

```text
id           unique resource-style id
resource     stylesheet resource id
scope        [data-<name>="<safe-token>"]
assetTokens  ordered unique {token,resource} mappings
```

Every token matches `dom-asset:[a-z][a-z0-9._-]{0,63}` and refers to an image
resource. The bound stylesheet is strict UTF-8 and at most the configured CSS
limit. `scope` MUST name an exact `[name,value]` attribute pair on `TREE.mount`.
The scope name matches `[a-z0-9-]{1,64}` and its value matches
`[A-Za-z0-9._-]{1,64}`.

The alpha CSS grammar is deliberately fail-closed. It accepts only flat
qualified rules. Backslash escapes, comments, CDO/CDC tokens, at-rules, nested
rules, custom properties, `behavior`, and `-moz-binding` are invalid. Every
selector in a comma list MUST begin with the exact declared scope. A sibling or
column combinator immediately after that scope is invalid because it could
select outside the mount; descendant and child selection remain inside it.

Declaration names are case-insensitive and limited to this fixed property
vocabulary; every other property is invalid:

```text
-webkit-backface-visibility backface-visibility
background background-clip background-color background-image
background-position-x background-position-y background-repeat background-size
border border-bottom-left-radius border-bottom-right-radius border-color border-shape
border-top-left-radius border-top-right-radius box-sizing color contain content
corner-bottom-left-shape corner-bottom-right-shape corner-top-left-shape
corner-top-right-shape cursor
display font font-style font-weight height image-rendering inset isolation left
line-height margin max-width object-fit object-position opacity overflow padding
pointer-events position text-decoration top touch-action transform
transform-origin transform-style user-select visibility width will-change z-index
```

Function names are case-insensitive and limited to this fixed vocabulary;
unknown functions such as `image-set`, `var`, `env`, `attr`, `paint`, and
`element` are invalid:

```text
abs acos asin atan atan2 blur brightness calc circle clamp color color-mix
conic-gradient contrast cos counter counters cubic-bezier drop-shadow ellipse
exp fit-content grayscale hsl hsla hwb hypot hue-rotate inset invert is lab lch
light-dark linear-gradient log matrix matrix3d max min minmax mod not nth-child
nth-last-child nth-last-of-type nth-of-type oklab oklch opacity path perspective
polygon pow radial-gradient rem repeat repeating-conic-gradient
repeating-linear-gradient repeating-radial-gradient rgb rgba rotate rotate3d
rotatex rotatey rotatez round saturate scale scale3d scalex scaley scalez sepia
sign sin skew skewx skewy sqrt steps tan translate translate3d translatex
translatey translatez url where
```

`url()` is special: its complete quoted or unquoted argument MUST be exactly a
declared logical token, and every declared token MUST appear at least once.
Strings in any other allowed function do not grant network access.

After validation and resource verification, a viewer allocates a unique safe
`data-domformat-instance` value on the viewer-owned mount surface. In one span-based pass it replaces
only initial selector scope spans with that instance selector and replaces only
complete `url()` token spans with URLs created or resolved for their matching
resources. It inserts one style element identified by the binding id and
removes it during teardown. Prefix/string replacement is nonconforming. The
embedding application container never receives package attributes, package
styles, or the runtime scope token.

## 5. STAT version 0

`STAT` contains exactly `version` and `channels`. Channels are strictly sorted
by stable `id` and contain exactly `id`, `codec`, and `data`. Every channel id is
unique. Version 0 knows these codecs:

| State codec | Matching interpreter | Status |
|---|---|---|
| `polycss-effects-prepared@0` | `polycss-effects@0` | executable |
| `polycss-playback-packed@0` | `polycss-playback@0` | executable |
| `polycss-pointer-grab-prepared@0` | `polycss-pointer-grab@0` | executable |
| `polycss-surface-packed@0` | `polycss-surface@0` | executable |
| `static-presentation@0` | `static-presentation@0` | executable |

Unknown codecs are invalid in profile version 0. Codec data is declarative and
is validated by its codec specification before materialization.

## 6. BIND version 0

`BIND` contains exactly `version`, `inputs`, and `channels`.

Inputs are strictly sorted by stable id and contain `id`, `type`, and optional
`default`. Type is `boolean`, finite `float`, or nonnegative safe-integer
`uint`; a default MUST match its type. Every declared input MUST be consumed by
at least one binding channel. Viewer-owned clock/source-frame/viewport inputs
MUST omit package defaults; fixed interaction controls use only the exact
profile defaults derived by their codec.

Binding channels are strictly sorted by stable id and contain:

```text
id           unique binding id
state        one STAT channel id
interpreter  fixed profile interpreter id
status       executable
inputs       unique declared input ids in interpreter-defined order
targets      interpreter-defined stable node ids or $host
sinks        unique whitelisted DOM sinks
parameters   interpreter-defined constants, when required
```

Every state channel is bound exactly once. The state codec and interpreter MUST
match the table above, and an interpreter occurs at most once. Every target is
an actual string leaf, is unique within a nonempty binding target graph, and
refers to an existing `TREE` id, except the literal `$host`. A binding cannot
contain more target strings than all retained node ids plus `$host`; malformed
scalar leaves are invalid rather than ignored. Codec-specific node arrays do
not permit `$host`. Cross-channel reuse of a target is allowed only where codec
semantics explicitly coordinate it (for example playback, surface, and
interaction share leaf targets).

Surface and interaction shape/leaf arrays exactly equal playback's arrays in
the same order. A surface requires playback, while leafless playback MAY omit
surface. Effects targets are disjoint from all other channels. Presentation
targets other than `$host` are disjoint from playback; its optional cursor
targets exactly match interaction when interaction is present. These ownership
rules prevent two unrelated interpreters from racing the same sink.

The complete sink vocabulary is:

```text
host.style.backgroundColor host.style.backgroundImage
host.style.backgroundPosition host.style.backgroundRepeat
host.style.backgroundSize
style.backgroundPosition style.backgroundPositionY style.height style.left
style.opacity style.top style.transform style.visibility style.width
```

A binding does not grant general DOM access. An interpreter MUST write only its
declared sinks on its declared targets.

## 7. Cross-section invariants

Validation occurs before state materialization or DOM construction and includes:

- profile/section version and known-field checks;
- exact state/interpreter pairing and one binding per state;
- target existence, uniqueness, and codec-specific cardinality;
- direct frame indexing and all offset/count ranges;
- transform/state/change/table allocation ceilings;
- image/resource role and CSS-token closure;
- codec-specific input order, input types/defaults, parameters, and sink order;
- playback/surface frame-count and leaf-count agreement when surface is
  present, and required surface closure for nonempty playback leaves;
- exact semantic equivalence of every prepared sequential surface transition
  and declared jump to its canonical target frame;
- cross-channel target ownership and interaction/playback target-order closure;
- effects/playback frame-count agreement for every effects channel, and
  effects/interaction/playback agreement for pointer interaction.

The minimum reference-mountable executable closure is static presentation.
Playback is optional; playback with one or more leaf targets requires surface, while
leafless playback MAY omit it. Effects are optional for noninteractive
animation, but effects themselves require playback and exactly share its frame
count. Pointer interaction requires playback, presentation, effects, and the
presentation cursor targets. A reader may inspect a valid package without
implementing every executable interpreter, but an executable viewer MUST reject
any required interpreter it does not implement before construction.

The reference `mountDom` implementation requires presentation and implements
the optional playback, surface, effects, and pointer channels according to the
validated closure. A presentation-only mount publishes source frame `1`, has
no scheduler, and accepts only `seek(1)`.

## 8. DOM publication and lifecycle

All prepared state updates are synchronous writes to existing targets. Viewer
input adapters translate trusted host events into standardized `BIND` inputs;
they do not expose package data to event handler compilation.

The only conforming lifecycle order is:

```text
validate → construct → bind → initialize → publish → destroy
```

No phase may be skipped, repeated, or entered out of order. The observable
precondition and postcondition of each phase are:

1. **validate** — precondition: complete JSON document bytes and every required
   sibling resource are available under active limits; postcondition: transport,
   closed schemas, versions, capabilities, references, CSS, media signatures,
   sizes, digests, and allocation products have passed, with no DOM mutation.
2. **construct** — precondition: validation passed; postcondition: a detached
   viewer-owned mount surface and exact parent-before-child `TREE` nodes exist,
   stable ids resolve to those same node objects, the embedding host is
   unchanged, and no resource or prepared-state publication has occurred.
3. **bind** — precondition: construction completed; postcondition: logical
   resources are resolved, typed resource attributes/styles are applied, scoped
   stylesheets are installed, and every declared target/sink is resolved to and
   retained as the already-constructed node object. This postcondition holds
   before the bind phase is observable. No prepared update has been published.
4. **initialize** — precondition: bindings completed; postcondition: bounded
   state has been materialized, fixed interpreters and input adapters exist, and
   observers may be allocated but are not active. Initialization MUST NOT start
   clocks, accept input, or publish prepared state.
5. **publish** — precondition: initialization completed; postcondition: every
   prepared initial sink has authoritatively overwritten detached TREE
   placeholders, the surface is atomically attached to the embedding host, the
   declared initial state/frame and experience are visible, owned input and
   observers are enabled, optional scheduling has begun, and runtime operations
   may be called.
6. **destroy** — may follow successful publication or any failed phase. It
   cancels scheduling and pointer capture, disconnects listeners/observers,
   destroys interpreter state, removes owned styles and the mount surface,
   revokes object URLs, and restores the embedding container. A second or later
   destroy is a no-op, and publication operations thereafter fail.

Phase completion is observable only after its postcondition holds. If any
operation or phase observer fails, the viewer MUST transactionally clean up all
work completed so far and enter `destroy`; it MUST NOT return a partial runtime.
The reference mount runtime exposes a read-only current phase and completed
phase history for verification. It also exposes the current prepared source
frame and a bounded `seek(frame)` operation after publication. Its public
controller does not expose raw node maps, input adapters, prepared channels, or
profile interpreter instances.

When playback is present, the reference scheduler derives its interval from
the closed playback binding `tickRateHz`; version 0 fixes that value to 30. It
advances once per due fixed-rate tick and carries the deadline forward by that
interval, including when one browser animation frame spans multiple ticks.

Keyboard input listeners are attached to the mount, not the global window, and
therefore act only while events target or bubble through that mount. A viewer
MAY add a temporary focus target such as `tabindex="0"`, but MUST restore its
prior value. Window-level blur handling MAY clear owned input state; it MUST NOT
capture keyboard commands outside the mount.

A mount controller owns every inserted stylesheet, object URL, event listener,
animation-frame request, and resize observer. Aborted URL loads MUST cancel
active response reads and MUST NOT construct partial DOM. The browser viewer
MUST decode every declared image and confirm its dimensions before publication;
decode failure rolls back the mount.

## 9. Codec specifications

The normative executable codec contracts are:

- [`codecs/polycss-playback-0.md`](./codecs/polycss-playback-0.md)
- [`codecs/polycss-surface-0.md`](./codecs/polycss-surface-0.md)
- [`codecs/static-presentation-0.md`](./codecs/static-presentation-0.md)
- [`codecs/polycss-effects-0.md`](./codecs/polycss-effects-0.md)
- [`codecs/polycss-pointer-grab-0.md`](./codecs/polycss-pointer-grab-0.md)

The profile deliberately omits arbitrary elements/attributes/CSS, package code,
network resources, text nodes, an accessibility alternate tree, and general
animation expressions. Those require later explicit versioned contracts.
