import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";
import sharp from "sharp";

const scriptRoot = dirname(fileURLToPath(import.meta.url));
const websiteRoot = resolve(scriptRoot, "..");
const galleryRoot = join(websiteRoot, "public/gallery");
const defaultCorpusRoot = join(galleryRoot, "domformat");
const directEntry = join(scriptRoot, "gallery-domformat-browser.ts");
const defaultModel = "glb-poly-pizza-animated-human";
const defaultFrameCount = 30;
const MAX_TRANSFORM_COMPONENT_DELTA = 0.0001;
const MAX_DIFFERING_PIXEL_RATIO = 0.01;
const MAX_MEAN_ABSOLUTE_CHANNEL_DELTA = 0.01;
const MIME_TYPES = new Map([
  [".bin", "application/octet-stream"], [".css", "text/css;charset=utf-8"],
  [".glb", "model/gltf-binary"], [".gltf", "model/gltf+json"],
  [".jpg", "image/jpeg"], [".jpeg", "image/jpeg"],
  [".js", "text/javascript;charset=utf-8"], [".json", "application/json;charset=utf-8"],
  [".mtl", "text/plain;charset=utf-8"], [".obj", "text/plain;charset=utf-8"],
  [".png", "image/png"], [".stl", "application/octet-stream"],
  [".vox", "application/octet-stream"], [".webp", "image/webp"],
]);

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function matrixComponents(value) {
  const match = /^matrix3d\(([^)]+)\)$/u.exec(value);
  if (!match) return null;
  const values = match[1].split(",").map(Number);
  return values.length === 16 && values.every(Number.isFinite) ? values : null;
}

function transformDelta(left, right) {
  if (left === right) return 0;
  const leftValues = matrixComponents(left);
  const rightValues = matrixComponents(right);
  if (!leftValues || !rightValues) return Number.POSITIVE_INFINITY;
  return Math.max(...leftValues.map((value, index) => Math.abs(value - rightValues[index])));
}

function parseArguments(argv) {
  const options = { corpus: defaultCorpusRoot, model: defaultModel, frames: defaultFrameCount, output: null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--corpus") options.corpus = resolve(argv[++index]);
    else if (argument === "--model") options.model = argv[++index];
    else if (argument === "--frames") options.frames = Number(argv[++index]);
    else if (argument === "--output") options.output = resolve(argv[++index]);
    else throw new Error(`Unknown argument ${argument}.`);
  }
  requireCondition(options.output, "--output is required so proof artifacts stay outside the repository by default.");
  requireCondition(/^[a-z][a-z0-9-]+$/u.test(options.model), "--model is invalid.");
  requireCondition(Number.isSafeInteger(options.frames) && options.frames > 0 && options.frames <= 300, "--frames must be between 1 and 300.");
  return options;
}

function safePath(root, pathname, prefix) {
  const decoded = decodeURIComponent(pathname.slice(prefix.length));
  const path = resolve(root, decoded);
  requireCondition(path === root || path.startsWith(`${root}${sep}`), `Request escaped ${prefix}.`);
  return path;
}

