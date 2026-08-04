import { createHash } from "node:crypto";
import { createServer } from "node:http";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";
import sharp from "sharp";
import {
  buildDom,
  readDomFile,
  validateDocument,
} from "@layoutit/polycss-domformat";

const scriptRoot = dirname(fileURLToPath(import.meta.url));
const websiteRoot = resolve(scriptRoot, "..");
const galleryRoot = join(websiteRoot, "public/gallery");
const defaultOutputRoot = join(galleryRoot, "domformat");
const browserEntry = join(scriptRoot, "gallery-domformat-browser.ts");
const scope = '[data-domformat-gallery="model"]';
const XHTML = "http://www.w3.org/1999/xhtml";
const TRANSFORM_SCALE = 1000;
const PLAYBACK_TICK_RATE_HZ = 30;
const MAX_TOTAL_DOCUMENT_BYTES = 192 * 1024 * 1024;
const MAX_TOTAL_EXTERNAL_BYTES = 64 * 1024 * 1024;
const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
const MAX_RESOURCE_BYTES = 4 * 1024 * 1024;

const GALLERY_CSS = [
  `${scope} .gallery-camera{position:relative;display:block;width:100%;height:100%}`,
  `${scope} .gallery-scene,${scope} .gallery-scene *{box-sizing:border-box}`,
  `${scope} .gallery-scene{position:absolute;top:50%;left:50%;width:0;height:0;transform-style:preserve-3d;will-change:transform}`,
  `${scope} .gallery-mesh,${scope} .gallery-bucket{position:absolute;transform-style:preserve-3d;transform-origin:0 0 0}`,
  `${scope} .gallery-leaf{position:absolute;display:block;transform-origin:0 0;transform-style:preserve-3d;margin:0;padding:0;font:inherit;font-weight:normal;font-style:normal;line-height:0;text-decoration:none;backface-visibility:hidden;background-repeat:no-repeat}`,
  `${scope} b.gallery-leaf{background:currentColor;width:64px;height:64px}`,
  `${scope} i.gallery-leaf{width:16px;height:16px;border-color:currentColor}`,
  `${scope} u.gallery-leaf{width:32px;height:32px;background:transparent;box-sizing:content-box;border:0 solid transparent;border-color:transparent transparent currentColor transparent;background-color:currentColor;border-top-left-radius:50% 100%;border-top-right-radius:50% 100%;corner-top-left-shape:bevel;corner-top-right-shape:bevel}`,
  `${scope} u.gallery-corner-solid{width:16px;height:16px;box-sizing:border-box;border:0;background:currentColor;border-top-left-radius:0;border-top-right-radius:0;border-bottom-right-radius:0;border-bottom-left-radius:0;corner-top-left-shape:initial;corner-top-right-shape:initial;corner-bottom-right-shape:initial;corner-bottom-left-shape:initial}`,
  `${scope} .gallery-voxel-face{position:absolute;display:block;top:0;left:0;width:0;height:0;transform-style:preserve-3d;transform-origin:0 0;margin:0;padding:0;font:inherit;line-height:0;pointer-events:none}`,
  `${scope} .gallery-voxel-face>b.gallery-leaf{top:0;left:0;width:1px;height:1px;backface-visibility:visible;pointer-events:none}`,
  `${scope} .gallery-pixelated{image-rendering:pixelated}`,
].join("\n");

const MIME_TYPES = new Map([
  [".bin", "application/octet-stream"],
  [".glb", "model/gltf-binary"],
  [".gltf", "model/gltf+json"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".js", "text/javascript;charset=utf-8"],
  [".json", "application/json;charset=utf-8"],
  [".mtl", "text/plain;charset=utf-8"],
  [".obj", "text/plain;charset=utf-8"],
  [".png", "image/png"],
  [".stl", "application/octet-stream"],
  [".vox", "application/octet-stream"],
  [".webp", "image/webp"],
]);

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function utf8(value) {
  return new TextEncoder().encode(value);
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

function canonicalBytes(value) {
  return utf8(`${JSON.stringify(canonicalize(value))}\n`);
}

function parseArguments(argv) {
  const options = { captureOnly: false, ids: null, outputRoot: defaultOutputRoot };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--capture-only") options.captureOnly = true;
    else if (argument === "--models") {
      const value = argv[++index];
      requireCondition(value, "--models requires a comma-separated value.");
      options.ids = value.split(",").map((entry) => entry.trim()).filter(Boolean);
      requireCondition(options.ids.length > 0, "--models requires at least one model id.");
      requireCondition(new Set(options.ids).size === options.ids.length, "--models must not contain duplicate model ids.");
    } else if (argument === "--output") {
      const value = argv[++index];
      requireCondition(value, "--output requires a directory.");
      options.outputRoot = resolve(value);
    } else throw new Error(`Unknown argument ${argument}.`);
  }
  const temporaryRoot = resolve(tmpdir());
  requireCondition(
    options.outputRoot === defaultOutputRoot || options.outputRoot.startsWith(`${temporaryRoot}${sep}`),
    `--output must be ${defaultOutputRoot} or a child of ${temporaryRoot}.`,
  );
  requireCondition(options.outputRoot !== temporaryRoot, `--output must not replace ${temporaryRoot}.`);
  requireCondition(
    options.captureOnly || options.ids === null || options.outputRoot !== defaultOutputRoot,
    "--models requires an explicit temporary --output and cannot replace the canonical Gallery corpus.",
  );
  return options;
}

