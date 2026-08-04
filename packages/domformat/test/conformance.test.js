import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { decodeJson, encodeCanonicalJson } from "../src/canonical-json.js";
import { readDomBrowser } from "../src/browser.js";
import { DomFormatError } from "../src/errors.js";
import { sha256Hex } from "../src/hash.js";
import { DEFAULT_LIMITS } from "../src/constants.js";
import { validateCssBytes } from "../src/resources.js";
import { readDom } from "../src/reader.js";
import { buildDom } from "../src/writer.js";
import { builtExternalResources, errorCode, syntheticExecutableInteractionInput, syntheticPolycssInput, syntheticTwoFramePolycssInput } from "./helpers.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const corpus = resolve(root, "conformance/corpus");

function f32Bits(value) {
  const bytes = new ArrayBuffer(4);
  const view = new DataView(bytes);
  view.setFloat32(0, Math.fround(value), true);
  return view.getUint32(0, true).toString(16).padStart(8, "0");
}

function canonicalBinary64Sample(count) {
  const values = [];
  const bytes = new ArrayBuffer(8);
  const view = new DataView(bytes);
  let state = 0x6a09e667f3bcc909n;
  while (values.length < count) {
    state ^= state << 13n;
    state ^= state >> 7n;
    state ^= state << 17n;
    state = BigInt.asUintN(64, state);
    view.setBigUint64(0, state, true);
    const value = view.getFloat64(0, true);
    if (Number.isFinite(value)) values.push(value);
  }
  return values;
}

function decodeCanonicalJsonForTest(bytes, label) {
  let value;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    throw new DomFormatError("MALFORMED_JSON", `${label} is not valid JSON.`, { cause: String(error) });
  }
  const canonical = encodeCanonicalJson(value);
  if (canonical.length !== bytes.length || !canonical.every((byte, index) => byte === bytes[index])) {
    throw new DomFormatError("NON_CANONICAL_JSON", `${label} is not canonically encoded.`);
  }
  return value;
}


function encodeUncheckedDocument(built, operation) {
  const document = decodeJson(built.bytes, "JSON fixture");
  operation(document, builtExternalResources(built));
  return encodeCanonicalJson(document);
}

function mutate(source, operation) {
  if (operation === "none") return source.slice();
  if (operation === "gzip-transport") return Uint8Array.of(0x1f, 0x8b, 0x08, 0x00);
  if (operation === "malformed-utf8") return new Uint8Array([0xff]);
  if (operation === "malformed-json") return new TextEncoder().encode("{\"meta\":");
  const text = new TextDecoder().decode(source);
  if (operation === "duplicate-key") return new TextEncoder().encode("{\"meta\":null," + text.slice(1));
  if (operation === "negative-zero") return new TextEncoder().encode(text.replace("\"version\":0", "\"version\":-0"));
  const envelope = decodeJson(source, "corpus fixture");
  if (operation === "unknown-top-level") envelope.privateAdapter = true;
  else if (operation === "unsupported-format") envelope.meta.format = "domformat@99";
  else if (operation === "unsupported-profile") envelope.meta.profile = "polycss-3d@99";
  else if (operation === "unknown-required-capability") envelope.meta.capabilities.push("future-required");
  else if (operation === "invalid-initial-experience") envelope.meta.initialExperience = "webpage-replay";
  else if (operation === "embedded-payload") envelope.payloads = {};
  else if (operation === "embedded-storage") {
    delete envelope.resources.resources[0].path;
    envelope.resources.resources[0].storage = { mode: "embedded", encoding: "base64" };
  } else if (operation === "unsafe-resource-path") envelope.resources.resources[0].path = "../private.png";
  else if (operation === "duplicate-resource-path") envelope.resources.resources[1].path = envelope.resources.resources[0].path;
  else if (operation === "casefold-resource-path") envelope.resources.resources[1].path = envelope.resources.resources[0].path.toUpperCase();
  else if (operation === "resource-path-prefix") envelope.resources.resources[1].path = `${envelope.resources.resources[0].path}/model.css`;
  else if (operation === "reserved-resource-path") envelope.resources.resources[0].path = "assets/CON.png";
  else if (operation === "trailing-dot-resource-path") envelope.resources.resources[0].path = "assets/checker.";
  else if (operation === "missing-aria-hidden") delete envelope.tree.nodes.find((node) => !envelope.tree.nodes.some((candidate) => candidate.parent === node.index)).attributes["aria-hidden"];
  else if (operation === "missing-resource" || operation === "resource-digest") return source.slice();
  else throw new Error("Unknown corpus mutation " + operation);
  return encodeCanonicalJson(envelope);
}


