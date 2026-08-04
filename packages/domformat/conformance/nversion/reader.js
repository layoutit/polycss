import { requireContract as require } from "./errors.js";
import { decodeTransport, parseJsonBytes } from "./json.js";
import { verifyResources } from "./resources.js";
import { validateNVersionDocument } from "./schema.js";

// This is deliberately a conformance path, not a package export. It imports
// neither the production reader nor the production schema/runtime modules.
const DEFAULT_LIMITS = Object.freeze({
  maxFileBytes: 32 * 1024 * 1024,
  maxDecodedInputBytes: 32 * 1024 * 1024,
  maxArrayItems: 16_000_000,
  maxObjectMembers: 2_048,
  maxKeyCodeUnits: 256,
  maxDepth: 256,
  maxNodes: 10_000,
  maxTreeDepth: 64,
  maxAttributesPerNode: 32,
  maxClassesPerNode: 32,
  maxStylesPerNode: 64,
  maxResources: 64,
  maxResourceBytes: 8 * 1024 * 1024,
  maxAggregateResourceBytes: 16 * 1024 * 1024,
  maxImageWidth: 16_384,
  maxImageHeight: 16_384,
  maxImagePixels: 16 * 1024 * 1024,
  maxAggregateImagePixels: 16 * 1024 * 1024,
  maxCssBytes: 1024 * 1024,
  maxCssRules: 8_192,
  maxCssSelectors: 32_768,
  maxCssSelectorBytes: 4_096,
  maxCssDeclarations: 131_072,
  maxCssAssetTokens: 2_048,
  maxStateChannels: 128,
  maxBindingChannels: 128,
  maxBindingInputs: 256,
  maxFrames: 2_000,
  maxTimelineTicks: 200_000,
  maxPreparedTransforms: 500_000,
  maxPreparedStates: 500_000,
  maxPreparedChanges: 1_000_000,
  maxVisibilityCells: 4 * 1024 * 1024,
  maxEffectParticles: 2_000,
  maxEffectSpawnTuples: 100_000,
  maxInteractionControls: 256,
  maxInteractionObjects: 4_096,
  maxInteractionVertices: 100_000,
  maxInteractionWeights: 250_000,
  maxInteractionWeightReferences: 1_000_000,
  maxInteractionLeafRows: 250_000,
});

function limits(overrides = {}) {
  for (const key of Object.keys(overrides)) require(Object.hasOwn(DEFAULT_LIMITS, key), "UNKNOWN_LIMIT", `Unknown N-version limit ${key}.`);
  const output = { ...DEFAULT_LIMITS, ...overrides };
  for (const [key, value] of Object.entries(output)) require(Number.isSafeInteger(value) && value > 0, "INVALID_LIMIT", `N-version limit ${key} is invalid.`);
  return Object.freeze(output);
}

function byteView(value, label) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  require(false, "INVALID_INPUT_BYTES", `${label} is not a byte buffer.`);
}

async function readResponse(response, maximum, label) {
  require(response?.ok && response.type !== "opaqueredirect", "RESOURCE_FETCH_FAILED", `${label} response failed.`);
  const declared = response.headers.get("content-length");
  if (declared !== null) require(/^\d+$/u.test(declared) && Number(declared) <= maximum, "RESPONSE_SIZE_LIMIT", `${label} Content-Length exceeds its limit.`);
  require(response.body && typeof response.body.getReader === "function", "RESOURCE_FETCH_FAILED", `${label} response has no readable body.`);
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      require(total <= maximum, "RESPONSE_SIZE_LIMIT", `${label} body exceeds its limit.`);
      chunks.push(value);
    }
  } finally {
    try { reader.releaseLock(); } catch {}
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
  return output;
}

function result(document, resourceBytes, transport) {
  const inspection = new Map([...resourceBytes].map(([id, bytes]) => [id, bytes.slice()]));
  return Object.freeze({
    document,
    resourceBytes: inspection,
    transport: Object.freeze({
      encoding: transport.encoding,
      fileBytes: transport.fileBytes,
      bytes: transport.bytes.slice(),
    }),
    implementation: "nversion-browser-probe@0",
  });
}

export async function readDomNVersion(input, options = {}) {
  const active = limits(options.limits);
  const transport = await decodeTransport(byteView(input, "domformat package"), active);
  const envelope = parseJsonBytes(transport.bytes, active);
  const validated = validateNVersionDocument(envelope, active);
  const resourceBytes = await verifyResources(envelope, validated.records, options, active);
  const document = Object.freeze({
    meta: envelope.meta,
    tree: envelope.tree,
    cssBinding: envelope.cssBinding,
    state: envelope.state,
    bindings: envelope.bindings,
    resources: envelope.resources,
  });
  return result(document, resourceBytes, transport);
}

export async function readDomNVersionUrl(value, options = {}) {
  const active = limits(options.limits);
  const url = new URL(value, options.baseUrl ?? globalThis.location?.href);
  require((url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password, "UNSAFE_MODEL_URL", "Model URL must be credential-free HTTP(S).");
  const fetcher = options.fetch ?? globalThis.fetch;
  require(typeof fetcher === "function", "MISSING_BROWSER_API", "N-version URL reading requires fetch.");
  const response = await fetcher(url, { credentials: "omit", redirect: "error", signal: options.signal });
  const modelBytes = await readResponse(response, active.maxFileBytes, "Model");
  return readDomNVersion(modelBytes, {
    limits: active,
    loadResource: async (record) => {
      const resourceUrl = new URL(record.path, url);
      require(resourceUrl.origin === url.origin && !resourceUrl.username && !resourceUrl.password, "UNSAFE_RESOURCE_URL", `Resource ${record.id} escapes the package origin.`);
      const resourceResponse = await fetcher(resourceUrl, { credentials: "omit", redirect: "error", signal: options.signal });
      return readResponse(resourceResponse, record.byteLength, `Resource ${record.id}`);
    },
  });
}