async function lstatIfPresent(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

function isWithin(root, path) {
  return path === root || path.startsWith(`${root}${sep}`);
}

async function validateOutputRoot(outputRoot, outputParent) {
  const parentStat = await lstat(outputParent);
  requireCondition(parentStat.isDirectory() && !parentStat.isSymbolicLink(), `Output parent is not a real directory: ${outputParent}.`);
  requireCondition(await realpath(outputParent) === outputParent, `Output parent changed after validation: ${outputParent}.`);
  requireCondition(dirname(outputRoot) === outputParent, `Output root escaped its validated parent: ${outputRoot}.`);
  const outputStat = await lstatIfPresent(outputRoot);
  if (!outputStat) return;
  requireCondition(outputStat.isDirectory() && !outputStat.isSymbolicLink(), `Output root must be a real directory: ${outputRoot}.`);
  requireCondition(await realpath(outputRoot) === outputRoot, `Output root resolves through a symlink: ${outputRoot}.`);
}

async function prepareOutputRoot(requestedOutputRoot) {
  if (requestedOutputRoot === defaultOutputRoot) {
    const outputParent = await realpath(dirname(defaultOutputRoot));
    const outputRoot = join(outputParent, basename(defaultOutputRoot));
    await validateOutputRoot(outputRoot, outputParent);
    return { outputParent, outputRoot };
  }

  const temporaryRoot = resolve(tmpdir());
  const requestedParent = dirname(requestedOutputRoot);
  const parentRelative = relative(temporaryRoot, requestedParent);
  requireCondition(!parentRelative.startsWith(`..${sep}`) && parentRelative !== ".." && !isAbsolute(parentRelative), `Output parent escaped ${temporaryRoot}.`);
  const realTemporaryRoot = await realpath(temporaryRoot);
  let current = temporaryRoot;
  for (const component of parentRelative.split(sep).filter(Boolean)) {
    const next = join(current, component);
    let stat = await lstatIfPresent(next);
    if (!stat) {
      try {
        await mkdir(next);
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
      }
      stat = await lstat(next);
    }
    requireCondition(stat.isDirectory() && !stat.isSymbolicLink(), `Temporary output path contains a symlink or non-directory: ${next}.`);
    const realNext = await realpath(next);
    requireCondition(isWithin(realTemporaryRoot, realNext), `Temporary output path escaped ${realTemporaryRoot}.`);
    current = next;
  }
  const outputParent = await realpath(current);
  const outputRoot = join(outputParent, basename(requestedOutputRoot));
  await validateOutputRoot(outputRoot, outputParent);
  return { outputParent, outputRoot };
}

function galleryRelativePath(pathname) {
  requireCondition(pathname.startsWith("/gallery/"), "Gallery request is outside the public asset route.");
  const decoded = decodeURIComponent(pathname.slice("/gallery/".length));
  const resolved = resolve(galleryRoot, decoded);
  requireCondition(resolved === galleryRoot || resolved.startsWith(`${galleryRoot}${sep}`), "Gallery request escaped the public asset root.");
  return relative(galleryRoot, resolved).split(sep).join("/");
}

async function safeGalleryPath(pathname) {
  const relativePath = galleryRelativePath(pathname);
  const path = await safeGalleryRelativePath(relativePath);
  return { path, relativePath };
}

async function safeGalleryRelativePath(relativePath) {
  requireCondition(relativePath.length > 0 && !relativePath.includes("\\"), `Gallery asset path is not canonical: ${relativePath}.`);
  const lexicalPath = resolve(galleryRoot, relativePath);
  requireCondition(isWithin(galleryRoot, lexicalPath), `Gallery asset escaped the public asset root: ${relativePath}.`);
  const [realGalleryRoot, path] = await Promise.all([realpath(galleryRoot), realpath(lexicalPath)]);
  requireCondition(isWithin(realGalleryRoot, path), "Gallery request resolved outside the public asset root.");
  return path;
}

async function startServer(browserBytes) {
  const galleryRequests = [];
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/") {
        const html = "<!doctype html><html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"></head><body><script type=\"module\" src=\"/harness.js\"></script></body></html>";
        response.writeHead(200, { "content-type": "text/html;charset=utf-8", "content-length": Buffer.byteLength(html) });
        response.end(html);
        return;
      }
      if (url.pathname === "/harness.js") {
        response.writeHead(200, { "content-type": "text/javascript;charset=utf-8", "content-length": browserBytes.length });
        response.end(browserBytes);
        return;
      }
      if (!url.pathname.startsWith("/gallery/")) {
        response.writeHead(404).end();
        return;
      }
      const { path, relativePath } = await safeGalleryPath(url.pathname);
      const bytes = await readFile(path);
      galleryRequests.push(relativePath);
      response.writeHead(200, {
        "content-type": MIME_TYPES.get(extname(path).toLowerCase()) ?? "application/octet-stream",
        "content-length": bytes.length,
        "cache-control": "no-store",
      });
      response.end(bytes);
    } catch (error) {
      response.writeHead(error?.code === "ENOENT" ? 404 : 500, { "content-type": "text/plain;charset=utf-8" });
      response.end(error instanceof Error ? error.message : String(error));
    }
  });
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  requireCondition(address && typeof address === "object", "Gallery producer server has no address.");
  return { galleryRequests, server, url: `http://127.0.0.1:${address.port}/` };
}

