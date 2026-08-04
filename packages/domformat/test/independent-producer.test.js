import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readDomFile } from "../src/reader.js";
import { readDomBrowser, mountDom } from "../src/browser.js";
import { encodeCanonicalJson } from "../src/canonical-json.js";
import { mountConformanceDom } from "../conformance/viewer/mount.js";
import { readDomNVersion } from "../conformance/nversion/reader.js";
import { dispatch, FakeElement, fakeBrowserDocument } from "./fake-browser.js";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const producer = resolve(root, "conformance/producer.py");
const reader = resolve(root, "conformance/reader.py");
const STYLE_PROPERTIES = Object.freeze([
  "backgroundColor", "backgroundImage", "backgroundPosition", "backgroundPositionY",
  "backgroundRepeat", "backgroundSize", "border", "borderBottomLeftRadius",
  "borderBottomRightRadius", "borderShape", "borderTopLeftRadius", "borderTopRightRadius",
  "boxSizing", "color", "contain", "cornerBottomLeftShape", "cornerBottomRightShape",
  "cornerTopLeftShape", "cornerTopRightShape", "display",
  "height", "inset", "isolation", "left", "margin", "maxWidth", "objectFit",
  "objectPosition", "opacity", "overflow", "padding", "perspective", "perspectiveOrigin",
  "pointerEvents", "position", "top", "transform", "transformOrigin", "transformStyle",
  "visibility", "width", "zIndex",
]);

