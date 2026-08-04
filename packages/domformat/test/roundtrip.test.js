import test from "node:test";
import assert from "node:assert/strict";
import { buildDom } from "../src/writer.js";
import { readDom } from "../src/reader.js";
import { inspection } from "../src/inspect.js";
import { sha256Hex } from "../src/hash.js";
import { encodeCanonicalJson } from "../src/canonical-json.js";
import { builtExternalResources, errorCode, syntheticInput, syntheticPolycssInput } from "./helpers.js";

test("JSON writer is deterministic and round-trips every semantic section with sibling resources", async () => {
  const input = await syntheticInput();
  const first = buildDom(input);
  const second = buildDom(input);
  assert.deepEqual(first.bytes, second.bytes);
  const result = readDom(first.bytes, { externalResources: builtExternalResources(first), requireResources: true });
  assert.deepEqual(result.document.tree, input.tree);
  assert.deepEqual(result.document.state, input.state);
  assert.deepEqual(result.document.bindings, input.bindings);
  assert.equal(result.document.meta.format, "domformat@0");
  assert.equal(result.document.meta.profile, "polycss-3d@0");
  assert.equal("packaging" in result.document.meta, false);
  assert.equal("payloads" in result.document, false);
  assert.equal(result.document.meta.generator.version, "0.0.0");
  assert.equal(result.document.resources.resources.every((record) => typeof record.path === "string" && !("storage" in record)), true);
  assert.equal(result.resourceBytes.size, 2);
  assert.match(sha256Hex(first.bytes), /^[0-9a-f]{64}$/u);
  const summary = inspection(result);
  assert.equal(summary.tree.nodes, 3);
  assert.equal(summary.allResourcesVerified, true);
  assert.throws(() => readDom(first.bytes, { externalResources: new Map(), requireResources: true }), errorCode("MISSING_EXTERNAL_RESOURCE"));
});

test("writer returns the same canonical Unicode document carried by its bytes", async () => {
  const input = await syntheticInput();
  input.meta.title = "Cafe\u0301 retained model";
  const built = buildDom(input);
  const read = readDom(built.bytes, { externalResources: builtExternalResources(built), requireResources: true });
  assert.equal(built.document.meta.title, "Café retained model");
  assert.deepEqual(built.document, read.document);
});

test("canonical JSON rejects sparse arrays and non-plain host objects", () => {
  const sparse = [];
  sparse.length = 1;
  assert.throws(() => encodeCanonicalJson(sparse), errorCode("INVALID_JSON_ARRAY"));
  assert.throws(() => encodeCanonicalJson(new Date(0)), errorCode("INVALID_JSON_OBJECT"));
});

test("writer rejects non-plain records and invalid resource ids before sorting", async () => {
  assert.throws(() => buildDom(new Date(0)), errorCode("INVALID_DOCUMENT_INPUT"));

  const record = await syntheticInput();
  record.resourceInputs[0] = new Date(0);
  assert.throws(() => buildDom(record), errorCode("INVALID_RESOURCE_INPUT"));

  const id = await syntheticInput();
  id.resourceInputs[0].id = { toString() { throw new Error("must not coerce"); } };
  assert.throws(() => buildDom(id), errorCode("INVALID_RESOURCE_ID"));
});

test("writer binds external bytes by size and digest", async () => {
  const input = await syntheticInput();
  const built = buildDom(input);
  assert.equal(built.externalResources.size, 2);
  const external = builtExternalResources(built);
  const result = readDom(built.bytes, { externalResources: external, requireResources: true });
  assert.deepEqual(result.externalMissing, []);
  assert.throws(() => readDom(built.bytes, { externalResources: { checker: new Uint8Array() } }), errorCode("INVALID_EXTERNAL_RESOURCES"));
  assert.throws(() => readDom(built.bytes, { externalResources: new Map([["undeclared", new Uint8Array()]]) }), errorCode("UNEXPECTED_EXTERNAL_RESOURCE"));
  assert.throws(() => readDom(built.bytes, { externalResources: new Map([["checker", "not bytes"]]) }), errorCode("INVALID_RESOURCE_BYTES"));
});

test("writer copies caller-owned resource bytes before validation and publication", async () => {
  const input = await syntheticInput();
  const source = input.resourceInputs[0].bytes;
  const built = buildDom(input);
  const before = builtExternalResources(built).get(input.resourceInputs[0].id).slice();
  source.fill(0);
  assert.deepEqual(builtExternalResources(built).get(input.resourceInputs[0].id), before);
  assert.equal(readDom(built.bytes, { externalResources: builtExternalResources(built), requireResources: true }).resourceBytes.size, 2);
});

test("executable PolyCSS fixture is deterministic and remains fully executable", async () => {
  const input = await syntheticPolycssInput();
  const first = buildDom(input);
  const second = buildDom(input);
  assert.deepEqual(first.bytes, second.bytes);
  const read = readDom(first.bytes, { externalResources: builtExternalResources(first), requireResources: true });
  assert.equal(read.document.tree.nodes.length, 8);
  assert.deepEqual(read.document.state.channels.map((channel) => channel.codec), [
    "polycss-effects-prepared@0",
    "polycss-playback-packed@0",
    "static-presentation@0",
    "polycss-surface-packed@0",
  ]);
});