function emptyTransformGroup() {
  return {
    encoding: "decimal-component-streams",
    empty: [0],
    scales: new Array(12).fill(0),
    columns: Array.from({ length: 12 }, () => []),
  };
}

function scaledMatrix(matrix) {
  requireCondition(Array.isArray(matrix) && matrix.length === 12 && matrix.every(Number.isFinite), "Captured matrix is malformed.");
  return matrix.map((value) => {
    const scaled = Math.round(value * TRANSFORM_SCALE);
    requireCondition(Math.abs(value * TRANSFORM_SCALE - scaled) < 1e-6, `Captured transform exceeds ${TRANSFORM_SCALE} precision.`);
    return scaled;
  });
}

function preparedAnimation(capture) {
  const shapeCount = capture.frames.length > 0 ? capture.visualLeafNodes.length : 0;
  const frameCount = capture.frames.length || 1;
  if (shapeCount === 0) {
    return {
      frameCount,
      shapeCount: 0,
      targets: [],
      timeline: [1],
      initialTransforms: [],
      initialVisibility: [],
      frameRows: [[1, 0, -1, 0, 0, 0, 0]],
      shapeSources: [],
      shapeTransforms: [],
      shapeVisibility: [],
      transformCount: 1,
      transformGroups: [emptyTransformGroup()],
    };
  }

  requireCondition(capture.frames.every((frame) => frame.transforms.length === shapeCount && frame.visibility.length === shapeCount), "Animated capture cardinality changed.");
  const shapeStates = [];
  let transformCount = 1;
  for (let shape = 0; shape < shapeCount; shape += 1) {
    const states = [];
    const byMatrix = new Map();
    const frameState = [];
    for (const frame of capture.frames) {
      const matrix = scaledMatrix(frame.transforms[shape]);
      const key = matrix.join(",");
      let state = byMatrix.get(key);
      if (state === undefined) {
        state = states.length;
        byMatrix.set(key, state);
        states.push(matrix);
      }
      frameState.push(state);
    }
    shapeStates.push({ offset: transformCount, states, frameState });
    transformCount += states.length;
  }

  const initialTransforms = [];
  let previousInitial = 0;
  for (const shape of shapeStates) {
    const target = shape.offset + shape.frameState[0];
    initialTransforms.push(target - previousInitial);
    previousInitial = target;
  }

  const shapeSources = [];
  const shapeTransforms = [];
  const shapeVisibility = [];
  const frameRows = [];
  let previousChangeTransform = 0;
  for (let targetFrame = 0; targetFrame < frameCount; targetFrame += 1) {
    const previousFrame = (targetFrame + frameCount - 1) % frameCount;
    const start = shapeSources.length;
    let previousShape = 0;
    for (let shape = 0; shape < shapeCount; shape += 1) {
      const state = shapeStates[shape];
      const transformChanged = state.frameState[targetFrame] !== state.frameState[previousFrame];
      const visibilityChanged = capture.frames[targetFrame].visibility[shape] !== capture.frames[previousFrame].visibility[shape];
      if (!transformChanged && !visibilityChanged) continue;
      shapeSources.push(shape - previousShape);
      previousShape = shape;
      const target = state.offset + state.frameState[targetFrame];
      shapeTransforms.push(target - previousChangeTransform);
      previousChangeTransform = target;
      shapeVisibility.push(capture.frames[targetFrame].visibility[shape] ? 1 : 0);
    }
    frameRows.push([targetFrame + 1, 0, -1, start, shapeSources.length - start, 0, 0]);
  }

  const transformGroups = [emptyTransformGroup()];
  for (const shape of shapeStates) {
    const columns = Array.from({ length: 12 }, (_, component) => {
      let previous = 0;
      return shape.states.map((matrix) => {
        const delta = matrix[component] - previous;
        previous = matrix[component];
        return delta;
      });
    });
    transformGroups.push({
      encoding: "decimal-component-streams",
      empty: [],
      scales: new Array(12).fill(TRANSFORM_SCALE),
      columns,
    });
  }

  const ticks = capture.clip?.timelineTicks ?? frameCount;
  const timeline = Array.from({ length: ticks }, (_, tick) => 1 + Math.floor(tick * frameCount / ticks));
  return {
    frameCount,
    shapeCount,
    targets: capture.visualLeafNodes,
    timeline,
    initialTransforms,
    initialVisibility: capture.frames[0].visibility.map((visible) => visible ? 1 : 0),
    frameRows,
    shapeSources,
    shapeTransforms,
    shapeVisibility,
    transformCount,
    transformGroups,
  };
}

