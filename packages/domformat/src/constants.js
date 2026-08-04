import { invariant } from "./errors.js";

export const FORMAT_ID = "domformat@0";
export const PROFILE_ID = "polycss-3d@0";

export const DEFAULT_LIMITS = Object.freeze({
  maxFileBytes: 128 * 1024 * 1024,
  maxManifestBytes: 1024 * 1024,
  maxDecodedInputBytes: 64 * 1024 * 1024,
  maxAggregateDecodedBytes: 128 * 1024 * 1024,
  maxNodes: 250_000,
  maxTreeDepth: 64,
  maxAttributesPerNode: 32,
  maxClassesPerNode: 32,
  maxStylesPerNode: 64,
  maxResources: 2048,
  maxResourceBytes: 64 * 1024 * 1024,
  maxAggregateResourceBytes: 128 * 1024 * 1024,
  maxCssBytes: 16 * 1024 * 1024,
  maxCssRules: 8192,
  maxCssSelectors: 32_768,
  maxCssSelectorBytes: 4096,
  maxCssDeclarations: 131_072,
  maxCssFunctions: 131_072,
  maxCssAssetTokens: 2048,
  maxImageWidth: 16_384,
  maxImageHeight: 16_384,
  maxImagePixels: 64 * 1024 * 1024,
  maxAggregateImagePixels: 128 * 1024 * 1024,
  maxStateChannels: 128,
  maxBindingChannels: 128,
  maxBindingInputs: 256,
  maxFrames: 10_000,
  maxTimelineTicks: 1_000_000,
  maxPreparedTransforms: 2_000_000,
  maxPreparedStates: 2_000_000,
  maxPreparedChanges: 4_000_000,
  maxVisibilityCells: 64 * 1024 * 1024,
  maxEffectParticles: 10_000,
  maxEffectSpawnTuples: 1_000_000,
  maxInteractionControls: 256,
  maxInteractionObjects: 65_536,
  maxInteractionVertices: 2_000_000,
  maxInteractionWeights: 4_000_000,
  maxInteractionWeightReferences: 8_000_000,
  maxInteractionLeafRows: 4_000_000,
});

function cappedProduct(value, multiplier) {
  return value > Math.floor(Number.MAX_SAFE_INTEGER / multiplier)
    ? Number.MAX_SAFE_INTEGER
    : value * multiplier;
}

export function jsonStructureLimits(limits = DEFAULT_LIMITS) {
  const decodedItemCeiling = Math.floor(limits.maxAggregateDecodedBytes / 2) + 1;
  const maxArrayItems = Math.min(decodedItemCeiling, Math.max(
    limits.maxNodes,
    cappedProduct(limits.maxNodes, 16),
    limits.maxResources,
    limits.maxStateChannels,
    limits.maxBindingChannels,
    limits.maxBindingInputs,
    limits.maxFrames,
    cappedProduct(limits.maxFrames, 3),
    limits.maxTimelineTicks,
    limits.maxPreparedTransforms,
    limits.maxPreparedStates,
    limits.maxPreparedChanges,
    limits.maxEffectParticles,
    limits.maxEffectSpawnTuples,
    limits.maxInteractionControls,
    cappedProduct(limits.maxInteractionObjects, 16),
    cappedProduct(limits.maxInteractionVertices, 4),
    cappedProduct(limits.maxInteractionWeights, 3),
    cappedProduct(limits.maxInteractionLeafRows, 4),
  ));
  const maxObjectMembers = Math.min(
    Math.floor(limits.maxAggregateDecodedBytes / 4) + 1,
    Math.max(128, limits.maxResources, limits.maxAttributesPerNode, limits.maxStylesPerNode),
  );
  return Object.freeze({ maxArrayItems, maxObjectMembers, maxKeyCodeUnits: 256 });
}

export const DEFAULT_JSON_STRUCTURE_LIMITS = jsonStructureLimits(DEFAULT_LIMITS);

export function validateLimitOverrides(overrides = {}) {
  invariant(overrides && typeof overrides === "object" && !Array.isArray(overrides), "INVALID_LIMITS", "Limit overrides must be an object.");
  for (const [name, value] of Object.entries(overrides)) {
    invariant(Object.hasOwn(DEFAULT_LIMITS, name), "INVALID_LIMITS", `Unknown limit ${name}.`);
    invariant(Number.isSafeInteger(value) && value >= 0, "INVALID_LIMITS", `Limit ${name} must be a nonnegative safe integer.`);
  }
  return overrides;
}

export function mergeLimits(overrides = {}) {
  validateLimitOverrides(overrides);
  return Object.freeze({ ...DEFAULT_LIMITS, ...overrides });
}
