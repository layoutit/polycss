import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { decodeJson, encodeCanonicalJson } from "../src/canonical-json.js";
import { readDom, readDomFile } from "../src/reader.js";
import { buildDom } from "../src/writer.js";
import { NVersionError } from "../conformance/nversion/errors.js";
import { readDomNVersion } from "../conformance/nversion/reader.js";
import { validateStylesheet } from "../conformance/nversion/resources.js";
import {
  builtExternalResources,
  syntheticEmptySurfaceInput,
  syntheticPlaybackWithoutSurfaceInput,
  syntheticStaticPresentationInput,
} from "./helpers.js";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const producer = resolve(root, "conformance/producer.py");
const pythonReader = resolve(root, "conformance/reader.py");
const corpus = resolve(root, "conformance/corpus");
const N_VERSION_FILES = Object.freeze([
  "conformance/nversion/errors.js",
  "conformance/nversion/json.js",
  "conformance/nversion/resources.js",
  "conformance/nversion/schema.js",
  "conformance/nversion/reader.js",
]);

function runPython(args) {
  return spawnSync("python3", ["-B", ...args], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
}

function mutateCorpus(source, operation) {
  if (operation === "none") return source.slice();
  if (operation === "gzip-transport") return Uint8Array.of(0x1f, 0x8b, 0x08, 0x00);
  if (operation === "malformed-utf8") return Uint8Array.of(0xff);
  if (operation === "malformed-json") return new TextEncoder().encode('{"meta":');
  const text = new TextDecoder().decode(source);
  if (operation === "duplicate-key") return new TextEncoder().encode('{"meta":null,' + text.slice(1));
  if (operation === "negative-zero") return new TextEncoder().encode(text.replace('"version":0', '"version":-0'));
  const document = decodeJson(source, "N-version corpus");
  if (operation === "unknown-top-level") document.privateAdapter = true;
  else if (operation === "unsupported-format") document.meta.format = "domformat@99";
  else if (operation === "unsupported-profile") document.meta.profile = "polycss-3d@99";
  else if (operation === "unknown-required-capability") document.meta.capabilities.push("future-required");
  else if (operation === "invalid-initial-experience") document.meta.initialExperience = "webpage-replay";
  else if (operation === "embedded-payload") document.payloads = {};
  else if (operation === "embedded-storage") {
    delete document.resources.resources[0].path;
    document.resources.resources[0].storage = { mode: "embedded", encoding: "base64" };
  } else if (operation === "unsafe-resource-path") document.resources.resources[0].path = "../private.png";
  else if (operation === "duplicate-resource-path") document.resources.resources[1].path = document.resources.resources[0].path;
  else if (operation === "casefold-resource-path") document.resources.resources[1].path = document.resources.resources[0].path.toUpperCase();
  else if (operation === "resource-path-prefix") document.resources.resources[1].path = `${document.resources.resources[0].path}/model.css`;
  else if (operation === "reserved-resource-path") document.resources.resources[0].path = "assets/CON.png";
  else if (operation === "trailing-dot-resource-path") document.resources.resources[0].path = "assets/checker.";
  else if (operation === "missing-aria-hidden") delete document.tree.nodes.find((node) => !document.tree.nodes.some((candidate) => candidate.parent === node.index)).attributes["aria-hidden"];
  else if (operation === "missing-resource" || operation === "resource-digest") return source.slice();
  else throw new Error(`Unknown corpus mutation ${operation}.`);
  return encodeCanonicalJson(document);
}

async function produce(directory, options = []) {
  await mkdir(directory, { recursive: true });
  const model = join(directory, "model.json");
  const run = runPython([producer, model, ...options]);
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  return { model, directory, bytes: await readFile(model), summary: JSON.parse(run.stdout) };
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) value = value >>> 1 ^ (value & 1 ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
}

test("N-version browser probe has a mechanically closed production boundary", async () => {
  for (const file of N_VERSION_FILES) {
    const source = await readFile(resolve(root, file), "utf8");
    assert.doesNotMatch(source, /(?:^|["'])\.\.\/\.\.\/src\//mu, file);
    assert.doesNotMatch(source, /(?:^|["'])\.\.\/src\//mu, file);
    assert.doesNotMatch(source, /conformance\/viewer|viewer\/mount/u, file);
    assert.doesNotMatch(source, /\b(?:eval|Function|WebAssembly)\s*\(/u, file);
    assert.doesNotMatch(source, /innerHTML|insertAdjacentHTML|document\.write/u, file);
  }
});

async function assertIndependentReadersAccept(input, prefix) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  try {
    const built = buildDom(input);
    const externalResources = builtExternalResources(built);
    assert.doesNotThrow(() => readDom(built.bytes, { externalResources, requireResources: true }));
    await assert.doesNotReject(readDomNVersion(built.bytes, { externalResources }));
    const model = join(directory, "model.json");
    await writeFile(model, built.bytes);
    for (const record of built.document.resources.resources) {
      const target = join(directory, record.path);
      await mkdir(resolve(target, ".."), { recursive: true });
      await writeFile(target, built.externalResources.get(record.path));
    }
    const python = runPython([pythonReader, "validate", model]);
    assert.equal(python.status, 0, `${python.stdout}\n${python.stderr}`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("production, N-version, and Python readers accept reduced executable closures", async () => {
  for (const [name, createInput] of [
    ["empty surface", syntheticEmptySurfaceInput],
    ["leafless playback without surface", syntheticPlaybackWithoutSurfaceInput],
    ["static presentation", syntheticStaticPresentationInput],
  ]) {
    await assertIndependentReadersAccept(await createInput(), `domformat-${name.replaceAll(" ", "-")}-`);
  }
});

test("production, N-version, and Python readers reject a null optional presentation background", async () => {
  const built = buildDom(await syntheticStaticPresentationInput());
  const document = decodeJson(built.bytes, "static presentation");
  document.state.channels.find((channel) => channel.codec === "static-presentation@0").data.packet.background = null;
  const bytes = encodeCanonicalJson(document);
  const externalResources = builtExternalResources(built);
  assert.throws(() => readDom(bytes, { externalResources, requireResources: true }), (error) => error?.code === "INVALID_PRESENTATION_STATE");
  await assert.rejects(readDomNVersion(bytes, { externalResources }), (error) => error instanceof NVersionError && error.code === "INVALID_PRESENTATION_STATE");

  const directory = await mkdtemp(join(tmpdir(), "domformat-null-presentation-background-"));
  try {
    const model = join(directory, "model.json");
    await writeFile(model, bytes);
    for (const record of built.document.resources.resources) {
      const target = join(directory, record.path);
      await mkdir(resolve(target, ".."), { recursive: true });
      await writeFile(target, built.externalResources.get(record.path));
    }
    const python = runPython([pythonReader, "validate", model]);
    assert.equal(python.status, 1, `${python.stdout}\n${python.stderr}`);
    assert.match(python.stderr, /INVALID_PRESENTATION_STATE/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("production, N-version, and Python readers reject effects without playback", async () => {
  const built = buildDom(await syntheticEmptySurfaceInput());
  const document = decodeJson(built.bytes, "effects without playback");
  document.state.channels = document.state.channels.filter((channel) => !["polycss-playback-packed@0", "polycss-surface-packed@0"].includes(channel.codec));
  document.bindings.channels = document.bindings.channels.filter((channel) => !["polycss-playback@0", "polycss-surface@0"].includes(channel.interpreter));
  document.bindings.inputs = document.bindings.inputs.filter((definition) => definition.id !== "time.tick");
  document.meta.capabilities = document.meta.capabilities.filter((capability) => !["prepared-playback", "prepared-surface-lighting"].includes(capability));
  document.meta.conformance.executable = document.meta.conformance.executable.filter((role) => !["playback", "surface-lighting"].includes(role));
  document.meta.counts = { nodes: document.tree.nodes.length };
  const bytes = encodeCanonicalJson(document);
  const externalResources = builtExternalResources(built);
  assert.throws(() => readDom(bytes, { externalResources, requireResources: true }), (error) => error?.code === "MISSING_POLYCSS_CHANNEL");
  await assert.rejects(readDomNVersion(bytes, { externalResources }), (error) => error instanceof NVersionError && error.code === "MISSING_POLYCSS_CHANNEL");

  const directory = await mkdtemp(join(tmpdir(), "domformat-effects-without-playback-"));
  try {
    const model = join(directory, "model.json");
    await writeFile(model, bytes);
    for (const record of built.document.resources.resources) {
      const target = join(directory, record.path);
      await mkdir(resolve(target, ".."), { recursive: true });
      await writeFile(target, built.externalResources.get(record.path));
    }
    const python = runPython([pythonReader, "validate", model]);
    assert.equal(python.status, 1, `${python.stdout}\n${python.stderr}`);
    assert.match(python.stderr, /MISSING_POLYCSS_CHANNEL/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("N-version probe matches the exact shared transport and envelope corpus", async () => {
  const manifest = JSON.parse(await readFile(resolve(corpus, "cases.json"), "utf8"));
  const source = new Uint8Array(await readFile(resolve(corpus, manifest.fixture.json)));
  const document = decodeJson(source, "N-version corpus");
  const baseResources = new Map(await Promise.all(document.resources.resources.map(async (record) => [record.id, new Uint8Array(await readFile(resolve(corpus, record.path)))])));
  for (const entry of manifest.cases) {
    const externalResources = new Map([...baseResources].map(([id, bytes]) => [id, bytes.slice()]));
    if (entry.mutation === "missing-resource") externalResources.delete("independent-checker");
    if (entry.mutation === "resource-digest") externalResources.get("independent-checker")[0] ^= 1;
    let actual = "valid";
    try {
      await readDomNVersion(mutateCorpus(source, entry.mutation), { externalResources });
    } catch (error) {
      assert.ok(error instanceof NVersionError, entry.id);
      actual = error.code;
    }
    assert.equal(actual, entry.expect, entry.id);
  }
});

test("N-version probe matches the shared fail-closed CSS security corpus", async () => {
  const manifest = JSON.parse(await readFile(resolve(corpus, "css-security-cases.json"), "utf8"));
  const records = new Map([["checker", { id: "checker", kind: "image" }]]);
  const limits = {
    maxCssBytes: 1024 * 1024,
    maxCssRules: 8_192,
    maxCssSelectors: 32_768,
    maxCssSelectorBytes: 4_096,
    maxCssDeclarations: 131_072,
  };
  for (const entry of manifest.cases) {
    let actual = "valid";
    try {
      validateStylesheet(new TextEncoder().encode(entry.css), {
        id: "model-css",
        scope: manifest.scope,
        assetTokens: entry.tokens,
      }, records, limits);
    } catch (error) {
      assert.ok(error instanceof NVersionError, entry.id);
      actual = error.code;
    }
    assert.equal(actual, entry.expect, entry.id);
  }
});

test("N-version probe accepts independently produced canonical and ordinary JSON", async () => {
  const directory = await mkdtemp(join(tmpdir(), "domformat-nversion-producer-"));
  try {
    const canonical = await produce(join(directory, "canonical"));
    const ordinary = await produce(join(directory, "ordinary"), ["--ordinary"]);
    const canonicalReference = await readDomFile(canonical.model);
    const ordinaryReference = await readDomFile(ordinary.model);
    const canonicalNVersion = await readDomNVersion(canonical.bytes, { externalResources: canonicalReference.resourceBytes });
    const ordinaryNVersion = await readDomNVersion(ordinary.bytes, { externalResources: ordinaryReference.resourceBytes });
    assert.deepEqual(plain(canonicalNVersion.document), canonicalReference.document);
    assert.deepEqual(plain(ordinaryNVersion.document), ordinaryReference.document);
    assert.equal(canonicalNVersion.implementation, "nversion-browser-probe@0");
    assert.equal(canonicalNVersion.resourceBytes.size, 2);
    assert.equal(ordinaryNVersion.transport.encoding, "json");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("seeded cross-field mutations agree across Node, Python, and the N-version probe", async () => {
  const directory = await mkdtemp(join(tmpdir(), "domformat-nversion-differential-"));
  try {
    const produced = await produce(directory, ["--ordinary"]);
    const reference = await readDomFile(produced.model);
    const original = JSON.parse(await readFile(produced.model, "utf8"));
    const mutations = [
      { valid: true, apply(document, seed) { document.meta.optionalCapabilities.push(`zz-review-${seed}`); } },
      { valid: false, apply(document, seed) { document[`unknown${seed}`] = true; } },
      { valid: false, apply(document, seed) { document.meta.format = `domformat@${seed + 1}`; } },
      { valid: false, apply(document) { document.tree.nodes[1].id = document.tree.nodes[0].id; } },
      { valid: false, apply(document, seed) { document.tree.nodes[1].sibling = seed + 2; } },
      { valid: false, apply(document, seed) { document.meta.counts.nodes += seed + 1; } },
      { valid: false, apply(document, seed) { const record = document.resources.resources[seed % 2]; record.digest.value = `${record.digest.value[0] === "0" ? "1" : "0"}${record.digest.value.slice(1)}`; } },
      { valid: false, apply(document, seed) { document[`payloads${seed}`] = {}; } },
      { valid: false, apply(document, seed) { const binding = document.bindings.channels.find((entry) => entry.interpreter === "polycss-playback@0"); binding.targets.leaves[seed % binding.targets.leaves.length] = `missing/leaf:${seed}`; } },
      { valid: false, apply(document) { document.state.channels.find((entry) => entry.id === "playback").codec = "static-presentation@0"; } },
      { valid: false, apply(document) { document.bindings.channels.find((entry) => entry.interpreter === "polycss-playback@0").targets.leaves.reverse(); } },
      { valid: false, apply(document, seed) { document.bindings.channels.find((entry) => entry.interpreter === "static-presentation@0").parameters.sourceWidth += seed + 1; } },
      { valid: false, apply(document, seed) { document.state.channels.find((entry) => entry.id === "playback").data.packet[`private${seed}`] = 1; } },
      { valid: false, apply(document) { document.bindings.channels.find((entry) => entry.interpreter === "polycss-effects@0").inputs.reverse(); } },
      { valid: false, apply(document, seed) { document.cssBinding.stylesheets[0].scope = `[data-missing="scope-${seed}"]`; } },
      { valid: false, apply(document, seed) { document.meta.capabilities.push(`unknown-${seed}`); } },
    ];
    for (let seed = 0; seed < 64; seed += 1) {
      const mutation = mutations[seed % mutations.length];
      const document = structuredClone(original);
      mutation.apply(document, seed);
      const bytes = new TextEncoder().encode(JSON.stringify(document, null, seed % 3));
      let nodeValid = true;
      try { readDom(bytes, { externalResources: reference.resourceBytes, requireResources: true }); } catch { nodeValid = false; }
      let nVersionValid = true;
      try { await readDomNVersion(bytes, { externalResources: reference.resourceBytes }); } catch (error) { assert.ok(error instanceof NVersionError, `seed ${seed}`); nVersionValid = false; }
      const path = join(directory, `case-${seed}.json`);
      await writeFile(path, bytes);
      const python = runPython([pythonReader, "validate", path]);
      const pythonValid = python.status === 0;
      assert.equal(nodeValid, mutation.valid, `seed ${seed} Node`);
      assert.equal(nVersionValid, mutation.valid, `seed ${seed} N-version`);
      assert.equal(pythonValid, mutation.valid, `seed ${seed} Python: ${python.stderr}`);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("deep codec mutations are rejected by Node, Python, and the N-version reader", async () => {
  const directory = await mkdtemp(join(tmpdir(), "domformat-nversion-codecs-"));
  try {
    const produced = await produce(directory, ["--ordinary"]);
    const reference = await readDomFile(produced.model);
    const original = JSON.parse(await readFile(produced.model, "utf8"));
    const packet = (document, id) => document.state.channels.find((entry) => entry.id === id).data.packet;
    const mutations = [
      ["playback transform encoding", (document) => { packet(document, "playback").transforms.groups[0].encoding = "future-packed"; }],
      ["playback transform scale width", (document) => { packet(document, "playback").transforms.groups[0].scales.pop(); }],
      ["playback unowned transform", (document) => { packet(document, "playback").initial.shapes.transforms[1] = 0; }],
      ["playback concealed unowned transform", (document) => {
        packet(document, "playback").initial.shapes.transforms[1] = 0;
        packet(document, "playback").transforms.groups.splice(2, 1);
      }],
      ["surface source-frame delta", (document) => { packet(document, "surface").surface.statePacking.sourceFrameDeltas[1] = packet(document, "surface").frameCount; }],
      ["effects emitter mode", (document) => { packet(document, "effects").emitters[0].mode = "network-stream"; }],
      ["interaction pointer quantization", (document) => { packet(document, "interaction").input.pointerQuantization = "round"; }],
      ["interaction overlong basis", (document) => { packet(document, "interaction").leaves[0].basis.push(0); }],
    ];
    for (const [label, mutate] of mutations) {
      const document = structuredClone(original);
      mutate(document);
      const bytes = new TextEncoder().encode(JSON.stringify(document));
      assert.throws(() => readDom(bytes, { externalResources: reference.resourceBytes, requireResources: true }), undefined, `${label} Node`);
      await assert.rejects(readDomNVersion(bytes, { externalResources: reference.resourceBytes }), NVersionError, `${label} N-version`);
      const path = join(directory, `invalid-${label.replaceAll(" ", "-")}.json`);
      await writeFile(path, bytes);
      const python = runPython([pythonReader, "validate", path]);
      assert.notEqual(python.status, 0, `${label} Python`);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("illegal PNG media survives digest rebinding but not independent validation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "domformat-nversion-media-"));
  try {
    const produced = await produce(directory, ["--ordinary"]);
    const document = JSON.parse(await readFile(produced.model, "utf8"));
    const record = document.resources.resources.find((entry) => entry.kind === "image" && entry.mediaType === "image/png");
    assert.ok(record);
    const imagePath = join(directory, record.path);
    const image = new Uint8Array(await readFile(imagePath));
    image[24] = 3;
    const checksum = crc32(image.subarray(12, 29));
    image[29] = checksum >>> 24;
    image[30] = checksum >>> 16 & 0xff;
    image[31] = checksum >>> 8 & 0xff;
    image[32] = checksum & 0xff;
    record.digest.value = createHash("sha256").update(image).digest("hex");
    await writeFile(imagePath, image);
    const modelBytes = new TextEncoder().encode(JSON.stringify(document));
    await writeFile(produced.model, modelBytes);
    const resources = new Map(await Promise.all(document.resources.resources.map(async (entry) => [entry.id, new Uint8Array(await readFile(join(directory, entry.path)))])));
    assert.throws(() => readDom(modelBytes, { externalResources: resources, requireResources: true }), (error) => error?.code === "IMAGE_MEDIA_MISMATCH");
    await assert.rejects(readDomNVersion(modelBytes, { externalResources: resources }), (error) => error instanceof NVersionError && error.code === "IMAGE_MEDIA_MISMATCH");
    const python = runPython([pythonReader, "validate", produced.model]);
    assert.notEqual(python.status, 0, python.stdout);
    assert.match(python.stderr, /IMAGE_MEDIA_MISMATCH/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
