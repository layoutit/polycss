import test from "node:test";
import assert from "node:assert/strict";
import { decodeJson, encodeCanonicalJson } from "../src/canonical-json.js";
import { DEFAULT_LIMITS, jsonStructureLimits } from "../src/constants.js";
import { loadManifest } from "../src/manifest.js";
import { readDom } from "../src/reader.js";
import { buildDom } from "../src/writer.js";
import {
  errorCode,
  syntheticExecutableInteractionInput,
  syntheticInput,
  syntheticManifestPath,
  syntheticTwoFramePolycssInput,
} from "./helpers.js";

const UTF8 = new TextEncoder();

test("JSON structure preflight enforces exact array, object, and depth boundaries", () => {
  const limits = { maxArrayItems: 2, maxObjectMembers: 2 };
  assert.deepEqual(decodeJson(UTF8.encode("[0,1]"), "array", limits), [0, 1]);
  assert.throws(() => decodeJson(UTF8.encode("[0,1,2]"), "array", limits), errorCode("JSON_ARRAY_LIMIT"));
  assert.deepEqual(decodeJson(UTF8.encode('{"a":0,"b":1}'), "object", limits), { a: 0, b: 1 });
  assert.throws(() => decodeJson(UTF8.encode('{"a":0,"b":1,"c":2}'), "object", limits), errorCode("JSON_OBJECT_LIMIT"));
  assert.equal(new TextDecoder().decode(encodeCanonicalJson([0, 1], limits)), "[0,1]");
  assert.throws(() => encodeCanonicalJson([0, 1, 2], limits), errorCode("JSON_ARRAY_LIMIT"));
  const exactKey = "a".repeat(256);
  const excessiveKey = "a".repeat(257);
  assert.deepEqual(decodeJson(UTF8.encode(`{${JSON.stringify(exactKey)}:0}`), "key"), { [exactKey]: 0 });
  assert.throws(() => decodeJson(UTF8.encode(`{${JSON.stringify(excessiveKey)}:0}`), "key"), errorCode("JSON_KEY_LIMIT"));
  assert.throws(() => encodeCanonicalJson({ [excessiveKey]: 0 }), errorCode("JSON_KEY_LIMIT"));

  const accepted = `${"[".repeat(256)}0${"]".repeat(256)}`;
  const rejected = `${"[".repeat(257)}0${"]".repeat(257)}`;
  assert.doesNotThrow(() => decodeJson(UTF8.encode(accepted), "depth"));
  assert.throws(() => decodeJson(UTF8.encode(rejected), "depth"), errorCode("JSON_DEPTH"));
});

