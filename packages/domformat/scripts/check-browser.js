import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";
import { buildDom } from "../src/writer.js";
import { invariant } from "../src/errors.js";
import { crc32 } from "../src/crc32.js";
import { loadManifest } from "../src/manifest.js";

const execFileAsync = promisify(execFile);
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const temporary = await mkdtemp(join(tmpdir(), "domformat-browser-release-"));
let server;

function contentType(path) {
  if (path.endsWith(".html")) return "text/html;charset=utf-8";
  if (path.endsWith(".js")) return "text/javascript;charset=utf-8";
  if (path.endsWith(".json")) return "application/json;charset=utf-8";
  if (path.endsWith(".css")) return "text/css;charset=utf-8";
  if (path.endsWith(".png")) return "image/png";
  return "application/octet-stream";
}

async function availableBrowser() {
  const candidates = [
    process.env.DOMFORMAT_BROWSER,
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {}
  }
  invariant(false, "MISSING_RELEASE_BROWSER", "A Chromium-family browser is required for the real-browser release gate. Set DOMFORMAT_BROWSER to its executable path.");
}

function serve(explicitFiles, requestPaths, runtimeRoot) {
  return createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, "http://127.0.0.1").pathname);
      requestPaths.push(pathname);
      const explicit = explicitFiles.get(pathname);
      const sourceRoot = pathname.startsWith("/src/") ? runtimeRoot : root;
      const target = explicit ?? resolve(sourceRoot, `.${pathname}`);
      invariant(explicit !== undefined || target.startsWith(`${sourceRoot}${sep}`), "UNSAFE_TEST_PATH", "Browser smoke request escaped its fixture root.");
      const bytes = await readFile(target);
      response.writeHead(200, {
        "cache-control": "no-store",
        "content-length": bytes.length,
        "content-type": contentType(target),
      });
      response.end(bytes);
    } catch {
      response.writeHead(404, { "content-type": "text/plain;charset=utf-8" });
      response.end("missing");
    }
  });
}

function chromeArguments(profile, dimensions = {}) {
  const width = dimensions.width ?? 320;
  const height = dimensions.height ?? 240;
  return [
    "--headless=new",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-default-apps",
    "--disable-extensions",
    "--disable-sync",
    "--hide-scrollbars",
    "--metrics-recording-only",
    "--no-default-browser-check",
    "--no-first-run",
    `--window-size=${width},${height}`,
    `--user-data-dir=${profile}`,
    ...(typeof process.getuid === "function" && process.getuid() === 0 ? ["--no-sandbox"] : []),
    "--virtual-time-budget=5000",
  ];
}

function uint32Be(bytes, offset) {
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, false);
}

function paeth(left, up, upperLeft) {
  const estimate = left + up - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const upDistance = Math.abs(estimate - up);
  const upperLeftDistance = Math.abs(estimate - upperLeft);
  if (leftDistance <= upDistance && leftDistance <= upperLeftDistance) return left;
  return upDistance <= upperLeftDistance ? up : upperLeft;
}