async function bundles(directory) {
  const directPath = join(directory, "direct.js");
  const canonicalPath = join(directory, "canonical.js");
  await Promise.all([
    build({ entryPoints: [directEntry], bundle: true, format: "esm", platform: "browser", target: "chrome120", outfile: directPath, logLevel: "silent" }),
    build({
      stdin: {
        contents: `
          import { mountDom, readDomBrowserUrl } from "@layoutit/polycss-domformat/browser";
          let runtime;
          const paint = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          window.mountCanonicalProof = async (id, frame = 0) => {
            runtime?.destroy();
            const host = document.querySelector("#host");
            host.replaceChildren();
            const result = await readDomBrowserUrl("/domformat/models/" + id + ".json");
            runtime = await mountDom(result, host, { animate: false, viewportWidth: 640, viewportHeight: 640 });
            if (frame > 0) runtime.seek(frame + 1);
            await paint();
            const playback = result.document.bindings.channels.find((channel) => channel.interpreter === "polycss-playback@0");
            return {
              id,
              frame,
              frameCount: playback?.parameters.frameCount ?? 1,
              baseSceneTransform: result.document.state.channels.find((channel) => channel.codec === "static-presentation@0").data.packet.camera.baseSceneTransform,
              perspective: result.document.state.channels.find((channel) => channel.codec === "static-presentation@0").data.packet.camera.perspective,
            };
          };
          window.seekCanonicalProof = async (frame) => {
            if (!runtime) throw new Error("No canonical proof model is mounted.");
            runtime.seek(frame + 1);
            await paint();
            return { frame, sourceFrame: runtime.sourceFrame };
          };
          document.documentElement.dataset.canonicalProofReady = "";
        `,
        resolveDir: websiteRoot,
        sourcefile: "canonical-gallery-proof.js",
      },
      bundle: true,
      format: "esm",
      platform: "browser",
      target: "chrome120",
      outfile: canonicalPath,
      logLevel: "silent",
    }),
  ]);
  return { direct: await readFile(directPath), canonical: await readFile(canonicalPath) };
}

