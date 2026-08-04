import { realpath, stat } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { jsonStructureLimits, mergeLimits } from "./constants.js";
import { decodeJson } from "./canonical-json.js";
import { fail, invariant } from "./errors.js";
import { readCappedFile } from "./file-io.js";
import { sha256Hex } from "./hash.js";
import { assertSafeRelativePath, validateCssBytes, validateResourceBytes } from "./resources.js";
import { validateDocumentInternal } from "./schema.js";
import { assertRealDescendantComponents, assertRealDirectory } from "./path-security.js";

const DOCUMENT_FIELDS = Object.freeze(["meta", "tree", "cssBinding", "state", "bindings", "resources"]);
function inside(base, target) {
  return target === base || target.startsWith(`${base}${sep}`);
}

function plainRecord(value, code, label) {
  invariant(value && typeof value === "object" && !Array.isArray(value), code, `${label} must be an object.`);
  const prototype = Object.getPrototypeOf(value);
  invariant(prototype === Object.prototype || prototype === null, code, `${label} must be a plain object.`);
  return value;
}

function inputBytes(value) {
  if (value instanceof Uint8Array) return value.slice();
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
  invariant(false, "INVALID_BYTES", "Expected an ArrayBuffer or Uint8Array.");
}

function externalResourceBytes(value, label) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  invariant(false, "INVALID_RESOURCE_BYTES", `${label} must be an ArrayBuffer view.`);
}

function decodeTransport(value, limits) {
  const bytes = inputBytes(value);
  invariant(bytes.length <= limits.maxFileBytes, "FILE_LIMIT", `File exceeds ${limits.maxFileBytes} bytes.`);
  invariant(!(bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b), "UNSUPPORTED_TRANSPORT", "domformat@0 accepts plain JSON only.");
  invariant(bytes.length <= limits.maxAggregateDecodedBytes, "DOCUMENT_DECODED_LIMIT", "JSON exceeds its configured limit.");
  return Object.freeze({
    encoding: "json",
    totalLength: bytes.length,
    decodedLength: bytes.length,
    bytes,
  });
}

function documentEnvelope(value) {
  const document = plainRecord(value, "INVALID_DOCUMENT", "Decoded document");
  const allowed = new Set(DOCUMENT_FIELDS);
  for (const key of Object.keys(document)) invariant(allowed.has(key), "INVALID_DOCUMENT", `Decoded document contains unsupported field ${key}.`);
  return Object.fromEntries(DOCUMENT_FIELDS.map((name) => [name, document[name]]));
}

function verifyResourceBytes(document, resourceBytes, validated) {
  const externalMissing = [];
  for (const record of document.resources.resources) {
    const bytes = resourceBytes.get(record.id);
    if (!bytes) {
      externalMissing.push(record.id);
      continue;
    }
    invariant(bytes.length === record.byteLength, "RESOURCE_SIZE_MISMATCH", `Resource ${record.id} byte length does not match RCRD.`);
    invariant(sha256Hex(bytes) === record.digest.value, "RESOURCE_DIGEST_MISMATCH", `Resource ${record.id} digest does not match RCRD.`);
    validateResourceBytes(record, bytes, validated.limits);
  }
  for (const binding of document.cssBinding.stylesheets) {
    const bytes = resourceBytes.get(binding.resource);
    if (bytes) validateCssBytes(bytes, binding, validated.resourceIds, validated.limits);
  }
  return externalMissing;
}

function readDomInternal(value, options = {}) {
  const limits = mergeLimits(options.limits);
  const transport = decodeTransport(value, limits);
  const parsed = decodeJson(transport.bytes, "domformat JSON document", jsonStructureLimits(limits));
  const document = documentEnvelope(parsed);
  const validated = validateDocumentInternal(document, options);
  const resourceBytes = new Map();
  if (options.externalResources !== undefined) {
    invariant(options.externalResources instanceof Map, "INVALID_EXTERNAL_RESOURCES", "externalResources must be a Map keyed by logical resource id.");
    for (const [id, bytes] of options.externalResources) {
      const record = document.resources.resources.find((entry) => entry.id === id);
      invariant(record, "UNEXPECTED_EXTERNAL_RESOURCE", `External resource ${String(id)} is not declared by this document.`);
      resourceBytes.set(id, externalResourceBytes(bytes, `External resource ${id}`).slice());
    }
  }
  const externalMissing = verifyResourceBytes(document, resourceBytes, validated);
  if (options.requireResources) invariant(externalMissing.length === 0, "MISSING_EXTERNAL_RESOURCE", `External resources are missing: ${externalMissing.join(", ")}.`);
  const result = Object.freeze({ transport, document: Object.freeze(document), resourceBytes, externalMissing: Object.freeze(externalMissing) });
  return Object.freeze({ result, validated });
}