test("every configured limit is wired to a rejecting path", async () => {
  const basic = await syntheticInput();
  const executable = await syntheticExecutableInteractionInput();
  const twoFrame = await syntheticTwoFramePolycssInput();
  const cases = [
    ["maxNodes", basic, "NODE_COUNT_LIMIT"],
    ["maxTreeDepth", basic, "TREE_DEPTH_LIMIT"],
    ["maxAttributesPerNode", basic, "INVALID_MOUNT"],
    ["maxClassesPerNode", basic, "CLASS_COUNT_LIMIT"],
    ["maxStylesPerNode", basic, "STYLE_COUNT_LIMIT"],
    ["maxResources", basic, "INVALID_RESOURCE_INPUTS"],
    ["maxResourceBytes", basic, "RESOURCE_SIZE_LIMIT"],
    ["maxAggregateResourceBytes", basic, "AGGREGATE_RESOURCE_LIMIT"],
    ["maxCssBytes", basic, "CSS_SIZE_LIMIT"],
    ["maxCssRules", basic, "CSS_RULE_LIMIT"],
    ["maxCssSelectors", basic, "CSS_SELECTOR_LIMIT"],
    ["maxCssSelectorBytes", basic, "CSS_SELECTOR_LIMIT"],
    ["maxCssDeclarations", basic, "CSS_DECLARATION_LIMIT"],
    ["maxCssFunctions", basic, "CSS_FUNCTION_LIMIT"],
    ["maxCssAssetTokens", basic, "CSS_TOKEN_LIMIT"],
    ["maxImageWidth", basic, "IMAGE_DIMENSION_LIMIT"],
    ["maxImageHeight", basic, "IMAGE_DIMENSION_LIMIT"],
    ["maxImagePixels", basic, "IMAGE_DIMENSION_LIMIT"],
    ["maxAggregateImagePixels", basic, "AGGREGATE_IMAGE_PIXEL_LIMIT"],
    ["maxStateChannels", executable, "STATE_CHANNEL_LIMIT"],
    ["maxBindingChannels", executable, "BINDING_CHANNEL_LIMIT"],
    ["maxBindingInputs", executable, "BINDING_INPUT_LIMIT"],
    ["maxFrames", executable, "FRAME_CARDINALITY_MISMATCH"],
    ["maxTimelineTicks", executable, "TIMELINE_LIMIT"],
    ["maxPreparedTransforms", executable, "TRANSFORM_ALLOCATION_LIMIT"],
    ["maxPreparedStates", executable, "SURFACE_STATE_LIMIT"],
    ["maxPreparedChanges", twoFrame, "STATE_CHANGE_LIMIT"],
    ["maxVisibilityCells", executable, "VISIBILITY_ALLOCATION_LIMIT"],
    ["maxEffectParticles", executable, "EFFECT_PARTICLE_LIMIT"],
    ["maxEffectSpawnTuples", executable, "EFFECT_STATE_LIMIT"],
    ["maxInteractionControls", executable, "INTERACTION_STATE_LIMIT"],
    ["maxInteractionObjects", executable, "INTERACTION_STATE_LIMIT"],
    ["maxInteractionVertices", executable, "INTERACTION_STATE_LIMIT"],
    ["maxInteractionWeights", executable, "INTERACTION_STATE_LIMIT"],
    ["maxInteractionWeightReferences", executable, "INTERACTION_STATE_LIMIT"],
    ["maxInteractionLeafRows", executable, "INTERACTION_STATE_LIMIT"],
  ];
  for (const [name, input, code] of cases) {
    assert.throws(
      () => buildDom(structuredClone(input), { limits: { [name]: 0 } }),
      errorCode(code),
      name,
    );
  }

  await assert.rejects(loadManifest(syntheticManifestPath, { limits: { maxManifestBytes: 0 } }), errorCode("MANIFEST_LIMIT"));
  await assert.rejects(loadManifest(syntheticManifestPath, { limits: { maxDecodedInputBytes: 0 } }), errorCode("MANIFEST_INPUT_LIMIT"));
  await assert.rejects(loadManifest(syntheticManifestPath, { limits: { maxAggregateDecodedBytes: 128 } }), errorCode("AGGREGATE_DECODED_LIMIT"));

  const built = buildDom(basic);
  assert.doesNotThrow(() => readDom(built.bytes, {
    limits: {
      maxFileBytes: built.bytes.length,
      maxAggregateDecodedBytes: built.bytes.length,
    },
  }));
  assert.throws(() => readDom(built.bytes, { limits: { maxFileBytes: built.bytes.length - 1 } }), errorCode("FILE_LIMIT"));
  assert.throws(() => readDom(built.bytes, { limits: { maxAggregateDecodedBytes: built.bytes.length - 1 } }), errorCode("DOCUMENT_DECODED_LIMIT"));

  const covered = new Set([
    ...cases.map(([name]) => name),
    "maxFileBytes",
    "maxManifestBytes",
    "maxDecodedInputBytes",
    "maxAggregateDecodedBytes",
  ]);
  assert.deepEqual([...covered].sort(), Object.keys(DEFAULT_LIMITS).sort());
  assert.equal(Object.isFrozen(jsonStructureLimits(DEFAULT_LIMITS)), true);
});
