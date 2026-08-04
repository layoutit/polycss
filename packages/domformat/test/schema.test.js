import test from "node:test";
import assert from "node:assert/strict";
import { buildDom } from "../src/writer.js";
import { crc32 } from "../src/crc32.js";
import { materializeCss } from "../src/resources.js";
import { cssScopeAttribute } from "../src/css.js";
import { validateDocument } from "../src/schema.js";
import {
  errorCode,
  syntheticAnimationWithoutEffectsInput,
  syntheticEffectsWithoutPlaybackInput,
  syntheticEmptySurfaceInput,
  syntheticInput,
  syntheticPlaybackWithoutSurfaceInput,
  syntheticPolycssInput,
  syntheticStaticPresentationInput,
  syntheticTwoFramePolycssInput,
} from "./helpers.js";

function copy(value) {
  return globalThis.structuredClone(value);
}

function insertPngChunk(bytes, type, payload) {
  const chunk = new Uint8Array(12 + payload.length);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, payload.length, false);
  chunk.set(new TextEncoder().encode(type), 4);
  chunk.set(payload, 8);
  view.setUint32(8 + payload.length, crc32(chunk.subarray(4, 8 + payload.length)), false);
  const afterIhdr = 8 + 12 + 13;
  const output = new Uint8Array(bytes.length + chunk.length);
  output.set(bytes.subarray(0, afterIhdr));
  output.set(chunk, afterIhdr);
  output.set(bytes.subarray(afterIhdr), afterIhdr + chunk.length);
  return output;
}

test("public document validation exposes no internal maps or limits", async () => {
  const built = buildDom(await syntheticInput());
  assert.equal(validateDocument(built.document), undefined);
});

test("rejects duplicate ids, invalid parents, forbidden elements, and event attributes", async () => {
  const input = await syntheticInput();
  const duplicate = copy(input);
  duplicate.tree.nodes[2].id = duplicate.tree.nodes[1].id;
  assert.throws(() => buildDom(duplicate), errorCode("DUPLICATE_NODE_ID"));
  const parent = copy(input);
  parent.tree.nodes[1].parent = 2;
  assert.throws(() => buildDom(parent), errorCode("INVALID_PARENT"));
  const script = copy(input);
  script.tree.nodes[2].name = "script";
  assert.throws(() => buildDom(script), errorCode("FORBIDDEN_ELEMENT"));
  const handler = copy(input);
  handler.tree.nodes[2].attributes.onclick = "alert(1)";
  assert.throws(() => buildDom(handler), errorCode("UNSAFE_ATTRIBUTE"));
  const fixedMount = copy(input);
  fixedMount.tree.mount.styles.position = "fixed";
  assert.throws(() => buildDom(fixedMount), errorCode("INVALID_MOUNT"));
  const transformedMount = copy(input);
  transformedMount.tree.mount.styles.transform = "scale(2)";
  assert.throws(() => buildDom(transformedMount), errorCode("UNSAFE_STYLE_PROPERTY"));
  const duplicateClassSource = copy(input);
  duplicateClassSource.tree.nodes[0].attributes.class = "overrides-classes";
  assert.throws(() => buildDom(duplicateClassSource), errorCode("UNSAFE_ATTRIBUTE"));
});

test("accepts the closed PolyCSS strategy element and inline style vocabulary", async () => {
  const input = await syntheticInput();
  const leaf = input.tree.nodes.find((node) => !input.tree.nodes.some((candidate) => candidate.parent === node.index));
  leaf.name = "b";
  Object.assign(leaf.styles, {
    borderBottomLeftRadius: "0",
    borderBottomRightRadius: "25%",
    borderShape: "polygon(0 0, 100% 0, 100% 100%)",
    borderTopLeftRadius: "50% 100%",
    borderTopRightRadius: "50% 100%",
    color: "rgb(12, 34, 56)",
    cornerBottomLeftShape: "initial",
    cornerBottomRightShape: "bevel",
    cornerTopLeftShape: "bevel",
    cornerTopRightShape: "initial",
  });
  assert.doesNotThrow(() => buildDom(input));
});