function decodeScreenshot(png, expectedWidth = 320, expectedHeight = 240) {
  const signature = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);
  invariant(png.length > 8 && png.subarray(0, 8).equals(signature), "BROWSER_RELEASE_PAINT", "Browser screenshot is not PNG.");
  let offset = 8;
  let header;
  let ended = false;
  const imageData = [];
  while (offset < png.length) {
    invariant(offset + 12 <= png.length, "BROWSER_RELEASE_PAINT", "Browser screenshot has a truncated PNG chunk.");
    const length = uint32Be(png, offset);
    const type = png.toString("ascii", offset + 4, offset + 8);
    const payloadStart = offset + 8;
    const payloadEnd = payloadStart + length;
    invariant(payloadEnd + 4 <= png.length, "BROWSER_RELEASE_PAINT", "Browser screenshot PNG chunk exceeds its bytes.");
    invariant(crc32(png.subarray(offset + 4, payloadEnd)) === uint32Be(png, payloadEnd), "BROWSER_RELEASE_PAINT", "Browser screenshot PNG CRC is invalid.");
    if (type === "IHDR") {
      invariant(!header && length === 13, "BROWSER_RELEASE_PAINT", "Browser screenshot PNG header is invalid.");
      header = {
        width: uint32Be(png, payloadStart),
        height: uint32Be(png, payloadStart + 4),
        bitDepth: png[payloadStart + 8],
        colorType: png[payloadStart + 9],
        compression: png[payloadStart + 10],
        filter: png[payloadStart + 11],
        interlace: png[payloadStart + 12],
      };
    } else if (type === "IDAT") {
      imageData.push(png.subarray(payloadStart, payloadEnd));
    } else if (type === "IEND") {
      invariant(length === 0 && payloadEnd + 4 === png.length, "BROWSER_RELEASE_PAINT", "Browser screenshot PNG end chunk is invalid.");
      ended = true;
    }
    offset = payloadEnd + 4;
  }
  invariant(header && ended && imageData.length > 0, "BROWSER_RELEASE_PAINT", "Browser screenshot PNG is incomplete.");
  invariant(header.width === expectedWidth && header.height === expectedHeight && header.bitDepth === 8
    && (header.colorType === 2 || header.colorType === 6)
    && header.compression === 0 && header.filter === 0 && header.interlace === 0,
  "BROWSER_RELEASE_PAINT", "Browser screenshot PNG has an unexpected raster format.");
  const bytesPerPixel = header.colorType === 6 ? 4 : 3;
  const stride = header.width * bytesPerPixel;
  const compressed = Buffer.concat(imageData.map((value) => Buffer.from(value)));
  const filtered = inflateSync(compressed);
  invariant(filtered.length === (stride + 1) * header.height, "BROWSER_RELEASE_PAINT", "Browser screenshot PNG raster length is invalid.");
  const pixels = new Uint8Array(stride * header.height);
  for (let y = 0; y < header.height; y += 1) {
    const filterType = filtered[y * (stride + 1)];
    invariant(filterType >= 0 && filterType <= 4, "BROWSER_RELEASE_PAINT", "Browser screenshot PNG uses an unknown row filter.");
    for (let x = 0; x < stride; x += 1) {
      const raw = filtered[y * (stride + 1) + x + 1];
      const left = x >= bytesPerPixel ? pixels[y * stride + x - bytesPerPixel] : 0;
      const up = y > 0 ? pixels[(y - 1) * stride + x] : 0;
      const upperLeft = y > 0 && x >= bytesPerPixel ? pixels[(y - 1) * stride + x - bytesPerPixel] : 0;
      const predictor = filterType === 0 ? 0
        : filterType === 1 ? left
          : filterType === 2 ? up
            : filterType === 3 ? Math.floor((left + up) / 2)
              : paeth(left, up, upperLeft);
      pixels[y * stride + x] = (raw + predictor) & 0xff;
    }
  }
  return { ...header, bytesPerPixel, pixels };
}

function sideBySideEvidence(png, label) {
  const decoded = decodeScreenshot(png, 640, 240);
  let modelPixelDifferences = 0;
  let maximumChannelDelta = 0;
  const colors = new Map();
  let minimumLuma = 255;
  let maximumLuma = 0;
  let samples = 0;
  for (let y = 48; y < 192; y += 1) {
    for (let x = 64; x < 256; x += 1) {
      const referenceOffset = (y * decoded.width + x) * decoded.bytesPerPixel;
      const independentOffset = (y * decoded.width + x + 320) * decoded.bytesPerPixel;
      let different = false;
      for (let channel = 0; channel < decoded.bytesPerPixel; channel += 1) {
        const delta = Math.abs(decoded.pixels[referenceOffset + channel] - decoded.pixels[independentOffset + channel]);
        maximumChannelDelta = Math.max(maximumChannelDelta, delta);
        if (delta !== 0) different = true;
      }
      if (different) modelPixelDifferences += 1;
      const red = decoded.pixels[referenceOffset];
      const green = decoded.pixels[referenceOffset + 1];
      const blue = decoded.pixels[referenceOffset + 2];
      const color = `${red},${green},${blue}`;
      colors.set(color, (colors.get(color) ?? 0) + 1);
      const luma = Math.round((red * 54 + green * 183 + blue * 19) / 256);
      minimumLuma = Math.min(minimumLuma, luma);
      maximumLuma = Math.max(maximumLuma, luma);
      samples += 1;
    }
  }
  invariant(modelPixelDifferences === 0, "BROWSER_RELEASE_PAINT", `${label} differs in ${modelPixelDifferences} central model pixels.`);
  const populations = [...colors.values()].sort((left, right) => right - left);
  const secondaryCoverage = (populations[1] ?? 0) / samples;
  invariant(colors.size >= 2 && maximumLuma - minimumLuma >= 2 && secondaryCoverage >= 0.2, "BROWSER_RELEASE_PAINT", `Side-by-side model paint is uniform (${colors.size} colors; luma range ${maximumLuma - minimumLuma}; secondary coverage ${secondaryCoverage.toFixed(3)}).`);
  return Object.freeze({
    distinctColors: colors.size,
    lumaRange: maximumLuma - minimumLuma,
    secondaryCoverage,
    modelPixelDifferences,
    maximumChannelDelta,
  });
}

