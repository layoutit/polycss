import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const python = process.platform === "win32" ? "python" : "python3";
const MAX_TARBALL_BYTES = 96 * 1024;
const MAX_UNPACKED_BYTES = 400 * 1024;
const ALLOWED_PACKAGE_PATHS = Object.freeze([
  "LICENSE",
  "README.md",
  "bin/domformat.js",
  "package.json",
  "src/base64.js",
  "src/browser-input.js",
  "src/browser.js",
  "src/canonical-json.js",
  "src/cli.js",
  "src/constants.js",
  "src/crc32.js",
  "src/css.js",
  "src/errors.js",
  "src/file-io.js",
  "src/hash.js",
  "src/index.js",
  "src/inspect.js",
  "src/lifecycle.js",
  "src/manifest.js",
  "src/package-files.js",
  "src/path-security.js",
  "src/reader.js",
  "src/resources.js",
  "src/retained-dom.js",
  "src/schema.js",
  "src/state/effects.js",
  "src/state/interaction.js",
  "src/state/numeric.js",
  "src/state/polycss.js",
  "src/state/triangle.js",
  "src/writer.js",
]);
const FORBIDDEN_PACKAGE_TEXT = Object.freeze([
  "/Users/",
  "/home/",
  "C:\\Users\\",
  ".local/",
]);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: 60_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
    throw new Error(`${command} ${args.join(" ")} failed${output ? `:\n${output}` : ""}`);
  }
  return result.stdout;
}

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function pack(destination) {
  const output = run(npm, ["pack", "--json", "--pack-destination", destination]);
  const jsonStart = output.lastIndexOf("\n[");
  const reports = JSON.parse(jsonStart === -1 ? output : output.slice(jsonStart + 1));
  invariant(Array.isArray(reports) && reports.length === 1, "npm pack returned an unexpected report.");
  const report = reports[0];
  invariant(report.name === "@layoutit/polycss-domformat" && report.version === "0.0.0", "npm pack returned the wrong package identity.");
  invariant(report.filename === "layoutit-polycss-domformat-0.0.0.tgz", "npm pack returned an unexpected filename.");
  invariant(Array.isArray(report.files), "npm pack omitted its file manifest.");
  invariant(report.size <= MAX_TARBALL_BYTES, `npm tarball exceeds ${MAX_TARBALL_BYTES} bytes.`);
  invariant(report.unpackedSize <= MAX_UNPACKED_BYTES, `npm package exceeds ${MAX_UNPACKED_BYTES} unpacked bytes.`);
  const paths = report.files.map((entry) => entry.path);
  const allowed = new Set(ALLOWED_PACKAGE_PATHS);
  const unexpected = paths.filter((path) => !allowed.has(path));
  const missing = ALLOWED_PACKAGE_PATHS.filter((path) => !paths.includes(path));
  invariant(unexpected.length === 0, `npm package contains non-allowlisted paths: ${unexpected.join(", ")}`);
  invariant(missing.length === 0, `npm package is missing allowlisted paths: ${missing.join(", ")}`);
  invariant(paths.length === ALLOWED_PACKAGE_PATHS.length, "npm package path count differs from the exact allowlist.");
  const forbidden = paths.filter((path) => (
    /^(?:notes|test|scripts|\.local|output)\//u.test(path)
    || /(?:^|\/)__pycache__(?:\/|$)|\.pyc$/u.test(path)
  ));
  invariant(forbidden.length === 0, `npm package contains forbidden paths: ${forbidden.join(", ")}`);
  for (const entry of report.files) {
    const sourceBytes = await readFile(resolve(root, entry.path));
    invariant(sourceBytes.byteLength === entry.size, `npm report size differs from source file ${entry.path}.`);
    const text = sourceBytes.toString("utf8");
    const marker = FORBIDDEN_PACKAGE_TEXT.find((value) => text.includes(value));
    invariant(marker === undefined, `npm package source ${entry.path} contains forbidden local/private marker ${marker}.`);
  }
  for (const required of [
    "LICENSE",
    "README.md",
    "bin/domformat.js",
    "package.json",
    "src/browser.js",
    "src/index.js",
  ]) {
    invariant(paths.includes(required), `npm package is missing ${required}.`);
  }
  const bin = report.files.find((entry) => entry.path === "bin/domformat.js");
  invariant(bin?.mode === 0o755, "The packaged CLI is not executable.");
  const tarball = join(destination, report.filename);
  const bytes = await readFile(tarball);
  invariant(bytes.byteLength === report.size, "npm tarball size does not match its report.");
  return { report, tarball, bytes, digest: sha256(bytes) };
}