test("accepts an empty prepared surface for retained documents without surface leaves", async () => {
  const input = await syntheticEmptySurfaceInput();
  assert.doesNotThrow(() => buildDom(input));
});

test("accepts static presentation, animation without effects, and leafless playback without surface", async () => {
  for (const input of await Promise.all([
    syntheticStaticPresentationInput(),
    syntheticAnimationWithoutEffectsInput(),
    syntheticPlaybackWithoutSurfaceInput(),
  ])) assert.doesNotThrow(() => buildDom(input));
});

test("rejects missing playback tick rate and incomplete optional presentation groups", async () => {
  const tickRate = await syntheticPolycssInput();
  delete tickRate.bindings.channels.find((channel) => channel.interpreter === "polycss-playback@0").parameters.tickRateHz;
  assert.throws(() => buildDom(tickRate), errorCode("INVALID_PLAYBACK_BINDING"));

  const cursor = await syntheticStaticPresentationInput();
  cursor.bindings.channels[0].targets.cursorLayer = "synthetic-polycss/model";
  assert.throws(() => buildDom(cursor), errorCode("INVALID_PRESENTATION_BINDING"));

  const background = await syntheticStaticPresentationInput();
  background.state.channels[0].data.packet.background = null;
  assert.throws(() => buildDom(background), errorCode("INVALID_PRESENTATION_STATE"));
});

test("rejects inert effects without executable playback", async () => {
  const input = await syntheticEffectsWithoutPlaybackInput();
  assert.throws(() => buildDom(input), errorCode("MISSING_POLYCSS_CHANNEL"));
});

test("attribute and CSS scope identifiers have closed length bounds", async () => {
  const input = await syntheticInput();
  const exact = copy(input);
  exact.tree.nodes[0].attributes[`data-${"a".repeat(64)}`] = "v";
  assert.doesNotThrow(() => buildDom(exact));

  const excessive = copy(input);
  excessive.tree.nodes[0].attributes[`data-${"a".repeat(65)}`] = "v";
  assert.throws(() => buildDom(excessive), errorCode("UNSAFE_ATTRIBUTE"));
  assert.deepEqual(cssScopeAttribute(`[data-${"a".repeat(64)}="v"]`), { name: `data-${"a".repeat(64)}`, value: "v" });
  assert.throws(() => cssScopeAttribute(`[data-${"a".repeat(65)}="v"]`), errorCode("INVALID_CSS_SCOPE"));
});

test("rejects unsafe paths, URLs, imports, and CSS scope escapes", async () => {
  const input = await syntheticInput();
  const path = copy(input);
  path.resourceInputs[0].path = "../escape.ppm";
  assert.throws(() => buildDom(path), errorCode("UNSAFE_RESOURCE_PATH"));
  const url = copy(input);
  url.resourceInputs.find((resource) => resource.kind === "stylesheet").bytes = new TextEncoder().encode('[data-domformat-root="synthetic"]{background:url("https://example.test/a")}' + "\n");
  assert.throws(() => buildDom(url), errorCode("UNSAFE_CSS"));
  const imported = copy(input);
  imported.resourceInputs.find((resource) => resource.kind === "stylesheet").bytes = new TextEncoder().encode('@import "other.css";' + "\n");
  assert.throws(() => buildDom(imported), errorCode("UNSAFE_CSS"));
  const escaped = copy(input);
  escaped.resourceInputs.find((resource) => resource.kind === "stylesheet").bytes = new TextEncoder().encode('body { color: red }' + "\n");
  assert.throws(() => buildDom(escaped), errorCode("CSS_SCOPE_ESCAPE"));
  const duplicatePath = copy(input);
  duplicatePath.resourceInputs[1].path = duplicatePath.resourceInputs[0].path;
  assert.throws(() => buildDom(duplicatePath), errorCode("DUPLICATE_RESOURCE_PATH"));
  const caseAlias = copy(input);
  caseAlias.resourceInputs[1].path = caseAlias.resourceInputs[0].path.toUpperCase();
  assert.throws(() => buildDom(caseAlias), errorCode("DUPLICATE_RESOURCE_PATH"));
  const prefixCollision = copy(input);
  prefixCollision.resourceInputs[1].path = `${prefixCollision.resourceInputs[0].path}/model.css`;
  assert.throws(() => buildDom(prefixCollision), errorCode("RESOURCE_PATH_COLLISION"));
  for (const unsafe of ["assets/CON.png", "assets/trailing."]) {
    const nonportable = copy(input);
    nonportable.resourceInputs[0].path = unsafe;
    assert.throws(() => buildDom(nonportable), errorCode("UNSAFE_RESOURCE_PATH"));
  }
});

