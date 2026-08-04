import {
  createPolyPerspectiveCamera,
  createPolyScene,
  optimizeAnimatedMeshPolygons,
  optimizeMeshPolygons,
  queryPolyLeaves,
} from "@layoutit/polycss";
import type { ParseAnimationController, Polygon } from "@layoutit/polycss";
import { loadPresetModel } from "../src/components/GalleryWorkbench/helpers/loaders";
import {
  defaultZoomForModel,
  smartAmbientForModel,
  smartKeyIntensityForModel,
} from "../src/components/GalleryWorkbench/helpers/smartDefaults";
import { firstSelectableAnimationClip } from "../src/components/GalleryWorkbench/helpers/animationClips";
import { responsiveZoomScaleForViewport } from "../src/components/GalleryWorkbench/helpers/responsivePresentation";
import { PRESETS } from "../src/components/GalleryWorkbench/presets/presetList";
import type {
  LoadedModel,
  PresetModel,
} from "../src/components/GalleryWorkbench/types";

const SOURCE_WIDTH = 640;
const SOURCE_HEIGHT = 640;
const ANIMATION_TICK_RATE = 30;
const LEGACY_ZOOM_COMPAT = 50;

let retainedProof: {
  id: string;
  frameCount: number;
  clip?: GalleryDomformatCapture["clip"];
  seek(frame: number): Promise<void>;
  destroy(): void;
} | undefined;

type AnimationClip = NonNullable<ParseAnimationController>["clips"][number];

interface CapturedNode {
  index: number;
  id: string;
  parent: number;
  sibling: number;
  name: string;
  classes: string[];
  styles: Record<string, string>;
  image: number | null;
  leaf: number | null;
}

interface CapturedFrame {
  transforms: number[][];
  visibility: boolean[];
}

interface CapturedImage {
  mediaType: "image/png" | "image/webp";
  bytesBase64: string;
}

export interface GalleryDomformatCapture {
  id: string;
  label: string;
  kind: PresetModel["kind"];
  category: string;
  galleryBucket?: PresetModel["galleryBucket"];
  sourceUrl?: string;
  mtlUrl?: string;
  attribution?: PresetModel["attribution"];
  sourceWidth: number;
  sourceHeight: number;
  perspective: number;
  baseSceneTransform: string;
  nodes: CapturedNode[];
  cameraNode: string;
  modelNode: string;
  visualLeafNodes: string[];
  images: CapturedImage[];
  frames: CapturedFrame[];
  clip?: { index: number; name: string; duration: number; tickRateHz: number; timelineTicks: number };
  sourcePolygonCount: number;
  renderedPolygonCount: number;
  warnings: string[];
  unsupportedInlineStyles: string[];
}

const STYLE_PROPERTIES = new Map<string, string>([
  ["background-color", "backgroundColor"],
  ["background-position", "backgroundPosition"],
  ["background-position-y", "backgroundPositionY"],
  ["background-repeat", "backgroundRepeat"],
  ["background-size", "backgroundSize"],
  ["border-bottom-left-radius", "borderBottomLeftRadius"],
  ["border-bottom-right-radius", "borderBottomRightRadius"],
  ["border-shape", "borderShape"],
  ["border-top-left-radius", "borderTopLeftRadius"],
  ["border-top-right-radius", "borderTopRightRadius"],
  ["color", "color"],
  ["corner-bottom-left-shape", "cornerBottomLeftShape"],
  ["corner-bottom-right-shape", "cornerBottomRightShape"],
  ["corner-top-left-shape", "cornerTopLeftShape"],
  ["corner-top-right-shape", "cornerTopRightShape"],
  ["height", "height"],
  ["left", "left"],
  ["opacity", "opacity"],
  ["perspective", "perspective"],
  ["perspective-origin", "perspectiveOrigin"],
  ["position", "position"],
  ["top", "top"],
  ["transform", "transform"],
  ["transform-origin", "transformOrigin"],
  ["transform-style", "transformStyle"],
  ["visibility", "visibility"],
  ["width", "width"],
]);

const IGNORED_INLINE_PROPERTIES = new Set([
  "-webkit-mask-image",
  "background",
  "background-blend-mode",
  "border",
  "box-sizing",
  "image-rendering",
  "mask-image",
]);