async function startServer(bundleBytes, corpusRoot) {
  const page = (script) => `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;width:640px;height:640px;overflow:hidden;background:#000}#host{position:relative;width:640px;height:640px;background:#000}</style></head><body>${script === "canonical" ? '<main id="host"></main>' : ""}<script type="module" src="/${script}.js"></script></body></html>`;
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/direct" || url.pathname === "/canonical") {
        const bytes = Buffer.from(page(url.pathname.slice(1)));
        response.writeHead(200, { "content-type": "text/html;charset=utf-8", "content-length": bytes.length });
        response.end(bytes);
        return;
      }
      if (url.pathname === "/direct.js" || url.pathname === "/canonical.js") {
        const bytes = url.pathname === "/direct.js" ? bundleBytes.direct : bundleBytes.canonical;
        response.writeHead(200, { "content-type": "text/javascript;charset=utf-8", "content-length": bytes.length });
        response.end(bytes);
        return;
      }
      let path;
      if (url.pathname.startsWith("/gallery/")) path = safePath(galleryRoot, url.pathname, "/gallery/");
      else if (url.pathname.startsWith("/domformat/")) path = safePath(corpusRoot, url.pathname, "/domformat/");
      else {
        response.writeHead(404).end();
        return;
      }
      const bytes = await readFile(path);
      response.writeHead(200, { "content-type": MIME_TYPES.get(extname(path).toLowerCase()) ?? "application/octet-stream", "content-length": bytes.length, "cache-control": "no-store" });
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
  requireCondition(address && typeof address === "object", "Proof server has no address.");
  return { server, url: `http://127.0.0.1:${address.port}` };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const bundleRoot = await mkdtemp("/tmp/polycss-domformat-proof-");
  let browser;
  let server;
  try {
    const started = await startServer(await bundles(bundleRoot), options.corpus);
    server = started.server;
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 640, height: 640 }, deviceScaleFactor: 1 });
    const direct = await context.newPage();
    const canonical = await context.newPage();
    const errors = [];
    direct.on("pageerror", (error) => errors.push(`direct: ${error.message}`));
    canonical.on("pageerror", (error) => errors.push(`canonical: ${error.message}`));
    await Promise.all([
      direct.goto(`${started.url}/direct`, { waitUntil: "load" }),
      canonical.goto(`${started.url}/canonical`, { waitUntil: "load" }),
    ]);
    await Promise.all([
      direct.waitForFunction(() => document.documentElement.hasAttribute("data-gallery-domformat-ready")),
      canonical.waitForFunction(() => document.documentElement.hasAttribute("data-canonical-proof-ready")),
    ]);
    const metadata = await Promise.all([
      direct.evaluate(({ id }) => window.galleryDomformat.renderPresetForProof(id, 0), { id: options.model }),
      canonical.evaluate(({ id }) => window.mountCanonicalProof(id, 0), { id: options.model }),
    ]);
    await direct.evaluate(() => {
      const surface = document.body.firstElementChild;
      if (!(surface instanceof HTMLElement)) throw new Error("Direct Gallery proof has no mount surface.");
      const host = document.createElement("main");
      host.id = "host";
      document.body.replaceChildren(host);
      host.append(surface);
      surface.setAttribute("data-proof-boundary", "");
      const declarations = [
        ["display", "block"], ["position", "relative"], ["inset", "0"],
        ["width", "100%"], ["height", "100%"], ["max-width", "none"],
        ["margin", "0"], ["padding", "0"], ["border", "0"],
        ["box-sizing", "border-box"], ["overflow", "hidden"], ["contain", "strict"],
        ["isolation", "isolate"], ["transform", "none"], ["z-index", "auto"],
        ["opacity", "1"], ["visibility", "visible"], ["pointer-events", "auto"],
      ];
      for (const [name, value] of declarations) surface.style.setProperty(name, value, "important");
    });
    requireCondition(errors.length === 0, errors.join(" | "));
    requireCondition(
      metadata[1].perspective === metadata[0].perspective,
      `Canonical proof perspective ${metadata[1].perspective} does not match the live Gallery value ${metadata[0].perspective}.`,
    );
    requireCondition(metadata[1].frameCount === metadata[0].frameCount, "Canonical and live Gallery frame counts differ.");
    requireCondition(metadata[1].baseSceneTransform === metadata[0].baseSceneTransform, "Canonical and live Gallery base scene transforms differ.");
    requireCondition(options.frames <= metadata[0].frameCount, `Proof requests ${options.frames} frames but ${options.model} has ${metadata[0].frameCount}.`);
    const expectedDirectory = join(options.output, "direct", "frames");
    const actualDirectory = join(options.output, "canonical", "frames");
    await Promise.all([mkdir(expectedDirectory, { recursive: true }), mkdir(actualDirectory, { recursive: true })]);
    const domMismatches = [];
    const containerMismatches = [];
    const transformDiffs = [];
    const pixelDiffs = [];
    const pixelFailures = [];
    for (let frame = 0; frame < options.frames; frame += 1) {
      if (frame > 0) {
        await Promise.all([
          direct.evaluate((value) => window.galleryDomformat.seekRetainedPreset(value), frame),
          canonical.evaluate((value) => window.seekCanonicalProof(value), frame),
        ]);
      }
      requireCondition(errors.length === 0, errors.join(" | "));
      const visualState = (selector) => [...document.querySelectorAll(selector)].map((element) => {
        const computed = getComputedStyle(element);
        return {
          name: element.localName,
          display: computed.display,
          position: computed.position,
          inlineTransform: element.style.transform,
          transformKind: computed.transform === "none"
            ? "none"
            : computed.transform.startsWith("matrix3d(") ? "matrix3d" : "matrix",
          transformOrigin: computed.transformOrigin,
          transformStyle: computed.transformStyle,
          backfaceVisibility: computed.backfaceVisibility,
          visibility: computed.visibility,
          opacity: computed.opacity,
          color: computed.color,
          width: computed.width,
          height: computed.height,
          boxSizing: computed.boxSizing,
          top: computed.top,
          right: computed.right,
          bottom: computed.bottom,
          left: computed.left,
          margin: computed.margin,
          padding: computed.padding,
          border: computed.border,
          borderTopWidth: computed.borderTopWidth,
          borderRightWidth: computed.borderRightWidth,
          borderBottomWidth: computed.borderBottomWidth,
          borderLeftWidth: computed.borderLeftWidth,
          borderTopStyle: computed.borderTopStyle,
          borderRightStyle: computed.borderRightStyle,
          borderBottomStyle: computed.borderBottomStyle,
          borderLeftStyle: computed.borderLeftStyle,
          borderTopColor: computed.borderTopColor,
          borderRightColor: computed.borderRightColor,
          borderBottomColor: computed.borderBottomColor,
          borderLeftColor: computed.borderLeftColor,
          backgroundColor: computed.backgroundColor,
          backgroundImage: computed.backgroundImage.replace(/url\([^)]*\)/gu, "url(<resource>)"),
          backgroundPosition: computed.backgroundPosition,
          backgroundRepeat: computed.backgroundRepeat,
          backgroundSize: computed.backgroundSize,
          backgroundBlendMode: computed.backgroundBlendMode,
          imageRendering: computed.imageRendering,
          lineHeight: computed.lineHeight,
          font: computed.font,
          pointerEvents: computed.pointerEvents,
          borderShape: computed.getPropertyValue("border-shape"),
          cornerTopLeftShape: computed.getPropertyValue("corner-top-left-shape"),
          cornerTopRightShape: computed.getPropertyValue("corner-top-right-shape"),
          cornerBottomRightShape: computed.getPropertyValue("corner-bottom-right-shape"),
          cornerBottomLeftShape: computed.getPropertyValue("corner-bottom-left-shape"),
          borderTopLeftRadius: computed.borderTopLeftRadius,
          borderTopRightRadius: computed.borderTopRightRadius,
          borderBottomRightRadius: computed.borderBottomRightRadius,
          borderBottomLeftRadius: computed.borderBottomLeftRadius,
        };
      });
      const [directState, canonicalState] = await Promise.all([
        direct.evaluate(visualState, ".polycss-camera b,.polycss-camera i,.polycss-camera s,.polycss-camera u"),
        canonical.evaluate(visualState, ".gallery-camera .gallery-leaf"),
      ]);
      requireCondition(directState.length === canonicalState.length, `Frame ${frame} DOM leaf counts differ.`);
      for (let index = 0; index < directState.length; index += 1) {
        const { inlineTransform: directTransform, ...directPaint } = directState[index];
        const { inlineTransform: canonicalTransform, ...canonicalPaint } = canonicalState[index];
        const delta = transformDelta(directTransform, canonicalTransform);
        if (delta > 0 && Number.isFinite(delta) && transformDiffs.length < 100) transformDiffs.push({ frame, index, maxComponentDelta: delta });
        if (JSON.stringify(directPaint) !== JSON.stringify(canonicalPaint) || delta > MAX_TRANSFORM_COMPONENT_DELTA) {
          domMismatches.push({ frame, index, direct: directState[index], canonical: canonicalState[index] });
          if (domMismatches.length >= 20) break;
        }
      }
      const containerState = (selector) => [...document.querySelectorAll(selector)].map((element) => {
        const computed = getComputedStyle(element);
        return {
          role: [...element.classList].find((name) => /(?:camera|scene|mesh|bucket|voxel-face)$/u.test(name))?.replace(/^(?:polycss|gallery)-/u, "") ?? "boundary",
          inlineTransform: element.style.transform,
          display: computed.display,
          position: computed.position,
          transformOrigin: computed.transformOrigin,
          transformStyle: computed.transformStyle,
          perspective: computed.perspective,
          perspectiveOrigin: computed.perspectiveOrigin,
          width: computed.width,
          height: computed.height,
          top: computed.top,
          right: computed.right,
          bottom: computed.bottom,
          left: computed.left,
          boxSizing: computed.boxSizing,
          contain: computed.contain,
          isolation: computed.isolation,
          overflow: computed.overflow,
          willChange: computed.willChange,
          zIndex: computed.zIndex,
          opacity: computed.opacity,
          visibility: computed.visibility,
          pointerEvents: computed.pointerEvents,
        };
      });
      const [directContainers, canonicalContainers] = await Promise.all([
        direct.evaluate(containerState, "[data-proof-boundary],.polycss-camera,.polycss-scene,.polycss-mesh,.polycss-bucket,.polycss-voxel-face"),
        canonical.evaluate(containerState, "[data-domformat-mount-surface],.gallery-camera,.gallery-scene,.gallery-mesh,.gallery-bucket,.gallery-voxel-face"),
      ]);
      requireCondition(directContainers.length === canonicalContainers.length, `Frame ${frame} DOM container counts differ.`);
      for (let index = 0; index < directContainers.length; index += 1) {
        if (JSON.stringify(directContainers[index]) !== JSON.stringify(canonicalContainers[index])) {
          containerMismatches.push({ frame, index, direct: directContainers[index], canonical: canonicalContainers[index] });
          if (containerMismatches.length >= 20) break;
        }
      }
      const name = `frame_${String(frame).padStart(4, "0")}.png`;
      const directPath = join(expectedDirectory, name);
      const canonicalPath = join(actualDirectory, name);
      await Promise.all([
        direct.locator("#host").screenshot({ path: directPath }),
        canonical.locator("#host").screenshot({ path: canonicalPath }),
      ]);
      const [directPixels, canonicalPixels] = await Promise.all([
        sharp(await readFile(directPath)).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
        sharp(await readFile(canonicalPath)).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
      ]);
      requireCondition(
        directPixels.info.width === canonicalPixels.info.width
          && directPixels.info.height === canonicalPixels.info.height
          && directPixels.info.channels === canonicalPixels.info.channels,
        `Frame ${frame} proof images have different geometry.`,
      );
      let differentPixels = 0;
      let maximumChannelDelta = 0;
      let absoluteChannelDelta = 0;
      for (let offset = 0; offset < directPixels.data.length; offset += 4) {
        let different = false;
        for (let channel = 0; channel < 4; channel += 1) {
          const delta = Math.abs(directPixels.data[offset + channel] - canonicalPixels.data[offset + channel]);
          if (delta !== 0) different = true;
          maximumChannelDelta = Math.max(maximumChannelDelta, delta);
          absoluteChannelDelta += delta;
        }
        if (different) differentPixels += 1;
      }
      if (differentPixels > 0) {
        const diff = {
          frame,
          differentPixels,
          differentPixelRatio: differentPixels / (directPixels.info.width * directPixels.info.height),
          maximumChannelDelta,
          meanAbsoluteChannelDelta: absoluteChannelDelta / directPixels.data.length,
        };
        pixelDiffs.push(diff);
        if (diff.differentPixelRatio > MAX_DIFFERING_PIXEL_RATIO
          || diff.meanAbsoluteChannelDelta > MAX_MEAN_ABSOLUTE_CHANNEL_DELTA) {
          pixelFailures.push(diff);
        }
      }
      process.stdout.write(`[${frame + 1}/${options.frames}] ${name}\n`);
    }
    requireCondition(domMismatches.length === 0, `Canonical DOM state diverged from the live Gallery: ${JSON.stringify(domMismatches)}`);
    requireCondition(containerMismatches.length === 0, `Canonical DOM containers diverged from the live Gallery: ${JSON.stringify(containerMismatches)}`);
    requireCondition(pixelFailures.length === 0, `Canonical pixels exceeded the calibrated Chromium compositor bound: ${JSON.stringify(pixelFailures)}`);
    process.stdout.write(`${JSON.stringify({ model: options.model, frames: options.frames, output: options.output, direct: metadata[0], canonical: metadata[1], domMismatches, containerMismatches, transformDiffs, pixelDiffs, pixelFailures, tolerance: { maxTransformComponentDelta: MAX_TRANSFORM_COMPONENT_DELTA, maxDifferingPixelRatio: MAX_DIFFERING_PIXEL_RATIO, maxMeanAbsoluteChannelDelta: MAX_MEAN_ABSOLUTE_CHANNEL_DELTA } }, null, 2)}\n`);
  } finally {
    await browser?.close();
    if (server) await new Promise((resolvePromise) => server.close(resolvePromise));
    await rm(bundleRoot, { recursive: true, force: true });
  }
}

await main();