test("terminal visual nodes require an explicit aria-hidden contract", async () => {
  const input = await syntheticInput();
  const terminal = input.tree.nodes.find((node) => !input.tree.nodes.some((candidate) => candidate.parent === node.index));
  delete terminal.attributes["aria-hidden"];
  assert.throws(() => buildDom(input), errorCode("ACCESSIBILITY_REQUIRED"));
});

test("CSS closure rejects indirect networking, escapes, sibling scope exits, and mismatched mounts", async () => {
  const input = await syntheticInput();
  const cssResource = (value) => {
    const changed = copy(input);
    changed.resourceInputs.find((resource) => resource.kind === "stylesheet").bytes = new TextEncoder().encode(`${value}\n`);
    return changed;
  };
  assert.throws(
    () => buildDom(cssResource('[data-domformat-root="synthetic"]{background-image:image-set("https://example.test/a" 1x)}')),
    errorCode("UNSAFE_CSS_FUNCTION"),
  );
  assert.throws(
    () => buildDom(cssResource('[data-domformat-root="synthetic"]{background-image:u\\72l("https://example.test/a")}')),
    errorCode("UNSAFE_CSS_ESCAPE"),
  );
  assert.throws(
    () => buildDom(cssResource('[data-domformat-root="synthetic"] ~ *{color:red}')),
    errorCode("CSS_SCOPE_ESCAPE"),
  );
  const mismatch = copy(input);
  mismatch.cssBinding.stylesheets[0].scope = '[data-domformat-root="other"]';
  assert.throws(() => buildDom(mismatch), errorCode("CSS_SCOPE_MISMATCH"));
  const reserved = copy(input);
  reserved.tree.mount.attributes.push(["data-domformat-instance", "package-controlled"]);
  assert.throws(() => buildDom(reserved), errorCode("UNSAFE_ATTRIBUTE"));
  const surface = copy(input);
  surface.tree.mount.attributes.push(["data-domformat-mount-surface", "package-controlled"]);
  assert.throws(() => buildDom(surface), errorCode("UNSAFE_ATTRIBUTE"));
  const nodeSurface = copy(input);
  nodeSurface.tree.nodes[0].attributes["data-domformat-mount-surface"] = "package-controlled";
  assert.throws(() => buildDom(nodeSurface), errorCode("UNSAFE_ATTRIBUTE"));
});

test("CSS materialization rewrites exact token and scope spans in one pass", () => {
  const scope = '[data-domformat-root="synthetic"]';
  const binding = {
    id: "model-css",
    scope,
    assetTokens: [
      { token: "dom-asset:foo", resource: "foo" },
      { token: "dom-asset:foo-bar", resource: "foo-bar" },
    ],
  };
  const css = `${scope}{background-image:url("dom-asset:foo"),url(dom-asset:foo-bar)}`;
  const output = materializeCss(css, binding, new Map([
    ["foo", "blob:short"],
    ["foo-bar", "blob:long"],
  ]), { scope: '[data-domformat-instance="d0"]' });
  assert.equal(output, '[data-domformat-instance="d0"]{background-image:url("blob:short"),url("blob:long")}');
});