function resourceIdentity(bytes, mediaType) {
  const digest = sha256(bytes);
  return {
    digest,
    id: `image-${digest.slice(0, 56)}`,
    path: `assets/${digest}.${mediaType === "image/webp" ? "webp" : "png"}`,
  };
}

async function compactImage(bytes, mediaType) {
  const candidate = await sharp(bytes).webp({ lossless: true, effort: 2 }).toBuffer();
  if (candidate.length >= bytes.length) return { bytes, mediaType };
  const [source, compacted] = await Promise.all([
    sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
    sharp(candidate).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
  ]);
  requireCondition(
    source.info.width === compacted.info.width
      && source.info.height === compacted.info.height
      && source.info.channels === 4
      && compacted.info.channels === 4,
    "Lossless WebP compaction changed image geometry.",
  );
  for (let offset = 0; offset < source.data.length; offset += 4) {
    const sourceAlpha = source.data[offset + 3];
    const compactedAlpha = compacted.data[offset + 3];
    requireCondition(sourceAlpha === compactedAlpha, "Lossless WebP compaction changed image alpha.");
    if (sourceAlpha === 0) continue;
    requireCondition(
      source.data[offset] === compacted.data[offset]
        && source.data[offset + 1] === compacted.data[offset + 1]
        && source.data[offset + 2] === compacted.data[offset + 2],
      "Lossless WebP compaction changed a painted image pixel.",
    );
  }
  return { bytes: candidate, mediaType: "image/webp" };
}

function gallerySourcePath(urlValue) {
  const url = new URL(urlValue, "http://gallery.invalid");
  requireCondition(url.origin === "http://gallery.invalid", `Gallery source must be local: ${urlValue}.`);
  return galleryRelativePath(url.pathname);
}

function sourceArtifactRole(path, primaryPath, materialPath) {
  if (path === primaryPath) return "primary";
  if (path === materialPath || extname(path).toLowerCase() === ".mtl") return "material";
  if (extname(path).toLowerCase() === ".bin") return "buffer";
  if (/\.(?:avif|gif|jpe?g|png|webp)$/iu.test(path)) return "texture";
  return "dependency";
}

