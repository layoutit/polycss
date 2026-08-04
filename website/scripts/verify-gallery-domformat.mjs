import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { readDomFile } from "@layoutit/polycss-domformat";

const scriptRoot = dirname(fileURLToPath(import.meta.url));
const websiteRoot = resolve(scriptRoot, "..");
const galleryRoot = join(websiteRoot, "public/gallery");
const corpusRoot = join(websiteRoot, "public/gallery/domformat");
const catalogPath = join(corpusRoot, "catalog.json");
const generatorPath = join(scriptRoot, "generate-gallery-domformat.mjs");
const execFileAsync = promisify(execFile);
const GALLERY_WIDTH = 640;
const GALLERY_HEIGHT = 640;
const GALLERY_PERSPECTIVE = 32_000;
const PLAYBACK_TICK_RATE_HZ = 30;
const MAX_TOTAL_DOCUMENT_BYTES = 192 * 1024 * 1024;
const MAX_TOTAL_EXTERNAL_BYTES = 64 * 1024 * 1024;
const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
const MAX_RESOURCE_BYTES = 4 * 1024 * 1024;

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

function serializeCanonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(serializeCanonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${serializeCanonical(value[key])}`).join(",")}}`;
}

function canonicalBytes(value, newline = false) {
  return Buffer.from(`${serializeCanonical(canonicalize(value))}${newline ? "\n" : ""}`);
}

function exactKeys(value, expected, label) {
  requireCondition(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object.`);
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  requireCondition(JSON.stringify(actual) === JSON.stringify(sortedExpected), `${label} fields are not canonical: ${actual.join(", ")}.`);
}

function parseArguments(argv) {
  let fresh = false;
  for (const argument of argv) {
    if (argument === "--fresh") fresh = true;
    else throw new Error(`Unknown argument ${argument}.`);
  }
  return { fresh };
}

function isWithin(root, path) {
  return path === root || path.startsWith(`${root}${sep}`);
}

async function safeCorpusPath(path) {
  const resolved = resolve(corpusRoot, path);
  requireCondition(resolved === corpusRoot || resolved.startsWith(`${corpusRoot}${sep}`), `Corpus path escapes its root: ${path}.`);
  const [realCorpusRoot, realPath] = await Promise.all([realpath(corpusRoot), realpath(resolved)]);
  requireCondition(realPath === resolve(realCorpusRoot, path), `Corpus path resolves through a symlink: ${path}.`);
  return realPath;
}

function gallerySourcePath(urlValue) {
  const url = new URL(urlValue, "http://gallery.invalid");
  requireCondition(url.origin === "http://gallery.invalid" && url.pathname.startsWith("/gallery/"), `Gallery source must be local: ${urlValue}.`);
  const decoded = decodeURIComponent(url.pathname.slice("/gallery/".length));
  const resolved = resolve(galleryRoot, decoded);
  requireCondition(isWithin(galleryRoot, resolved), `Gallery source escaped its root: ${urlValue}.`);
  return relative(galleryRoot, resolved).split(sep).join("/");
}

async function safeSourceArtifactPath(path) {
  requireCondition(typeof path === "string" && path.length > 0 && !path.includes("\\"), `Source artifact path is not canonical: ${path}.`);
  const lexicalPath = resolve(galleryRoot, path);
  requireCondition(isWithin(galleryRoot, lexicalPath), `Source artifact escaped the Gallery root: ${path}.`);
  requireCondition(relative(galleryRoot, lexicalPath).split(sep).join("/") === path, `Source artifact path is not normalized: ${path}.`);
  const [realGalleryRoot, realPath] = await Promise.all([realpath(galleryRoot), realpath(lexicalPath)]);
  requireCondition(isWithin(realGalleryRoot, realPath), `Source artifact resolved outside the Gallery root: ${path}.`);
  return realPath;
}

function sourceArtifactRole(path, primaryPath, materialPath) {
  if (path === primaryPath) return "primary";
  if (path === materialPath || extname(path).toLowerCase() === ".mtl") return "material";
  if (extname(path).toLowerCase() === ".bin") return "buffer";
  if (/\.(?:avif|gif|jpe?g|png|webp)$/iu.test(path)) return "texture";
  return "dependency";
}

async function galleryInventory() {
  const result = await build({
    stdin: {
      contents: `
        import { PRESETS } from "./src/components/GalleryWorkbench/presets/presetList.ts";
        export default PRESETS.map(({ id, label, kind, category, galleryBucket, attribution, url, mtlUrl }) => ({
          id, label, kind, category,
          ...(galleryBucket ? { galleryBucket } : {}),
          attribution,
          ...(url ? { url } : {}),
          ...(mtlUrl ? { mtlUrl } : {}),
        }));
      `,
      resolveDir: websiteRoot,
      sourcefile: "gallery-domformat-inventory.ts",
      loader: "ts",
    },
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    minify: true,
    treeShaking: true,
    write: false,
    logLevel: "silent",
  });
  requireCondition(result.outputFiles.length === 1, "Gallery inventory bundle was not singular.");
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString("base64")}`;
  return (await import(moduleUrl)).default;
}

async function filesBelow(root) {
  const output = [];
  const visit = async (directory) => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else {
        requireCondition(entry.isFile(), `Corpus contains a non-file entry: ${relative(root, path)}.`);
        output.push(relative(root, path).split(sep).join("/"));
      }
    }
  };
  await visit(root);
  return output;
}