test("CSS and binding cardinality limits reject unused or excessive declarations", async () => {
  const input = await syntheticInput();
  assert.throws(() => buildDom(input, { limits: { maxCssRules: 1 } }), errorCode("CSS_RULE_LIMIT"));
  assert.throws(() => buildDom(input, { limits: { maxCssAssetTokens: 0 } }), errorCode("CSS_TOKEN_LIMIT"));
  const executable = await syntheticPolycssInput();
  assert.throws(() => buildDom(executable, { limits: { maxBindingInputs: 0 } }), errorCode("BINDING_INPUT_LIMIT"));
  const unused = copy(executable);
  unused.bindings.inputs.push({ id: "zz-unused", type: "boolean", default: false });
  assert.throws(() => buildDom(unused), errorCode("UNUSED_INPUT"));
});

test("rejects unsupported format and profile declarations", async () => {
  const input = await syntheticInput();
  const built = buildDom(input);
  const document = copy(built.document);
  document.meta.profile = "private-producer-adapter@0";
  assert.throws(() => validateDocument(document), errorCode("UNSUPPORTED_PROFILE"));
  document.meta.profile = "polycss-3d@0";
  document.meta.format = "gzip-wrapper@0";
  assert.throws(() => validateDocument(document), errorCode("UNSUPPORTED_FORMAT"));
});

test("META fails unknown required capabilities and safely ignores unknown optional ones", async () => {
  const built = buildDom(await syntheticInput());
  const optional = copy(built.document);
  optional.meta.optionalCapabilities = ["future-decoration"];
  assert.doesNotThrow(() => validateDocument(optional));

  const unknown = copy(built.document);
  unknown.meta.capabilities.push("future-required");
  assert.throws(() => validateDocument(unknown), errorCode("UNSUPPORTED_REQUIRED_CAPABILITY"));

  const missing = copy(built.document);
  delete missing.meta.capabilities;
  assert.throws(() => validateDocument(missing), errorCode("INVALID_META"));

  const overlap = copy(built.document);
  overlap.meta.optionalCapabilities = [overlap.meta.capabilities[0]];
  assert.throws(() => validateDocument(overlap), errorCode("INVALID_META"));

  const experience = copy(built.document);
  experience.meta.initialExperience = "webpage-replay";
  assert.throws(() => validateDocument(experience), errorCode("INVALID_META"));

  const unavailable = copy(built.document);
  unavailable.meta.initialExperience = "interaction";
  unavailable.meta.capabilities.push("prepared-pointer-grab-interaction");
  assert.throws(() => validateDocument(unavailable), errorCode("MISSING_INITIAL_EXPERIENCE"));

  const polycss = buildDom(await syntheticPolycssInput()).document;
  const underdeclared = copy(polycss);
  underdeclared.meta.capabilities = underdeclared.meta.capabilities.filter((value) => value !== "prepared-playback");
  assert.throws(() => validateDocument(underdeclared), errorCode("CAPABILITY_CLOSURE_MISMATCH"));
  const falseConformance = copy(polycss);
  falseConformance.meta.conformance.executable[1] = "future-viewer-only";
  assert.throws(() => validateDocument(falseConformance), errorCode("CONFORMANCE_CLOSURE_MISMATCH"));
  const declaredOnly = copy(polycss);
  declaredOnly.meta.conformance.declaredOnly.push("future-viewer-only");
  assert.throws(() => validateDocument(declaredOnly), errorCode("CONFORMANCE_CLOSURE_MISMATCH"));
});

test("rejects unknown tree fields and codec/interpreter mismatches", async () => {
  const input = await syntheticInput();
  const unknown = copy(input);
  unknown.tree.nodes[0].adapterPrivateState = { executable: "no" };
  assert.throws(() => buildDom(unknown), errorCode("INVALID_NODE"));
  const mismatch = copy(await syntheticPolycssInput());
  mismatch.bindings.channels[0].interpreter = "static-presentation@0";
  assert.throws(() => buildDom(mismatch), errorCode("STATE_INTERPRETER_MISMATCH"));
});

