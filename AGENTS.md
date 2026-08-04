# PolyCSS — agent guide

This file is the single source of truth for AI coding agents (Claude Code, Cursor, etc.). `CLAUDE.md` is a symlink to this file — **always edit `AGENTS.md`, never `CLAUDE.md`**. The constraints below describe the current design and the rules we work under; if a request conflicts with one of them, push back before doing it.

## What this repo is

PolyCSS is a CSS-based polygon mesh rendering engine. It paints 3D meshes by emitting one DOM element per polygon, transforming it with `matrix3d`, and letting the browser composite the result. No WebGL, no canvas-per-frame. Rasterisation only happens once, into a texture atlas; everything after that is pure DOM + CSS.

Monorepo layout (pnpm workspaces):

| Package | npm name | Role |
|---|---|---|
| `packages/core` | `@layoutit/polycss-core` | Pure math: Vec3, Polygon, scene, camera, mesh ops, atlas planning. Zero browser globals (lib: ES2020 only). |
| `packages/polycss` | `@layoutit/polycss` | Vanilla renderer + custom elements (`<poly-scene>`, etc.). Owns DOM emission, CSS injection, its own copy of atlas rasterisation. Depends on `core` only. |
| `packages/react` | `@layoutit/polycss-react` | React components + hooks. Owns its own copy of atlas rasterisation. Depends on `core` only — **NOT on `polycss`.** |
| `packages/vue` | `@layoutit/polycss-vue` | Vue 3 mirror of the React package. Owns its own copy of atlas rasterisation. Depends on `core` only. |
| `packages/fonts` | `@layoutit/polycss-fonts` | Fonts + text → extruded 3D `Polygon[]`. Hand-written TrueType (`glyf`) reader + extruder (flat/round/bevel profiles) + Google Fonts loader. Framework-agnostic (returns `Polygon[]`, no React/Vue mirror needed). Depends on `core` + `earcut`. |
| `packages/morph` | `@layoutit/polycss-morph` | Framework-agnostic prepared-model contracts, deterministic Node preparation, browser loading, retained DOM mounting, sparse deformation, controls, springs, animation, joint skinning, and prepared playback. The browser entry uses public `@layoutit/polycss` APIs; Node-only preparation lives at `@layoutit/polycss-morph/prepare`. No React/Vue mirrors. |
| `packages/domformat` | `@layoutit/polycss-domformat` | Private source-only `domformat@0` writer, reader, validator, CLI, and browser mount with repository-side conformance. Owns the producer-neutral wire contract; producer lowering stays in producer packages. Runtime installs exclude certification material. Not published. |
| `website` | `@layoutit/polycss-website` | Astro + Starlight docs site. Not published. |
| `examples/{html,vanilla,react,vue,fontcss}` | private | Per-framework Vite apps demonstrating the minimal usage for each renderer (`fontcss` demos `@layoutit/polycss-fonts`). Workspace members so they resolve to local `workspace:^` packages. Not published. |

Public API is **mirrored** across React and Vue. Adding a hook on one side without adding the matching composable on the other is not acceptable (see "Cross-package discipline" below).

### Three-like parity surface

The native PolyCSS API keeps PolyCSS world and camera conventions. For agent-friendly Three.js ports, the monorepo also exposes explicit `*/three` subpaths:

- `@layoutit/polycss-core/three` — pure Three-like math wrappers, camera conversion, lights, and transforms.
- `@layoutit/polycss/three` — the core Three-like surface plus vanilla scene helpers.
- `@layoutit/polycss-react/three` and `@layoutit/polycss-vue/three` — mirrored framework components: `PolyThreePerspectiveCamera`, `PolyThreeOrthographicCamera`, and `PolyThreeMesh`.

These subpaths intentionally use Three-compatible public names and units: `Vector3`, `Euler`, `Object3D`, `PerspectiveCamera`, `OrthographicCamera`, `DirectionalLight`, `PointLight`, `AmbientLight`, radians for object rotations, Y-up authoring coordinates, and `camera.position` + `camera.lookAt(...)` framing. They are adapters over PolyCSS, not a Three.js runtime dependency. Geometry authored in that surface is converted to native PolyCSS coordinates with `transformPolygonsToPoly`; the Y-up → Z-up axis map is `[x, -z, y]` so winding and Lambert lighting stay right-handed. The vanilla `mountPolyThreeScene` helper defaults `textureLighting` to `"baked"` because baked Lambert is the Three-parity baseline. Dynamic lighting remains available as an explicit opt-in for live CSS light changes, but it is not the exact conformance mode.

## Rendering model — the mental model

**One visible `Polygon` → one leaf DOM element.** Leaves use canonical CSS primitives where possible and move scale into `matrix3d`; clipped solids use fixed primitives because their paint geometry becomes unstable when collapsed to 1px. Atlas-backed textured polygons pack their local-2D bounding rect (`canvasW × canvasH`) into atlas pages; source-exact textured polygons may instead carry `textureImageSource` + `texturePresentation.backend="image"` and render as direct image leaves without atlas rasterisation. The HTML tag *is* the render strategy — the renderer picks one tag per polygon based on its shape and material.