async function dumpedMount(browser, url, profile, label, nodes, leaves) {
  let result = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      result = await execFileAsync(browser, [...chromeArguments(`${profile}-attempt-${attempt + 1}`), "--dump-dom", url], {
        maxBuffer: 16 * 1024 * 1024,
        timeout: 20_000,
        killSignal: "SIGKILL",
      });
    } catch (error) {
      const stdout = typeof error?.stdout === "string" ? error.stdout : "";
      if (error?.killed && error.signal === "SIGKILL" && stdout.includes("data-domformat-ready")) {
        result = { stdout, stderr: error.stderr ?? "" };
      } else if (attempt === 2) throw error;
      else continue;
    }
    invariant(!result.stdout.includes("data-domformat-error"), "BROWSER_RELEASE_MOUNT", `${label} reported a package mount failure.`);
    if (/<html[^>]*data-domformat-ready=""/u.test(result.stdout)) break;
    result = null;
  }
  invariant(result, "BROWSER_RELEASE_MOUNT", `${label} did not publish the retained DOM after three isolated attempts.`);
  invariant(result.stdout.includes("data-domformat-mount-surface=\"\""), "BROWSER_RELEASE_MOUNT", `${label} lacks the isolated mount surface.`);
  invariant(result.stdout.includes(`domformat@0 · ${nodes} nodes · ${leaves} leaves`), "BROWSER_RELEASE_MOUNT", `${label} has unexpected retained-DOM counts.`);
}

async function paintedComparison(browser, url, profile, screenshot, label) {
  try {
    await execFileAsync(browser, [
      ...chromeArguments(profile, { width: 640, height: 240 }),
      `--screenshot=${screenshot}`,
      url,
    ], { maxBuffer: 4 * 1024 * 1024, timeout: 20_000, killSignal: "SIGKILL" });
  } catch (error) {
    if (!error?.killed || error.signal !== "SIGKILL") throw error;
  }
  const png = await readFile(screenshot);
  invariant(png.length > 1024, "BROWSER_RELEASE_PAINT", `${label} did not produce a substantial painted PNG proof.`);
  return Object.freeze({ ...sideBySideEvidence(png, label), pngBytes: png.length });
}

async function browserFixtureProof(browser, origin, modelUrl, slug, nodes, leaves, requestPaths) {
  const referenceUrl = `${origin}/viewer/index.html?model=${encodeURIComponent(modelUrl)}&animate=0`;
  const independentUrl = `${referenceUrl}&implementation=conformance`;
  const nVersionUrl = `${origin}/test/nversion-viewer.html?model=${encodeURIComponent(modelUrl)}&animate=0`;
  await dumpedMount(browser, referenceUrl, join(temporary, `${slug}-reference-profile`), `${slug} reference viewer`, nodes, leaves);
  await dumpedMount(browser, independentUrl, join(temporary, `${slug}-independent-profile`), `${slug} independent viewer`, nodes, leaves);
  const nVersionRequestStart = requestPaths.length;
  await dumpedMount(browser, nVersionUrl, join(temporary, `${slug}-nversion-profile`), `${slug} N-version probe/viewer`, nodes, leaves);
  const nVersionRequests = requestPaths.slice(nVersionRequestStart);
  invariant(!nVersionRequests.some((path) => path.startsWith("/src/")), "BROWSER_RELEASE_IMPORT_BOUNDARY", `${slug} N-version path requested production source: ${nVersionRequests.filter((path) => path.startsWith("/src/")).join(", ")}`);

  const independentComparison = await paintedComparison(
    browser,
    `${referenceUrl}&compare=conformance`,
    join(temporary, `${slug}-independent-comparison-profile`),
    join(temporary, `${slug}-independent-comparison-painted.png`),
    `${slug} reference/independent viewers`,
  );
  const nVersionComparison = await paintedComparison(
    browser,
    `${nVersionUrl}&compare=reference`,
    join(temporary, `${slug}-nversion-comparison-profile`),
    join(temporary, `${slug}-nversion-comparison-painted.png`),
    `${slug} reference/N-version viewers`,
  );
  return Object.freeze({
    slug,
    nodes,
    leaves,
    independentViewerPaintedDistinctColors: independentComparison.distinctColors,
    independentViewerPaintedLumaRange: independentComparison.lumaRange,
    independentViewerPaintedSecondaryCoverage: independentComparison.secondaryCoverage,
    independentViewerPaintedPngBytes: independentComparison.pngBytes,
    independentViewerModelPixelsIdentical: independentComparison.modelPixelDifferences === 0,
    independentViewerMaximumChannelDelta: independentComparison.maximumChannelDelta,
    nVersionProbePaintedDistinctColors: nVersionComparison.distinctColors,
    nVersionProbePaintedLumaRange: nVersionComparison.lumaRange,
    nVersionProbePaintedSecondaryCoverage: nVersionComparison.secondaryCoverage,
    nVersionProbePaintedPngBytes: nVersionComparison.pngBytes,
    nVersionProbeModelPixelsIdentical: nVersionComparison.modelPixelDifferences === 0,
    nVersionProbeMaximumChannelDelta: nVersionComparison.maximumChannelDelta,
  });
}