function parserStateFor(model: PresetModel): { targetSize: number; defaultColor: string } {
  const options = model.options as { targetSize?: number; defaultColor?: string } | undefined;
  return {
    targetSize: options?.targetSize ?? 60,
    defaultColor: options?.defaultColor ?? "#8b95a1",
  };
}

function paint(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
}

function directionalLight(intensity: number) {
  const azimuth = 40 * Math.PI / 180;
  const elevation = 45 * Math.PI / 180;
  const cosElevation = Math.cos(elevation);
  return {
    direction: [
      cosElevation * Math.sin(azimuth),
      cosElevation * Math.cos(azimuth),
      Math.sin(elevation),
    ] as [number, number, number],
    color: "#ffffff",
    intensity,
  };
}

function affineMatrix(element: HTMLElement): number[] {
  const match = /^matrix3d\(([^)]+)\)$/u.exec(element.style.transform);
  if (!match) throw new Error(`Animated Gallery leaf lacks matrix3d(): ${element.style.transform}`);
  const matrix = match[1].split(",").map(Number);
  if (matrix.length !== 16 || matrix.some((value) => !Number.isFinite(value))) {
    throw new Error("Animated Gallery leaf has a malformed matrix3d().");
  }
  if (matrix[3] !== 0 || matrix[7] !== 0 || matrix[11] !== 0 || matrix[15] !== 1) {
    throw new Error("Animated Gallery leaf uses a projective transform that prepared playback cannot represent.");
  }
  return [
    matrix[0], matrix[1], matrix[2],
    matrix[4], matrix[5], matrix[6],
    matrix[8], matrix[9], matrix[10],
    matrix[12], matrix[13], matrix[14],
  ].map((value) => Object.is(value, -0) ? 0 : value);
}

function bytesBase64(bytes: Uint8Array): string {
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 32768) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 32768)));
  }
  return btoa(chunks.join(""));
}

function imageUrl(value: string): string | null {
  const match = /^url\((?:"([^"]+)"|'([^']+)'|([^'"()]+))\)$/u.exec(value.trim());
  return match ? (match[1] ?? match[2] ?? match[3]).trim() : null;
}

async function pngBytes(blob: Blob): Promise<Uint8Array> {
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Gallery image conversion lacks a 2D canvas context.");
    context.drawImage(bitmap, 0, 0);
    const png = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((value) => value ? resolve(value) : reject(new Error("Gallery image conversion failed.")), "image/png");
    });
    return new Uint8Array(await png.arrayBuffer());
  } finally {
    bitmap.close();
  }
}

async function captureImage(url: string): Promise<CapturedImage> {
  const response = await fetch(url, { credentials: "omit" });
  if (!response.ok) throw new Error(`Gallery retained image fetch failed: ${response.status}`);
  const blob = await response.blob();
  let mediaType = blob.type.toLowerCase().split(";", 1)[0];
  let bytes = new Uint8Array(await blob.arrayBuffer());
  if (mediaType !== "image/png" && mediaType !== "image/webp") {
    bytes = await pngBytes(blob);
    mediaType = "image/png";
  }
  return { mediaType: mediaType as CapturedImage["mediaType"], bytesBase64: bytesBase64(bytes) };
}

function nodeClasses(element: HTMLElement): string[] {
  const classes: string[] = [];
  if (element.classList.contains("polycss-camera")) classes.push("gallery-camera");
  if (element.classList.contains("polycss-scene")) classes.push("gallery-scene");
  if (element.classList.contains("polycss-mesh")) classes.push("gallery-mesh");
  if (element.classList.contains("polycss-voxel-face")) classes.push("gallery-voxel-face");
  if (element.classList.contains("polycss-bucket")) classes.push("gallery-bucket");
  if (["B", "I", "S", "U"].includes(element.tagName)) classes.push("gallery-leaf");
  if (element.classList.contains("polycss-corner-shape-solid")) classes.push("gallery-corner-solid");
  if (element.style.imageRendering === "pixelated") classes.push("gallery-pixelated");
  return classes;
}