Raw MagicaVoxel `.vox` sources have a narrower baked-mode fast path: `parseVox` still returns the polygon mesh for bounds, fallback rendering, and public handles, but also preserves a `PolyVoxelSource` marker. Eligible vanilla, React, and Vue meshes render visible voxel quads as `<b>` leaves inside persistent signed-face wrappers (`t`, `b`, `fl`, `br`, `fr`, `bl`), with canonical `matrix3d(...)` transforms and projected tile4 scanline order inside each mounted face. Camera-facing culling mounts/removes those face wrappers instead of removing thousands of live brush children from the mesh root. `.vox` normalization snaps to the nearest integer CSS cell size so direct voxel matrices use integer pixel coordinates without any scale wrapper; same-color shared voxel edges get a tiny matrix-space overscan to hide compositor seams without fattening exterior silhouette edges. Brush colors still receive baked Lambert shading from the scene lights. Callers may opt into lossy `.vox` palette merging and small local face-region cleanup before greedy meshing when authored palettes contain visually redundant colors; gallery and builder route this through Mesh resolution so `Lossy` may simplify palettes while `Lossless` keeps palette colors exact. Dynamic lighting, shadows, stable DOM animation, non-exact voxel geometry, and geometry replaced via `setPolygons` fall back to the polygon renderer.

Voxel-shaped meshes are the exception to "all polygons stay mounted": meshes with at most the six axis-aligned face normals, excluding helpers/auto-center-exempt meshes, automatically mount only camera-facing leaves and patch the mounted set when the camera or mesh rotation crosses a visible-normal boundary. Non-voxel meshes keep the full leaf DOM mounted; broad camera-dependent DOM culling is not worth the mutation cost.

### Tag-as-strategy table

| Tag | Strategy | When chosen | Paint mechanism | Atlas memory |
|---|---|---|---|---|
| `<b>` | **Quads** | Axis-aligned rectangle, or untextured convex quad when the homography passes stability guards on non-Safari engines | `background: currentColor` on a fixed 64px rectangle; affine and projective quads normalize their `matrix3d` to that primitive, with tiny solid bleed on projective quads to overlap antialias seams. Safari-family browsers skip the projective quad path and fall through because transformed projective rectangles composite incorrectly there. | None |
| `<i>` | **Border-shape clipped solid** | Untextured non-rect not caught by the exact corner-shape solid path, on browsers with CSS `border-shape` (Chromium + `pointer:fine` + `hover:hover`) | `border-color: currentColor` on a fixed 16px border-shape primitive, clipped by `border-shape: polygon(...)`; polygon bbox scale and tiny solid bleed are folded into `matrix3d` | None |
| `<s>` | **Texture slice / atlas fallback** | Atlas-backed textured polygons, direct `textureImageSource` polygons, or untextured non-rect on browsers without `border-shape` | Atlas leaves use a packed bitmap slice on an auto-budgeted primitive (128px for desktop-class `textureQuality="auto"`, 64px for mobile-class `auto` and explicit numeric quality by default; `textureLeafSizing` can switch to local or raster dimensions). Direct image leaves use the caller's source URL and source rect directly, keep source lighting, and may use guarded affine or projective matrices for exact quad mapping. Atlas position/size, image position/size, filtering (`textureImageRendering`), readiness, projection, and source rect are emitted as PolyCSS-owned metadata so callers do not parse private style strings. | Atlas: bounding-rect area; direct image: none |
| `<u>` | **Stable solid triangle / corner-shape solid** | Triangles on non-WebKit engines; or untextured non-triangle polygons whose normalized outline is exactly a rectangle with one or more beveled corners on browsers with CSS `corner-shape` | Triangles use a 32px box with two beveled top corners and `background: currentColor` when CSS `corner-shape` support is present, progressively falling back to the CSS border-color triangle trick. Firefox uses a 96px border-triangle primitive to avoid large-perspective compositor banding. Exact corner-shape solids use a fixed 16px classed box with inline per-corner radii + `corner-*-shape: bevel` and `background: currentColor`. Tiny solid bleed is folded into `matrix3d`. WebKit/Safari falls through to `<s>` for border triangles because transformed CSS border triangles composite incorrectly there. | None |

Strategies are ordered cheapest → most expensive. The mesher's job is to maximise `<b>` / `<u>` / `<i>` and minimise `<s>` (see "Meshing implications" below).

Callers can opt out of specific strategies via `strategies: { disable: ["b" | "i" | "u"] }` on `RenderTextureAtlasOptions`. Disabled or unsupported strategies fall through the chain (`b → i → s`, `u → i → s`, `i → s`). Disabling `"i"` also disables the exact corner-shape solid branch even though that branch emits a bare `<u>`, because it belongs to the non-triangle clipped-solid family. `<s>` is the universal fallback and cannot be disabled. Solid seam bleed is internal: detected shared solid edges get up to `1.5` CSS px of per-edge overscan, fitted to the polygon plan, rather than inflating every side of each participating polygon. It is not exposed as a scene, mesh, custom-element, or atlas renderer option.

