# PolyCSS

A CSS polygon mesh library. A 3D engine for the DOM. Renders OBJ/MTL, STL, glTF/GLB, and VOX as real HTML elements transformed with CSS `matrix3d(...)`. Supports colors, textures, lighting, shadows, shapes and animations. Works with React, Vue or plain JavaScript.

Visit [polycss.com](https://polycss.com) for docs and model examples.

Join [chat.polycss.com](https://chat,polycss.com) for support and community discussions.

<img width="1600" height="300" alt="PolyCSS primitives banner" src="https://github.com/user-attachments/assets/b05e2204-9323-4f83-8d1b-01ea0dd000db" />

## Installation

```bash

# Vanilla
npm install @layoutit/polycss

# React
npm install @layoutit/polycss-react

# Vue
npm install @layoutit/polycss-vue

```

You can also load PolyCSS directly from a CDN. Here is a minimal custom-element scene:

```html
<script type="module" src="https://esm.sh/@layoutit/polycss/elements"></script>

<poly-camera rot-x="65" rot-y="45">
  <poly-scene>
    <poly-orbit-controls drag wheel></poly-orbit-controls>
    <poly-box size="100" color="#ffd166"></poly-box>
  </poly-scene>
</poly-camera>
```

<img width="2500" height="1145" alt="PolyCSS intro" src="https://github.com/user-attachments/assets/0e5df0d8-04a8-4e50-8e3a-1097a96ce42f" />

## Framework Components

React and Vue expose the same component model. `<PolyCamera>` owns the viewpoint, `<PolyScene>` owns lighting and options, and `<PolyMesh>` loads or receives polygon data.

```tsx
import { PolyCamera, PolyScene, PolyOrbitControls, PolyMesh } from "@layoutit/polycss-react";

export default function App() {
  return (
    <PolyCamera rotX={65} rotY={45}>
      <PolyScene textureLighting="dynamic">
        <PolyOrbitControls drag wheel />
        <PolyMesh src="/gallery/obj/cottage.obj" mtl="/gallery/obj/cottage.mtl" />
      </PolyScene>
    </PolyCamera>
  );
}
```

## API Reference

### PolyCamera

- `rotX`, `rotY` control the orbit angle in degrees.
- `zoom` scales the projected scene.
- `target` pans the camera target in world coordinates.
- `distance` adds dolly pull-back.
- `PolyCamera` is the orthographic default. Use `PolyPerspectiveCamera` when you want perspective depth.

### PolyScene

- `polygons` renders a static `Polygon[]` directly.
- `directionalLight`, `pointLights` (direction-only, baked mode; optional per-light `castShadow`), and `ambientLight` control scene lighting.
- `textureLighting` chooses `"baked"` or `"dynamic"`.
- `textureQuality` controls atlas raster budget.
- `strategies` can disable selected render strategies for diagnostics.
- `autoCenter` rotates around the rendered mesh bounds instead of world origin.

### PolyMesh

- `src` loads `.obj`, `.gltf`, `.glb`, or `.vox` files.
- `mtl` loads companion OBJ materials.
- `polygons` accepts pre-parsed geometry.
- `position`, `scale`, and `rotation` transform the mesh wrapper.
- `autoCenter` shifts the mesh bbox center to local origin.
- `meshResolution` chooses `"lossy"` (default) or `"lossless"` optimization. STL imports use the conservative lossless path in both modes.
- `castShadow` emits CSS-projected shadows in dynamic lighting mode.

### Controls

- `<PolyOrbitControls>` adds drag orbit, shift-drag pan, wheel zoom, and optional auto-rotate.
- `<PolyMapControls>` uses pan-first map-style input.
- `<PolyFirstPersonControls>` provides keyboard and pointer-look navigation.
- `<PolyTransformControls>` adds translate/rotate gizmos for selected mesh handles.

### Snapshot Export

The vanilla package exports `exportPolySceneSnapshot(target)`. It clones the current rendered `.polycss-camera` / `.polycss-scene` DOM, injects only the PolyCSS CSS needed by that snapshot, inlines CSS `url(...)` image assets as `data:image/...;base64,...`, strips scripts and inline event handlers, and returns a standalone HTML document string with no PolyCSS runtime import. It works with rendered React/Vue scenes too; import it from `@layoutit/polycss` and pass the rendered camera or scene element.

```ts
import { exportPolySceneSnapshot } from "@layoutit/polycss";

const html = await exportPolySceneSnapshot(scene.host);
```

If any referenced asset cannot be inlined, the function throws `PolySceneSnapshotError` with `code: "ASSET_INLINE_FAILED"`.

### PolyCSS Morph

Use `@layoutit/polycss-morph` for models built ahead of time and updated through
a stable PolyCSS DOM graph.

Preparation runs in Node:

```ts
import { preparePolyMorphModel } from "@layoutit/polycss-morph/prepare";

await preparePolyMorphModel({
  configPath: "./source/prepare.json",
  outputRoot: "./public/model/package",
});
```

The browser entry loads, mounts, samples, and applies updates:

```ts
import {
  createPolyMorphDeformationRuntime,
  loadPolyMorphPackage,
  mountPolyMorphModel,
} from "@layoutit/polycss-morph";

const loaded = await loadPolyMorphPackage("/model/");
const mounted = mountPolyMorphModel(host, loaded.model, {
  resources: loaded.resources,
});
const deformation = createPolyMorphDeformationRuntime(loaded.model);
const frame = deformation.sample({
  tick: 0,
  morphWeights: { "corner-lift": 0.5 },
});

mounted.apply({ leaves: frame.leafUpdates });
```

Morph supports `static-prepared`, `morph-regions`, `joint-skin`, and
`prepared-playback` profiles. It does not own an animation scheduler: callers
sample controls, springs, clips, skinning, or playback and pass only changed
rows to `mounted.apply(...)`. Mounted leaf identity stays stable, and runtime
updates do not rebuild topology or redraw prepared image resources.
Prepared playback uses a two-phase sample: apply `sample.update`, then call
`runtime.commit(sample)` only after the retained mount accepts the update.

Morph chooses the triangle paint path once when it mounts. It uses
`corner-shape` where available, a larger CSS border triangle in Firefox, and
prepared alpha-atlas pages in WebKit/Safari. Every polygon receives a slice
sized to its local-2D bounding rect. Mount creates object URLs from the
already-verified package bytes, selects the fallback once, and revokes those
URLs at teardown; it never refetches, generates, or redraws the atlas.

See the [PolyCSS Morph guide](https://polycss.com/guides/morph/), including the
interactive cube-to-sphere example.

### Polygon Data Model

Each polygon describes one renderable face:

```ts
const polygons = [
  {
    vertices: [[0, 0, 0], [60, 0, 0], [0, 60, 0]],
    color: "#f97316",
  },
  {
    vertices: [[0, 0, 0], [60, 0, 0], [60, 60, 0], [0, 60, 0]],
    texture: "/texture.png",
    uvs: [[0, 0], [1, 0], [1, 1], [0, 1]],
  },
];
```

Render polygons directly when you need per-face DOM events or custom styling:

```tsx
<PolyCamera>
  <PolyScene>
    {polygons.map((polygon, index) => (
      <Poly
        key={index}
        {...polygon}
        onClick={() => console.log("clicked polygon", index)}
        className="my-polygon"
      />
    ))}
  </PolyScene>
</PolyCamera>
```

## Loading Mesh Files

Use `loadMesh()` to parse supported model formats:

```ts
import { createPolyCamera, createPolyScene, loadMesh } from "@layoutit/polycss";

const host = document.getElementById("polycss")!;
const camera = createPolyCamera({ rotX: 65, rotY: 45 });
const scene = createPolyScene(host, { camera });

const mesh = await loadMesh("https://polycss.com/gallery/obj/cottage.obj", {
  mtlUrl: "https://polycss.com/gallery/obj/cottage.mtl",
});

scene.add(mesh);
```

Supported formats:

- OBJ + MTL, including `map_Kd` textures and UV coordinates.
- STL triangle meshes, including binary Magics face colors. STL has no standard units, textures, UVs, or hierarchy, so imports skip lossy simplification and ray-based interior culling.
- glTF / GLB, including embedded images and `TEXCOORD_0`.
- MagicaVoxel `.vox`, with direct voxel fast paths when eligible.
- Generated primitives: box, plane, ring, sphere, torus, cylinder, cone, and Platonic solids.

## Performance

PolyCSS renders through the DOM, so performance is mostly shaped by two things: the number of mounted leaves, and the amount of texture atlas area the browser has to paint. The renderer tries to keep the common cases cheap. Simple surfaces stay as solid CSS elements, while textured, irregular, or high-detail geometry falls back to atlas-backed slices only when needed.

Each visible polygon is emitted as one leaf element; the renderer chooses the least expensive CSS primitive that can represent the polygon, then uses `matrix3d(...)` to place that primitive in 3D space.

- `<b>` uses `background: currentColor` on a fixed box for solid rectangles and stable quads.
- `<u>` uses `corner-shape` for stable triangles and beveled-corner solids, with a `border-width` triangle fallback when needed.
- `<i>` clips solid polygons with `border-shape: polygon(...)` when the browser supports it.
- `<s>` maps a packed texture-atlas slice with `background-image`, and is the fallback for textured or unsupported shapes.

## Packages

| Package | Description |
|---|---|
| `@layoutit/polycss-core` | Pure math, parsers, lighting, camera helpers, mesh optimization. Zero browser globals. |
| `@layoutit/polycss` | Vanilla custom elements and imperative `createPolyScene` API. |
| `@layoutit/polycss-react` | React components, hooks, controls, and core re-exports. |
| `@layoutit/polycss-vue` | Vue 3 components, composables, controls, and core re-exports. |
| `@layoutit/polycss-morph` | Prepared-model loading, retained DOM animation, morph targets, skinning, and playback. |
| `@layoutit/polycss-domformat` | Private MIT-licensed producer-neutral `domformat@0` runtime for canonical JSON plus digest-bound sibling resources; conformance and specifications stay repository-side. Not published. |

The website-owned producer also carries a deterministic canonical JSON snapshot
of every Gallery model at `website/public/gallery/domformat/`, with digest-bound
CSS and image siblings. Its catalog pins the 640×640 Playwright Chromium
strategy environment, including engine version, device scale, media queries,
CSS feature branches, and per-model leaf-strategy counts; it does not claim
cross-engine strategy topology. Static models are presentation-only. Animated
models add the Gallery-selected preferred clip sampled at a fixed 30 Hz. The
corpus is a website asset, not package payload.
Regenerate it with `pnpm gallery:domformat`, verify exact Gallery inventory and
sibling-resource closure with `pnpm gallery:domformat:verify`, and run an
independent byte-for-byte regeneration check with
`pnpm gallery:domformat:verify:fresh`. Produce an
external direct-versus-canonical animated proof with
`pnpm gallery:domformat:prove --output /absolute/path`; it requires exact
retained DOM and computed paint semantics and reports bounded subpixel
Chromium compositor differences.

## Made with PolyCSS

[cssQuake](https://cssquake.com)
-> A CSS port of Quake (1996)

<img width="1280" height="720" alt="quake" src="https://github.com/user-attachments/assets/6d9d809c-857a-4a39-b5cf-733ead2661ec" />


[Layoutit Terra](https://terra.layoutit.com)
-> A CSS Terrain Generator

<img width="1000" height="601" alt="layoutit-terra" src="https://polycss.com/layoutit-terra.png" />

## License

MIT.