async function sourceClosure(capture, consumedSourcePaths) {
  const paths = [...new Set(consumedSourcePaths)].sort();
  requireCondition(!paths.some((path) => path.startsWith("domformat/")), `${capture.id} consumed generated domformat corpus data as source.`);
  if (!capture.sourceUrl) {
    requireCondition(paths.length === 0, `${capture.id} consumed Gallery assets without declaring a source: ${paths.join(", ")}.`);
    return { source: undefined, sourceArtifacts: [] };
  }

  const primaryPath = gallerySourcePath(capture.sourceUrl);
  const materialPath = capture.mtlUrl ? gallerySourcePath(capture.mtlUrl) : undefined;
  requireCondition(paths.includes(primaryPath), `${capture.id} did not consume its primary source ${primaryPath}.`);
  requireCondition(!materialPath || paths.includes(materialPath), `${capture.id} did not consume its declared material source ${materialPath}.`);
  const sourceArtifacts = await Promise.all(paths.map(async (path) => {
    const bytes = await readFile(await safeGalleryRelativePath(path));
    return {
      path,
      role: sourceArtifactRole(path, primaryPath, materialPath),
      byteLength: bytes.length,
      digest: { algorithm: "sha256", value: sha256(bytes) },
    };
  }));
  const primary = sourceArtifacts.find((artifact) => artifact.path === primaryPath);
  requireCondition(primary, `${capture.id} source closure has no primary artifact.`);
  return {
    source: {
      byteLength: primary.byteLength,
      decodedByteLength: primary.byteLength,
      digest: primary.digest,
      status: "gallery-source",
    },
    sourceArtifacts,
  };
}