const temporaryRoot = await mkdtemp(join(tmpdir(), "domformat-release-"));
try {
  const firstRoot = join(temporaryRoot, "pack-a");
  const secondRoot = join(temporaryRoot, "pack-b");
  const installRoot = join(temporaryRoot, "install");
  const outputRoot = join(temporaryRoot, "output");
  const encodedRootA = join(outputRoot, "encoded-a");
  const encodedRootB = join(outputRoot, "encoded-b");
  const producerRootA = join(outputRoot, "producer-a");
  const producerRootB = join(outputRoot, "producer-b");
  await Promise.all([
    mkdir(firstRoot),
    mkdir(secondRoot),
    mkdir(installRoot),
    mkdir(encodedRootA, { recursive: true }),
    mkdir(encodedRootB, { recursive: true }),
    mkdir(producerRootA, { recursive: true }),
    mkdir(producerRootB, { recursive: true }),
  ]);

  const first = await pack(firstRoot);
  const second = await pack(secondRoot);
  invariant(first.digest === second.digest, "Two npm tarballs from identical input were not byte-identical.");

  run(npm, [
    "install",
    "--prefix", installRoot,
    "--no-audit",
    "--no-fund",
    first.tarball,
  ]);
  const installed = join(installRoot, "node_modules", "@layoutit", "polycss-domformat");
  const installedEntries = (await readdir(installed)).sort();
  invariant(
    JSON.stringify(installedEntries) === JSON.stringify(["LICENSE", "README.md", "bin", "package.json", "src"]),
    `Clean install contains non-runtime top-level entries: ${installedEntries.join(", ")}`,
  );
  const installedManifest = JSON.parse(await readFile(join(installed, "package.json"), "utf8"));
  invariant(installedManifest.name === "@layoutit/polycss-domformat", "Installed package name differs from the release identity.");
  invariant(installedManifest.version === "0.0.0", "Installed package version differs from the release identity.");
  invariant(installedManifest.private === true, "Installed package must remain private.");
  invariant(installedManifest.license === "MIT", "Installed package license must match the PolyCSS MIT license.");
  invariant(installedManifest.type === "module", "Installed package must remain ESM.");
  invariant(JSON.stringify(installedManifest.files) === JSON.stringify(["bin/", "src/", "LICENSE", "README.md"]), "Installed package file allowlist changed.");
  invariant(JSON.stringify(installedManifest.bin) === JSON.stringify({ domformat: "./bin/domformat.js" }), "Installed CLI surface changed.");
  invariant(JSON.stringify(installedManifest.exports) === JSON.stringify({ ".": "./src/index.js", "./browser": "./src/browser.js" }), "Installed export map changed.");
  invariant(installedManifest.dependencies === undefined && installedManifest.optionalDependencies === undefined && installedManifest.peerDependencies === undefined, "Installed package gained a dependency.");
  invariant(installedManifest.scripts?.prepack === undefined, "Installed package contains a source-checkout-only prepack hook.");
  const cli = join(installed, "bin", "domformat.js");
  const manifest = join(root, "fixtures", "synthetic-polycss", "manifest.json");
  const producer = join(root, "conformance", "producer.py");
  const reader = join(root, "conformance", "reader.py");
  const encodedA = join(encodedRootA, "synthetic.json");
  const encodedB = join(encodedRootB, "synthetic.json");

  run(process.execPath, [cli, "--help"]);
  if (process.platform !== "win32") {
    run(join(installRoot, "node_modules", ".bin", "domformat"), ["--help"]);
  }
  run(process.execPath, [
    "--input-type=module",
    "--eval",
    "import * as core from '@layoutit/polycss-domformat'; import * as browser from '@layoutit/polycss-domformat/browser'; const same=(a,b)=>JSON.stringify(Object.keys(a).sort())===JSON.stringify(b); if (!same(core, ['DomFormatError','buildDom','readDom','readDomFile','validateDocument']) || !same(browser, ['mountDom','readDomBrowser','readDomBrowserUrl'])) process.exit(1);",
  ], { cwd: installRoot });
  run(process.execPath, [cli, "encode", manifest, "--output", encodedA]);
  run(process.execPath, [cli, "encode", manifest, "--output", encodedB]);
  invariant(sha256(await readFile(encodedA)) === sha256(await readFile(encodedB)), "Installed CLI JSON output is not deterministic.");
  for (const relative of ["independent.css", join("assets", "independent-checker.png")]) {
    const encodedRelative = relative === "independent.css" ? "model.css" : join("assets", "checker.png");
    invariant(sha256(await readFile(join(encodedRootA, encodedRelative))) === sha256(await readFile(join(encodedRootB, encodedRelative))), `Installed CLI sibling resource ${encodedRelative} is not deterministic.`);
  }
  run(process.execPath, [cli, "validate", encodedA]);
  const inspection = JSON.parse(run(process.execPath, [cli, "inspect", encodedA, "--json"]));
  invariant(inspection.tree.nodes === 8 && inspection.resources.length === 2, "Installed CLI inspect returned an unexpected contract.");
  const decoded = join(outputRoot, "decoded");
  run(process.execPath, [cli, "decode", encodedA, "--output", decoded]);
  invariant((await readdir(decoded)).sort().join(",") === "bindings.json,css-binding.json,meta.json,resource-by-id,resources.json,state.json,tree.json", "Installed CLI decode emitted an unexpected file set.");
  run(python, ["-B", reader, "validate", encodedA]);

  const independentA = join(producerRootA, "independent.json");
  const independentB = join(producerRootB, "independent.json");
  run(python, ["-B", producer, independentA]);
  run(python, ["-B", producer, independentB]);
  invariant(sha256(await readFile(independentA)) === sha256(await readFile(independentB)), "Independent producer JSON bytes are not deterministic.");
  for (const relative of ["independent.css", join("assets", "independent-checker.png")]) {
    invariant(sha256(await readFile(join(producerRootA, relative))) === sha256(await readFile(join(producerRootB, relative))), `Independent producer sibling resource ${relative} is not deterministic.`);
  }
  run(process.execPath, [cli, "validate", independentA]);
  run(python, ["-B", reader, "validate", independentA]);

  process.stdout.write(`${JSON.stringify({
    package: `${first.report.name}@${first.report.version}`,
    tarballBytes: first.report.size,
    unpackedBytes: first.report.unpackedSize,
    entries: first.report.entryCount,
    sha256: first.digest,
    deterministicTarball: true,
    runtimeOnlyTopLevel: true,
    installedJsonAndSiblingSmoke: true,
    installedAllCliCommandsSmoke: true,
    installedRuntimeAcceptsIndependentProducer: true,
  }, null, 2)}\n`);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
