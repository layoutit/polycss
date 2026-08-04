import { FORMAT_ID, PROFILE_ID, jsonStructureLimits, mergeLimits } from "./constants.js";
import { canonicalize, encodeCanonicalJson } from "./canonical-json.js";
import { invariant } from "./errors.js";
import { sha256Hex } from "./hash.js";
import { assertResourceId, assertSafeRelativePath, imageDimensions, validateCssBytes, validateResourceBytes } from "./resources.js";
import { validateDocumentInternal } from "./schema.js";

function bytesOf(value) {
  if (value instanceof Uint8Array) return value.slice();
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (typeof value === "string") return new TextEncoder().encode(value);
  invariant(false, "INVALID_RESOURCE_BYTES", "Resource input bytes must be a string, ArrayBuffer, or Uint8Array.");
}

function plainRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function buildDom(input, options = {}) {
  const limits = mergeLimits(options.limits);
  const jsonLimits = jsonStructureLimits(limits);
  invariant(plainRecord(input), "INVALID_DOCUMENT_INPUT", "Writer input must be a plain object.");
  for (const key of Object.keys(input)) {
    invariant(["meta", "tree", "cssBinding", "state", "bindings", "resourceInputs"].includes(key), "INVALID_DOCUMENT_INPUT", `Writer input contains unsupported field ${key}.`);
  }
  invariant(Array.isArray(input.resourceInputs) && input.resourceInputs.length <= limits.maxResources, "INVALID_RESOURCE_INPUTS", "resourceInputs must be a bounded array.");
  const resourceInputs = input.resourceInputs.map((entry, index) => {
    invariant(plainRecord(entry), "INVALID_RESOURCE_INPUT", `Resource input ${index} must be a plain object.`);
    for (const key of Object.keys(entry)) {
      invariant(["id", "kind", "mediaType", "path", "bytes"].includes(key), "INVALID_RESOURCE_INPUT", `Resource input ${index} contains unsupported field ${key}.`);
    }
    return { ...entry, id: assertResourceId(entry.id), bytes: bytesOf(entry.bytes) };
  }).sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);

  let aggregateInputBytes = 0;
  const seen = new Set();
  const records = resourceInputs.map((entry) => {
    invariant(!seen.has(entry.id), "DUPLICATE_RESOURCE_ID", `Resource input ${entry.id} is duplicated.`);
    seen.add(entry.id);
    invariant(entry.kind === "stylesheet" || entry.kind === "image", "INVALID_RESOURCE_KIND", `Resource ${entry.id} kind is invalid.`);
    const path = assertSafeRelativePath(entry.path, `Resource ${entry.id} path`);
    invariant(entry.bytes.length <= limits.maxResourceBytes, "RESOURCE_SIZE_LIMIT", `Resource input ${entry.id} exceeds its byte limit.`);
    aggregateInputBytes += entry.bytes.length;
    invariant(aggregateInputBytes <= limits.maxAggregateResourceBytes, "AGGREGATE_RESOURCE_LIMIT", "Resource inputs exceed their aggregate byte limit.");
    return {
      id: entry.id,
      kind: entry.kind,
      mediaType: entry.mediaType,
      byteLength: entry.bytes.length,
      digest: { algorithm: "sha256", value: sha256Hex(entry.bytes) },
      path,
      ...(entry.kind === "image" ? { dimensions: imageDimensions(entry.bytes, entry.mediaType) } : {}),
    };
  });

  const document = {
    meta: canonicalize({
      ...input.meta,
      format: FORMAT_ID,
      profile: PROFILE_ID,
      generator: { name: "domformat", version: "0.0.0" },
    }, jsonLimits),
    tree: canonicalize(input.tree, jsonLimits),
    cssBinding: canonicalize(input.cssBinding, jsonLimits),
    state: canonicalize(input.state, jsonLimits),
    bindings: canonicalize(input.bindings, jsonLimits),
    resources: canonicalize({ version: 0, resources: records }, jsonLimits),
  };
  const validated = validateDocumentInternal(document, options);
  const resourceMap = new Map(resourceInputs.map((entry) => [entry.id, entry.bytes]));
  for (const binding of document.cssBinding.stylesheets) {
    const stylesheet = resourceMap.get(binding.resource);
    invariant(stylesheet, "MISSING_CSS_RESOURCE", `Stylesheet bytes ${binding.resource} are absent.`);
    validateCssBytes(stylesheet, binding, validated.resourceIds, validated.limits);
  }
  for (const record of records) validateResourceBytes(record, resourceMap.get(record.id), validated.limits);

  const jsonBytes = encodeCanonicalJson(document, jsonLimits);
  invariant(jsonBytes.length <= limits.maxAggregateDecodedBytes, "DOCUMENT_DECODED_LIMIT", "The JSON document exceeds its configured limit.");
  invariant(jsonBytes.length <= limits.maxFileBytes, "FILE_TOO_LARGE", "The JSON document exceeds its configured file limit.");
  const externalResources = new Map(records.map((record) => [record.path, resourceMap.get(record.id)]));
  return Object.freeze({
    bytes: jsonBytes,
    document: Object.freeze(document),
    externalResources,
  });
}