test("validates image identity, dimensions, and semantic resource roles", async () => {
  const input = await syntheticInput();
  assert.throws(() => buildDom(input, { limits: { maxImagePixels: 1 } }), errorCode("IMAGE_DIMENSION_LIMIT"));
  assert.throws(() => buildDom(input, { limits: { maxAggregateImagePixels: 3 } }), errorCode("AGGREGATE_IMAGE_PIXEL_LIMIT"));
  const animatedPng = copy(input);
  const checker = animatedPng.resourceInputs.find((resource) => resource.id === "checker");
  const animationControl = new Uint8Array(8);
  new DataView(animationControl.buffer).setUint32(0, 2, false);
  checker.bytes = insertPngChunk(checker.bytes, "acTL", animationControl);
  assert.throws(() => buildDom(animatedPng), errorCode("IMAGE_ANIMATION_UNSUPPORTED"));
  const malformedImage = copy(input);
  malformedImage.resourceInputs.find((resource) => resource.id === "checker").bytes = new TextEncoder().encode("not a png");
  assert.throws(() => buildDom(malformedImage), errorCode("IMAGE_MEDIA_MISMATCH"));
  const wrongRole = copy(input);
  wrongRole.cssBinding.stylesheets[0].assetTokens[0].resource = "model-css";
  assert.throws(() => buildDom(wrongRole), errorCode("RESOURCE_ROLE_MISMATCH"));
  const unused = copy(input);
  unused.resourceInputs.push({
    id: "unused",
    kind: "binary",
    mediaType: "application/octet-stream",
    path: "unused.bin",
    bytes: new Uint8Array([1, 2, 3]),
  });
  assert.throws(() => buildDom(unused), errorCode("INVALID_RESOURCE_KIND"));

  const headerOnlyWebp = copy(input);
  const webp = new Uint8Array(30);
  webp.set(new TextEncoder().encode("RIFF"), 0);
  new DataView(webp.buffer).setUint32(4, 22, true);
  webp.set(new TextEncoder().encode("WEBPVP8X"), 8);
  new DataView(webp.buffer).setUint32(16, 10, true);
  headerOnlyWebp.resourceInputs[0].mediaType = "image/webp";
  headerOnlyWebp.resourceInputs[0].bytes = webp;
  assert.throws(() => buildDom(headerOnlyWebp), errorCode("IMAGE_MEDIA_MISMATCH"));
});

test("rejects unknown resource catalog, record, digest, dimensions, and legacy storage fields", async () => {
  const input = await syntheticInput();
  const built = buildDom(input);
  const cases = [
    ["INVALID_RESOURCES", (document) => { document.resources.privateUrl = "https://example.test/catalog"; }],
    ["INVALID_RESOURCE", (document) => { document.resources.resources[0].privateUrl = "https://example.test/resource"; }],
    ["INVALID_RESOURCE_DIGEST", (document) => { document.resources.resources[0].digest.trustMe = true; }],
    ["INVALID_RESOURCE_DIMENSIONS", (document) => { document.resources.resources[0].dimensions.channels = 4; }],
    ["INVALID_RESOURCE", (document) => { document.resources.resources[0].storage = { mode: "external", path: "asset.png" }; }],
    ["UNSAFE_RESOURCE_PATH", (document) => { document.resources.resources[0].path = "https://example.test/asset"; }],
  ];
  for (const [code, mutate] of cases) {
    const document = copy(built.document);
    mutate(document);
    assert.throws(() => validateDocument(document), errorCode(code));
  }
});

test("rejects context-dependent inline styles and obsolete state-machine surface", async () => {
  const input = await syntheticInput();
  const contextual = copy(input);
  contextual.tree.nodes[2].styles.transform = "translateX(var(--embedding-owned-offset))";
  assert.throws(() => buildDom(contextual), errorCode("UNSAFE_STYLE_VALUE"));
  const environment = copy(input);
  environment.tree.nodes[2].styles.transform = "translateX(env(safe-area-inset-left))";
  assert.throws(() => buildDom(environment), errorCode("UNSAFE_STYLE_VALUE"));
  const obsolete = copy(input);
  obsolete.state.channels.push({ id: "frames", codec: "style-frames@0", data: { frames: [] } });
  assert.throws(() => buildDom(obsolete), errorCode("UNSUPPORTED_STATE_CODEC"));
  const declared = copy(await syntheticPolycssInput());
  declared.bindings.channels[0].status = "declared";
  assert.throws(() => buildDom(declared), errorCode("INVALID_BINDING_STATUS"));
});