Cast shadows are not a render-strategy leaf tag. Meshes with `castShadow: true` project casting polygons on the CPU into SVG shadow surfaces: one aggregate path for the ground plane in vanilla, per-mesh SVG paths in React/Vue, plus scene-level receiver surfaces where `receiveShadow` is enabled. EVERY polygon casts — shadow casters are NOT filtered to the camera-rendered set (atlas plan) or de-duplicated, because a polygon casts a shadow regardless of whether it's painted for the camera; filtering left camera-dependent holes in imported-mesh shadows. Coincident/overlapping projections are merged into one compound path per caster under `fill-rule: nonzero`, so they don't alpha-stack rather than being pre-dropped. The directional light projects in parallel; each `pointLights` entry with `castShadow: true` casts an additional **radial** shadow (each vertex projected along its own ray from the light position), and point-light passes always project the caster *silhouette* — projecting individual back-faces leaves the contact footprint unshadowed under radial divergence. Shadows are **shaded, not flat black**: each light's shadow is filled with the receiver lit by every OTHER light (the blocked light removed), so a region shadowed from one colored light still shows the remaining lights' color (Three.js colored shadows). A lone directional light reduces this to the ambient-only fill (unchanged). All of a receiver FACE's lights are merged into **one SVG per face** so overlapping shadows composite correctly: a single-light face paints its remaining color directly (one path); a multi-light solid face paints a base = full-lit color `C` then each light as a `mix-blend-mode: multiply` layer with factor `remaining/C`, so the both-blocked overlap becomes `C·∏factor` (ambient only). `mix-blend-mode` works *within* one SVG but NOT across SVGs (`preserve-3d` isolates each SVG against a transparent backdrop — verified), which is why the merge is per-face rather than per-light. Textured receivers (per-pixel base, no uniform multiply) fall back to per-pass alpha layers that cumulatively darken. The per-face color uses the face CENTROID direction (matching the baked per-polygon shading) so the base leaves no visible color box. The per-face merge is the shared core helper `computeMergedReceiverShadows` (runs every light pass + aggregates each face into one SVG descriptor); all three renderers call it and only emit the `<svg>`/`<path>` nodes, so multi-light overlap is identical everywhere. Moving a light or changing caster/receiver geometry re-emits the shadow SVGs; this is DOM/SVG work only and does not redraw texture atlases.

Receiver-shadow geometry has two caster paths. The default per-mesh **silhouette fast path** (caster ≠ receiver, ≥40 polys) projects one outline per caster instead of every front-facing triangle — but only when the caster's silhouette under the current light is a clean union of simple closed loops (every silhouette vertex shared by exactly two silhouette edges). Meshes whose silhouette has non-manifold / T-junction / open-boundary vertices (imported architecture like the castle) fall back to the **per-polygon union**, which is gap-free for any topology. Light-back-facing caster polygons are normally culled (single-sided casting, correct for clean closed meshes); the per-poly path casts **double-sided** (skips that cull) for two cases — cross-mesh casters whose silhouette is unreliable, and ALL self-shadow casters (caster = receiver) — so badly-wound / single-sided interior walls don't leave holes. Closed meshes are unaffected by double-siding: their far back-faces sit below each lit receiver plane and get above-plane-culled, adding no spurious shadow.

**Parametric shadows (all three renderers, opt-in via `shadow.parametric` + `shadow.definition`).** A lightweight approximation that replaces a caster's per-poly/silhouette projection with low-resolution coverage-contour loops, so a complex caster emits far fewer shadow-path vertices. Per caster the light-perpendicular coverage is rasterised into a mask (resolution scales with `definition`), traced with marching squares, simplified, and lifted back to 3D for the normal receiver projector. Cross-mesh casting uses ONE flat proxy outline slid toward the light so it clears receivers below the caster (footprint is depth-invariant under directional projection); self-shadow uses depth-stratified bands, each biased to its far-from-light edge so a face is only shadowed by geometry genuinely in front of it. The approximation is governed by named **rubrics** measured parametric-vs-exact in `bench/shadow-rubric.mjs`; the current correction terms are: **flat casters route to the exact path** (their tilted proxy would project garbage onto a coplanar receiver), **convex casters skip self-shadow** (a convex surface self-shadows nothing), **self-shadow depth-bias** (flat band proxies otherwise over-darken), and **hole subtraction** (coverage holes — courtyards, the coliseum arena — are emitted with opposite winding by nesting depth and the override path preserves that relative winding so they subtract under the receiver's `fill-rule: nonzero`; the exact path keeps per-loop CCW). Higher `definition` trades DOM weight for fidelity and is the knob for resolving fine concave holes. **Point lights** are supported: each shadow-casting point light gets its own RADIAL override silhouette built from the caster-centroid → light direction (the small-object approximation point shading already uses), stored per-light in `overridePointSilhouettes` and selected per pass; the directional override is the wrong outline for a finite-distance light, so point passes never reuse it. Parametric does not change the exact path, which remains the default. **Render style** is selectable via `shadow.style`: `"vector"` (default) traces the smooth concave contour; `"pixel"` greedy-meshes the coverage mask into axis-aligned rectangles for a blocky/voxel shadow — holes (courtyards, the coliseum arena) fall out for free as absent cells (no winding/`fill-rule` work), and `definition` becomes the pixel-grid resolution (lower → chunkier; the block size is the aesthetic). Both styles share the per-mesh def, point-light, and progressive machinery. The override builder (`buildParametricCasterOverride` + `isFlatCaster`/`isConvexCaster`) lives in **core** so all three renderers produce byte-identical loops — vanilla `receiverShadow.ts`, React `PolyMesh.tsx`, and Vue `PolyMesh.ts` each just call it in their caster loop and drop the result on the `ReceiverCasterInput`. Per-mesh `shadowDefinition` is a `PolyMeshTransform` field (vanilla), a `<PolyMesh shadowDefinition>` prop (React), and a `shadow-definition` prop (Vue). The ONE intentional asymmetry: **progressive `dragDefinition` is vanilla-only**, because it's a `createPolyScene` orchestration concern (auto-detect a light-direction change → emit at the drag def → debounced full-def refine). React/Vue are declarative and re-render on prop change, so an app gets the same effect idiomatically by lowering `shadow.definition` in its own state during a drag and restoring it at rest. **Animated shadows** (`shadow.followAnimation`, all three renderers): a caster's shadow normally FREEZES during a same-topology deform — re-projecting every frame is expensive — so the default is frozen and `followAnimation` opts into tracking the pose (pair with a low parametric `definition`). Vanilla re-emits (throttled ~12fps) from the freshly-deformed polygons in `setPolygons`; React/Vue gate the caster re-registration (a same-topology polygon change is skipped unless `followAnimation`, so the receiver re-emits only when following). Topology changes (different polygon count) always re-emit regardless.