export function readDom(value, options = {}) {
  return readDomInternal(value, options).result;
}

async function readDomFileInternal(path, options = {}) {
  const limits = mergeLimits(options.limits);
  const { bytes } = await readCappedFile(path, {
    label: "domformat package",
    maximum: limits.maxFileBytes,
    limitCode: "FILE_LIMIT",
    mismatchCode: "FILE_SIZE_MISMATCH",
  });
  const { result: initial, validated } = readDomInternal(bytes, { ...options, requireResources: false });
  if (options.loadExternal === false) {
    if (options.requireResources) invariant(initial.externalMissing.length === 0, "MISSING_EXTERNAL_RESOURCE", `External resources are missing: ${initial.externalMissing.join(", ")}.`);
    return initial;
  }
  const lexicalBase = dirname(resolve(path));
  let base;
  try {
    base = await assertRealDirectory(lexicalBase, "UNSAFE_RESOURCE_PATH", "Resource directory");
  } catch (error) {
    if (error?.code === "ENOENT") fail("MISSING_EXTERNAL_RESOURCE", "The resource directory is missing.");
    throw error;
  }
  const externalResources = new Map();
  for (const record of initial.document.resources.resources) {
    try {
      const relative = assertSafeRelativePath(record.path);
      const target = resolve(base, relative);
      invariant(inside(base, target), "UNSAFE_RESOURCE_PATH", `Resource ${record.id} escapes its package directory.`);
      await assertRealDescendantComponents(base, relative, "UNSAFE_RESOURCE_PATH", `Resource ${record.id} path`);
      const resolvedTarget = await realpath(target);
      invariant(inside(base, resolvedTarget), "UNSAFE_RESOURCE_PATH", `Resource ${record.id} resolves outside its package directory.`);
      const loaded = await readCappedFile(target, {
        label: `Resource ${record.id}`,
        maximum: Math.min(record.byteLength, limits.maxResourceBytes),
        expectedLength: record.byteLength,
        noFollow: true,
        limitCode: "RESOURCE_SIZE_LIMIT",
        mismatchCode: "RESOURCE_SIZE_MISMATCH",
      });
      const finalTarget = await realpath(target);
      invariant(inside(base, finalTarget), "UNSAFE_RESOURCE_PATH", `Resource ${record.id} moved outside its package directory while loading.`);
      const finalMetadata = await stat(target);
      invariant(finalMetadata.dev === loaded.metadata.dev && finalMetadata.ino === loaded.metadata.ino, "FILE_CHANGED_DURING_READ", `Resource ${record.id} path changed while it was read.`);
      externalResources.set(record.id, loaded.bytes);
    } catch (error) {
      if (error?.code === "ENOENT") fail("MISSING_EXTERNAL_RESOURCE", `Resource ${record.id} is missing.`);
      throw error;
    }
  }
  const externalMissing = verifyResourceBytes(initial.document, externalResources, validated);
  if (options.requireResources ?? true) invariant(externalMissing.length === 0, "MISSING_EXTERNAL_RESOURCE", `External resources are missing: ${externalMissing.join(", ")}.`);
  return Object.freeze({
    ...initial,
    resourceBytes: externalResources,
    externalMissing: Object.freeze(externalMissing),
  });
}

export async function readDomFile(path, options = {}) {
  try {
    return await readDomFileInternal(path, options);
  } catch (error) {
    if (error?.name === "DomFormatError") throw error;
    const code = error?.code === "ENOENT" ? "FILE_NOT_FOUND" : error?.code === "EACCES" ? "FILE_ACCESS_DENIED" : "FILE_IO";
    fail(code, "The domformat package or one of its required resources could not be read.");
  }
}