test("rejects malformed, empty, host-escaped, or excessive binding targets before execution", async () => {
  const input = await syntheticPolycssInput();
  const malformed = copy(input);
  malformed.bindings.channels[0].targets.emitters[0][0] = null;
  assert.throws(() => buildDom(malformed), errorCode("INVALID_TARGETS"));
  const empty = copy(input);
  empty.bindings.channels[0].targets = {};
  assert.throws(() => buildDom(empty), errorCode("INVALID_TARGETS"));

  const polycss = await syntheticPolycssInput();
  const hostLeaf = copy(polycss);
  hostLeaf.bindings.channels.find((channel) => channel.interpreter === "polycss-playback@0").targets.leaves[0] = "$host";
  assert.throws(() => buildDom(hostLeaf), errorCode("INVALID_STABLE_ID"));

  const excessive = copy(input);
  excessive.bindings.channels[0].targets = { repeated: new Array(excessive.tree.nodes.length + 2).fill(excessive.tree.nodes[0].id) };
  assert.throws(() => buildDom(excessive), errorCode("TARGET_CARDINALITY_MISMATCH"));
});

test("rejects unknown executable PolyCSS packet fields", async () => {
  const base = await syntheticPolycssInput();
  const cases = [
    ["INVALID_PLAYBACK_STATE", (input) => {
      input.state.channels.find((channel) => channel.id === "playback").data.packet.lighting = [];
    }],
    ["INVALID_PLAYBACK_STATE", (input) => {
      input.state.channels.find((channel) => channel.id === "playback").data.packet.initial.leaves.visibility = [1];
    }],
    ["INVALID_FRAME_ROW", (input) => {
      input.state.channels.find((channel) => channel.id === "playback").data.packet.frameRows[0].push(0);
    }],
    ["INVALID_SURFACE_STATE", (input) => {
      input.state.channels.find((channel) => channel.id === "surface").data.packet.lighting = {};
    }],
    ["INVALID_PRESENTATION_STATE", (input) => {
      input.state.channels.find((channel) => channel.id === "presentation").data.packet.background.asset = "checker";
    }],
    ["INVALID_EFFECTS_STATE", (input) => {
      input.state.channels.find((channel) => channel.id === "effects").data.packet.spawnStream.tuples[0][1] = 1e40;
    }],
  ];
  for (const [code, mutate] of cases) {
    const input = copy(base);
    mutate(input);
    assert.throws(() => buildDom(input), errorCode(code));
  }
});

test("cross-checks initial surface bits and atlas state against retained TREE styles", async () => {
  const base = await syntheticPolycssInput();
  const unusedBit = copy(base);
  unusedBit.state.channels.find((channel) => channel.id === "surface").data.packet.visibility.initialVisibleBitsBase64 = "Aw==";
  assert.throws(() => buildDom(unusedBit), errorCode("INVALID_SURFACE_STATE"));

  const visibility = copy(base);
  visibility.tree.nodes.find((node) => node.id === "synthetic-polycss/leaf").styles.visibility = "hidden";
  assert.throws(() => buildDom(visibility), errorCode("SURFACE_TREE_MISMATCH"));

  const defaultAtlas = copy(base);
  delete defaultAtlas.tree.nodes.find((node) => node.id === "synthetic-polycss/leaf").styles.backgroundPositionY;
  assert.doesNotThrow(() => buildDom(defaultAtlas));

  const atlas = copy(base);
  atlas.tree.nodes.find((node) => node.id === "synthetic-polycss/leaf").styles.backgroundPositionY = "-1px";
  assert.throws(() => buildDom(atlas), errorCode("SURFACE_TREE_MISMATCH"));
});