function runPython(args) {
  const result = spawnSync("python3", ["-B", ...args], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

async function produce(directory, options = []) {
  await mkdir(directory, { recursive: true });
  const model = join(directory, "independent.json");
  const summary = JSON.parse(runPython([
    producer,
    model,
    ...options,
  ]));
  return { directory, model, summary, bytes: await readFile(model) };
}

function resourceUrls(result, fake) {
  const ids = result.document.resources.resources
    .filter((record) => record.kind !== "stylesheet")
    .map((record) => record.id);
  return new Map(ids.map((id, index) => [id, fake.urls.created[index]]));
}

function normalize(value, urls) {
  if (typeof value !== "string") return value;
  let output = value;
  for (const [id, url] of urls) output = output.split(url).join(`dom-resource:${id}`);
  return output;
}

function styles(element, urls) {
  return Object.fromEntries(STYLE_PROPERTIES
    .map((property) => [property, normalize(element.style[property], urls)])
    .filter(([, value]) => value !== undefined && value !== ""));
}

function mountedSnapshot(result, host, fake) {
  const surface = host.childNodes[0];
  const elements = fake.namespaced;
  const urls = resourceUrls(result, fake);
  return {
    mount: {
      attributes: result.document.tree.mount.attributes
        .map(([name]) => [name, surface.getAttribute(name)]),
      styles: styles(surface, urls),
    },
    nodes: result.document.tree.nodes.map((record) => {
      const element = elements[record.index];
      const parent = element.parentNode === surface ? -1 : elements.indexOf(element.parentNode);
      const attributeNames = [
        ...Object.keys(record.attributes ?? {}),
        ...Object.keys(record.resourceAttributes ?? {}),
      ].sort();
      return {
        id: record.id,
        index: record.index,
        parent,
        sibling: element.parentNode.childNodes.indexOf(element),
        namespace: element.namespaceURI,
        name: element.localName,
        classes: [...element.classes],
        attributes: Object.fromEntries(attributeNames
          .map((name) => [name, normalize(element.getAttribute(name), urls)])),
        styles: styles(element, urls),
      };
    }),
  };
}

function normalizedWrites(result, host, fake) {
  const surface = host.childNodes[0];
  const urls = resourceUrls(result, fake);
  return fake.writes.flatMap(({ element, property, value }) => {
    if (element === surface) return [["$host", property, normalize(value, urls)]];
    const index = fake.namespaced.indexOf(element);
    if (index < 0) return [];
    return [[result.document.tree.nodes[index].id, property, normalize(value, urls)]];
  });
}

function normalizedCss(result, fake) {
  const urls = resourceUrls(result, fake);
  return fake.document.head.childNodes.map((element) => normalize(element.textContent, urls)
    .replace(/\[data-domformat-instance="[^"]+"\]/gu, "[data-domformat-instance=INSTANCE]"));
}

function clearWrites(...fakes) {
  for (const fake of fakes) fake.writes.splice(0);
}

async function browserResult(produced, nodeResult) {
  return readDomBrowser(produced.bytes, { externalResources: nodeResult.resourceBytes });
}

function plainDocument(document) {
  return JSON.parse(JSON.stringify(document));
}

async function assertViewerPair(result, label, conformanceResult = result) {
  const reference = fakeBrowserDocument();
  const independent = fakeBrowserDocument();
  const referenceHost = new FakeElement(reference.document, "main");
  const independentHost = new FakeElement(independent.document, "main");
  const referencePhases = [];
  const independentPhases = [];
  const referenceRuntime = await mountDom(result, referenceHost, {
    animate: true,
    mode: "interaction",
    onLifecyclePhase: (phase) => referencePhases.push(phase),
  });
  const independentRuntime = await mountConformanceDom(conformanceResult, independentHost, {
    animate: true,
    mode: "interaction",
    onLifecyclePhase: (phase) => independentPhases.push(phase),
  });
  const transcript = [];
  const compareWrites = (stage) => {
    const referenceWrites = normalizedWrites(result, referenceHost, reference);
    const independentWrites = normalizedWrites(result, independentHost, independent);
    assert.deepEqual(independentWrites, referenceWrites, `${label}: ${stage}`);
    transcript.push(...referenceWrites);
    return referenceWrites;
  };
  try {
    assert.deepEqual(referencePhases, ["validate", "construct", "bind", "initialize", "publish"], `${label}: reference lifecycle`);
    assert.deepEqual(independentPhases, referencePhases, `${label}: lifecycle`);
    assert.deepEqual(independentRuntime.snapshot(), mountedSnapshot(result, referenceHost, reference), `${label}: initial retained tree`);
    assert.deepEqual(normalizedCss(result, independent), normalizedCss(result, reference), `${label}: CSS closure`);
    compareWrites("initial publication");

    reference.frame(0);
    independent.frame(0);
    clearWrites(reference, independent);
    const events = [
      ["pointerdown", { button: 0, pointerId: 7, clientX: 160, clientY: 120 }],
      ["pointermove", { pointerId: 7, clientX: 176, clientY: 124 }],
      ["pointerup", { button: 0, pointerId: 7, clientX: 176, clientY: 124 }],
    ];
    let timestamp = 34;
    for (const [name, event] of events) {
      dispatch(referenceHost, name, event);
      dispatch(independentHost, name, event);
      reference.frame(timestamp);
      independent.frame(timestamp);
      assert.deepEqual(independentRuntime.snapshot(), mountedSnapshot(result, referenceHost, reference), `${label}: ${name} retained tree`);
      compareWrites(`${name} publication`);
      clearWrites(reference, independent);
      timestamp += 34;
    }

    assert.equal(referenceRuntime.setMode("animation"), "animation");
    assert.equal(independentRuntime.setMode("animation"), "animation");
    compareWrites("animation reset");
    clearWrites(reference, independent);
    reference.frame(timestamp);
    independent.frame(timestamp);
    compareWrites("animation tick zero");
    clearWrites(reference, independent);
    timestamp += 34;
    reference.frame(timestamp);
    independent.frame(timestamp);
    compareWrites("animation frame two");

    assert.ok(transcript.some(([id, property, value]) => (
      id === "independent/effects/particle:0"
      && property === "visibility"
      && value === "visible"
    )), `${label}: effects codec never visibly published`);
    assert.ok(transcript.some(([id, property, value]) => (
      id === "independent/leaf:grab"
      && property === "backgroundPositionY"
      && value === "-32px"
    )), `${label}: surface codec never changed atlas state`);
    assert.ok(transcript.some(([id, property, value]) => (
      id === "independent/leaf:grab"
      && property === "transform"
      && value === "matrix3d(1,0,0,0,0,1,0,0,0,0,1,0,16,0,0,1)"
    )), `${label}: playback codec never published its second-frame transform`);
  } finally {
    assert.equal(referenceRuntime.destroy(), true);
    assert.equal(independentRuntime.destroy(), true);
    assert.equal(referenceRuntime.destroy(), false);
    assert.equal(independentRuntime.destroy(), false);
  }
}

test("independent producer has a mechanically enforced implementation and fixture boundary", async () => {
  const source = await readFile(producer, "utf8");
  assert.doesNotMatch(source, /(?:^|["'])\.\.\/src\//mu);
  assert.doesNotMatch(source, /(?:^|["'])(?:src|test|fixtures)\//mu);
  assert.doesNotMatch(source, /^\s*(?:from|import)\s+(?:reader|domformat)\b/mu);
  assert.doesNotMatch(source, /read_(?:bytes|text)\s*\(/u);
  assert.match(source, /It is conformance evidence, not a public producer API/u);
});

test("independent producer emits deterministic canonical JSON and sibling resources", async () => {
  const directory = await mkdtemp(join(tmpdir(), "domformat-independent-producer-determinism-"));
  try {
    const first = await produce(join(directory, "canonical-a"));
    const second = await produce(join(directory, "canonical-b"));
    assert.deepEqual(first.bytes, second.bytes, "JSON document bytes");
    assert.equal(first.summary.sha256, second.summary.sha256, "JSON digest");
    assert.equal(first.summary.codecs, 5);
    assert.equal(first.bytes[0], 0x7b);
    const decoded = await readDomFile(first.model);
    const parsed = JSON.parse(new TextDecoder().decode(decoded.transport.bytes));
    assert.deepEqual(decoded.transport.bytes, encodeCanonicalJson(parsed), "canonical JSON");
    for (const record of decoded.document.resources.resources) {
      const left = await readFile(join(first.directory, ...record.path.split("/")));
      const right = await readFile(join(second.directory, ...record.path.split("/")));
      assert.deepEqual(left, right, `resource ${record.id}`);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("independent producer preflights every sibling target without partial output", async () => {
  const directory = await mkdtemp(join(tmpdir(), "domformat-independent-producer-preflight-"));
  try {
    const existingCss = join(directory, "independent.css");
    const sentinel = new TextEncoder().encode("existing user file\n");
    await writeFile(existingCss, sentinel);
    const model = join(directory, "independent.json");
    const result = spawnSync("python3", ["-B", producer, model], { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /Refusing to overwrite resource/u);
    assert.deepEqual(await readFile(existingCss), Buffer.from(sentinel));
    await assert.rejects(access(model));
    await assert.rejects(access(join(directory, "assets")));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Node, browser, and Python accept independent canonical and ordinary JSON", async () => {
  const directory = await mkdtemp(join(tmpdir(), "domformat-independent-producer-readers-"));
  try {
    const canonical = await produce(join(directory, "canonical"));
    const ordinary = await produce(join(directory, "ordinary"), ["--ordinary"]);
    const canonicalNode = await readDomFile(canonical.model);
    const ordinaryNode = await readDomFile(ordinary.model);
    assert.equal(canonicalNode.document.state.channels.length, 5);
    assert.deepEqual(canonicalNode.document, ordinaryNode.document);
    assert.equal(ordinaryNode.transport.encoding, "json");
    assert.match(new TextDecoder().decode(ordinary.bytes), /"version": 0e0/u);
    assert.notDeepEqual(ordinaryNode.transport.bytes, canonicalNode.transport.bytes);

    for (const produced of [canonical, ordinary]) {
      const validation = runPython([reader, "validate", produced.model]);
      assert.match(validation, /11 nodes; 2 resources verified/u);
    }
    const canonicalBrowser = await browserResult(canonical, canonicalNode);
    const ordinaryBrowser = await browserResult(ordinary, ordinaryNode);
    assert.deepEqual(canonicalBrowser.document, ordinaryBrowser.document);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("production and production-free probe/viewer paths publish the Python-produced contract identically", async () => {
  const directory = await mkdtemp(join(tmpdir(), "domformat-independent-producer-viewers-"));
  try {
    const produced = await produce(join(directory, "canonical"));
    const nodeResult = await readDomFile(produced.model);
    const referenceResult = await browserResult(produced, nodeResult);
    const nVersionResult = await readDomNVersion(produced.bytes, { externalResources: nodeResult.resourceBytes });
    assert.deepEqual(plainDocument(nVersionResult.document), referenceResult.document);
    await assertViewerPair(referenceResult, "canonical JSON", nVersionResult);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