**Cost + the laggless levers.** Cross-mesh/floor cast shadows are cheap (one outline, ~1 receiver face) and follow a moving light at 60fps+; camera orbit is free (shadows ride the scene transform — only light/geometry changes re-emit). SELF-shadow is the expensive case: it projects every depth band onto every one of the mesh's own coplanar faces, so the recompute is O(faces × bands × points) and that work is irreducible by spatial culling (the depth-band proxies span the whole mesh, so their AABBs overlap nearly every face — a broad-phase cull was measured to reject nothing). The lever for smooth interaction is therefore reducing *quality during motion*, not a faster projector. Two knobs make this configurable:
- **Per-mesh `PolyMeshTransform.shadowDefinition`** overrides the scene `shadow.definition` for one mesh's cast/self shadow — a detailed caster stays sharp while a simple prop runs cheap in the same scene.
- **`shadow.dragDefinition`** is the library's built-in progressive refinement: when set (and `parametric`), a light-DIRECTION change emits at `min(definition, dragDefinition)` for a laggless drag (castle ~100fps at 16 vs 36fps at 96), then a debounced pass re-emits at full `definition` once the light settles — the same atlas-rebake-at-rest escape hatch. It's auto-detected in `setOptions` (direction change = motion; an appearance edit like the `definition` slider renders full immediately). Per-mesh def composes: motion caps each mesh at `min(its def, dragDefinition)`.

The fps↔definition curve and per-phase breakdown are measured with `bench/shadow-trace.html` + the chrome-trace skill; `bench/shadow-parametric.html` exposes both knobs (`definition`, `dragDef` sliders; `?def=`, `?dragdef=`).

The `.vox` fast path emits plain `<b>` elements inside `.polycss-voxel-face` wrappers. They intentionally reuse the cheap quad tag; each visible quad has one `matrix3d(...)`, with same-color shared-edge overscan folded into the local left/top/width/height before matrix generation. The face wrappers are grouping nodes for cheap add/remove and are not render-strategy leaves. Desktop-class documents use a canonical 1px primitive for the cheapest transform shape; mobile-class documents (`pointer: coarse` or `hover: none`) use an 8px primitive and divide the in-plane matrix scale by 8 to preserve identical CSS-space geometry while avoiding large GPU filtering gaps.

### Lights