async function buildCapture(capture, consumedSourcePaths) {
  requireCondition(capture.unsupportedInlineStyles.length === 0, `${capture.id} has unsupported retained styles: ${capture.unsupportedInlineStyles.join(", ")}`);
  const imageInputs = [];
  const imagesByDigest = new Map();
  const imageIds = new Map();
  const browserImageResources = [];
  const registerImage = (bytes, mediaType) => {
    const identity = resourceIdentity(bytes, mediaType);
    const existing = imagesByDigest.get(identity.digest);
    if (existing) return existing;
    const existingDigest = imageIds.get(identity.id);
    requireCondition(existingDigest === undefined || existingDigest === identity.digest, `Image resource id collision for ${identity.id}.`);
    const value = { ...identity, bytes, mediaType };
    imagesByDigest.set(identity.digest, value);
    imageIds.set(identity.id, identity.digest);
    imageInputs.push(value);
    return value;
  };
  for (const image of capture.images) {
    const compacted = await compactImage(Buffer.from(image.bytesBase64, "base64"), image.mediaType);
    browserImageResources.push(registerImage(compacted.bytes, compacted.mediaType));
  }

  const children = new Set(capture.nodes.filter((node) => node.parent >= 0).map((node) => node.parent));
  const nodes = capture.nodes.map((node) => ({
    index: node.index,
    id: node.id,
    parent: node.parent,
    sibling: node.sibling,
    namespace: XHTML,
    name: node.name,
    classes: node.classes,
    attributes: children.has(node.index) ? {} : { "aria-hidden": "true" },
    styles: { ...node.styles },
    resourceAttributes: {},
    resourceStyles: node.image === null
      ? {}
      : { backgroundImage: { resource: browserImageResources[node.image].id, syntax: "url" } },
  }));
  const camera = nodes.find((node) => node.id === capture.cameraNode);
  requireCondition(camera, `${capture.id} has no camera node.`);
  Object.assign(camera.styles, {
    height: `${capture.sourceHeight}px`,
    perspective: `${capture.perspective}px`,
    perspectiveOrigin: `${capture.sourceWidth / 2}px ${capture.sourceHeight / 2}px`,
    position: "relative",
    width: `${capture.sourceWidth}px`,
  });
  const animated = capture.frames.length > 0;
  const playback = animated ? preparedAnimation(capture) : null;
  requireCondition(!animated || capture.clip?.tickRateHz === PLAYBACK_TICK_RATE_HZ, `${capture.id} has a noncanonical playback rate.`);
  const cssDigest = sha256(utf8(GALLERY_CSS));
  const cssResource = {
    id: "gallery-css",
    kind: "stylesheet",
    mediaType: "text/css;charset=utf-8",
    path: `styles/${cssDigest}.css`,
    bytes: utf8(GALLERY_CSS),
  };
  const resourceInputs = [
    cssResource,
    ...imageInputs.map((image) => ({
      id: image.id,
      kind: "image",
      mediaType: image.mediaType,
      path: image.path,
      bytes: image.bytes,
    })),
  ];
  const { source, sourceArtifacts } = await sourceClosure(capture, consumedSourcePaths);
  const presentationState = {
    id: "presentation",
    codec: "static-presentation@0",
    data: {
      packet: {
        version: 0,
        camera: {
          baseSceneTransform: capture.baseSceneTransform,
          fitHeight: capture.sourceHeight,
          fitWidth: capture.sourceWidth,
          perspective: capture.perspective,
          sourceHeight: capture.sourceHeight,
          sourceWidth: capture.sourceWidth,
        },
      },
    },
  };
  const presentationBinding = {
    id: "presentation",
    state: "presentation",
    interpreter: "static-presentation@0",
    status: "executable",
    inputs: ["viewport.height", "viewport.width"],
    targets: { host: "$host", camera: capture.cameraNode },
    sinks: ["style.height", "style.left", "style.top", "style.transform", "style.width"],
    parameters: {
      fitHeight: capture.sourceHeight,
      fitWidth: capture.sourceWidth,
      sourceHeight: capture.sourceHeight,
      sourceWidth: capture.sourceWidth,
    },
  };
  const stateChannels = [presentationState];
  const bindingChannels = [presentationBinding];
  const bindingInputs = [
    { id: "viewport.height", type: "float" },
    { id: "viewport.width", type: "float" },
  ];
  if (playback) {
    stateChannels.unshift({
      id: "playback",
      codec: "polycss-playback-packed@0",
      data: {
        packet: {
          version: 0,
          layout: "delta-component-streams@0",
          shapeCount: playback.shapeCount,
          leafCount: 0,
          appearances: [["default", 1, 0]],
          timeline: { introTicks: 0, loopTicks: playback.timeline.length, frames: playback.timeline },
          initial: {
            sourceFrame: 1,
            appearance: 0,
            modelTransform: 0,
            shapes: {
              count: playback.shapeCount,
              transforms: playback.initialTransforms,
              visibility: playback.initialVisibility,
            },
            leaves: { count: 0, transforms: [] },
          },
          frameRows: playback.frameRows,
          shapeChanges: {
            sources: playback.shapeSources,
            transforms: playback.shapeTransforms,
            visibility: playback.shapeVisibility,
          },
          leafChanges: { sources: [], transforms: [] },
          transforms: { count: playback.transformCount, groups: playback.transformGroups },
        },
        leafFit: [],
      },
    });
    bindingChannels.unshift({
      id: "playback",
      state: "playback",
      interpreter: "polycss-playback@0",
      status: "executable",
      inputs: ["time.tick"],
      targets: { model: capture.modelNode, shapes: playback.targets, leaves: [] },
      sinks: ["style.transform", "style.visibility"],
      parameters: {
        baseSceneTransform: capture.baseSceneTransform,
        frameCount: playback.frameCount,
        tickRateHz: PLAYBACK_TICK_RATE_HZ,
      },
    });
    bindingInputs.unshift({ id: "time.tick", type: "uint" });
  }
  const input = {
    meta: {
      title: capture.label,
      capabilities: [
        "css-semantic-closure",
        "deterministic-json",
        "explicit-retained-tree",
        "logical-assets",
        ...(playback ? ["prepared-playback"] : []),
      ],
      optionalCapabilities: [],
      ...(playback ? { initialExperience: "animation" } : {}),
      conformance: {
        executable: ["retained-tree", ...(playback ? ["playback"] : []), "presentation"],
        declaredOnly: [],
      },
      counts: playback
        ? { nodes: nodes.length, shapes: playback.shapeCount, leaves: 0, sourceFrames: playback.frameCount }
        : { nodes: nodes.length },
      ...(source ? { sourceArtifact: source } : {}),
    },
    tree: {
      version: 0,
      mount: {
        behavior: "replace-children",
        attributes: [["data-domformat-gallery", "model"]],
        styles: {
          backgroundColor: "#000000",
          position: "relative",
        },
      },
      nodes,
    },
    cssBinding: {
      version: 0,
      stylesheets: [{ id: "gallery-css", resource: "gallery-css", scope, assetTokens: [] }],
    },
    state: {
      version: 0,
      channels: stateChannels,
    },
    bindings: {
      version: 0,
      inputs: bindingInputs,
      channels: bindingChannels,
    },
    resourceInputs,
  };

  const first = buildDom(input);
  const second = buildDom(input);
  requireCondition(Buffer.from(first.bytes).equals(Buffer.from(second.bytes)), `${capture.id} writer output is nondeterministic.`);
  validateDocument(first.document);
  return { built: first, source, sourceArtifacts, playback };
}

