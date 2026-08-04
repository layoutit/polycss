import test from "node:test";
import assert from "node:assert/strict";
import { decodeJson, encodeCanonicalJson } from "../src/canonical-json.js";
import { readDomBrowser } from "../src/browser.js";
import { readDom } from "../src/reader.js";
import { buildDom } from "../src/writer.js";
import { builtExternalResources, errorCode, syntheticInput } from "./helpers.js";

async function validBuild() {
  return buildDom(await syntheticInput());
}

function changedDocument(built, operation) {
  const document = decodeJson(built.bytes);
  operation(document);
  return encodeCanonicalJson(document);
}

test("JSON writer is deterministic and reader accepts bounded noncanonical JSON syntax", async () => {
  const first = await validBuild();
  const second = await validBuild();
  assert.deepEqual(first.bytes, second.bytes);
  assert.equal(first.bytes[0], 0x7b);

  const ordinary = new TextEncoder().encode(JSON.stringify(JSON.parse(new TextDecoder().decode(first.bytes)), null, 2));
  const result = readDom(ordinary, { externalResources: builtExternalResources(first), requireResources: true });
  assert.equal(result.transport.encoding, "json");
  assert.equal(result.document.meta.format, "domformat@0");
});

test("reader rejects gzip and enforces JSON byte limits", async () => {
  const built = await validBuild();
  const gzipHeader = Uint8Array.of(0x1f, 0x8b, 0x08, 0x00);
  assert.throws(() => readDom(gzipHeader), errorCode("UNSUPPORTED_TRANSPORT"));
  assert.throws(() => readDom(built.bytes, { limits: { maxFileBytes: built.bytes.length - 1 } }), errorCode("FILE_LIMIT"));
  assert.throws(() => readDom(built.bytes, { limits: { maxAggregateDecodedBytes: built.bytes.length - 1 } }), errorCode("DOCUMENT_DECODED_LIMIT"));
  assert.throws(() => readDom(built.bytes, { limits: { maxFilesBytes: 1 } }), errorCode("INVALID_LIMITS"));
});

test("JSON preflight rejects malformed UTF-8, duplicate normalized keys, negative zero, and trailing data", async () => {
  const built = await validBuild();
  assert.throws(() => readDom(new Uint8Array([0xff])), errorCode("MALFORMED_UTF8"));
  const text = new TextDecoder().decode(built.bytes);
  assert.throws(() => readDom(new TextEncoder().encode(`{"meta":null,${text.slice(1)}`)), errorCode("DUPLICATE_NORMALIZED_KEY"));
  assert.throws(() => readDom(new TextEncoder().encode(text.replace('"version":0', '"version":-0'))), errorCode("INVALID_NUMBER"));
  assert.throws(() => readDom(new TextEncoder().encode(`${text}x`)), errorCode("MALFORMED_JSON"));
  assert.throws(() => readDom(new TextEncoder().encode(text.replace("Synthetic retained triangle", "Cafe\\u0301 retained triangle"))), errorCode("NON_NORMALIZED_JSON"));
});

test("closed JSON envelope rejects packet and embedded-resource fields", async () => {
  const built = await validBuild();
  assert.throws(() => readDom(changedDocument(built, (value) => { value.payloads = {}; })), errorCode("INVALID_DOCUMENT"));
  assert.throws(() => readDom(changedDocument(built, (value) => { value.privateAdapter = true; })), errorCode("INVALID_DOCUMENT"));
  assert.throws(() => readDom(changedDocument(built, (value) => { value.meta.packaging = "packed"; })), errorCode("INVALID_META"));
  assert.throws(() => readDom(changedDocument(built, (value) => { value.resources.resources[0].storage = { mode: "embedded", encoding: "base64" }; })), errorCode("INVALID_RESOURCE"));
});

test("multi-megabyte sibling resource validation stays bounded in Node and browser readers", async () => {
  const input = await syntheticInput();
  const stylesheet = input.resourceInputs.find((resource) => resource.id === "model-css");
  const padded = new Uint8Array(stylesheet.bytes.length + 4 * 1024 * 1024);
  padded.set(stylesheet.bytes);
  padded.fill(0x20, stylesheet.bytes.length);
  stylesheet.bytes = padded;
  const built = buildDom(input, { limits: { maxCssBytes: 8 * 1024 * 1024 } });
  const externalResources = builtExternalResources(built);
  assert.equal(readDom(built.bytes, { externalResources, requireResources: true, limits: { maxCssBytes: 8 * 1024 * 1024 } }).resourceBytes.get("model-css").length, padded.length);
  assert.equal((await readDomBrowser(built.bytes, { externalResources, limits: { maxCssBytes: 8 * 1024 * 1024 } })).resourceBytes.get("model-css").length, padded.length);
});

test("sibling resource digest mismatch remains fatal", async () => {
  const built = await validBuild();
  const external = builtExternalResources(built);
  const checker = external.get("checker").slice();
  checker[checker.length - 1] ^= 1;
  external.set("checker", checker);
  assert.throws(() => readDom(built.bytes, { externalResources: external, requireResources: true }), errorCode("RESOURCE_DIGEST_MISMATCH"));
});