The scene takes one `directionalLight`, one `ambientLight`, and zero or more `pointLights` (`PolyPointLight[]`). Directional light `direction` is the unit source vector from the surface toward the distant light. Point lights are **direction-only** — no distance falloff. Per polygon the contribution is `color · intensity · max(0, n · L̂)`, where `L̂` is the unit direction from the surface to the light position; multiple colored lights accumulate per-channel alongside the directional + ambient terms. This deliberately omits CSS gradients: point lights shade flat-per-face (an accepted approximation vs three.js's per-fragment `PointLight(distance:0, decay:0)`; exact for small faces / distant lights). Point lights are **baked-mode only** — the dynamic mode's zero-JS light move can't express a per-face direction that varies with position, so dynamic scenes ignore `pointLights` entirely: not for surface shading, and not for shadows. (A point light casting a shadow onto a floor those same lights never lit would read as broken, so dynamic shadows are directional-only — see the lighting modes below.)

### Lighting modes (`PolyTextureLightingMode = "baked" | "dynamic"`)

- **Baked.** Lambert (directional + each point light + ambient) is computed once on the CPU per polygon, multiplied into the inline `color` (for `<b>`/`<i>`/`<u>`) or into the rasterised atlas pixels (for atlas-backed `<s>`). Direct image `<s>` leaves preserve source pixels and use `texturePresentation.lighting="source"`; scene-lit direct images fall back to the atlas path. Moving a light requires explicit re-rasterising of affected lit atlas polys via `mesh.rebakeAtlas()` — the atlas bake (canvas raster + async `toBlob`) is the one expensive step, so the vanilla imperative API does NOT auto-rebake the lit surface on a `setOptions({directionalLight})` / point-light change; that keeps high-frequency light drags fast (the caller rebakes, typically debounced to drag-end). Cast shadows ARE cheap (CPU-projected SVG paths) so they re-emit automatically on any light change — direction, intensity, or color (intensity 0 removes the shadow) — and follow the light interactively even while the baked lit side stays frozen. **Renderer asymmetry:** the declarative React/Vue components re-render → auto-rebake the lit surface on any light prop change; vanilla freezes it until an explicit `rebakeAtlas()`. This is intentional (vanilla keeps the fast-drag escape hatch); for live/animated lights prefer dynamic mode. Left as-is by design — do not "fix" the asymmetry by making vanilla auto-rebake without explicit approval.
- **Dynamic.** Scene root carries the directional + ambient setup as custom properties (`--plx/y/z`, `--plr/g/b`, `--pli`, `--par/g/b`, `--pai`). Each leaf embeds its surface normal (`--pnx/y/z`) and base color (`--psr/g/b`) inline. CSS `calc()` resolves the Lambert dot product and per-channel tint at paint time. Moving a light mutates scene-root vars for surface lighting — zero JS, no atlas redraw. Point lights are not represented in dynamic mode at all — neither surface shading nor shadows (see above). Cast shadows are **directional-only** in dynamic mode (CPU-projected SVG paths, ambient fill) and re-emit when the directional light changes.

All solid and atlas-backed tags work in both modes. Direct image `<s>` leaves are source-lit only; callers that need scene lighting use the atlas backend. The `.vox` direct-matrix fast path is baked-only for now; dynamic mode uses the polygon path so lighting semantics stay correct. The full coverage matrix is in `packages/polycss/src/styles/styles.ts`.

### Meshing implications (what generators must respect)

- **Polygon count is the dominant cost.** Each polygon is one DOM node, one `matrix3d`, one paint. Halving the polygon count is almost always worth a more complex mesher.
- **Lossy optimization favors low DOM render cost.** The default `"lossy"` `loadMesh` / core import path first bakes solid texture swatches, merges visually redundant baked swatch colors, and tries endpoint-preserving static triangle simplification for eligible non-animated meshes. It then scores exact and approximate merge candidates by estimated render cost and keeps the cheapest direct candidate. Static simplification has a relaxed seam-key pass plus a stricter source-vertex fallback, and is accepted only when the final optimized DOM leaf count is lower than the baseline optimizer result. The polygon optimizer can also try a more aggressive triangle-pair merge candidate inside the same boundary displacement budget, but accepts it only when the render-cost win is material and whole-mesh seam diagnostics do not get worse. STL parse results are the conservative exception: they keep the lossless optimizer path and skip ray-based interior culling because public CAD/STL corpora frequently contain shell, winding, or topology quirks where false-positive culling is a visible data-loss bug. It avoids per-candidate seam-repair passes in the import path; targeted seam repair remains a lower-level helper for explicit repair workflows.
- **Fill ratio matters.** An atlas-backed textured polygon's atlas slice equals its local-2D bounding rect. Empty space inside that slice is wasted bitmap pixels. Direct image leaves avoid atlas memory, but only for source-exact surfaces with preserved source metadata and source lighting. Prefer atlas shapes with high `area / boundingRect.area`:
  - axis-aligned rectangle = 1.0 (and hits the fastest path)
  - right-isosceles triangle = 0.5
  - skinny/long triangle ≪ 0.5 (worst case — many such triangles balloon atlas memory)
- **Regular grids are not a constraint.** Vertices may sit anywhere on the surface. Any planar tiling whose edges match across neighbours (no T-junctions, no cracks) is valid. Break the grid where it lets you fit larger axis-aligned rects to flat regions.
- **Coplanarity is a hard requirement at render time, but the mesher can engineer it.** A non-triangular polygon must have all vertices on a common plane within a small epsilon, or the renderer snaps the offending vertex in isolation and opens a visible seam with adjacent polygons. The mesher avoids this either by (a) only merging when natural coplanarity holds, or (b) deliberately snapping shared vertices to a common plane and propagating the new position to *every* polygon that references them. Snap-and-propagate is preferred when it widens the merge opportunity, subject to the budget below.
- **Vertex displacement budget.** Every snap consumes budget on the moved vertex and on all polygons that reference it. Track cumulative displacement from the original DEM-sampled position per vertex; reject any merge that would push a vertex past the user's height tolerance. Errors compound across merges, so the bound is per-vertex cumulative drift, not per-merge.

## The "no JS in the render loop" principle

This is the load-bearing constraint behind the whole engine. **JavaScript should not run per-frame to paint polygons when the motion can be expressed as a scene, mesh, camera, or light update.** Once the scene is built and the atlas is rasterised, the browser drives most rendering through CSS — `matrix3d` transforms, `calc()`-driven custom properties, `background-blend-mode`, `border-shape`, etc.

The renderer exception is imported skeletal animation. glTF/GLB skinning changes each polygon independently, so the vanilla stable-DOM animation path samples the active clip in JS, keeps the leaf set mounted, caches baked stable-triangle transform frames, and pins each mounted triangle's baked color while transforms animate. Recomputing Lambert from every deformed low-poly face normal creates visible color pumping, so color refresh is internal opt-in rather than the default animation behavior. On WebKit/Safari, where stable CSS triangles fall through to solid atlas `<s>` leaves, same-topology animation updates keep the existing atlas elements and bitmap URLs mounted, cache transform frames once warmed, and hide briefly degenerate atlas triangles only until the next valid frame. That optimized path is the default; do not add a user-facing "baseline vs optimized" toggle or maintain a legacy slow path in product UI.

The domformat reference mount has one separate, closed exception: it may schedule its validated fixed-rate prepared playback and interaction tables. That scheduler may write only declared sinks on the retained targets, never reconstruct topology or evaluate producer code, expressions, renderer internals, or network resources, and is disabled by `animate: false`. This is a reference implementation of an already-lowered wire profile, not a PolyCSS renderer loop.

| Where JS runs | Where JS does NOT run |
|---|---|
| Scene construction (`createPolyScene`, mesh ops, vertex snapping) | Per-frame polygon paint |
| OBJ/STL/glTF/GLB import, mesh optimisation, coplanar merging | Per-frame Lambert evaluation (dynamic mode is pure CSS) |
| Atlas planning + rasterisation (one-shot to `<canvas>`, then `toBlob`) | Per-frame atlas redraw (only on baked-mode light changes) |
| Control input handling (`PolyOrbitControls`, `PolyMapControls`, `PolyTransformControls`) | Per-frame transform recomputation of every polygon for camera/mesh motion — only the scene-root or mesh-root transform changes |
| Camera math (matrix4 product → scene-root `transform` CSS var) | Per-polygon JS in any hot path |
| Hover/selection raycasting (only on pointer events, not per frame) | Continuous renderer re-rendering "ticks" |

If you find yourself wanting a `requestAnimationFrame` loop to update many renderer DOM nodes outside skeletal animation or the closed domformat prepared-runtime exception, stop. Find the CSS variable that should be carrying the change, and update that single variable on a single ancestor. Cascading + `@property`-registered custom properties do the rest.

### PolyCSS Morph boundary

`@layoutit/polycss-morph` is an imperative, framework-agnostic prepared-model
layer. It does not replace ordinary `Polygon[]` loading and it does not add
React or Vue wrappers.

- `@layoutit/polycss-morph/prepare` is the Node-only authoring boundary. It
  reads strict config plus glTF/GLB input and writes a deterministic,
  content-addressed package with `manifest.json` last. The generic preparer
  directly authors `static-prepared` and `morph-regions` with canonical solid
  CSS triangle leaves for base-color materials plus packed prepared alpha-atlas
  pages for browsers without the corner-shape triangle primitive. Every
  polygon owns a slice sized to its local-2D bounding rect and a precomputed
  transform relation; there is no shared canonical triangle mask. The pages
  are generated with Node built-ins, add no native image dependency, and are
  selected once at mount without runtime rasterization. Product adapters or
  dedicated tooling may author other validated image-backed, `joint-skin`, and
  `prepared-playback` packages.
- `@layoutit/polycss-morph` is the browser-safe boundary. It validates and loads
  prepared packages, mounts one retained PolyCSS graph, and exposes
  caller-driven runtimes for morphs, controls, springs, animation, skinning,
  and prepared playback.
- Sparse deformation supports retained solid triangles and affine solid quads.
  Browsers where PolyCSS enables projective quad compositing also accept planar
  projective solid quads. Quad updates recompute one CSS `matrix3d(...)` per
  dirty leaf; deformation rejects non-coplanar, non-convex, or
  compositor-unstable geometry, and the retained mount rejects projective quad
  matrices on unsupported Safari-family browsers before DOM writes.
- `createPolyMorphPreparedDomTarget` adopts a caller-owned retained graph as
  source-ordered model, shape, and leaf targets. It tracks requested values for
  sparse write deduplication, preserves element identity, invalidates writers
  when destroyed, and leaves DOM teardown to the caller.
- A mount uses PolyCSS's public solid-triangle support check, so Firefox keeps
  its border-triangle path while WebKit/Safari selects each leaf's prepared
  polygon-sized atlas slice. Image paint comes only from loader-verified bytes:
  mount creates object URLs once and revokes them at teardown, with no resource
  refetch or arbitrary prepared CSS injection. It creates topology and leaves
  once. Runtime samples may update only declared model, shape, or leaf state.
  They must preserve leaf identity, must not rebuild topology or redraw atlases,
  and must not own a scheduler. Prepared playback commits a sample only after
  the caller's retained apply succeeds. The caller owns input and timing.
- Morph does not copy renderer feature detection or maintain a fourth visual
  browser harness. Package certification exercises native and fallback retained
  DOM resolution; actual engine-specific triangle painting remains covered by
  the renderer-owned browser paths that define `isSolidTriangleSupported`.
- The four executable profiles are `static-prepared`, `morph-regions`,
  `joint-skin`, and `prepared-playback`.
- Product-specific source cadence, schemas, preparation provenance, mounting
  paths, product behavior, and oracle evidence stay in the consuming product.

### domformat boundary

`@layoutit/polycss-domformat` is the private, producer-neutral reference package
for the experimental `domformat@0` wire contract. It is not a serialization
alias for Morph packages and does not depend on Morph or renderer internals.

- Node exposes only `buildDom`, `readDom`, `readDomFile`, `validateDocument`,
  and `DomFormatError`; the CLI exposes only `encode`, `decode`, `inspect`, and
  `validate`; the browser subpath exposes only `readDomBrowser`,
  `readDomBrowserUrl`, and `mountDom`.
- Producers emit the closed writer manifest natively. Source parsing,
  preparation, lowering, and product adapters remain in producer packages.
- The only physical form is canonical `.json` plus digest-bound external
  sibling resource files. There is no `.dom` packet, gzip transport, embedded
  payload, archive, or alternate packaging mode.
- Mounting follows `validate → construct → bind → initialize → publish →
  destroy`, with rollback on partial failure and idempotent teardown.
- The package is source-only, `private`, and MIT-licensed. Workspace test/build
  commands include it; public version-bump and npm-publish automation must not.
- Install tarballs contain only package metadata, README, CLI, and runtime
  source. Specifications, conformance implementations, fixtures, viewers,
  scripts, and tests remain repository-side certification material.
- The first concrete producer is website-owned:
  `website/scripts/generate-gallery-domformat.mjs` lowers all Gallery presets
  through shared Gallery preset/loader/presentation/animation behavior into
  canonical documents under
  `website/public/gallery/domformat/`. The generated 304-model corpus and its
  digest-bound CSS/image siblings are website assets, never package payload or
  runtime code. Its catalog pins the exact Chromium strategy environment and
  per-model strategy counts; the corpus does not claim browser-neutral leaf
  topology. Static documents are presentation-only; animated documents add
  one Gallery-selected preferred clip at 30 Hz. Adding this producer does not
  move source parsing or renderer internals into domformat.

## Naming (three.js parity)

- Brand text is **PolyCSS**. Keep lowercase `polycss` only for literal package names, import paths, CSS classes, domains, and other code identifiers.
- Every public export gets a `Poly` prefix. Exceptions are generic math types (`Vec2`, `Vec3`, `Polygon`, `PolyMaterial`), the closed versioned domformat API listed above, and the explicit `*/three` compatibility subpaths, where Three-compatible names are the point of the API. React/Vue components in those subpaths still use the `PolyThree` prefix.
- **Hooks/composables:** `usePolyCamera`, `usePolyMesh`, `usePolySceneContext`, `usePolySelect`, `usePolySelectionApi`, `usePolyAnimation`.
- **Components:** `PolyPerspectiveCamera`, `PolyOrthographicCamera`, `PolyOrbitControls`, `PolyMapControls`, `PolyTransformControls`, `PolySelect`, `PolyAxesHelper`, `PolyDirectionalLightHelper`, `PolyIframe`, `PolyThreePerspectiveCamera`, `PolyThreeOrthographicCamera`, `PolyThreeMesh`.
- **Types:** `PolyDirectionalLight`, `PolyPointLight`, `PolyAmbientLight`, `PolyTextureLightingMode`, `PolyTextureLeafSizing`, `PolyTextureBackend`, `PolyTextureImageRendering`, `PolyTextureImageLighting`, `PolyTextureProjection`, `PolyTexturePresentation`, `PolyTextureImageSource`, `PolyCameraProjection`, `PolyCameraSnapshot`, `PolyCameraSnapshotStats`, `PolyMeshTransformInput`, `PolySceneTransformInput`, `PolyAnimationMixer`, `PolyRenderStats`.
- **Functions:** `findPolyMeshHandle`, `injectPolyBaseStyles`, `collectPolyRenderStats`, `collectPolyTextureReadiness`, `queryPolyLeaves`, `resolvePolyTextureLeafGeometry`, `resolvePolyTextureImageSource`, `resolvePolyTexturePresentation`, `resolvePolyTextureImageRendering`, `buildPolyCameraSceneTransform`, `buildPolyMeshTransform`, `buildPolySceneTransform`, `capturePolyCameraSnapshot`, `polyCameraTargetToCss`, `resolvePolyCameraAppliedPerspectiveStyle`, `worldPositionToCss`, `worldPositionToPolyCss`, `cssPositionToWorld`, `polyCssPositionToWorld`, `worldDistanceToCss`, `worldDistanceToPolyCss`, `cssDistanceToWorld`, `polyCssDistanceToWorld`, `worldDirectionToCss`, `worldDirectionToPolyCss`, `worldDirectionalLightToCss`, `worldDirectionalLightToPolyCss`, `exportPolySceneSnapshot`.
- **Vanilla factories:** `create*` names stay as-is (`createPolyScene`, `createTransformControls`, `createSelect`).
- **HTML custom elements:** `poly-` prefix + kebab-case. Existing tags: `<poly-scene>`, `<poly-mesh>`, `<poly-iframe>`, `<poly-polygon>`, `<poly-perspective-camera>`, `<poly-orthographic-camera>`, `<poly-axes-helper>`, `<poly-directional-light-helper>`. Any new element follows the same shape (e.g. `<poly-transform-controls>`, `<poly-select>`).
- **`<poly-iframe>`:** flat textured "quad" whose "texture" is a live document (an `<iframe>`) instead of an atlas slice. NOT a render-strategy leaf — same transform conventions as `<poly-mesh>` (`position`/`rotation`/`scale` post-parity; iframe content centered at the wrapper's local origin so rotation/scale pivot at the visible center). Mounted as a child of `.polycss-scene` and inherits the camera transform.
- **Leaf DOM tags (`<b>`, `<i>`, `<s>`, `<u>`):** internal render-strategy tags. Not part of the public API and not user-facing — do not document them as such.
- `PolyCamera` is a kept alias for `PolyOrthographicCamera` — the ergonomic default, optimised for iso/voxel/diagrammatic scenes which is PolyCSS's structural strength. **Not deprecated.**

## Cross-package discipline

The React and Vue packages are mirror images. **Any public API change in one must land in the other in the same PR.** Same names, same arguments, same defaults, same return shapes (allowing for idiomatic differences — refs vs reactives, `useEffect` vs `watchEffect`).

When you change `packages/polycss` or `packages/core` in a way that affects the public surface (new option, renamed export, changed default), the React and Vue bindings update in the same PR. Don't ship a PolyCSS change that leaves the bindings stale.

The DOM snapshot exporter is the current exception to mirrored React/Vue public exports: `exportPolySceneSnapshot` lives in `@layoutit/polycss` because it is browser DOM serialization, not component API. React/Vue callers import it from `@layoutit/polycss` and pass the rendered `.polycss-camera` / `.polycss-scene` element.

**Renderer-owned browser glue.** The canvas atlas pipeline (`buildAtlasPages` + helpers), browser-feature detection (`isBorderShapeSupported`, `isSolidTriangleSupported`, `resolveSolidTrianglePrimitive`), direct voxel renderer (`voxelRenderer.ts`), and injected `.polycss-scene` / `.polycss-camera` base styles exist as **independent copies** across the three renderers. This includes `packages/polycss/src/render/atlas/`, `packages/react/src/scene/atlas/`, `packages/vue/src/scene/atlas/`, the three renderer-local `voxelRenderer.ts` files, and the three sibling `styles.ts` files. This is deliberate — each renderer is self-contained on its dep graph (React/Vue do not import from the `polycss` package). The trade-off is that a bug fix in any of these files MUST be mirrored into the other two. Coverage is pinned per copy by the co-located test files.

Before opening a PR:

- [ ] If I touched a React component/hook, the Vue composable/component matches.
- [ ] If I touched a Vue component/composable, the React component/hook matches.
- [ ] If I added an option to a `polycss` factory, both bindings expose it.
- [ ] If I renamed a `core` export, every package that imports it is updated.
- [ ] If I touched the canvas atlas pipeline (`rasterise.ts` / `buildAtlasPages.ts`), browser-feature detection, or direct voxel renderer in ONE renderer, the same fix lands in the other two renderers (`polycss` + react + vue) in this PR.
- [ ] If I touched any of the three `styles.ts` (`packages/polycss/src/styles/styles.ts`, `packages/react/src/styles/styles.ts`, `packages/vue/src/styles/styles.ts`), the other two are consistent — CSS rules cover every emitted tag for both lighting modes, and shared properties like `will-change: transform` on `.polycss-scene` exist in all three.
- [ ] Website docs (`website/src/content/docs/**`) and READMEs reflect any user-visible change.
- [ ] If I changed a render strategy, lighting mode, naming convention, or the JS-in-render-loop rules, `AGENTS.md` reflects the new state in this same PR.

## Iterating on the system

The rendering model, tag table, lighting modes, and naming conventions described in this document are the *current* design — not frozen. Render strategies can be added or removed, lighting modes can change shape, the public API will keep evolving. The rules for evolving them:

- **AGENTS.md is the canonical reference.** Edit it directly; `CLAUDE.md` is just a symlink that exists so Claude Code finds the same content.
- **Architectural changes require user approval.** Dropping a render strategy, adding a lighting mode, renaming a public-facing convention, changing what JS is allowed in the render path — propose, don't decide. The user (human) is the architect.
- **Same-PR sync.** Any PR that adds, removes, or materially changes a render strategy, lighting mode, naming rule, or cross-package contract must update `AGENTS.md` in the same PR. An API change that lands without an AGENTS.md update is an incomplete change.
- **Don't append-only.** Prune content that no longer reflects the codebase. If a strategy is dropped, remove its row from the tag table — don't leave a "deprecated" note. If a hook is renamed, update the naming section in place — don't list the old name "for reference".

## Backward compatibility

- **No BC shims.** Clean breaks only. No re-export aliases for renamed symbols. No `@deprecated` wrappers. If the API changes, callers update.
- This applies even to the multi-package monorepo — all four packages move together.

## Commits & PRs

- Conventional commits format. Single-line subject. No body unless genuinely useful.
- **NO `Co-Authored-By: Claude` trailer.**
- **NO "🤖 Generated with Claude Code" footer in PR bodies, commit messages, issue comments, or anywhere else.**
- Never amend commits. New follow-up commits only. (Pre-commit hook failures: fix and create a new commit, don't `--amend`.)
- Branch names should not use a `codex/` prefix. Use plain descriptive branch names unless the user explicitly asks for a different naming convention.
- Never push without explicit user approval in the current conversation, even for an existing PR branch or a small follow-up fix. Commit locally and stop for review unless the user clearly asks to push.
- Don't auto-push subagent exploration branches — local commits only. The user pushes when ready.
- `main` is protected. All work lands via PR.

## Tests & build

- Refactors must keep all tests passing. Don't delete or weaken assertions to make a refactor go through.
- If a renamed export still has tests for the old name, rename the test imports — don't keep the old export as an alias just to satisfy them.
- `pnpm test` runs the full suite across all four packages.
- **`pnpm build` is mandatory before opening a PR.** Vitest doesn't catch DTS / declaration build failures (tsup runs strict type-checking that vitest's transient TS pass doesn't enforce). A green test run with a red build is a real failure mode. Run `pnpm test && pnpm build` as a unit; treat either failing as "not ready."
- **CI enforces both gates.** `.github/workflows/ci.yml` runs `pnpm test` + `pnpm build:packages` + `pnpm build:website` on every PR against `main` and on every push to `main`. Don't merge with red CI.

## Style / process

- No time estimates in planning docs ("2 days", "1 hour" etc.). This is agentic engineering, not human team scheduling.
- Prune superseded content from long planning docs as you go — don't just append.
- No half-finished features, no speculative abstractions, no defensive code for cases that can't happen.
- No comments explaining *what* code does — the code already says that. Comments are for *why*: a non-obvious constraint, a workaround for a specific browser bug, an invariant that isn't visible locally.
