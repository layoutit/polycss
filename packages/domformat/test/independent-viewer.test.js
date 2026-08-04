import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { mountDom, readDomBrowser } from "../src/browser.js";
import { buildDom } from "../src/writer.js";
import { mountConformanceDom } from "../conformance/viewer/mount.js";
import {
  builtExternalResources,
  projectRoot,
  syntheticExecutableInteractionInput,
  syntheticPolycssInput,
  syntheticStaticPresentationInput,
  syntheticTwoFramePolycssInput,
} from "./helpers.js";
import { dispatch, FakeElement, fakeBrowserDocument } from "./fake-browser.js";

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
const INDEPENDENT_FILES = Object.freeze([
  "conformance/viewer/errors.js",
  "conformance/viewer/numeric.js",
  "conformance/viewer/triangle.js",
  "conformance/viewer/playback.js",
  "conformance/viewer/effects.js",
  "conformance/viewer/interaction.js",
  "conformance/viewer/input.js",
  "conformance/viewer/mount.js",
]);

function resourceUrls(result, fake) {
  const ids = result.document.resources.resources.filter((record) => record.kind !== "stylesheet").map((record) => record.id);
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

function referenceSnapshot(result, host, fake) {
  const surface = host.childNodes[0];
  const elements = fake.namespaced;
  const urls = resourceUrls(result, fake);
  return {
    mount: {
      attributes: result.document.tree.mount.attributes.map(([name]) => [name, surface.getAttribute(name)]),
      styles: styles(surface, urls),
    },
    nodes: result.document.tree.nodes.map((node) => {
      const element = elements[node.index];
      const parent = element.parentNode === surface ? -1 : elements.indexOf(element.parentNode);
      const attributeNames = [...Object.keys(node.attributes ?? {}), ...Object.keys(node.resourceAttributes ?? {})].sort();
      return {
        id: node.id,
        index: node.index,
        parent,
        sibling: element.parentNode.childNodes.indexOf(element),
        namespace: element.namespaceURI,
        name: element.localName,
        classes: [...element.classes],
        attributes: Object.fromEntries(attributeNames.map((name) => [name, normalize(element.getAttribute(name), urls)])),
        styles: styles(element, urls),
      };
    }),
  };
}

function normalizedCss(result, fake) {
  const urls = resourceUrls(result, fake);
  return fake.document.head.childNodes.map((element) => {
    let text = normalize(element.textContent, urls);
    text = text.replace(/\[data-domformat-instance="[^"]+"\]/gu, "[data-domformat-instance=INSTANCE]");
    return text;
  });
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

function clearWrites(...fakes) {
  for (const fake of fakes) fake.writes.splice(0);
}

async function mountedPair(input, options = {}) {
  const built = buildDom(input);
  const result = await readDomBrowser(built.bytes, { externalResources: builtExternalResources(built) });
  const reference = fakeBrowserDocument();
  const independent = fakeBrowserDocument();
  const referenceHost = new FakeElement(reference.document, "main");
  const independentHost = new FakeElement(independent.document, "main");
  const referencePhases = [];
  const independentPhases = [];
  const referenceRuntime = await mountDom(result, referenceHost, {
    animate: options.animate ?? false,
    mode: options.mode,
    onLifecyclePhase: (phase) => referencePhases.push(phase),
  });
  const independentRuntime = await mountConformanceDom(result, independentHost, {
    animate: options.animate ?? false,
    mode: options.mode,
    onLifecyclePhase: (phase) => independentPhases.push(phase),
  });
  return {
    result,
    reference,
    independent,
    referenceHost,
    independentHost,
    referencePhases,
    independentPhases,
    referenceRuntime,
    independentRuntime,
  };
}

function assertEquivalent(value, label) {
  assert.deepEqual(value.independentRuntime.snapshot(), referenceSnapshot(value.result, value.referenceHost, value.reference), label);
  assert.deepEqual(normalizedCss(value.result, value.independent), normalizedCss(value.result, value.reference), `${label}: CSS closure`);
}

test("independent viewer has a mechanically enforced production-runtime import boundary", async () => {
  for (const file of INDEPENDENT_FILES) {
    const source = await readFile(resolve(projectRoot, file), "utf8");
    assert.doesNotMatch(source, /(?:^|["'])\.\.\/\.\.\/src\//mu, file);
    assert.doesNotMatch(source, /(?:^|["'])\.\.\/src\//mu, file);
    assert.doesNotMatch(source, /from\s+["'][^"']*src\//mu, file);
  }
});

test("independent viewer reconstructs the exact stable tree, initial publication, CSS closure, and lifecycle", async () => {
  const value = await mountedPair(await syntheticPolycssInput());
  assert.deepEqual(value.independentPhases, value.referencePhases);
  assert.deepEqual(value.independentPhases, ["validate", "construct", "bind", "initialize", "publish"]);
  assertEquivalent(value, "initial publication");
  assert.deepEqual(
    normalizedWrites(value.result, value.independentHost, value.independent),
    normalizedWrites(value.result, value.referenceHost, value.reference),
    "initial DOM write transcript",
  );

  const identities = new Map(value.result.document.tree.nodes.map((node) => [node.id, value.independentRuntime.node(node.id)]));
  value.independentRuntime.advance();
  for (const [id, element] of identities) assert.equal(value.independentRuntime.node(id), element, `identity ${id}`);

  assert.equal(value.referenceRuntime.destroy(), true);
  assert.equal(value.independentRuntime.destroy(), true);
  assert.equal(value.referenceRuntime.destroy(), false);
  assert.equal(value.independentRuntime.destroy(), false);
  assert.deepEqual(value.independentPhases, value.referencePhases);
  assert.deepEqual(value.independentPhases, ["validate", "construct", "bind", "initialize", "publish", "destroy"]);
  assert.equal(value.referenceHost.childNodes.length, 0);
  assert.equal(value.independentHost.childNodes.length, 0);
});

test("initial playback preserves an identical TREE scene transform without reassigning it", async () => {
  const value = await mountedPair(await syntheticPolycssInput());
  for (const [label, host, fake] of [
    ["public", value.referenceHost, value.reference],
    ["independent", value.independentHost, value.independent],
  ]) {
    const writes = normalizedWrites(value.result, host, fake).filter(([id, property]) => (
      id === "synthetic-polycss/model" && property === "transform"
    ));
    assert.deepEqual(writes, [["synthetic-polycss/model", "transform", "translate3d(0px, 0px, 0px)"]], label);
  }
  value.referenceRuntime.destroy();
  value.independentRuntime.destroy();
});

test("independent and public viewers agree on static presentation without playback or effects", async () => {
  const value = await mountedPair(await syntheticStaticPresentationInput());
  assertEquivalent(value, "static presentation");
  assert.equal(value.referenceRuntime.sourceFrame, 1);
  assert.equal(value.independentRuntime.sourceFrame, 1);
  assert.equal(value.referenceRuntime.seek(1), 1);
  assert.equal(value.independentRuntime.seek(1), 1);
  assert.throws(() => value.referenceRuntime.seek(2), (error) => error?.code === "FRAME_RANGE");
  assert.throws(() => value.independentRuntime.seek(2), (error) => error?.code === "FRAME_RANGE");
  value.referenceRuntime.destroy();
  value.independentRuntime.destroy();
});

test("independent CSS materialization rewrites URL tokens but not url-like text inside strings", async () => {
  const input = await syntheticPolycssInput();
  const stylesheet = input.resourceInputs.find((resource) => resource.id === "model-css");
  const scope = input.cssBinding.stylesheets[0].scope;
  const css = new TextDecoder().decode(stylesheet.bytes);
  stylesheet.bytes = new TextEncoder().encode(`${css}\n${scope} .leaf{content:"url(dom-asset:checker)";}`);
  const value = await mountedPair(input);
  assertEquivalent(value, "CSS string token isolation");
  const materialized = normalizedCss(value.result, value.independent).join("\n");
  assert.match(materialized, /content:"url\(dom-asset:checker\)"/u);
  value.referenceRuntime.destroy();
  value.independentRuntime.destroy();
});

test("independent and public viewers publish identical ordered animation transitions and wrap", async () => {
  const value = await mountedPair(await syntheticTwoFramePolycssInput(), { animate: true });
  assertEquivalent(value, "animation initial");
  clearWrites(value.reference, value.independent);

  assert.equal(value.reference.frame(0), 1);
  assert.equal(value.independent.frame(0), 1);
  assert.deepEqual(normalizedWrites(value.result, value.independentHost, value.independent), normalizedWrites(value.result, value.referenceHost, value.reference));
  clearWrites(value.reference, value.independent);

  value.reference.frame(34);
  value.independent.frame(34);
  assertEquivalent(value, "animation frame 2");
  assert.deepEqual(
    normalizedWrites(value.result, value.independentHost, value.independent),
    normalizedWrites(value.result, value.referenceHost, value.reference),
    "frame 1 to 2 write order",
  );
  clearWrites(value.reference, value.independent);

  value.reference.frame(68);
  value.independent.frame(68);
  assertEquivalent(value, "animation wrap to frame 1");
  assert.deepEqual(
    normalizedWrites(value.result, value.independentHost, value.independent),
    normalizedWrites(value.result, value.referenceHost, value.reference),
    "frame 2 to 1 write order",
  );
  value.referenceRuntime.destroy();
  value.independentRuntime.destroy();
});

test("independent and public viewers catch up every due fixed-rate playback tick", async () => {
  const value = await mountedPair(await syntheticTwoFramePolycssInput(), { animate: true });
  value.reference.frame(0);
  value.independent.frame(0);
  clearWrites(value.reference, value.independent);

  value.reference.frame(68);
  value.independent.frame(68);
  assert.equal(value.referenceRuntime.sourceFrame, 1);
  assert.equal(value.independentRuntime.sourceFrame, 1);
  assertEquivalent(value, "two-tick RAF catch-up");
  assert.deepEqual(
    normalizedWrites(value.result, value.independentHost, value.independent),
    normalizedWrites(value.result, value.referenceHost, value.reference),
    "two-tick RAF catch-up write order",
  );
  value.referenceRuntime.destroy();
  value.independentRuntime.destroy();
});

test("independent and public viewers agree through pointer pick, drag, release, effects, and mode reset", async () => {
  const value = await mountedPair(await syntheticExecutableInteractionInput(), { animate: true, mode: "interaction" });
  assertEquivalent(value, "interaction initial");
  const independentIdentities = new Map(value.result.document.tree.nodes.map((node) => [node.id, value.independentRuntime.node(node.id)]));
  value.reference.frame(0);
  value.independent.frame(0);
  clearWrites(value.reference, value.independent);

  const events = [
    ["pointerdown", { button: 0, pointerId: 1, clientX: 160, clientY: 120 }],
    ["pointermove", { pointerId: 1, clientX: 170, clientY: 120 }],
    ["pointermove", { pointerId: 1, clientX: 180, clientY: 125 }],
    ["pointerup", { button: 0, pointerId: 1, clientX: 180, clientY: 125 }],
  ];
  let timestamp = 34;
  for (const [name, event] of events) {
    dispatch(value.referenceHost, name, event);
    dispatch(value.independentHost, name, event);
    value.reference.frame(timestamp);
    value.independent.frame(timestamp);
    assertEquivalent(value, `interaction ${name}`);
    assert.deepEqual(
      normalizedWrites(value.result, value.independentHost, value.independent),
      normalizedWrites(value.result, value.referenceHost, value.reference),
      `${name} write order`,
    );
    clearWrites(value.reference, value.independent);
    timestamp += 34;
  }
  for (const [id, element] of independentIdentities) assert.equal(value.independentRuntime.node(id), element, `interaction identity ${id}`);

  assert.equal(value.referenceRuntime.setMode("animation"), "animation");
  assert.equal(value.independentRuntime.setMode("animation"), "animation");
  assertEquivalent(value, "interaction teardown to animation");
  assert.deepEqual(
    normalizedWrites(value.result, value.independentHost, value.independent),
    normalizedWrites(value.result, value.referenceHost, value.reference),
    "mode reset write order",
  );
  value.referenceRuntime.destroy();
  value.independentRuntime.destroy();
});

test("independent viewer rolls back partial phases and keeps destroy idempotent", async () => {
  const built = buildDom(await syntheticPolycssInput());
  const result = await readDomBrowser(built.bytes, { externalResources: builtExternalResources(built) });
  for (const failedPhase of ["construct", "bind", "publish"]) {
    const fake = fakeBrowserDocument();
    const host = new FakeElement(fake.document, "main");
    const prior = new FakeElement(fake.document, "p");
    host.appendChild(prior);
    const replaceChildren = host.replaceChildren.bind(host);
    let replacements = 0;
    host.replaceChildren = (...children) => {
      replacements += 1;
      return replaceChildren(...children);
    };
    host.style.position = "sticky";
    const phases = [];
    await assert.rejects(mountConformanceDom(result, host, {
      animate: false,
      onLifecyclePhase(phase) {
        phases.push(phase);
        if (phase === failedPhase) throw new Error(`injected ${failedPhase} failure`);
      },
    }), new RegExp(`injected ${failedPhase} failure`, "u"));
    assert.deepEqual(host.childNodes, [prior]);
    assert.equal(host.style.position, "sticky");
    assert.equal(host.hasAttribute("tabindex"), false);
    assert.equal(fake.document.head.childNodes.length, 0);
    assert.deepEqual(fake.urls.revoked, fake.urls.created);
    assert.equal(phases.at(-1), "destroy");
    assert.equal(replacements, failedPhase === "publish" ? 2 : 0);
  }
});