test("surface transitions and jumps must reproduce the canonical target frame", async () => {
  const base = await syntheticTwoFramePolycssInput();
  assert.doesNotThrow(() => buildDom(base));

  const transition = copy(base);
  transition.state.channels.find((channel) => channel.id === "surface").data.packet.transitions.sequential.stateIndexDeltas = [0, 0];
  assert.throws(() => buildDom(transition), errorCode("SURFACE_TRANSITION_MISMATCH"));

  const jump = copy(base);
  const packet = jump.state.channels.find((channel) => channel.id === "surface").data.packet;
  packet.transitions.nonInteractiveJumps = [{
    fromFrame: 1,
    toFrame: 2,
    faceIndicesBase64: "",
    stateIndicesBase64: "",
  }];
  packet.visibility.nonInteractiveJumps = [{ fromFrame: 1, toFrame: 2, faceIndicesBase64: "" }];
  assert.throws(() => buildDom(jump), errorCode("SURFACE_JUMP_MISMATCH"));
});

test("closed inputs, binary32 publication, and target ownership fail before runtime", async () => {
  const base = await syntheticPolycssInput();

  const tickDefault = copy(base);
  tickDefault.bindings.inputs.find((input) => input.id === "time.tick").default = 0;
  assert.throws(() => buildDom(tickDefault), errorCode("INVALID_PLAYBACK_BINDING"));

  const overflowingAppearance = copy(base);
  overflowingAppearance.state.channels.find((channel) => channel.id === "playback").data.packet.appearances[0][1] = Number.MAX_VALUE;
  assert.throws(() => buildDom(overflowingAppearance), errorCode("INVALID_PLAYBACK_STATE"));

  const overlappingEffect = copy(base);
  overlappingEffect.bindings.channels.find((channel) => channel.id === "effects").targets.emitters[0][0] = "synthetic-polycss/model";
  assert.throws(() => buildDom(overlappingEffect), errorCode("TARGET_OWNERSHIP_CONFLICT"));
});

test("target traversal is depth-bounded and codec base64 scanning is stack-safe", async () => {
  const built = buildDom(await syntheticPolycssInput());

  const deep = copy(built.document);
  let targets = "synthetic-polycss/model";
  for (let depth = 0; depth < 20_000; depth += 1) targets = { nested: targets };
  deep.bindings.channels.find((channel) => channel.id === "playback").targets = targets;
  assert.throws(() => validateDocument(deep), errorCode("TARGET_DEPTH_LIMIT"));

  const broad = copy(built.document);
  broad.bindings.channels.find((channel) => channel.id === "playback").targets = {
    branches: Array.from({ length: 101 }, () => ({})),
  };
  assert.throws(() => validateDocument(broad), errorCode("TARGET_CARDINALITY_MISMATCH"));

  const large = copy(built.document);
  large.state.channels.find((channel) => channel.id === "surface").data.packet.visibility.sequential.faceIndicesBase64 = `${"AAAA".repeat(2_599_999)}AAA*`;
  assert.throws(() => validateDocument(large), (error) => {
    assert.equal(error?.name, "DomFormatError");
    assert.equal(error?.code, "INVALID_SURFACE_STATE");
    return true;
  });
});

test("rejects unknown top-level and META fields in the executable fixture", async () => {
  const built = buildDom(await syntheticPolycssInput());
  assert.throws(() => validateDocument(Object.create(built.document)), errorCode("INVALID_DOCUMENT"));
  const top = copy(built.document);
  top.privateAdapter = {};
  assert.throws(() => validateDocument(top), errorCode("INVALID_DOCUMENT"));
  const meta = copy(built.document);
  meta.meta.privateAdapter = "private-producer";
  assert.throws(() => validateDocument(meta), errorCode("INVALID_META"));
  const counts = copy(built.document);
  counts.meta.counts.nodes += 1;
  assert.throws(() => validateDocument(counts), errorCode("META_COUNT_MISMATCH"));
});