async function verifyFreshCorpus() {
  const freshRoot = await mkdtemp(join(tmpdir(), "polycss-gallery-domformat-fresh-"));
  try {
    await execFileAsync(process.execPath, [generatorPath, "--output", freshRoot], {
      cwd: websiteRoot,
      maxBuffer: 4 * 1024 * 1024,
      timeout: 30 * 60 * 1000,
    });
    const [committedFiles, freshFiles] = await Promise.all([filesBelow(corpusRoot), filesBelow(freshRoot)]);
    requireCondition(sameValue(committedFiles, freshFiles), "Fresh Gallery generation changed the corpus file inventory.");
    for (const path of committedFiles) {
      const [committed, fresh] = await Promise.all([readFile(join(corpusRoot, path)), readFile(join(freshRoot, path))]);
      requireCondition(committed.equals(fresh), `Committed Gallery corpus is stale at ${path}.`);
    }
  } finally {
    await rm(freshRoot, { recursive: true, force: true });
  }
}

function sameValue(left, right) {
  return JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));
}

async function verifySourceClosure(entry, preset, document) {
  if (!preset.url) {
    exactKeys(entry.source, ["polygons"], `Catalog model ${preset.id} source`);
    requireCondition(document.meta.sourceArtifact === undefined, `${preset.id} primitive unexpectedly declares a source artifact.`);
    return;
  }

  exactKeys(entry.source, ["artifacts", "byteLength", "decodedByteLength", "digest", ...(preset.mtlUrl ? ["mtlUrl"] : []), "polygons", "status", "url"], `Catalog model ${preset.id} source`);
  requireCondition(entry.source.status === "gallery-source" && entry.source.byteLength === entry.source.decodedByteLength, `Catalog model ${preset.id} source identity is incomplete.`);
  requireCondition(entry.source.digest?.algorithm === "sha256" && /^[0-9a-f]{64}$/u.test(entry.source.digest.value), `Catalog model ${preset.id} source digest is invalid.`);
  requireCondition(Array.isArray(entry.source.artifacts) && entry.source.artifacts.length > 0, `Catalog model ${preset.id} has no source dependency closure.`);
  const primaryPath = gallerySourcePath(preset.url);
  const materialPath = preset.mtlUrl ? gallerySourcePath(preset.mtlUrl) : undefined;
  const artifactPaths = entry.source.artifacts.map((artifact) => artifact.path);
  requireCondition(sameValue(artifactPaths, [...artifactPaths].sort()), `Catalog model ${preset.id} source artifacts are not sorted.`);
  requireCondition(new Set(artifactPaths).size === artifactPaths.length, `Catalog model ${preset.id} source artifacts are duplicated.`);
  let primary;
  for (const artifact of entry.source.artifacts) {
    exactKeys(artifact, ["byteLength", "digest", "path", "role"], `Catalog model ${preset.id} source artifact ${artifact.path}`);
    requireCondition(!artifact.path.startsWith("domformat/"), `Catalog model ${preset.id} consumes its generated corpus as source.`);
    requireCondition(artifact.role === sourceArtifactRole(artifact.path, primaryPath, materialPath), `Catalog model ${preset.id} source artifact ${artifact.path} has the wrong role.`);
    requireCondition(Number.isSafeInteger(artifact.byteLength) && artifact.byteLength >= 0, `Catalog model ${preset.id} source artifact ${artifact.path} has an invalid byte length.`);
    requireCondition(artifact.digest?.algorithm === "sha256" && /^[0-9a-f]{64}$/u.test(artifact.digest.value), `Catalog model ${preset.id} source artifact ${artifact.path} has an invalid digest.`);
    const bytes = await readFile(await safeSourceArtifactPath(artifact.path));
    requireCondition(bytes.length === artifact.byteLength && sha256(bytes) === artifact.digest.value, `Catalog model ${preset.id} source artifact ${artifact.path} is stale.`);
    if (artifact.path === primaryPath) primary = artifact;
  }
  requireCondition(primary, `Catalog model ${preset.id} source closure has no primary artifact.`);
  requireCondition(!materialPath || artifactPaths.includes(materialPath), `Catalog model ${preset.id} source closure omits its material artifact.`);
  const sourceIdentity = {
    byteLength: primary.byteLength,
    decodedByteLength: primary.byteLength,
    digest: primary.digest,
    status: "gallery-source",
  };
  requireCondition(sameValue(sourceIdentity, {
    byteLength: entry.source.byteLength,
    decodedByteLength: entry.source.decodedByteLength,
    digest: entry.source.digest,
    status: entry.source.status,
  }), `Catalog model ${preset.id} primary source identity is stale.`);
  requireCondition(sameValue(document.meta.sourceArtifact, sourceIdentity), `${preset.id} wire source artifact is not bound to the current primary source.`);
}