async function writeOnce(path, bytes) {
  await mkdir(dirname(path), { recursive: true });
  try {
    const prior = await readFile(path);
    requireCondition(Buffer.from(prior).equals(Buffer.from(bytes)), `Generated resource collision at ${path}.`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    await writeFile(path, bytes);
  }
}

function catalogEntry(capture, built, source, sourceArtifacts, playback) {
  const externalBytes = [...built.externalResources.values()].reduce((sum, bytes) => sum + bytes.length, 0);
  const strategies = { b: 0, i: 0, s: 0, u: 0, voxelFaces: 0 };
  for (const node of capture.nodes) {
    if (node.classes.includes("gallery-leaf")) {
      requireCondition(Object.hasOwn(strategies, node.name), `${capture.id} emitted unknown Gallery strategy ${node.name}.`);
      strategies[node.name] += 1;
    }
    if (node.classes.includes("gallery-voxel-face")) strategies.voxelFaces += 1;
  }
  return {
    id: capture.id,
    label: capture.label,
    kind: capture.kind,
    category: capture.category,
    ...(capture.galleryBucket ? { galleryBucket: capture.galleryBucket } : {}),
    document: `models/${capture.id}.json`,
    attribution: capture.attribution,
    source: {
      ...(capture.sourceUrl ? { url: capture.sourceUrl } : {}),
      ...(capture.mtlUrl ? { mtlUrl: capture.mtlUrl } : {}),
      ...(source ? source : {}),
      ...(source ? { artifacts: sourceArtifacts } : {}),
      polygons: capture.sourcePolygonCount,
    },
    canonical: {
      byteLength: built.bytes.length,
      digest: { algorithm: "sha256", value: sha256(built.bytes) },
      externalByteLength: externalBytes,
      resources: built.document.resources.resources.length,
      nodes: built.document.tree.nodes.length,
      visualLeaves: capture.visualLeafNodes.length,
      renderedPolygons: capture.renderedPolygonCount,
      strategies,
      ...(playback ? { sourceFrames: playback.frameCount } : {}),
      ...(playback ? { clip: capture.clip } : {}),
      warnings: capture.warnings,
    },
  };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const output = options.captureOnly ? undefined : await prepareOutputRoot(options.outputRoot);
  const bundleRoot = await mkdtemp(join(await realpath(tmpdir()), "polycss-gallery-domformat-bundle-"));
  const bundlePath = join(bundleRoot, "harness.js");
  let browser;
  let server;
  let stagingRoot;
  try {
    await build({
      entryPoints: [browserEntry],
      bundle: true,
      format: "esm",
      platform: "browser",
      target: "chrome120",
      outfile: bundlePath,
      logLevel: "silent",
    });
    const browserBytes = await readFile(bundlePath);
    const started = await startServer(browserBytes);
    server = started.server;
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 640, height: 640 }, deviceScaleFactor: 1 });
    page.setDefaultTimeout(120_000);
    const browserErrors = [];
    page.on("pageerror", (error) => browserErrors.push(error.message));
    await page.goto(started.url, { waitUntil: "load" });
    await page.waitForFunction(() => document.documentElement.hasAttribute("data-gallery-domformat-ready"));
    const presets = await page.evaluate(() => window.galleryDomformat.presets);
    const captureProfile = {
      deviceScaleFactor: 1,
      engine: { name: "chromium", version: browser.version() },
      css: await page.evaluate(() => ({
        borderShape: CSS.supports("border-shape", "polygon(0 0, 100% 0, 100% 100%)"),
        cornerShape: CSS.supports("corner-shape", "bevel"),
      })),
      media: await page.evaluate(() => ({
        hover: matchMedia("(hover: hover)").matches ? "hover" : "none",
        pointer: matchMedia("(pointer: fine)").matches
          ? "fine"
          : matchMedia("(pointer: coarse)").matches ? "coarse" : "none",
      })),
      strategy: "polycss-gallery-chromium@0",
    };
    const selected = options.ids ?? presets.map((preset) => preset.id);
    const known = new Set(presets.map((preset) => preset.id));
    for (const id of selected) requireCondition(known.has(id), `Unknown selected Gallery preset ${id}.`);

    if (!options.captureOnly) {
      stagingRoot = await mkdtemp(join(output.outputParent, ".domformat-build-"));
    }
    const entries = [];
    const captureSummary = [];
    let maxDocumentBytes = 0;
    let maxResourceBytes = 0;
    for (const [index, id] of selected.entries()) {
      process.stdout.write(`[${index + 1}/${selected.length}] ${id}\n`);
      const requestStart = started.galleryRequests.length;
      const capture = await page.evaluate((presetId) => window.galleryDomformat.capturePreset(presetId), id);
      const consumedSourcePaths = started.galleryRequests.slice(requestStart);
      requireCondition(browserErrors.length === 0, `${id} raised browser errors: ${browserErrors.join(" | ")}`);
      captureSummary.push({
        id,
        nodes: capture.nodes.length,
        leaves: capture.visualLeafNodes.length,
        images: capture.images.length,
        frames: capture.frames.length,
        clip: capture.clip?.name,
        tags: [...new Set(capture.nodes.map((node) => node.name))].sort(),
        styleProperties: [...new Set(capture.nodes.flatMap((node) => Object.keys(node.styles)))].sort(),
        unsupportedInlineStyles: capture.unsupportedInlineStyles,
      });
      if (options.captureOnly) continue;
      const { built, source, sourceArtifacts, playback } = await buildCapture(capture, consumedSourcePaths);
      requireCondition(built.bytes.length <= MAX_DOCUMENT_BYTES, `${capture.id} document exceeds the ${MAX_DOCUMENT_BYTES}-byte corpus budget.`);
      maxDocumentBytes = Math.max(maxDocumentBytes, built.bytes.length);
      for (const [path, bytes] of built.externalResources) {
        requireCondition(bytes.length <= MAX_RESOURCE_BYTES, `${capture.id} resource ${path} exceeds the ${MAX_RESOURCE_BYTES}-byte corpus budget.`);
        maxResourceBytes = Math.max(maxResourceBytes, bytes.length);
      }
      const documentPath = join(stagingRoot, "models", `${capture.id}.json`);
      await writeOnce(documentPath, built.bytes);
      for (const [path, bytes] of built.externalResources) await writeOnce(join(stagingRoot, "models", path), bytes);
      const readBack = await readDomFile(documentPath);
      requireCondition(readBack.externalMissing.length === 0, `${capture.id} has missing generated resources.`);
      entries.push(catalogEntry(capture, built, source, sourceArtifacts, playback));
    }
    if (options.captureOnly) {
      process.stdout.write(`${JSON.stringify(captureSummary, null, 2)}\n`);
      return;
    }
    const totals = entries.reduce((value, entry) => ({
      documents: value.documents + entry.canonical.byteLength,
      external: value.external + entry.canonical.externalByteLength,
      leaves: value.leaves + entry.canonical.visualLeaves,
    }), { documents: 0, external: 0, leaves: 0 });
    requireCondition(totals.documents <= MAX_TOTAL_DOCUMENT_BYTES, `Gallery documents exceed the ${MAX_TOTAL_DOCUMENT_BYTES}-byte corpus budget.`);
    requireCondition(totals.external <= MAX_TOTAL_EXTERNAL_BYTES, `Gallery external resources exceed the ${MAX_TOTAL_EXTERNAL_BYTES}-byte referenced corpus budget.`);
    const catalog = {
      schema: "polycss-gallery-domformat@0",
      format: "domformat@0",
      profile: "polycss-3d@0",
      capture: captureProfile,
      presentation: { width: 640, height: 640, renderer: "gallery-vanilla-chromium" },
      models: entries,
    };
    await writeFile(join(stagingRoot, "catalog.json"), canonicalBytes(catalog));
    const expectedComplete = options.ids === null;
    if (expectedComplete) requireCondition(entries.length === presets.length, "Generated Gallery catalog is incomplete.");
    await validateOutputRoot(output.outputRoot, output.outputParent);
    await rm(output.outputRoot, { recursive: true, force: true });
    await rename(stagingRoot, output.outputRoot);
    stagingRoot = undefined;
    process.stdout.write(`${JSON.stringify({ outputRoot: output.outputRoot, models: entries.length, ...totals, maxDocumentBytes, maxResourceBytes }, null, 2)}\n`);
  } finally {
    await browser?.close();
    if (server) await new Promise((resolvePromise) => server.close(resolvePromise));
    if (stagingRoot) await rm(stagingRoot, { recursive: true, force: true });
    await rm(bundleRoot, { recursive: true, force: true });
  }
}

await main();