try {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const packRoot = join(temporary, "pack");
  const installRoot = join(temporary, "install");
  await Promise.all([mkdir(packRoot), mkdir(installRoot)]);
  const packRun = await execFileAsync(npm, ["pack", "--json", "--pack-destination", packRoot], { cwd: root, maxBuffer: 16 * 1024 * 1024, timeout: 60_000 });
  const reportStart = packRun.stdout.lastIndexOf("\n[");
  const packReports = JSON.parse(reportStart === -1 ? packRun.stdout : packRun.stdout.slice(reportStart + 1));
  invariant(packReports.length === 1, "BROWSER_RELEASE_PACKAGE", "Browser release npm pack returned an unexpected report.");
  const tarball = join(packRoot, packReports[0].filename);
  await execFileAsync(npm, ["install", "--prefix", installRoot, "--no-audit", "--no-fund", tarball], { maxBuffer: 16 * 1024 * 1024, timeout: 60_000 });
  const installedRuntime = join(installRoot, "node_modules", "@layoutit", "polycss-domformat");

  const input = await loadManifest(resolve(root, "fixtures/synthetic-polycss/manifest.json"));
  const built = buildDom(input);
  const modelPath = join(temporary, "synthetic.json");
  await writeFile(modelPath, built.bytes);
  for (const [relative, bytes] of built.externalResources) {
    const target = join(temporary, ...relative.split("/"));
    await mkdir(resolve(target, ".."), { recursive: true });
    await writeFile(target, bytes);
  }

  const producerPath = resolve(root, "conformance/producer.py");
  const python = process.platform === "win32" ? "python" : "python3";
  const pythonRoot = join(temporary, "independent");
  await mkdir(pythonRoot);
  const pythonModel = join(pythonRoot, "model.json");
  const producerRun = await execFileAsync(python, ["-B", producerPath, pythonModel], { maxBuffer: 4 * 1024 * 1024, timeout: 20_000 });
  const producerSummary = JSON.parse(producerRun.stdout);
  invariant(producerSummary.codecs === 5 && producerSummary.nodes === 11 && producerSummary.resources === 2, "BROWSER_RELEASE_PRODUCER", "Independent producer emitted an unexpected contract.");

  const requestPaths = [];
  server = serve(new Map([
    ["/model.json", modelPath],
    ["/model.css", join(temporary, "model.css")],
    ["/assets/checker.png", join(temporary, "assets", "checker.png")],
    ["/independent/model.json", pythonModel],
    ["/independent/independent.css", join(pythonRoot, "independent.css")],
    ["/independent/assets/independent-checker.png", join(pythonRoot, "assets", "independent-checker.png")],
  ]), requestPaths, installedRuntime);
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  invariant(address && typeof address === "object", "BROWSER_RELEASE_SERVER", "Browser release server did not bind a local port.");
  const origin = `http://127.0.0.1:${address.port}`;
  const browser = await availableBrowser();
  const proofs = [];
  proofs.push(await browserFixtureProof(browser, origin, "/model.json", "reference-writer-json", 8, 1, requestPaths));
  proofs.push(await browserFixtureProof(browser, origin, "/independent/model.json", "independent-producer-json", 11, 2, requestPaths));
  process.stdout.write(`${JSON.stringify({
    browser,
    fixtures: proofs,
    independentProducer: producerSummary,
    browserRuntime: "clean-installed npm tarball",
    independentViewerModelPixelsIdentical: proofs.every((proof) => proof.independentViewerModelPixelsIdentical),
    independentViewerMaximumChannelDelta: Math.max(...proofs.map((proof) => proof.independentViewerMaximumChannelDelta)),
    nVersionProbeModelPixelsIdentical: proofs.every((proof) => proof.nVersionProbeModelPixelsIdentical),
    nVersionProbeMaximumChannelDelta: Math.max(...proofs.map((proof) => proof.nVersionProbeMaximumChannelDelta)),
    realBrowser: true,
  }, null, 2)}\n`);
} finally {
  if (server) await new Promise((resolveClose) => server.close(resolveClose));
  await rm(temporary, { recursive: true, force: true });
}