function capturedStyles(element: HTMLElement, unsupported: Set<string>): { styles: Record<string, string>; imageUrl: string | null } {
  const styles: Record<string, string> = {};
  let backgroundUrl: string | null = null;
  const declarations = (element.getAttribute("style") ?? "")
    .split(";")
    .map((declaration) => declaration.trim())
    .filter(Boolean);
  for (const declaration of declarations) {
    const separator = declaration.indexOf(":");
    if (separator < 1) {
      unsupported.add(declaration);
      continue;
    }
    const property = declaration.slice(0, separator).trim().toLowerCase();
    const value = declaration.slice(separator + 1).trim();
    if (property.startsWith("--")) continue;
    if (property === "background-image") {
      backgroundUrl = imageUrl(value);
      if (!backgroundUrl) unsupported.add(`${property}:${value}`);
      continue;
    }
    const mapped = STYLE_PROPERTIES.get(property);
    if (mapped) {
      styles[mapped] = value;
      continue;
    }
    if (IGNORED_INLINE_PROPERTIES.has(property)) continue;
    unsupported.add(`${property}:${value}`);
  }
  if (element.tagName === "S") {
    const width = element.dataset.polycssTextureLeafWidth ?? getComputedStyle(element).width;
    const height = element.dataset.polycssTextureLeafHeight ?? getComputedStyle(element).height;
    styles.width = /px$/u.test(width) ? width : `${width}px`;
    styles.height = /px$/u.test(height) ? height : `${height}px`;
  }
  if (["B", "I", "U"].includes(element.tagName) && !styles.color) {
    styles.color = getComputedStyle(element).color;
  }
  return { styles, imageUrl: backgroundUrl };
}

function renderedModel(loaded: LoadedModel, clip: AnimationClip | undefined): { polygons: Polygon[]; parseResult: LoadedModel["parseResult"]; animation?: ParseAnimationController } {
  if (clip && loaded.animation) {
    const optimized = optimizeAnimatedMeshPolygons(loaded.parseResult, { meshResolution: "lossy" });
    return {
      polygons: optimized.animation?.sample(clip.index, 0) ?? optimized.polygons,
      parseResult: optimized,
      animation: optimized.animation,
    };
  }
  if (loaded.parseResult.voxelSource) return { polygons: loaded.rawPolygons, parseResult: loaded.parseResult };
  if (loaded.kind === "primitive") {
    const polygons = optimizeMeshPolygons(loaded.rawPolygons, { meshResolution: "lossless" });
    return { polygons, parseResult: { ...loaded.parseResult, polygons } };
  }
  return { polygons: loaded.polygons, parseResult: loaded.parseResult };
}

function releaseRetainedPreset(): void {
  retainedProof?.destroy();
  retainedProof = undefined;
}

