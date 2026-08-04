import { realpath, stat } from "node:fs/promises";
import { basename, dirname, resolve, sep } from "node:path";
import { jsonStructureLimits, mergeLimits } from "./constants.js";
import { decodeJson } from "./canonical-json.js";
import { invariant } from "./errors.js";
import { readCappedFile } from "./file-io.js";
import { assertRealDescendantComponents, assertRealDirectory } from "./path-security.js";
import { assertSafeRelativePath } from "./resources.js";

function inside(base, target) {
  return target === base || target.startsWith(`${base}${sep}`);
}

function manifestPath(value, label) {
  try {
    return assertSafeRelativePath(value, `${label} source path`);
  } catch (error) {
    if (error?.code !== "UNSAFE_RESOURCE_PATH") throw error;
    invariant(false, "UNSAFE_MANIFEST_PATH", `${label} source must be a portable project-relative path.`);
  }
}

async function readManifestReference(base, value, options) {
  const relative = manifestPath(value, options.label);
  const target = resolve(base, relative);
  invariant(inside(base, target), "UNSAFE_MANIFEST_PATH", `${options.label} source escapes the manifest directory.`);
  await assertRealDescendantComponents(base, relative, "UNSAFE_MANIFEST_PATH", `${options.label} source path`);
  const resolvedTarget = await realpath(target);
  invariant(inside(base, resolvedTarget), "UNSAFE_MANIFEST_PATH", `${options.label} source resolves outside the manifest directory.`);
  const loaded = await readCappedFile(target, { ...options, noFollow: true });
  const finalTarget = await realpath(target);
  invariant(inside(base, finalTarget), "UNSAFE_MANIFEST_PATH", `${options.label} source moved outside the manifest directory while loading.`);
  const finalMetadata = await stat(target);
  invariant(finalMetadata.dev === loaded.metadata.dev && finalMetadata.ino === loaded.metadata.ino, "FILE_CHANGED_DURING_READ", `${options.label} source path changed while it was read.`);
  return loaded;
}

function parseJson(bytes, code, label, path, limits) {
  try {
    return decodeJson(bytes, `${label} from ${path}`, jsonStructureLimits(limits));
  } catch (error) {
    if (error?.name === "DomFormatError") throw error;
    invariant(false, code, `Cannot parse ${label} from ${path}: ${String(error)}`);
  }
}

async function jsonValue(base, value, label, limits, aggregate) {
  if (typeof value !== "string") return value;
  const path = resolve(base, value);
  try {
    const remaining = limits.maxAggregateDecodedBytes - aggregate.bytes;
    const { bytes } = await readManifestReference(base, value, {
      label,
      maximum: Math.min(limits.maxDecodedInputBytes, remaining),
      limitCode: remaining < limits.maxDecodedInputBytes ? "AGGREGATE_DECODED_LIMIT" : "MANIFEST_INPUT_LIMIT",
      mismatchCode: "MANIFEST_INPUT_SIZE",
    });
    aggregate.bytes += bytes.length;
    invariant(aggregate.bytes <= limits.maxAggregateDecodedBytes, "AGGREGATE_DECODED_LIMIT", "Manifest section inputs exceed their aggregate byte limit.");
    return parseJson(bytes, "MANIFEST_INPUT", label, path, limits);
  } catch (error) {
    if (error?.name === "DomFormatError") throw error;
    invariant(false, "MANIFEST_INPUT", `Cannot read ${label} from ${path}: ${String(error)}`);
  }
}

export async function loadManifest(path, options = {}) {
  const limits = mergeLimits(options.limits);
  const absolute = resolve(path);
  const base = await assertRealDirectory(dirname(absolute), "UNSAFE_MANIFEST_PATH", "Manifest directory");
  let manifest;
  try {
    await assertRealDescendantComponents(base, basename(absolute), "UNSAFE_MANIFEST_PATH", "Manifest path");
    const { bytes } = await readCappedFile(absolute, {
      label: "manifest",
      maximum: limits.maxManifestBytes,
      noFollow: true,
      limitCode: "MANIFEST_LIMIT",
      mismatchCode: "MANIFEST_SIZE",
    });
    manifest = parseJson(bytes, "MANIFEST", "manifest", absolute, limits);
  } catch (error) {
    if (error?.name === "DomFormatError") throw error;
    invariant(false, "MANIFEST", `Cannot read manifest ${absolute}: ${String(error)}`);
  }
  invariant(manifest && typeof manifest === "object" && !Array.isArray(manifest), "MANIFEST", "Manifest must be an object.");
  for (const key of Object.keys(manifest)) {
    invariant(["meta", "tree", "cssBinding", "state", "bindings", "resources"].includes(key), "MANIFEST", `Manifest contains unsupported field ${key}.`);
  }
  invariant(Array.isArray(manifest.resources) && manifest.resources.length <= limits.maxResources, "MANIFEST", "Manifest resources must be a bounded array.");
  const aggregateSections = { bytes: 0 };
  const resourceInputs = [];
  let aggregateBytes = 0;
  for (const resource of manifest.resources) {
    invariant(resource && typeof resource === "object" && !Array.isArray(resource) && typeof resource.source === "string", "MANIFEST", "Manifest resource entries require a source path.");
    for (const key of Object.keys(resource)) {
      invariant(["id", "kind", "mediaType", "path", "source"].includes(key), "MANIFEST", `Manifest resource ${resource.id ?? "<missing>"} contains unsupported field ${key}.`);
    }
    const remaining = limits.maxAggregateResourceBytes - aggregateBytes;
    const loaded = await readManifestReference(base, resource.source, {
      label: `Resource source ${resource.id ?? "<missing>"}`,
      maximum: Math.min(limits.maxResourceBytes, remaining),
      limitCode: remaining < limits.maxResourceBytes ? "AGGREGATE_RESOURCE_LIMIT" : "RESOURCE_SIZE_LIMIT",
      mismatchCode: "RESOURCE_SIZE_MISMATCH",
    });
    aggregateBytes += loaded.bytes.length;
    invariant(aggregateBytes <= limits.maxAggregateResourceBytes, "AGGREGATE_RESOURCE_LIMIT", "Manifest resources exceed their aggregate byte limit.");
    resourceInputs.push({
      id: resource.id,
      kind: resource.kind,
      mediaType: resource.mediaType,
      path: resource.path,
      bytes: loaded.bytes,
    });
  }
  return {
    meta: await jsonValue(base, manifest.meta, "META", limits, aggregateSections),
    tree: await jsonValue(base, manifest.tree, "TREE", limits, aggregateSections),
    cssBinding: await jsonValue(base, manifest.cssBinding, "CSSB", limits, aggregateSections),
    state: await jsonValue(base, manifest.state, "STAT", limits, aggregateSections),
    bindings: await jsonValue(base, manifest.bindings, "BIND", limits, aggregateSections),
    resourceInputs,
  };
}