test("JavaScript and independent Python readers pass the shared conformance corpus", async () => {
  const manifest = JSON.parse(await readFile(resolve(corpus, "cases.json"), "utf8"));
  const source = new Uint8Array(await readFile(resolve(corpus, manifest.fixture.json)));
  assert.equal(source.length, manifest.fixture.byteLength);
  assert.equal(sha256Hex(source), manifest.fixture.sha256);
  const sourceDocument = decodeJson(source, "corpus fixture");
  const baseResources = new Map(await Promise.all(sourceDocument.resources.resources.map(async (record) => [
    record.id,
    new Uint8Array(await readFile(resolve(corpus, record.path))),
  ])));
  for (const entry of manifest.cases) {
    const bytes = mutate(source, entry.mutation);
    const externalResources = new Map([...baseResources].map(([id, value]) => [id, value.slice()]));
    if (entry.mutation === "missing-resource") externalResources.delete("independent-checker");
    if (entry.mutation === "resource-digest") externalResources.get("independent-checker")[0] ^= 1;
    let actual = "valid";
    try {
      const result = readDom(bytes, { externalResources, requireResources: true });
      if (entry.id === "valid") {
        const construction = result.document.tree.nodes.map((node) => [node.id, node.parent, node.sibling, node.namespace, node.name]);
        const bindings = result.document.bindings.channels.map((channel) => [channel.id, channel.state, channel.interpreter, channel.targets, channel.sinks]);
        assert.equal(sha256Hex(encodeCanonicalJson(construction)), manifest.fixture.constructionPlanSha256);
        assert.equal(sha256Hex(encodeCanonicalJson(bindings)), manifest.fixture.bindingPlanSha256);
      }
    } catch (error) {
      assert.ok(error instanceof DomFormatError);
      actual = error.code;
    }
    assert.equal(actual, entry.expect, entry.id);

    let browserActual = "valid";
    try {
      await readDomBrowser(bytes, { externalResources });
    } catch (error) {
      assert.ok(error instanceof DomFormatError);
      browserActual = error.code;
    }
    assert.equal(browserActual, entry.expect, `${entry.id} browser`);
  }

  const python = spawnSync("python3", ["-B", "conformance/run_corpus.py"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(python.status, 0, `${python.stdout}\n${python.stderr}`);
  assert.match(python.stdout, /ok valid: valid/u);
  assert.match(python.stdout, /ok embedded-payload: INVALID_DOCUMENT/u);
});

test("JavaScript and Python agree on canonical JSON and binary32 vectors", async () => {
  const manifest = JSON.parse(await readFile(resolve(corpus, "canonical-json-cases.json"), "utf8"));
  for (const entry of manifest.cases) {
    const source = JSON.parse(entry.source);
    assert.equal(new TextDecoder().decode(encodeCanonicalJson(source)), entry.canonical, entry.id);
    assert.deepEqual(decodeCanonicalJsonForTest(new TextEncoder().encode(entry.canonical), entry.id), JSON.parse(entry.canonical));
    if (entry.source !== entry.canonical) {
      assert.throws(
        () => decodeCanonicalJsonForTest(new TextEncoder().encode(entry.source), entry.id),
        errorCode("NON_CANONICAL_JSON"),
      );
    }
  }

  const vectors = JSON.parse(await readFile(resolve(corpus, "f32-vectors.json"), "utf8"));
  for (const entry of vectors.values) {
    const value = entry.negativeZero ? -0 : entry.value;
    assert.equal(f32Bits(value), entry.bits, entry.id);
  }
  for (const entry of vectors.operations) {
    let value;
    if (entry.op === "add") value = Math.fround(Math.fround(entry.left) + Math.fround(entry.right));
    else if (entry.op === "multiply") value = Math.fround(Math.fround(entry.left) * Math.fround(entry.right));
    else if (entry.op === "sqrt") value = Math.fround(Math.sqrt(Math.fround(entry.value)));
    else assert.fail(`Unknown f32 operation ${entry.op}`);
    assert.equal(f32Bits(value), entry.bits, entry.id);
  }

  const pythonVectors = spawnSync("python3", ["-B", "conformance/check_canonical.py"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(pythonVectors.status, 0, `${pythonVectors.stdout}\n${pythonVectors.stderr}`);
  assert.match(pythonVectors.stdout, /ok canonical-json and f32 vectors/u);
});

test("JavaScript and Python enforce the shared fail-closed CSS security vectors", async () => {
  const manifest = JSON.parse(await readFile(resolve(corpus, "css-security-cases.json"), "utf8"));
  for (const entry of manifest.cases) {
    const binding = { id: "model-css", scope: manifest.scope, assetTokens: entry.tokens };
    let actual = "valid";
    try {
      validateCssBytes(new TextEncoder().encode(entry.css), binding, new Set(["checker"]), DEFAULT_LIMITS);
    } catch (error) {
      assert.ok(error instanceof DomFormatError);
      actual = error.code;
    }
    assert.equal(actual, entry.expect, entry.id);
  }
  const python = spawnSync("python3", ["-B", "conformance/check_css.py"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(python.status, 0, `${python.stdout}\n${python.stderr}`);
  assert.match(python.stdout, /ok indirect-image-set: UNSAFE_CSS_FUNCTION/u);
});

test("independent Python canonicalizer accepts a deterministic binary64 sample from JavaScript", () => {
  const sample = encodeCanonicalJson(canonicalBinary64Sample(4096));
  const python = spawnSync("python3", ["-B", "conformance/check_canonical.py", "--stdin"], {
    cwd: root,
    input: sample,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  assert.equal(python.status, 0, `${python.stdout}\n${python.stderr}`);
  const evidence = JSON.parse(python.stdout);
  assert.equal(evidence.count, 4096);
  assert.equal(evidence.sha256, sha256Hex(sample));
});

test("independent Python reader validates canonical and ordinary JSON with sibling resources", async () => {
  const directory = await mkdtemp(join(tmpdir(), "domformat-python-fixture-"));
  try {
    const input = await syntheticPolycssInput();
    const built = buildDom(input);
    const file = join(directory, "synthetic.json");
    await writeFile(file, built.bytes);
    for (const [relative, bytes] of built.externalResources) {
      const target = join(directory, ...relative.split("/"));
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, bytes);
    }
    const validate = spawnSync("python3", ["-B", "conformance/reader.py", "validate", file], { cwd: root, encoding: "utf8" });
    assert.equal(validate.status, 0, `${validate.stdout}\n${validate.stderr}`);
    assert.match(validate.stdout, /8 nodes; 2 resources verified/u);
    const ordinaryText = JSON.stringify(decodeJson(built.bytes), null, 2).replace('"version": 0', '"version": 0e0');
    const ordinaryFile = join(directory, "ordinary-json.json");
    await writeFile(ordinaryFile, ordinaryText);
    const ordinaryValidate = spawnSync("python3", ["-B", "conformance/reader.py", "validate", ordinaryFile], { cwd: root, encoding: "utf8" });
    assert.equal(ordinaryValidate.status, 0, `${ordinaryValidate.stdout}\n${ordinaryValidate.stderr}`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("independent Python reader enforces interaction arithmetic envelopes", async () => {
  const built = buildDom(await syntheticExecutableInteractionInput());
  const directory = await mkdtemp(join(tmpdir(), "domformat-python-interaction-"));
  try {
    const validFile = join(directory, "valid.json");
    await writeFile(validFile, built.bytes);
    for (const [relative, bytes] of built.externalResources) {
      const target = join(directory, ...relative.split("/"));
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, bytes);
    }
    const valid = spawnSync("python3", ["-B", "conformance/reader.py", "validate", validFile], {
      cwd: root,
      encoding: "utf8",
    });
    assert.equal(valid.status, 0, `${valid.stdout}\n${valid.stderr}`);

    const overflow = encodeUncheckedDocument(built, (document) => {
      document.state.channels.find((channel) => channel.codec === "polycss-pointer-grab-prepared@0")
        .data.packet.source.displacementMagnitude = Math.fround(3e38);
    });
    const overflowFile = join(directory, "overflow.json");
    await writeFile(overflowFile, overflow);
    const invalid = spawnSync("python3", ["-B", "conformance/reader.py", "validate", overflowFile], {
      cwd: root,
      encoding: "utf8",
    });
    assert.equal(invalid.status, 1, `${invalid.stdout}\n${invalid.stderr}`);
    assert.match(invalid.stderr, /INVALID_INTERACTION_STATE/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Node, browser, and Python reject retained-DOM semantic evasions", async () => {
  const built = buildDom(await syntheticPolycssInput());
  const cases = [
    ["META_COUNT_MISMATCH", (document) => { document.meta.counts = { nodes: document.tree.nodes.length + 1 }; }],
    ["UNSAFE_ATTRIBUTE", (document) => { document.tree.nodes[0].attributes["data-domformat-mount-surface"] = "package-controlled"; }],
    ["INVALID_TARGETS", (document) => {
      document.bindings.channels.find((channel) => channel.interpreter === "polycss-playback@0").targets.leaves[0] = null;
    }],
    ["UNSUPPORTED_SINK", (document) => {
      document.bindings.channels.find((channel) => channel.interpreter === "polycss-playback@0").sinks = ["attribute.src"];
    }],
    ["UNSAFE_STYLE_VALUE", (document) => {
      document.bindings.channels.find((channel) => channel.interpreter === "polycss-playback@0").parameters.baseSceneTransform = "var(--adapter-transform)";
    }],
    ["INVALID_FRAME_ROW", (document) => {
      document.state.channels.find((channel) => channel.codec === "polycss-playback-packed@0").data.packet.frameRows[0][0] = 999;
    }],
    ["INVALID_EFFECTS_STATE", (document) => {
      const packet = document.state.channels.find((channel) => channel.codec === "polycss-effects-prepared@0").data.packet;
      packet.biases.continuous[0] = 3.4e38;
      packet.spawnStream.tuples[0][1] = 3.4e38;
    }],
    ["UNUSED_RESOURCE", (document, resourceBytes) => {
      const bytes = resourceBytes.get("checker");
      document.resources.resources.push({
        id: "unused",
        kind: "image",
        mediaType: "image/png",
        byteLength: bytes.length,
        dimensions: { width: 2, height: 2 },
        digest: { algorithm: "sha256", value: sha256Hex(bytes) },
        path: "unused.png",
      });
    }],
  ];
  const directory = await mkdtemp(join(tmpdir(), "domformat-semantic-evasion-"));
  try {
    for (const [relative, bytes] of built.externalResources) {
      const target = join(directory, ...relative.split("/"));
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, bytes);
    }
    for (const [code, operation] of cases) {
      const bytes = encodeUncheckedDocument(built, operation);
      const externalResources = builtExternalResources(built);
      assert.throws(() => readDom(bytes, { externalResources, requireResources: true }), errorCode(code));
      await assert.rejects(readDomBrowser(bytes, { externalResources }), errorCode(code));
      const file = join(directory, `${code}.json`);
      await writeFile(file, bytes);
      const python = spawnSync("python3", ["-B", "conformance/reader.py", "validate", file], {
        cwd: root,
        encoding: "utf8",
      });
      assert.equal(python.status, 1, `${python.stdout}\n${python.stderr}`);
      assert.match(python.stderr, new RegExp(`\\b${code}\\b`, "u"));
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Node, browser, and Python reject contradictory prepared surface jumps", async () => {
  const built = buildDom(await syntheticTwoFramePolycssInput());
  const bytes = encodeUncheckedDocument(built, (document) => {
    const packet = document.state.channels.find((channel) => channel.codec === "polycss-surface-packed@0").data.packet;
    packet.transitions.nonInteractiveJumps = [{
      fromFrame: 1,
      toFrame: 2,
      faceIndicesBase64: "",
      stateIndicesBase64: "",
    }];
    packet.visibility.nonInteractiveJumps = [{ fromFrame: 1, toFrame: 2, faceIndicesBase64: "" }];
  });
  const externalResources = builtExternalResources(built);
  assert.throws(() => readDom(bytes, { externalResources, requireResources: true }), errorCode("SURFACE_JUMP_MISMATCH"));
  await assert.rejects(readDomBrowser(bytes, { externalResources }), errorCode("SURFACE_JUMP_MISMATCH"));

  const directory = await mkdtemp(join(tmpdir(), "domformat-surface-jump-"));
  try {
    const file = join(directory, "contradictory.json");
    await writeFile(file, bytes);
    const python = spawnSync("python3", ["-B", "conformance/reader.py", "validate", file], {
      cwd: root,
      encoding: "utf8",
    });
    assert.equal(python.status, 1, `${python.stdout}\n${python.stderr}`);
    assert.match(python.stderr, /SURFACE_JUMP_MISMATCH/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Node, browser, and Python scan multi-megabyte codec base64 without regex recursion", async () => {
  const built = buildDom(await syntheticPolycssInput());
  const bytes = encodeUncheckedDocument(built, (document) => {
    document.state.channels.find((channel) => channel.codec === "polycss-surface-packed@0")
      .data.packet.visibility.sequential.faceIndicesBase64 = `${"AAAA".repeat(2_599_999)}AAA*`;
  });
  const externalResources = builtExternalResources(built);
  assert.throws(() => readDom(bytes, { externalResources, requireResources: true }), errorCode("INVALID_SURFACE_STATE"));
  await assert.rejects(readDomBrowser(bytes, { externalResources }), errorCode("INVALID_SURFACE_STATE"));

  const directory = await mkdtemp(join(tmpdir(), "domformat-codec-base64-"));
  try {
    const file = join(directory, "malformed.json");
    await writeFile(file, bytes);
    const python = spawnSync("python3", ["-B", "conformance/reader.py", "validate", file], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
    });
    assert.equal(python.status, 1, `${python.stdout}\n${python.stderr}`);
    assert.match(python.stderr, /INVALID_SURFACE_STATE/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