async function capturePreset(id: string, retain = false): Promise<GalleryDomformatCapture> {
  releaseRetainedPreset();
  const preset = PRESETS.find((candidate) => candidate.id === id);
  if (!preset) throw new Error(`Unknown Gallery preset ${id}.`);
  const loaded = await loadPresetModel(preset, parserStateFor(preset), "lossy");
  const host = document.createElement("div");
  host.style.width = `${SOURCE_WIDTH}px`;
  host.style.height = `${SOURCE_HEIGHT}px`;
  host.style.position = "relative";
  host.style.overflow = "hidden";
  host.style.backgroundColor = "#000000";
  document.body.replaceChildren(host);
  let scene: ReturnType<typeof createPolyScene> | undefined;
  let retained = false;
  try {
    const clip = firstSelectableAnimationClip(loaded.animation?.clips ?? []);
    const rendered = renderedModel(loaded, clip);
    const resolvedClip = clip && rendered.animation
      ? rendered.animation.clips.find((candidate) => candidate.index === clip.index) ?? clip
      : undefined;
    const effectiveClip = resolvedClip && resolvedClip.duration > 0 ? resolvedClip : undefined;
    const animationFrameCount = effectiveClip
      ? Math.max(1, Math.round(effectiveClip.duration * ANIMATION_TICK_RATE))
      : 0;
    const zoom = defaultZoomForModel(preset, loaded.rawPolygons)
      * responsiveZoomScaleForViewport(SOURCE_WIDTH, SOURCE_HEIGHT)
      * LEGACY_ZOOM_COMPAT;
    const camera = createPolyPerspectiveCamera({
      rotX: preset.rotX ?? 65,
      rotY: preset.rotY ?? 45,
      zoom,
      target: [0, 0, 0],
    });
    scene = createPolyScene(host, {
      camera,
      directionalLight: directionalLight(smartKeyIntensityForModel(loaded.rawPolygons)),
      ambientLight: { color: "#ffffff", intensity: smartAmbientForModel(preset, loaded.rawPolygons) },
      textureLighting: "baked",
      autoCenter: true,
      textureQuality: "auto",
      strategies: { disable: [] },
      shadow: { maxExtend: 2000, lift: 0.01, parametric: true, definition: 35, style: "vector", followAnimation: true },
    });
    const mesh = scene.add({ ...rendered.parseResult, polygons: rendered.polygons, dispose: () => {} }, {
      merge: false,
      stableDom: Boolean(effectiveClip),
      id: preset.label,
      castShadow: false,
      receiveShadow: false,
    });
    await mesh.whenTexturesReady();
    await paint();

    const leafEntries = queryPolyLeaves(mesh.element);
    const leaves = leafEntries.map((entry) => entry.element);
    if (leaves.length === 0) throw new Error(`Gallery preset ${id} mounted no visual leaves.`);
    const frames: CapturedFrame[] = [];
    if (effectiveClip && rendered.animation) {
      const applyAnimationFrame = async (frame: number): Promise<CapturedFrame> => {
        const time = frame / ANIMATION_TICK_RATE;
        mesh.setPolygons(rendered.animation.sample(effectiveClip.index, time), {
          merge: false,
          stableDom: true,
          recomputeAutoCenter: false,
          stableTriangleColorPolicy: "cadence",
          stableTriangleColorFreezeFrames: 0,
        });
        await paint();
        const current = queryPolyLeaves(mesh.element).map((entry) => entry.element);
        if (current.length !== leaves.length || current.some((element, index) => element !== leaves[index])) {
          throw new Error(`Gallery preset ${id} did not preserve animated leaf identity.`);
        }
        return {
          transforms: current.map(affineMatrix),
          visibility: current.map((element) => element.style.visibility !== "hidden"),
        };
      };
      for (let frame = 0; frame < animationFrameCount; frame += 1) {
        await applyAnimationFrame(frame);
      }
      for (let frame = 0; frame < animationFrameCount; frame += 1) {
        frames.push(await applyAnimationFrame(frame));
      }
      const reset = await applyAnimationFrame(0);
      if (reset.transforms.some((matrix, index) => matrix.some((value, component) => value !== frames[0].transforms[index][component]))
        || reset.visibility.some((value, index) => value !== frames[0].visibility[index])) {
        throw new Error(`Gallery preset ${id} animation is not stable across its retained loop boundary.`);
      }
    }

    const cameraElement = host.querySelector<HTMLElement>(".polycss-camera");
    const sceneElement = cameraElement?.querySelector<HTMLElement>(".polycss-scene");
    if (!cameraElement || !sceneElement) throw new Error(`Gallery preset ${id} lacks the camera/scene retained roots.`);
    const elements = [cameraElement, ...cameraElement.querySelectorAll<HTMLElement>("*")];
    const included = new Map<HTMLElement, number>();
    for (const element of elements) {
      if (!["B", "DIV", "I", "S", "SPAN", "U"].includes(element.tagName)) {
        throw new Error(`Gallery preset ${id} emitted unsupported element ${element.tagName}.`);
      }
      included.set(element, included.size);
    }
    const leafIndex = new Map(leaves.map((element, index) => [element, index]));
    const unsupported = new Set<string>();
    const pendingImages: string[] = [];
    const imageIndices = new Map<string, number>();
    const nodes = elements.map((element, index): CapturedNode => {
      const parentElement = element.parentElement;
      const parent = parentElement ? (included.get(parentElement) ?? -1) : -1;
      const siblings = parentElement
        ? [...parentElement.children].filter((child): child is HTMLElement => included.has(child as HTMLElement))
        : [element];
      const captured = capturedStyles(element, unsupported);
      let image: number | null = null;
      if (captured.imageUrl) {
        image = imageIndices.get(captured.imageUrl) ?? null;
        if (image === null) {
          image = pendingImages.length;
          imageIndices.set(captured.imageUrl, image);
          pendingImages.push(captured.imageUrl);
        }
      }
      return {
        index,
        id: `g/n${index.toString(36)}`,
        parent,
        sibling: siblings.indexOf(element),
        name: element.tagName.toLowerCase(),
        classes: nodeClasses(element),
        styles: captured.styles,
        image,
        leaf: leafIndex.get(element) ?? null,
      };
    });
    const images = await Promise.all(pendingImages.map(captureImage));
    const visualLeafNodes = leaves.map((element) => nodes[included.get(element)!].id);
    const perspective = Number.parseFloat(cameraElement.style.perspective);
    const baseSceneTransform = sceneElement.style.transform;
    if (!Number.isFinite(perspective) || perspective <= 0 || !baseSceneTransform) {
      throw new Error(`Gallery preset ${id} has invalid presentation state.`);
    }
    const result: GalleryDomformatCapture = {
      id: preset.id,
      label: preset.label,
      kind: preset.kind,
      category: preset.category,
      ...(preset.galleryBucket ? { galleryBucket: preset.galleryBucket } : {}),
      ...(preset.url ? { sourceUrl: preset.url } : {}),
      ...(preset.mtlUrl ? { mtlUrl: preset.mtlUrl } : {}),
      ...(preset.attribution ? { attribution: preset.attribution } : {}),
      sourceWidth: SOURCE_WIDTH,
      sourceHeight: SOURCE_HEIGHT,
      perspective,
      baseSceneTransform,
      nodes,
      cameraNode: nodes[included.get(cameraElement)!].id,
      modelNode: nodes[included.get(sceneElement)!].id,
      visualLeafNodes,
      images,
      frames,
      ...(effectiveClip ? {
        clip: {
          index: effectiveClip.index,
          name: effectiveClip.name,
          duration: effectiveClip.duration,
          tickRateHz: ANIMATION_TICK_RATE,
          timelineTicks: animationFrameCount,
        },
      } : {}),
      sourcePolygonCount: loaded.sourcePolygons,
      renderedPolygonCount: rendered.polygons.length,
      warnings: [...loaded.warnings],
      unsupportedInlineStyles: [...unsupported].sort(),
    };
    if (retain) {
      retained = true;
      retainedProof = {
        id,
        frameCount: frames.length || 1,
        clip: result.clip,
        async seek(frame) {
          if (!effectiveClip || !rendered.animation) {
            if (frame !== 0) throw new Error(`Static Gallery preset ${id} has no frame ${frame}.`);
            return;
          }
          if (!Number.isSafeInteger(frame) || frame < 0 || frame >= animationFrameCount) {
            throw new Error(`Gallery proof frame ${frame} is outside 0..${animationFrameCount - 1}.`);
          }
          mesh.setPolygons(rendered.animation.sample(effectiveClip.index, frame / ANIMATION_TICK_RATE), {
            merge: false,
            stableDom: true,
            recomputeAutoCenter: false,
            stableTriangleColorPolicy: "cadence",
            stableTriangleColorFreezeFrames: 0,
          });
          await paint();
        },
        destroy() {
          scene?.destroy();
          loaded.dispose();
        },
      };
    }
    return result;
  } finally {
    if (!retained) {
      scene?.destroy();
      loaded.dispose();
    }
  }
}

async function renderPresetForProof(id: string, frame = 0) {
  const capture = await capturePreset(id, true);
  try {
    if (frame > 0) await retainedProof!.seek(frame);
    return {
      id,
      frame,
      frameCount: retainedProof!.frameCount,
      perspective: capture.perspective,
      baseSceneTransform: capture.baseSceneTransform,
      clip: capture.clip,
    };
  } catch (error) {
    releaseRetainedPreset();
    throw error;
  }
}

async function seekRetainedPreset(frame: number) {
  if (!retainedProof) throw new Error("No Gallery proof model is retained.");
  await retainedProof.seek(frame);
  return { id: retainedProof.id, frame, frameCount: retainedProof.frameCount, clip: retainedProof.clip };
}

Object.assign(window, {
  galleryDomformat: Object.freeze({
    presets: PRESETS.map((preset) => Object.freeze({ id: preset.id, label: preset.label, kind: preset.kind })),
    capturePreset,
    releaseRetainedPreset,
    renderPresetForProof,
    seekRetainedPreset,
  }),
});

document.documentElement.dataset.galleryDomformatReady = "";