function verifyGalleryDocumentStructure(entry, document) {
  const id = entry.id;
  const animated = Boolean(entry.canonical.clip);
  const expectedCapabilities = [
    "css-semantic-closure",
    "deterministic-json",
    "explicit-retained-tree",
    "logical-assets",
    ...(animated ? ["prepared-playback"] : []),
  ];
  requireCondition(sameValue(document.meta.capabilities, expectedCapabilities), `${id} declares noncanonical Gallery capabilities.`);
  requireCondition(sameValue(document.meta.conformance.executable, ["retained-tree", ...(animated ? ["playback"] : []), "presentation"]), `${id} declares noncanonical executable behavior.`);
  requireCondition(document.meta.conformance.declaredOnly.length === 0, `${id} has declared-only runtime behavior.`);
  requireCondition(document.meta.initialExperience === (animated ? "animation" : undefined), `${id} has the wrong initial experience.`);
  exactKeys(document.meta.counts, animated ? ["leaves", "nodes", "shapes", "sourceFrames"] : ["nodes"], `${id} metadata counts`);
  requireCondition(document.meta.counts.nodes === document.tree.nodes.length && entry.canonical.nodes === document.tree.nodes.length, `${id} node counts are stale.`);
  const visualLeaves = document.tree.nodes.filter((node) => node.classes.includes("gallery-leaf")).length;
  requireCondition(entry.canonical.visualLeaves === visualLeaves, `${id} visual leaf counts are stale.`);
  const strategies = { b: 0, i: 0, s: 0, u: 0, voxelFaces: 0 };
  for (const node of document.tree.nodes) {
    if (node.classes.includes("gallery-leaf")) {
      requireCondition(Object.hasOwn(strategies, node.name), `${id} declares unknown Gallery strategy ${node.name}.`);
      strategies[node.name] += 1;
    }
    if (node.classes.includes("gallery-voxel-face")) strategies.voxelFaces += 1;
  }
  requireCondition(sameValue(entry.canonical.strategies, strategies), `${id} strategy summary is stale.`);
  requireCondition(!document.tree.nodes.some((node) => node.id.includes("cursor") || node.classes.some((name) => name.includes("cursor"))), `${id} contains a synthetic cursor layer.`);
  requireCondition(document.tree.mount.resourceStyles === undefined, `${id} contains a synthetic mount background resource.`);

  const expectedStateIds = animated ? ["playback", "presentation"] : ["presentation"];
  const expectedInputIds = animated ? ["time.tick", "viewport.height", "viewport.width"] : ["viewport.height", "viewport.width"];
  requireCondition(sameValue(document.state.channels.map((channel) => channel.id), expectedStateIds), `${id} has fake or noncanonical state channels.`);
  requireCondition(sameValue(document.bindings.channels.map((channel) => channel.id), expectedStateIds), `${id} has fake or noncanonical binding channels.`);
  requireCondition(sameValue(document.bindings.inputs.map((input) => input.id), expectedInputIds), `${id} has fake or noncanonical runtime inputs.`);
  requireCondition(!document.state.channels.some((channel) => channel.id === "effects" || channel.id === "surface"), `${id} contains fake effects or surface state.`);
  requireCondition(!document.bindings.channels.some((channel) => channel.id === "effects" || channel.id === "surface"), `${id} contains fake effects or surface bindings.`);

  const presentationBinding = document.bindings.channels.find((channel) => channel.interpreter === "static-presentation@0");
  requireCondition(presentationBinding?.id === "presentation" && presentationBinding.state === "presentation", `${id} has no canonical presentation binding.`);
  exactKeys(presentationBinding.targets, ["camera", "host"], `${id} presentation targets`);
  requireCondition(presentationBinding.targets.host === "$host", `${id} presentation does not target its host.`);
  requireCondition(sameValue(presentationBinding.parameters, {
    fitHeight: GALLERY_HEIGHT,
    fitWidth: GALLERY_WIDTH,
    sourceHeight: GALLERY_HEIGHT,
    sourceWidth: GALLERY_WIDTH,
  }), `${id} presentation binding is not fixed at 640x640.`);
  const presentationState = document.state.channels.find((channel) => channel.id === presentationBinding.state);
  requireCondition(presentationState?.codec === "static-presentation@0", `${id} has no canonical presentation state.`);
  exactKeys(presentationState.data.packet, ["camera", "version"], `${id} presentation packet`);
  const camera = presentationState.data.packet.camera;
  requireCondition(camera.fitWidth === GALLERY_WIDTH && camera.sourceWidth === GALLERY_WIDTH && camera.fitHeight === GALLERY_HEIGHT && camera.sourceHeight === GALLERY_HEIGHT, `${id} presentation state is not fixed at 640x640.`);
  requireCondition(camera.perspective === GALLERY_PERSPECTIVE, `${id} does not use the Gallery default perspective.`);
  const cameraNode = document.tree.nodes.find((node) => node.id === presentationBinding.targets.camera);
  requireCondition(cameraNode?.styles.perspective === `${GALLERY_PERSPECTIVE}px`, `${id} camera node does not retain the Gallery default perspective.`);

  if (animated) {
    exactKeys(entry.canonical.clip, ["duration", "index", "name", "tickRateHz", "timelineTicks"], `${id} animation clip`);
    requireCondition(entry.canonical.clip.duration > 0 && entry.canonical.clip.tickRateHz === PLAYBACK_TICK_RATE_HZ, `${id} animation clip does not use the 30 Hz Gallery timeline.`);
    requireCondition(Number.isSafeInteger(entry.canonical.clip.timelineTicks) && entry.canonical.clip.timelineTicks > 0, `${id} animation clip has an invalid timeline length.`);
    requireCondition(entry.canonical.sourceFrames === entry.canonical.clip.timelineTicks, `${id} animation frame summary is stale.`);
    requireCondition(document.meta.counts.sourceFrames === entry.canonical.sourceFrames && document.meta.counts.shapes === entry.canonical.visualLeaves && document.meta.counts.leaves === 0, `${id} animation counts are stale.`);
    const playbackState = document.state.channels.find((channel) => channel.id === "playback");
    const playbackBinding = document.bindings.channels.find((channel) => channel.id === "playback");
    requireCondition(playbackState?.codec === "polycss-playback-packed@0" && playbackBinding?.interpreter === "polycss-playback@0", `${id} has no canonical playback channel.`);
    requireCondition(playbackBinding.parameters.tickRateHz === PLAYBACK_TICK_RATE_HZ && playbackBinding.parameters.frameCount === entry.canonical.sourceFrames, `${id} playback binding has stale timing.`);
    requireCondition(playbackBinding.parameters.baseSceneTransform === camera.baseSceneTransform, `${id} playback and presentation disagree on the base scene transform.`);
    requireCondition(playbackState.data.packet.timeline.loopTicks === entry.canonical.clip.timelineTicks && playbackState.data.packet.timeline.frames.length === entry.canonical.clip.timelineTicks, `${id} playback timeline is stale.`);
  } else {
    requireCondition(!Object.hasOwn(entry.canonical, "sourceFrames"), `${id} static model has a fabricated source-frame summary.`);
  }

  const stylesheets = document.resources.resources.filter((record) => record.kind === "stylesheet");
  requireCondition(stylesheets.length === 1 && stylesheets[0].id === "gallery-css", `${id} does not have exactly one Gallery stylesheet.`);
  requireCondition(document.resources.resources.every((record) => record.kind === "stylesheet" || record.kind === "image"), `${id} contains a fake runtime resource.`);
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const [catalogBytes, presets] = await Promise.all([readFile(catalogPath), galleryInventory()]);
  const catalog = JSON.parse(catalogBytes);
  requireCondition(catalogBytes.equals(canonicalBytes(catalog, true)), "Gallery domformat catalog is not canonical deterministic JSON.");
  exactKeys(catalog, ["capture", "format", "models", "presentation", "profile", "schema"], "Gallery domformat catalog");
  requireCondition(catalog.schema === "polycss-gallery-domformat@0", "Gallery domformat catalog schema is wrong.");
  requireCondition(catalog.format === "domformat@0" && catalog.profile === "polycss-3d@0", "Gallery domformat catalog format/profile is wrong.");
  exactKeys(catalog.capture, ["css", "deviceScaleFactor", "engine", "media", "strategy"], "Gallery domformat capture profile");
  exactKeys(catalog.capture.engine, ["name", "version"], "Gallery domformat capture engine");
  exactKeys(catalog.capture.css, ["borderShape", "cornerShape"], "Gallery domformat capture CSS features");
  exactKeys(catalog.capture.media, ["hover", "pointer"], "Gallery domformat capture media features");
  requireCondition(catalog.capture.strategy === "polycss-gallery-chromium@0" && catalog.capture.engine.name === "chromium", "Gallery domformat corpus is not bound to the Chromium Gallery strategy.");
  requireCondition(typeof catalog.capture.engine.version === "string" && /^\d+(?:\.\d+){3}$/u.test(catalog.capture.engine.version), "Gallery domformat capture engine version is invalid.");
  requireCondition(catalog.capture.deviceScaleFactor === 1 && Object.values(catalog.capture.css).every((value) => typeof value === "boolean"), "Gallery domformat capture CSS fingerprint is invalid.");
  requireCondition(["hover", "none"].includes(catalog.capture.media.hover) && ["fine", "coarse", "none"].includes(catalog.capture.media.pointer), "Gallery domformat capture media fingerprint is invalid.");
  requireCondition(sameValue(catalog.presentation, { width: GALLERY_WIDTH, height: GALLERY_HEIGHT, renderer: "gallery-vanilla-chromium" }), "Gallery domformat presentation is not the fixed Chromium Gallery presentation.");
  requireCondition(Array.isArray(catalog.models) && catalog.models.length === presets.length, `Gallery domformat catalog has ${catalog.models?.length ?? "no"} models; expected ${presets.length}.`);
  requireCondition(new Set(presets.map((preset) => preset.id)).size === presets.length, "Gallery preset inventory contains duplicate ids.");
  requireCondition(new Set(catalog.models.map((model) => model.id)).size === catalog.models.length, "Gallery domformat catalog contains duplicate ids.");

  const expectedFiles = new Set(["catalog.json"]);
  let documentBytesTotal = 0;
  let externalBytesTotal = 0;
  let visualLeavesTotal = 0;
  let maxDocumentBytes = 0;
  let maxResourceBytes = 0;
  for (const [index, preset] of presets.entries()) {
    const entry = catalog.models[index];
    exactKeys(entry, ["attribution", "canonical", "category", "document", ...(preset.galleryBucket ? ["galleryBucket"] : []), "id", "kind", "label", "source"], `Catalog model ${preset.id}`);
    requireCondition(entry.id === preset.id && entry.label === preset.label && entry.kind === preset.kind && entry.category === preset.category, `Catalog model ${preset.id} does not match the Gallery preset.`);
    requireCondition(entry.galleryBucket === preset.galleryBucket, `Catalog model ${preset.id} has the wrong Gallery bucket.`);
    requireCondition(sameValue(entry.attribution, preset.attribution), `Catalog model ${preset.id} has stale attribution.`);
    requireCondition(entry.document === `models/${preset.id}.json`, `Catalog model ${preset.id} has a noncanonical document path.`);
    requireCondition(entry.source.url === preset.url && entry.source.mtlUrl === preset.mtlUrl, `Catalog model ${preset.id} has stale source paths.`);
    requireCondition(Number.isSafeInteger(entry.source.polygons) && entry.source.polygons > 0, `Catalog model ${preset.id} has no source polygon count.`);

    exactKeys(entry.canonical, ["byteLength", ...(entry.canonical.clip ? ["clip", "sourceFrames"] : []), "digest", "externalByteLength", "nodes", "renderedPolygons", "resources", "strategies", "visualLeaves", "warnings"], `Catalog model ${preset.id} canonical summary`);
    exactKeys(entry.canonical.strategies, ["b", "i", "s", "u", "voxelFaces"], `Catalog model ${preset.id} strategy summary`);
    requireCondition(Object.values(entry.canonical.strategies).every((value) => Number.isSafeInteger(value) && value >= 0), `Catalog model ${preset.id} has invalid strategy counts.`);
    requireCondition(entry.canonical.strategies.b + entry.canonical.strategies.i + entry.canonical.strategies.s + entry.canonical.strategies.u === entry.canonical.visualLeaves, `Catalog model ${preset.id} strategy counts do not cover every visual leaf.`);
    const documentPath = await safeCorpusPath(entry.document);
    const bytes = await readFile(documentPath);
    requireCondition(bytes.equals(canonicalBytes(JSON.parse(bytes))), `${preset.id} is not canonical deterministic JSON.`);
    requireCondition(entry.canonical.byteLength === bytes.length, `${preset.id} document byte length is stale.`);
    requireCondition(entry.canonical.digest?.algorithm === "sha256" && entry.canonical.digest.value === sha256(bytes), `${preset.id} document digest is stale.`);
    requireCondition(bytes.length <= MAX_DOCUMENT_BYTES, `${preset.id} exceeds the ${MAX_DOCUMENT_BYTES}-byte document budget.`);
    maxDocumentBytes = Math.max(maxDocumentBytes, bytes.length);
    const read = await readDomFile(documentPath);
    requireCondition(read.externalMissing.length === 0, `${preset.id} has missing external resources.`);
    const document = read.document;
    requireCondition(document.meta.format === "domformat@0" && document.meta.profile === "polycss-3d@0", `${preset.id} document format/profile is wrong.`);
    requireCondition(document.meta.title === preset.label, `${preset.id} document title is stale.`);
    requireCondition(document.meta.generator.name === "domformat" && document.meta.generator.version === "0.0.0", `${preset.id} document generator identity is wrong.`);
    await verifySourceClosure(entry, preset, document);
    verifyGalleryDocumentStructure(entry, document);
    requireCondition(entry.canonical.renderedPolygons > 0 && Number.isSafeInteger(entry.canonical.renderedPolygons), `${preset.id} rendered polygon count is invalid.`);
    requireCondition(Array.isArray(entry.canonical.warnings), `${preset.id} warnings are not an array.`);
    requireCondition(document.resources.resources.length === entry.canonical.resources, `${preset.id} resource count is stale.`);
    let externalBytes = 0;
    for (const record of document.resources.resources) {
      requireCondition(record.storage === undefined && record.inline === undefined, `${preset.id} embeds a resource.`);
      const expectedPattern = record.kind === "stylesheet"
        ? /^styles\/[0-9a-f]{64}\.css$/u
        : /^assets\/[0-9a-f]{64}\.(?:png|webp)$/u;
      requireCondition(expectedPattern.test(record.path), `${preset.id} has a noncanonical sibling resource path ${record.path}.`);
      requireCondition(record.path.includes(record.digest.value), `${preset.id} resource ${record.id} path is not content-addressed.`);
      requireCondition(record.byteLength <= MAX_RESOURCE_BYTES, `${preset.id} resource ${record.id} exceeds the ${MAX_RESOURCE_BYTES}-byte resource budget.`);
      maxResourceBytes = Math.max(maxResourceBytes, record.byteLength);
      const corpusPath = `models/${record.path}`;
      expectedFiles.add(corpusPath);
      externalBytes += record.byteLength;
    }
    requireCondition(entry.canonical.externalByteLength === externalBytes, `${preset.id} external byte length is stale.`);
    expectedFiles.add(entry.document);
    documentBytesTotal += bytes.length;
    externalBytesTotal += externalBytes;
    visualLeavesTotal += entry.canonical.visualLeaves;
  }

  const files = await filesBelow(corpusRoot);
  for (const file of files) {
    requireCondition(!/(?:^|\/)(?:\.DS_Store|node_modules|__pycache__)(?:\/|$)|\.(?:dom|gz|map|log|tmp|zip)$/u.test(file), `Gallery domformat corpus contains a private, generated, or forbidden artifact: ${file}.`);
  }
  const actualFiles = new Set(files);
  const missing = [...expectedFiles].filter((file) => !actualFiles.has(file));
  const orphaned = [...actualFiles].filter((file) => !expectedFiles.has(file));
  requireCondition(missing.length === 0, `Gallery domformat corpus is missing: ${missing.join(", ")}.`);
  requireCondition(orphaned.length === 0, `Gallery domformat corpus has orphaned files: ${orphaned.join(", ")}.`);
  requireCondition(documentBytesTotal <= MAX_TOTAL_DOCUMENT_BYTES, `Gallery documents exceed the ${MAX_TOTAL_DOCUMENT_BYTES}-byte corpus budget.`);
  requireCondition(externalBytesTotal <= MAX_TOTAL_EXTERNAL_BYTES, `Gallery external resources exceed the ${MAX_TOTAL_EXTERNAL_BYTES}-byte referenced corpus budget.`);
  if (options.fresh) await verifyFreshCorpus();
  process.stdout.write(`${JSON.stringify({
    models: catalog.models.length,
    documents: documentBytesTotal,
    referencedExternalBytes: externalBytesTotal,
    files: files.length,
    visualLeaves: visualLeavesTotal,
    maxDocumentBytes,
    maxResourceBytes,
    ...(options.fresh ? { fresh: true } : {}),
  }, null, 2)}\n`);
}

await main();
