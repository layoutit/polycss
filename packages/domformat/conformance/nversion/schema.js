import { requireContract as require } from "./errors.js";
import { assertResourceId, validateResourceCatalog } from "./resources.js";

const XHTML = "http://www.w3.org/1999/xhtml";
const STABLE_ID = /^[a-z][A-Za-z0-9._:/-]{0,127}$/u;
const CLASS = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/u;
const DATA_ATTRIBUTE = /^data-[a-z][a-z0-9._:-]{0,63}$/u;
const SHORT_TOKEN = /^[a-z][a-z0-9-]{0,63}$/u;
const GENERATOR_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const GENERATOR_VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const ELEMENTS = new Set(["b", "div", "i", "img", "s", "span", "u"]);
const ATTRIBUTES = new Set(["alt", "aria-hidden", "class", "decoding", "draggable", "height", "id", "role", "width"]);
const NODE_STYLES = new Set(`backgroundColor backgroundPosition backgroundPositionY backgroundRepeat backgroundSize borderBottomLeftRadius borderBottomRightRadius borderShape borderTopLeftRadius borderTopRightRadius color cornerBottomLeftShape cornerBottomRightShape cornerTopLeftShape cornerTopRightShape height left objectFit objectPosition opacity perspective perspectiveOrigin position top transform transformOrigin transformStyle visibility width`.split(" "));
const MOUNT_STYLES = new Set(["backgroundColor", "backgroundPosition", "backgroundRepeat", "backgroundSize", "position"]);
const INLINE_FUNCTIONS = new Set(`abs acos asin atan atan2 calc clamp color color-mix cos exp hsl hsla hwb hypot lab lch linear-gradient log matrix matrix3d max min mod oklab oklch polygon pow radial-gradient rem rgb rgba rotate rotate3d rotatex rotatey rotatez round scale scale3d scalex scaley scalez sign sin skew skewx skewy sqrt tan translate translate3d translatex translatey translatez`.split(" "));
const VIEWER_ATTRIBUTES = new Set(["data-domformat-instance", "data-domformat-mount-surface"]);
const CODECS = new Map([
  ["polycss-effects@0", "polycss-effects-prepared@0"],
  ["polycss-playback@0", "polycss-playback-packed@0"],
  ["polycss-pointer-grab@0", "polycss-pointer-grab-prepared@0"],
  ["polycss-surface@0", "polycss-surface-packed@0"],
  ["static-presentation@0", "static-presentation@0"],
]);
const INPUTS = Object.freeze({
  "polycss-effects@0": ["interaction.grab-active", "interaction.grab-x", "interaction.grab-y", "interaction.grab-z", "time.source-frame"],
  "polycss-playback@0": ["time.tick"],
  "polycss-pointer-grab@0": ["axis.x", "axis.y", "button.hold", "pointer.positioned", "pointer.pressed", "pointer.x", "pointer.y"],
  "polycss-surface@0": ["time.source-frame"],
  "static-presentation@0": ["viewport.height", "viewport.width"],
});
const SINKS = Object.freeze({
  "polycss-effects@0": ["style.backgroundPosition", "style.opacity", "style.transform", "style.visibility"],
  "polycss-playback@0": ["style.transform", "style.visibility"],
  "polycss-pointer-grab@0": ["style.transform", "style.visibility"],
  "polycss-surface@0": ["style.backgroundPositionY", "style.visibility"],
  "static-presentation@0": null,
});
const BASE_CAPABILITIES = ["css-semantic-closure", "deterministic-json", "explicit-retained-tree", "logical-assets"];
const CAPABILITY_ORDER = [
  ["polycss-effects@0", "prepared-particle-effects"],
  ["polycss-pointer-grab@0", "prepared-pointer-grab-interaction"],
  ["polycss-playback@0", "prepared-playback"],
  ["polycss-surface@0", "prepared-surface-lighting"],
];
const CONFORMANCE_ORDER = [
  ["polycss-effects@0", "particle-effects"],
  ["polycss-playback@0", "playback"],
  ["polycss-pointer-grab@0", "pointer-grab-interaction"],
  ["static-presentation@0", "presentation"],
  ["polycss-surface@0", "surface-lighting"],
];

function exactObject(value, allowed, code, label, required = allowed) {
  require(value && typeof value === "object" && !Array.isArray(value), code, `${label} must be an object.`);
  for (const key of Object.keys(value)) require(allowed.includes(key), code, `${label} contains unknown field ${key}.`);
  for (const key of required) require(Object.hasOwn(value, key), code, `${label} is missing ${key}.`);
  return value;
}

function plainObject(value, code, label) {
  require(value && typeof value === "object" && !Array.isArray(value), code, `${label} must be an object.`);
  return value;
}

function exactArray(value, expected, code, label) {
  require(Array.isArray(value) && value.length === expected.length && value.every((entry, index) => entry === expected[index]), code, `${label} differs from the fixed profile order.`);
}

function uniqueArray(value, maximum, code, label, predicate = () => true) {
  require(Array.isArray(value) && value.length <= maximum && new Set(value).size === value.length && value.every(predicate), code, `${label} is invalid or excessive.`);
  return value;
}

function closedObject(value, allowed, code, label) {
  return exactObject(value, allowed, code, label, []);
}

function finiteF32(value) {
  return typeof value === "number" && Number.isFinite(value) && Number.isFinite(Math.fround(value));
}

function finiteF32Array(value, length, code, label) {
  require(Array.isArray(value) && value.length === length && value.every(finiteF32), code, `${label} must contain ${length} finite binary32 values.`);
  return value;
}

function multiplyF32Matrices(left, right) {
  const output = new Array(16);
  for (let row = 0; row < 4; row += 1) {
    for (let column = 0; column < 4; column += 1) {
      let value = Math.fround(Math.fround(left[row * 4]) * Math.fround(right[column]));
      for (let index = 1; index < 4; index += 1) {
        value = Math.fround(value + Math.fround(Math.fround(left[row * 4 + index]) * Math.fround(right[index * 4 + column])));
      }
      output[row * 4 + column] = value;
    }
  }
  return output;
}

function inverseMatrixPair(left, right) {
  for (const product of [multiplyF32Matrices(left, right), multiplyF32Matrices(right, left)]) {
    if (!product.every(Number.isFinite)) return false;
    if (!product.every((value, index) => Math.abs(value - (index % 5 === 0 ? 1 : 0)) <= 1e-4)) return false;
  }
  return true;
}

function operationF32(value) {
  const result = Math.fround(value);
  return Number.isFinite(result) ? result : Number.NaN;
}

function addF32(left, right) {
  return operationF32(operationF32(left) + operationF32(right));
}

function multiplyF32(left, right) {
  return operationF32(operationF32(left) * operationF32(right));
}

function transformF32(value, matrix) {
  return [0, 1, 2].map((column) => {
    let result = multiplyF32(matrix[column], value[0]);
    result = addF32(result, multiplyF32(matrix[4 + column], value[1]));
    return addF32(result, multiplyF32(matrix[8 + column], value[2]));
  });
}

function grabDisplacementBounds(input, source) {
  const spanX = operationF32(input.cursorBounds[1] - input.cursorBounds[0]);
  const spanY = operationF32(input.cursorBounds[3] - input.cursorBounds[2]);
  if (!Number.isFinite(spanX) || !Number.isFinite(spanY)) return null;
  const bounds = [0, 0, 0];
  for (const deltaX of [-spanX, spanX]) {
    for (const deltaY of [-spanY, spanY]) {
      const transformed = transformF32([
        multiplyF32(deltaX, source.displacementMagnitude),
        multiplyF32(deltaY, source.displacementMagnitude),
        0,
      ], source.inverseCameraMatrix);
      if (!transformed.every(Number.isFinite)) return null;
      for (let component = 0; component < 3; component += 1) bounds[component] = Math.max(bounds[component], Math.abs(transformed[component]));
    }
  }
  return bounds;
}

function projectedF32(position, source) {
  const camera = transformF32(position, source.cameraViewMatrix);
  for (let component = 0; component < 3; component += 1) camera[component] = addF32(camera[component], source.cameraViewMatrix[12 + component]);
  if (!camera.every(Number.isFinite) || Math.abs(camera[2]) <= 1e-6) return null;
  const xScale = operationF32(source.projection.scale / operationF32(-camera[2]));
  const yScale = operationF32(source.projection.scale / camera[2]);
  const projected = [
    addF32(multiplyF32(camera[0], xScale), source.projection.origin[0]),
    addF32(multiplyF32(camera[1], yScale), source.projection.origin[1]),
  ];
  return projected.every(Number.isFinite) ? projected : null;
}

function finiteMagnitudeF32(value) {
  let squared = multiplyF32(value[0], value[0]);
  squared = addF32(squared, multiplyF32(value[1], value[1]));
  squared = addF32(squared, multiplyF32(value[2], value[2]));
  return Number.isFinite(squared) && squared >= 0 && Number.isFinite(operationF32(Math.sqrt(squared)));
}

function integerArray(value, maximum, code, label, options = {}) {
  const minimum = options.minimum ?? Number.MIN_SAFE_INTEGER;
  const upper = options.upper ?? Number.MAX_SAFE_INTEGER;
  require(Array.isArray(value) && value.length <= maximum && value.every((entry) => Number.isSafeInteger(entry) && entry >= minimum && entry <= upper), code, `${label} is invalid or excessive.`);
  if (options.unique) require(new Set(value).size === value.length, code, `${label} contains duplicates.`);
  return value;
}

function base64Value(character) {
  const code = character.charCodeAt(0);
  if (code >= 65 && code <= 90) return code - 65;
  if (code >= 97 && code <= 122) return code - 71;
  if (code >= 48 && code <= 57) return code + 4;
  if (character === "+") return 62;
  if (character === "/") return 63;
  return -1;
}

function base64Integers(value, width, maximum, code, label) {
  require(typeof value === "string" && value.length % 4 === 0, code, `${label} is not canonical base64.`);
  let padding = 0;
  if (value.endsWith("==")) padding = 2;
  else if (value.endsWith("=")) padding = 1;
  const contentLength = value.length - padding;
  for (let index = 0; index < contentLength; index += 1) require(base64Value(value[index]) >= 0, code, `${label} is not canonical base64.`);
  for (let index = contentLength; index < value.length; index += 1) require(value[index] === "=", code, `${label} has misplaced padding.`);
  if (padding === 2) require(contentLength >= 2 && (base64Value(value[contentLength - 1]) & 15) === 0, code, `${label} has nonzero padding bits.`);
  if (padding === 1) require(contentLength >= 3 && (base64Value(value[contentLength - 1]) & 3) === 0, code, `${label} has nonzero padding bits.`);
  const decodedLength = value.length / 4 * 3 - padding;
  require(Number.isSafeInteger(decodedLength) && decodedLength % width === 0 && decodedLength / width <= maximum, code, `${label} is truncated or excessive.`);
  let binary;
  try { binary = globalThis.atob(value); }
  catch { require(false, code, `${label} is not valid base64.`); }
  require(binary.length === decodedLength, code, `${label} decoded length is noncanonical.`);
  return Array.from({ length: decodedLength / width }, (_, index) => {
    let result = 0;
    for (let byte = 0; byte < width; byte += 1) result += binary.charCodeAt(index * width + byte) * 2 ** (byte * 8);
    return result;
  });
}

function cumulativeReferences(deltas, count, code, label) {
  integerArray(deltas, count, code, label);
  require(deltas.length === count, code, `${label} cardinality differs from its declaration.`);
  let current = 0;
  return deltas.map((delta) => {
    current += delta;
    require(Number.isSafeInteger(current) && current >= 0, code, `${label} contains an invalid reference.`);
    return current;
  });
}

function uniqueTargets(values, label) {
  require(Array.isArray(values) && new Set(values).size === values.length, "TARGET_CARDINALITY_MISMATCH", `${label} targets must be unique.`);
  values.forEach((value, index) => stableId(value, `${label} target ${index}`));
  return values;
}

function stableId(value, label) {
  require(typeof value === "string" && STABLE_ID.test(value) && !value.includes("..") && !value.includes("//"), "INVALID_STABLE_ID", `${label} is invalid.`);
  return value;
}

function safeStyle(value, label) {
  require(typeof value === "string" && value.length <= 4096, "INVALID_STYLE_VALUE", `${label} is not a bounded string.`);
  const lower = value.toLowerCase();
  require(!/[\\;{}]/u.test(value) && !value.includes("/*") && !value.includes("*/") && !value.includes("--") && !lower.includes("url(") && !lower.includes("javascript:") && !lower.includes("expression(") && !lower.includes("@import") && !lower.includes("!important"), "UNSAFE_STYLE_VALUE", `${label} contains unsafe CSS.`);
  let quote = "";
  let depth = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quote) { if (character === quote) quote = ""; continue; }
    if (character === '"' || character === "'") { quote = character; continue; }
    if (character === "(") depth += 1;
    else if (character === ")") depth -= 1;
    require(depth >= 0, "UNSAFE_STYLE_VALUE", `${label} has unmatched parentheses.`);
    if (!/[A-Za-z_-]/u.test(character)) continue;
    let end = index + 1;
    while (/[A-Za-z0-9_-]/u.test(value[end] ?? "")) end += 1;
    if (value[end] === "(") require(INLINE_FUNCTIONS.has(value.slice(index, end).toLowerCase()), "UNSAFE_STYLE_VALUE", `${label} uses an unsupported function.`);
    index = end - 1;
  }
  require(!quote && depth === 0, "UNSAFE_STYLE_VALUE", `${label} has unterminated CSS syntax.`);
}

function attribute(name, value, mount, label) {
  require(typeof name === "string" && !VIEWER_ATTRIBUTES.has(name) && (ATTRIBUTES.has(name) || DATA_ATTRIBUTE.test(name)), "UNSAFE_ATTRIBUTE", `${label} attribute ${name} is unsupported.`);
  require(mount || (name !== "class" && name !== "srcdoc" && name !== "style" && !name.toLowerCase().startsWith("on")), "UNSAFE_ATTRIBUTE", `${label} attribute ${name} is forbidden.`);
  require(typeof value === "string" && value.length <= 1024, "INVALID_ATTRIBUTE", `${label} attribute ${name} is invalid.`);
}

function resourceStyles(value, records, label) {
  exactObject(value ?? Object.create(null), ["backgroundImage"], "INVALID_RESOURCE_STYLES", `${label} resource styles`, []);
  for (const [property, binding] of Object.entries(value ?? {})) {
    require(property === "backgroundImage", "UNSAFE_STYLE_PROPERTY", `${label} resource style is unsupported.`);
    exactObject(binding, ["resource", "syntax", "overlayOpacity"], "INVALID_RESOURCE_STYLE", `${label} resource binding`, ["resource", "syntax"]);
    const record = records.get(assertResourceId(binding.resource, `${label} resource`));
    require(record?.kind === "image", "RESOURCE_ROLE_MISMATCH", `${label} resource binding is not an image.`);
    require(binding.syntax === "url" || binding.syntax === "overlay-url", "INVALID_RESOURCE_STYLE", `${label} resource syntax is invalid.`);
    if (binding.syntax === "overlay-url") require(typeof binding.overlayOpacity === "number" && Number.isFinite(binding.overlayOpacity) && binding.overlayOpacity >= 0 && binding.overlayOpacity <= 1, "INVALID_RESOURCE_STYLE", `${label} overlay opacity is invalid.`);
    else require(!Object.hasOwn(binding, "overlayOpacity"), "INVALID_RESOURCE_STYLE", `${label} plain URL declares overlay opacity.`);
  }
}

function validateMeta(meta) {
  exactObject(meta, ["format", "profile", "title", "generator", "capabilities", "optionalCapabilities", "initialExperience", "conformance", "counts", "sourceArtifact"], "INVALID_META", "META", ["format", "profile", "title", "generator", "capabilities", "conformance"]);
  require(meta.format === "domformat@0", "UNSUPPORTED_FORMAT", "META format is unsupported.");
  require(meta.profile === "polycss-3d@0", "UNSUPPORTED_PROFILE", "META profile is unsupported.");
  require(typeof meta.title === "string" && [...meta.title].length > 0 && [...meta.title].length <= 256, "INVALID_TITLE", "META title is invalid.");
  exactObject(meta.generator, ["name", "version"], "INVALID_META", "META generator");
  require(typeof meta.generator.name === "string" && GENERATOR_NAME.test(meta.generator.name) && typeof meta.generator.version === "string" && GENERATOR_VERSION.test(meta.generator.version), "INVALID_META", "META generator identity is invalid.");
  uniqueArray(meta.capabilities, 128, "INVALID_META", "META capabilities", (value) => typeof value === "string" && SHORT_TOKEN.test(value));
  for (const capability of meta.capabilities) require([...BASE_CAPABILITIES, ...CAPABILITY_ORDER.map(([, value]) => value)].includes(capability), "UNSUPPORTED_REQUIRED_CAPABILITY", `Required capability ${capability} is unknown.`);
  if (meta.optionalCapabilities !== undefined) {
    uniqueArray(meta.optionalCapabilities, 128, "INVALID_META", "META optional capabilities", (value) => typeof value === "string" && SHORT_TOKEN.test(value));
    require(meta.optionalCapabilities.every((value, index) => !meta.capabilities.includes(value) && (index === 0 || meta.optionalCapabilities[index - 1] < value)), "INVALID_META", "META optional capabilities overlap or are unsorted.");
  }
  if (meta.initialExperience !== undefined) require(meta.initialExperience === "animation" || meta.initialExperience === "interaction", "INVALID_META", "META initial experience is invalid.");
  exactObject(meta.conformance, ["executable", "declaredOnly"], "INVALID_META", "META conformance");
  uniqueArray(meta.conformance.executable, 128, "INVALID_META", "META executable conformance", (value) => typeof value === "string" && SHORT_TOKEN.test(value));
  uniqueArray(meta.conformance.declaredOnly, 128, "INVALID_META", "META declared conformance", (value) => typeof value === "string" && SHORT_TOKEN.test(value));
  require(meta.conformance.declaredOnly.length === 0, "CONFORMANCE_CLOSURE_MISMATCH", "Declared-only conformance is unsupported.");
  if (meta.counts !== undefined) {
    exactObject(meta.counts, ["nodes", "shapes", "leaves", "sourceFrames"], "INVALID_META", "META counts", []);
    require(Object.values(meta.counts).every((value) => Number.isSafeInteger(value) && value >= 0), "INVALID_META", "META counts are invalid.");
  }
  if (meta.sourceArtifact !== undefined) {
    exactObject(meta.sourceArtifact, ["byteLength", "decodedByteLength", "digest", "status"], "INVALID_META", "META source artifact");
    require(Number.isSafeInteger(meta.sourceArtifact.byteLength) && meta.sourceArtifact.byteLength >= 0 && Number.isSafeInteger(meta.sourceArtifact.decodedByteLength) && meta.sourceArtifact.decodedByteLength >= 0 && typeof meta.sourceArtifact.status === "string" && /^[a-z0-9][a-z0-9-]*$/u.test(meta.sourceArtifact.status), "INVALID_META", "META source artifact is invalid.");
    exactObject(meta.sourceArtifact.digest, ["algorithm", "value"], "INVALID_META", "META source digest");
    require(meta.sourceArtifact.digest.algorithm === "sha256" && SHA256.test(meta.sourceArtifact.digest.value), "INVALID_META", "META source digest is invalid.");
  }
}

function validateTree(tree, records, limits) {
  exactObject(tree, ["version", "mount", "nodes"], "INVALID_TREE", "TREE");
  require(tree.version === 0, "UNSUPPORTED_TREE_SCHEMA", "TREE version must be 0.");
  exactObject(tree.mount, ["behavior", "attributes", "styles", "resourceStyles"], "INVALID_MOUNT", "TREE mount", ["behavior", "attributes"]);
  require(tree.mount.behavior === "replace-children", "INVALID_MOUNT", "TREE mount behavior is unsupported.");
  require(Array.isArray(tree.mount.attributes) && tree.mount.attributes.length <= limits.maxAttributesPerNode, "INVALID_MOUNT", "TREE mount attributes are excessive.");
  const mountNames = new Set();
  for (const entry of tree.mount.attributes) {
    require(Array.isArray(entry) && entry.length === 2, "INVALID_MOUNT", "TREE mount attribute is malformed.");
    attribute(entry[0], entry[1], true, "Mount");
    require(!mountNames.has(entry[0]), "INVALID_ATTRIBUTE", "TREE mount attribute is duplicated.");
    mountNames.add(entry[0]);
  }
  exactObject(tree.mount.styles ?? Object.create(null), [...MOUNT_STYLES], "INVALID_MOUNT", "TREE mount styles", []);
  for (const [name, value] of Object.entries(tree.mount.styles ?? {})) {
    require(MOUNT_STYLES.has(name), "UNSAFE_STYLE_PROPERTY", `Mount style ${name} is unsupported.`);
    safeStyle(value, `Mount style ${name}`);
    if (name === "position") require(value === "relative", "INVALID_MOUNT", "Mount position must be relative.");
  }
  resourceStyles(tree.mount.resourceStyles, records, "Mount");
  require(Array.isArray(tree.nodes) && tree.nodes.length <= limits.maxNodes, "NODE_COUNT_LIMIT", "TREE has too many nodes.");
  const ids = new Set();
  const byId = new Map();
  const siblings = new Map();
  const parentIndices = new Set();
  const depths = [];
  for (const [index, node] of tree.nodes.entries()) {
    exactObject(node, ["index", "id", "parent", "sibling", "namespace", "name", "classes", "attributes", "styles", "resourceAttributes", "resourceStyles"], "INVALID_NODE", `TREE node ${index}`, ["index", "id", "parent", "sibling", "namespace", "name"]);
    require(node.index === index, "NODE_INDEX", `TREE node ${index} index is noncanonical.`);
    const id = stableId(node.id, `TREE node ${index} id`);
    require(!ids.has(id), "DUPLICATE_NODE_ID", `TREE node ${id} is duplicated.`);
    ids.add(id);
    byId.set(id, node);
    require(node.namespace === XHTML, "UNSUPPORTED_NAMESPACE", `TREE node ${id} namespace is unsupported.`);
    require(ELEMENTS.has(node.name), "FORBIDDEN_ELEMENT", `TREE node ${id} element is unsupported.`);
    require(Number.isSafeInteger(node.parent) && node.parent >= -1 && node.parent < index, "INVALID_PARENT", `TREE node ${id} parent is invalid.`);
    if (node.parent >= 0) parentIndices.add(node.parent);
    const expectedSibling = siblings.get(node.parent) ?? 0;
    require(node.sibling === expectedSibling, "INVALID_SIBLING", `TREE node ${id} sibling is not ${expectedSibling}.`);
    siblings.set(node.parent, expectedSibling + 1);
    const depth = node.parent === -1 ? 1 : depths[node.parent] + 1;
    require(depth <= limits.maxTreeDepth, "TREE_DEPTH_LIMIT", `TREE node ${id} is too deep.`);
    depths.push(depth);
    uniqueArray(node.classes ?? [], limits.maxClassesPerNode, "INVALID_CLASS", `TREE node ${id} classes`, (value) => typeof value === "string" && CLASS.test(value));
    plainObject(node.attributes ?? Object.create(null), "INVALID_ATTRIBUTES", `TREE node ${id} attributes`);
    require(Object.keys(node.attributes ?? {}).length <= limits.maxAttributesPerNode, "ATTRIBUTE_COUNT_LIMIT", `TREE node ${id} has too many attributes.`);
    for (const [name, value] of Object.entries(node.attributes ?? {})) attribute(name, value, false, `TREE node ${id}`);
    exactObject(node.styles ?? Object.create(null), [...NODE_STYLES], "INVALID_STYLES", `TREE node ${id} styles`, []);
    require(Object.keys(node.styles ?? {}).length <= limits.maxStylesPerNode, "STYLE_COUNT_LIMIT", `TREE node ${id} has too many styles.`);
    for (const [name, value] of Object.entries(node.styles ?? {})) { require(NODE_STYLES.has(name), "UNSAFE_STYLE_PROPERTY", `TREE node ${id} style ${name} is unsupported.`); safeStyle(value, `TREE node ${id} style ${name}`); }
    exactObject(node.resourceAttributes ?? Object.create(null), ["src"], "INVALID_RESOURCE_ATTRIBUTES", `TREE node ${id} resource attributes`, []);
    for (const [name, resource] of Object.entries(node.resourceAttributes ?? {})) require(name === "src" && records.get(resource)?.kind === "image", "RESOURCE_ROLE_MISMATCH", `TREE node ${id} resource attribute is invalid.`);
    resourceStyles(node.resourceStyles, records, `TREE node ${id}`);
  }
  for (const node of tree.nodes) if (!parentIndices.has(node.index)) require(node.attributes?.["aria-hidden"] === "true", "ACCESSIBILITY_REQUIRED", `Terminal visual node ${node.id} must be aria-hidden.`);
  return { ids, byId };
}

function validateCssBinding(cssBinding, records, mount, limits) {
  exactObject(cssBinding, ["version", "stylesheets"], "INVALID_CSS_BINDING", "CSSB");
  require(cssBinding.version === 0, "UNSUPPORTED_CSS_BINDING_SCHEMA", "CSSB version must be 0.");
  require(Array.isArray(cssBinding.stylesheets) && cssBinding.stylesheets.length > 0 && cssBinding.stylesheets.length <= records.size, "INVALID_CSS_BINDING", "CSSB stylesheets are invalid.");
  const ids = new Set();
  for (const binding of cssBinding.stylesheets) {
    exactObject(binding, ["id", "resource", "scope", "assetTokens"], "INVALID_CSS_BINDING", "Stylesheet binding");
    assertResourceId(binding.id, "Stylesheet binding id");
    require(!ids.has(binding.id) && records.get(binding.resource)?.kind === "stylesheet", "RESOURCE_ROLE_MISMATCH", `Stylesheet binding ${binding.id} is duplicated or not a stylesheet.`);
    ids.add(binding.id);
    const scope = /^\[([a-z0-9-]{1,64})="([A-Za-z0-9._-]{1,64})"\]$/u.exec(binding.scope);
    require(scope && mount.attributes.some(([name, value]) => name === scope[1] && value === scope[2]), "CSS_SCOPE_MISMATCH", `Stylesheet ${binding.id} scope does not match TREE.`);
    require(Array.isArray(binding.assetTokens) && binding.assetTokens.length <= limits.maxCssAssetTokens, "CSS_TOKEN_LIMIT", `Stylesheet ${binding.id} tokens are excessive.`);
    const tokens = new Set();
    for (const token of binding.assetTokens) {
      exactObject(token, ["token", "resource"], "INVALID_CSS_BINDING", `Stylesheet ${binding.id} token`);
      require(typeof token.token === "string" && /^dom-asset:[a-z][a-z0-9._-]{0,63}$/u.test(token.token) && !tokens.has(token.token) && records.get(token.resource)?.kind === "image", "INVALID_CSS_TOKEN", `Stylesheet ${binding.id} token is invalid.`);
      tokens.add(token.token);
    }
  }
}

function collectTargets(value, maximum, depthLimit) {
  const output = [];
  const stack = [{ value, depth: 0 }];
  let containers = 0;
  let entries = 0;
  const structuralLimit = maximum * 4 + depthLimit;
  while (stack.length) {
    const current = stack.pop();
    if (typeof current.value === "string") { output.push(current.value); require(output.length <= maximum, "TARGET_CARDINALITY_MISMATCH", "Binding targets exceed their limit."); continue; }
    require(current.value && typeof current.value === "object" && current.depth < depthLimit, "INVALID_TARGETS", "Binding target graph is invalid or too deep.");
    containers += 1;
    require(containers <= structuralLimit, "TARGET_CARDINALITY_MISMATCH", "Binding target containers exceed their limit.");
    const values = Array.isArray(current.value) ? current.value : Object.values(current.value);
    entries += values.length;
    require(entries <= structuralLimit, "TARGET_CARDINALITY_MISMATCH", "Binding target entries exceed their limit.");
    for (let index = values.length - 1; index >= 0; index -= 1) stack.push({ value: values[index], depth: current.depth + 1 });
  }
  return output;
}

function validateStateAndBindings(state, bindings, nodeIds, limits) {
  exactObject(state, ["version", "channels"], "INVALID_STATE", "STAT");
  require(state.version === 0 && Array.isArray(state.channels) && state.channels.length <= limits.maxStateChannels, "STATE_CHANNEL_LIMIT", "STAT is invalid or excessive.");
  const states = new Map();
  let previous = "";
  for (const channel of state.channels) {
    exactObject(channel, ["id", "codec", "data"], "INVALID_STATE", "State channel");
    const id = stableId(channel.id, "State channel id");
    require(id > previous && !states.has(id) && [...CODECS.values()].includes(channel.codec), "STATE_CHANNEL_ORDER", "State channels are unsorted, duplicated, or unsupported.");
    previous = id;
    states.set(id, channel);
  }
  exactObject(bindings, ["version", "inputs", "channels"], "INVALID_BINDINGS", "BIND");
  require(bindings.version === 0 && Array.isArray(bindings.inputs) && bindings.inputs.length <= limits.maxBindingInputs && Array.isArray(bindings.channels) && bindings.channels.length <= limits.maxBindingChannels, "INVALID_BINDINGS", "BIND is invalid or excessive.");
  const inputs = new Map();
  previous = "";
  for (const input of bindings.inputs) {
    exactObject(input, ["id", "type", "default"], "INVALID_BINDINGS", "Binding input", ["id", "type"]);
    const id = stableId(input.id, "Binding input id");
    require(id > previous && !inputs.has(id) && ["boolean", "float", "uint"].includes(input.type), "INPUT_ORDER", "Binding inputs are unsorted, duplicated, or mistyped.");
    previous = id;
    if (Object.hasOwn(input, "default")) require(input.type === "boolean" ? typeof input.default === "boolean" : input.type === "float" ? typeof input.default === "number" && Number.isFinite(input.default) : Number.isSafeInteger(input.default) && input.default >= 0, "INVALID_INPUT_DEFAULT", `Input ${id} default is invalid.`);
    inputs.set(id, input);
  }
  const channels = new Map();
  const interpreters = new Set();
  const boundStates = new Set();
  const usedInputs = new Set();
  previous = "";
  for (const channel of bindings.channels) {
    exactObject(channel, ["id", "state", "interpreter", "status", "inputs", "targets", "sinks", "parameters"], "INVALID_BINDINGS", "Binding channel", ["id", "state", "interpreter", "status", "inputs", "targets", "sinks"]);
    const id = stableId(channel.id, "Binding channel id");
    const stateChannel = states.get(channel.state);
    require(id > previous && !channels.has(id), "BINDING_CHANNEL_ORDER", "Binding channels are unsorted or duplicated.");
    previous = id;
    require(stateChannel && CODECS.get(channel.interpreter) === stateChannel.codec && !interpreters.has(channel.interpreter) && !boundStates.has(channel.state), "STATE_INTERPRETER_MISMATCH", `Binding ${id} does not uniquely match its state codec.`);
    require(channel.status === "executable", "INVALID_BINDING_STATUS", `Binding ${id} is not executable.`);
    exactArray(channel.inputs, INPUTS[channel.interpreter], "INVALID_BINDING_INPUTS", `Binding ${id} inputs`);
    if (SINKS[channel.interpreter]) exactArray(channel.sinks, SINKS[channel.interpreter], "UNSUPPORTED_SINK", `Binding ${id} sinks`);
    for (const input of channel.inputs) { require(inputs.has(input), "MISSING_INPUT", `Binding ${id} input ${input} is undeclared.`); usedInputs.add(input); }
    const targets = collectTargets(channel.targets, nodeIds.size + 1, limits.maxTreeDepth);
    require((targets.length > 0 || channel.interpreter === "polycss-surface@0") && new Set(targets).size === targets.length, "DUPLICATE_TARGET", `Binding ${id} targets are empty or duplicated.`);
    for (const target of targets) require(target === "$host" || nodeIds.has(target), "MISSING_TARGET_NODE", `Binding ${id} target ${target} is missing.`);
    interpreters.add(channel.interpreter);
    boundStates.add(channel.state);
    channels.set(id, channel);
  }
  require(states.size === boundStates.size && [...states.keys()].every((id) => boundStates.has(id)), "UNBOUND_STATE_CHANNEL", "A state channel is not bound exactly once.");
  require(inputs.size === usedInputs.size && [...inputs.keys()].every((id) => usedInputs.has(id)), "UNUSED_INPUT", "A declared input is unused.");
  return { states, channels, inputs, interpreters };
}

function validatePlayback(state, binding, inputs, limits) {
  const tick = inputs.get("time.tick");
  require(tick?.type === "uint" && !Object.hasOwn(tick, "default"), "INVALID_PLAYBACK_BINDING", "Playback time.tick must be an un-defaulted uint.");
  const targets = exactObject(binding.targets, ["model", "shapes", "leaves"], "INVALID_PLAYBACK_BINDING", "Playback targets");
  stableId(targets.model, "Playback model target");
  uniqueTargets(targets.shapes, "Playback shape");
  uniqueTargets(targets.leaves, "Playback leaf");
  const parameters = exactObject(binding.parameters, ["frameCount", "baseSceneTransform", "tickRateHz"], "INVALID_PLAYBACK_BINDING", "Playback parameters");
  require(Number.isSafeInteger(parameters.frameCount) && parameters.frameCount > 0 && parameters.frameCount <= limits.maxFrames, "FRAME_CARDINALITY_MISMATCH", "Playback frameCount is invalid or excessive.");
  require(parameters.tickRateHz === 30, "INVALID_PLAYBACK_BINDING", "Playback tickRateHz must be 30.");
  safeStyle(parameters.baseSceneTransform, "Playback base scene transform");

  exactObject(state.data, ["packet", "leafFit"], "INVALID_PLAYBACK_STATE", "Playback state");
  const packet = exactObject(state.data.packet, ["version", "layout", "shapeCount", "leafCount", "appearances", "timeline", "initial", "frameRows", "shapeChanges", "leafChanges", "transforms"], "INVALID_PLAYBACK_STATE", "Playback packet");
  require(packet.version === 0 && packet.layout === "delta-component-streams@0", "INVALID_PLAYBACK_STATE", "Playback version/layout is invalid.");
  require(Number.isSafeInteger(packet.shapeCount) && packet.shapeCount >= 0 && packet.shapeCount <= limits.maxNodes, "TARGET_CARDINALITY_MISMATCH", "Playback shapeCount is invalid.");
  require(Number.isSafeInteger(packet.leafCount) && packet.leafCount >= 0 && packet.leafCount <= Math.min(limits.maxNodes, 65_536), "TARGET_CARDINALITY_MISMATCH", "Playback leafCount is invalid.");
  require(packet.shapeCount === targets.shapes.length && packet.leafCount === targets.leaves.length, "TARGET_CARDINALITY_MISMATCH", "Playback target counts disagree.");
  require(packet.leafCount * parameters.frameCount <= limits.maxVisibilityCells, "VISIBILITY_ALLOCATION_LIMIT", "Playback visibility allocation is excessive.");
  require(Array.isArray(state.data.leafFit) && state.data.leafFit.length === packet.leafCount, "TARGET_CARDINALITY_MISMATCH", "Playback leafFit differs from leafCount.");
  for (const [index, fit] of state.data.leafFit.entries()) {
    exactObject(fit, ["canonicalSize"], "INVALID_PLAYBACK_STATE", `Playback leafFit ${index}`);
    require(Number.isSafeInteger(fit.canonicalSize) && fit.canonicalSize > 0 && fit.canonicalSize <= 65_535, "INVALID_PLAYBACK_STATE", `Playback leafFit ${index} is invalid.`);
  }

  require(Array.isArray(packet.appearances) && packet.appearances.length > 0 && packet.appearances.length <= limits.maxFrames, "INVALID_PLAYBACK_STATE", "Playback appearances are invalid or excessive.");
  const appearanceIds = new Set();
  for (const [index, appearance] of packet.appearances.entries()) {
    require(Array.isArray(appearance) && appearance.length === 3, "INVALID_PLAYBACK_STATE", `Playback appearance ${index} is malformed.`);
    const id = stableId(appearance[0], `Playback appearance ${index} id`);
    require(!appearanceIds.has(id) && finiteF32(appearance[1]) && appearance[1] > 0 && finiteF32(appearance[2]), "INVALID_PLAYBACK_STATE", `Playback appearance ${index} is invalid.`);
    appearanceIds.add(id);
  }

  const transforms = exactObject(packet.transforms, ["count", "groups"], "INVALID_PLAYBACK_STATE", "Playback transforms");
  require(Number.isSafeInteger(transforms.count) && transforms.count > 0 && transforms.count <= limits.maxPreparedTransforms, "TRANSFORM_ALLOCATION_LIMIT", "Playback transform count is invalid or excessive.");
  require(Array.isArray(transforms.groups) && transforms.groups.length <= limits.maxNodes, "TRANSFORM_ALLOCATION_LIMIT", "Playback transform groups are invalid or excessive.");

  const initial = exactObject(packet.initial, ["sourceFrame", "appearance", "modelTransform", "shapes", "leaves"], "INVALID_PLAYBACK_STATE", "Playback initial state");
  require(Number.isSafeInteger(initial.sourceFrame) && initial.sourceFrame >= 1 && initial.sourceFrame <= parameters.frameCount, "FRAME_CARDINALITY_MISMATCH", "Playback initial source frame is invalid.");
  require(Number.isSafeInteger(initial.appearance) && initial.appearance >= 0 && initial.appearance < packet.appearances.length, "INVALID_PLAYBACK_STATE", "Playback initial appearance is invalid.");
  require(Number.isSafeInteger(initial.modelTransform) && initial.modelTransform >= 0 && initial.modelTransform < transforms.count, "INVALID_PLAYBACK_STATE", "Playback initial model transform is invalid.");
  const initialShapes = exactObject(initial.shapes, ["count", "transforms", "visibility"], "INVALID_PLAYBACK_STATE", "Playback initial shapes");
  require(initialShapes.count === packet.shapeCount, "TARGET_CARDINALITY_MISMATCH", "Playback initial shape count differs.");
  const initialShapeTransforms = cumulativeReferences(initialShapes.transforms, packet.shapeCount, "INVALID_PLAYBACK_STATE", "Playback initial shape transforms");
  integerArray(initialShapes.visibility, packet.shapeCount, "INVALID_PLAYBACK_STATE", "Playback initial shape visibility", { minimum: 0, upper: 1 });
  require(initialShapes.visibility.length === packet.shapeCount, "TARGET_CARDINALITY_MISMATCH", "Playback initial visibility differs from shapeCount.");
  const initialLeaves = exactObject(initial.leaves, ["count", "transforms"], "INVALID_PLAYBACK_STATE", "Playback initial leaves");
  require(initialLeaves.count === packet.leafCount, "TARGET_CARDINALITY_MISMATCH", "Playback initial leaf count differs.");
  const initialLeafTransforms = cumulativeReferences(initialLeaves.transforms, packet.leafCount, "INVALID_PLAYBACK_STATE", "Playback initial leaf transforms");
  require([...initialShapeTransforms, ...initialLeafTransforms].every((index) => index < transforms.count), "INVALID_PLAYBACK_STATE", "Playback initial state references an absent transform.");

  const timeline = exactObject(packet.timeline, ["introTicks", "loopTicks", "frames"], "INVALID_PLAYBACK_STATE", "Playback timeline");
  require(Number.isSafeInteger(timeline.introTicks) && timeline.introTicks >= 0 && Number.isSafeInteger(timeline.loopTicks) && timeline.loopTicks > 0, "TIMELINE_LIMIT", "Playback timeline ranges are invalid.");
  integerArray(timeline.frames, limits.maxTimelineTicks, "TIMELINE_LIMIT", "Playback timeline frames", { minimum: 1, upper: parameters.frameCount });
  require(timeline.frames.length === timeline.introTicks + timeline.loopTicks && timeline.frames[0] === initial.sourceFrame, "TIMELINE_LIMIT", "Playback timeline coverage or initial frame is invalid.");

  const shapeChanges = exactObject(packet.shapeChanges, ["sources", "transforms", "visibility"], "INVALID_PLAYBACK_STATE", "Playback shape changes");
  const leafChanges = exactObject(packet.leafChanges, ["sources", "transforms"], "INVALID_PLAYBACK_STATE", "Playback leaf changes");
  integerArray(shapeChanges.sources, limits.maxPreparedChanges, "STATE_CHANGE_LIMIT", "Playback shape sources");
  integerArray(shapeChanges.transforms, limits.maxPreparedChanges, "STATE_CHANGE_LIMIT", "Playback shape transforms");
  integerArray(shapeChanges.visibility, limits.maxPreparedChanges, "STATE_CHANGE_LIMIT", "Playback shape visibility", { minimum: 0, upper: 1 });
  integerArray(leafChanges.sources, limits.maxPreparedChanges, "STATE_CHANGE_LIMIT", "Playback leaf sources");
  integerArray(leafChanges.transforms, limits.maxPreparedChanges, "STATE_CHANGE_LIMIT", "Playback leaf transforms");
  require(shapeChanges.sources.length === shapeChanges.transforms.length && shapeChanges.sources.length === shapeChanges.visibility.length && leafChanges.sources.length === leafChanges.transforms.length, "STATE_COLUMN_MISMATCH", "Playback change columns differ in length.");
  require(Array.isArray(packet.frameRows) && packet.frameRows.length === parameters.frameCount, "FRAME_CARDINALITY_MISMATCH", "Playback frame rows differ from frameCount.");

  const owners = new Array(transforms.count);
  const claim = (index, owner) => {
    require(Number.isSafeInteger(index) && index >= 0 && index < transforms.count, "INVALID_PLAYBACK_STATE", "Playback references an absent transform.");
    if (owners[index] === undefined) owners[index] = owner;
    else require(owners[index] === owner || (owners[index].startsWith("shape:") && owner.startsWith("shape:")), "TRANSFORM_GROUP_MISMATCH", "Playback transform aliases incompatible owners.");
  };
  claim(initial.modelTransform, "model");
  initialShapeTransforms.forEach((transform, index) => claim(transform, `shape:${index}`));
  initialLeafTransforms.forEach((transform, index) => claim(transform, `leaf:${index}`));
  let shapeCursor = 0;
  let leafCursor = 0;
  let shapeTransform = 0;
  let leafTransform = 0;
  for (const [index, row] of packet.frameRows.entries()) {
    require(Array.isArray(row) && row.length === 7 && row.every(Number.isSafeInteger) && row[0] === index + 1, "INVALID_FRAME_ROW", `Playback frame row ${index} is malformed.`);
    require(row[1] >= 0 && row[1] < packet.appearances.length && (row[2] === -1 || (row[2] >= 0 && row[2] < transforms.count)), "INVALID_FRAME_ROW", `Playback frame row ${index} references invalid state.`);
    if (row[2] !== -1) claim(row[2], "model");
    require(row[3] === shapeCursor && row[4] >= 0 && row[3] + row[4] <= shapeChanges.sources.length, "STATE_COLUMN_MISMATCH", `Playback frame row ${index} shape range is noncanonical.`);
    let shape = 0;
    for (let cursor = row[3]; cursor < row[3] + row[4]; cursor += 1) {
      shape += shapeChanges.sources[cursor];
      shapeTransform += shapeChanges.transforms[cursor];
      require(shape >= 0 && shape < packet.shapeCount, "STATE_COLUMN_MISMATCH", `Playback frame row ${index} has an invalid shape.`);
      claim(shapeTransform, `shape:${shape}`);
    }
    shapeCursor += row[4];
    require(row[5] === leafCursor && row[6] >= 0 && row[5] + row[6] <= leafChanges.sources.length, "STATE_COLUMN_MISMATCH", `Playback frame row ${index} leaf range is noncanonical.`);
    let leaf = 0;
    for (let cursor = row[5]; cursor < row[5] + row[6]; cursor += 1) {
      leaf += leafChanges.sources[cursor];
      leafTransform += leafChanges.transforms[cursor];
      require(leaf >= 0 && leaf < packet.leafCount, "STATE_COLUMN_MISMATCH", `Playback frame row ${index} has an invalid leaf.`);
      claim(leafTransform, `leaf:${leaf}`);
    }
    leafCursor += row[6];
  }
  require(shapeCursor === shapeChanges.sources.length && leafCursor === leafChanges.sources.length, "STATE_COLUMN_MISMATCH", "Playback change tables contain unreferenced rows.");
  const inferredGroups = new Map();
  for (let index = 0; index < owners.length; index += 1) {
    const owner = owners[index];
    require(typeof owner === "string", "TRANSFORM_GROUP_MISMATCH", `Playback transform ${index} is unowned.`);
    if (!inferredGroups.has(owner)) inferredGroups.set(owner, []);
    inferredGroups.get(owner).push(index);
  }
  require(transforms.groups.length === inferredGroups.size, "TRANSFORM_GROUP_MISMATCH", "Playback transform groups differ from inferred owners.");
  for (const [groupIndex, [owner, indices]] of [...inferredGroups].entries()) {
    const group = exactObject(transforms.groups[groupIndex], ["encoding", "empty", "scales", "columns"], "INVALID_PLAYBACK_STATE", `Playback transform group ${groupIndex}`);
    require(group.encoding === "decimal-component-streams" || group.encoding === "source-milli-fitted-leaf", "INVALID_PLAYBACK_STATE", `Playback transform group ${groupIndex} encoding is unsupported.`);
    if (group.encoding === "source-milli-fitted-leaf") require(owner.startsWith("leaf:"), "TRANSFORM_GROUP_MISMATCH", `Playback fitted group ${groupIndex} is not leaf-owned.`);
    integerArray(group.empty, indices.length, "INVALID_PLAYBACK_STATE", `Playback transform group ${groupIndex} empty rows`, { minimum: 0, upper: Math.max(0, indices.length - 1), unique: true });
    require(group.empty.every((value, index) => index === 0 || group.empty[index - 1] < value), "INVALID_PLAYBACK_STATE", `Playback transform group ${groupIndex} empty rows are unsorted.`);
    require(Array.isArray(group.scales) && group.scales.length === 12 && group.scales.every((scale) => Number.isSafeInteger(scale) && scale >= 0), "INVALID_PLAYBACK_STATE", `Playback transform group ${groupIndex} scales are invalid.`);
    if (group.encoding === "source-milli-fitted-leaf") require(group.scales.every((scale) => scale === 1000), "INVALID_PLAYBACK_STATE", `Playback fitted group ${groupIndex} scales are invalid.`);
    const presentCount = indices.length - group.empty.length;
    require(Array.isArray(group.columns) && group.columns.length === 12, "INVALID_PLAYBACK_STATE", `Playback transform group ${groupIndex} must have 12 columns.`);
    group.columns.forEach((column, columnIndex) => {
      require(Array.isArray(column) && column.length === presentCount && column.every((value) => typeof value === "number" && Number.isFinite(value)), "INVALID_PLAYBACK_STATE", `Playback transform group ${groupIndex} column ${columnIndex} is invalid.`);
      if (group.scales[columnIndex] > 0) {
        let current = 0;
        for (const delta of column) {
          require(Number.isSafeInteger(delta), "INVALID_PLAYBACK_STATE", `Playback transform group ${groupIndex} scaled column is noninteger.`);
          current += delta;
          require(Number.isSafeInteger(current) && Number.isFinite(current / group.scales[columnIndex]), "INVALID_PLAYBACK_STATE", `Playback transform group ${groupIndex} column overflows.`);
        }
      }
    });
  }
  return packet;
}

function surfaceStateAt(sourceFrames, frameIndex) {
  let lower = 0;
  let upper = sourceFrames.length;
  while (lower < upper) {
    const middle = lower + Math.floor((upper - lower) / 2);
    if (sourceFrames[middle] <= frameIndex) lower = middle + 1;
    else upper = middle;
  }
  return lower - 1;
}

function validateSurface(state, binding, playback, inputs, limits) {
  const sourceFrame = inputs.get("time.source-frame");
  require(sourceFrame?.type === "uint" && !Object.hasOwn(sourceFrame, "default"), "INVALID_SURFACE_BINDING", "Surface time.source-frame must be an un-defaulted uint.");
  require(!Object.hasOwn(binding, "parameters"), "INVALID_SURFACE_BINDING", "Surface binding has no parameters.");
  const targets = exactObject(binding.targets, ["leaves"], "INVALID_SURFACE_BINDING", "Surface targets");
  uniqueTargets(targets.leaves, "Surface leaf");
  require(playback && exactEqualArray(targets.leaves, playback.binding.targets.leaves), "TARGET_CARDINALITY_MISMATCH", "Surface leaves must exactly match playback leaves.");

  exactObject(state.data, ["packet"], "INVALID_SURFACE_STATE", "Surface state");
  const packet = exactObject(state.data.packet, ["version", "frameCount", "surface", "transitions", "visibility"], "INVALID_SURFACE_STATE", "Surface packet");
  require(packet.version === 0 && packet.frameCount === playback.binding.parameters.frameCount, "FRAME_CARDINALITY_MISMATCH", "Surface version/frameCount differs from playback.");
  const surface = exactObject(packet.surface, ["faces", "statePacking"], "INVALID_SURFACE_STATE", "Surface table");
  require(Array.isArray(surface.faces) && surface.faces.length === playback.packet.leafCount, "TARGET_CARDINALITY_MISMATCH", "Surface faces differ from playback leaves.");
  const packing = exactObject(surface.statePacking, ["stateCount", "sourceFrameDeltas"], "INVALID_SURFACE_STATE", "Surface state packing");
  require(Number.isSafeInteger(packing.stateCount) && packing.stateCount >= 0 && packing.stateCount <= limits.maxPreparedStates, "SURFACE_STATE_LIMIT", "Surface state count is invalid or excessive.");
  integerArray(packing.sourceFrameDeltas, limits.maxPreparedStates, "SURFACE_STATE_LIMIT", "Surface source-frame deltas", { minimum: 0, upper: packet.frameCount - 1 });
  require(packing.sourceFrameDeltas.length === packing.stateCount, "STATE_COLUMN_MISMATCH", "Surface source-frame deltas differ from stateCount.");
  const faceIds = new Set();
  const sourceFramesByFace = [];
  let stateOffset = 0;
  for (const [index, face] of surface.faces.entries()) {
    exactObject(face, ["faceId", "sourceOrder", "stateOffset", "stateCount", "leafWidth", "leafHeight"], "INVALID_SURFACE_STATE", `Surface face ${index}`);
    const id = stableId(face.faceId, `Surface face ${index} id`);
    require(!faceIds.has(id) && face.sourceOrder === index, "INVALID_SURFACE_STATE", `Surface face ${index} identity/order is invalid.`);
    faceIds.add(id);
    require(face.stateOffset === stateOffset && Number.isSafeInteger(face.stateCount) && face.stateCount > 0 && stateOffset + face.stateCount <= packing.stateCount, "STATE_COLUMN_MISMATCH", `Surface face ${index} state range is noncanonical.`);
    require(Number.isSafeInteger(face.leafWidth) && face.leafWidth > 0 && face.leafWidth <= 65_535 && Number.isSafeInteger(face.leafHeight) && face.leafHeight > 0 && face.leafHeight <= 65_535, "INVALID_SURFACE_STATE", `Surface face ${index} dimensions are invalid.`);
    let frame = 0;
    const frames = [];
    for (let local = 0; local < face.stateCount; local += 1) {
      const delta = packing.sourceFrameDeltas[stateOffset + local];
      require(local === 0 ? delta === 0 : delta > 0, "INVALID_SURFACE_STATE", `Surface face ${index} deltas are noncanonical.`);
      frame += delta;
      require(frame < packet.frameCount, "INVALID_SURFACE_STATE", `Surface face ${index} state exceeds frameCount.`);
      frames.push(frame);
    }
    sourceFramesByFace.push(frames);
    stateOffset += face.stateCount;
  }
  require(stateOffset === packing.stateCount, "STATE_COLUMN_MISMATCH", "Surface state rows are unreferenced.");

  const transitions = exactObject(packet.transitions, ["initialFrame", "sequential", "nonInteractiveJumps"], "INVALID_SURFACE_STATE", "Surface transitions");
  require(transitions.initialFrame === 1 && transitions.initialFrame === playback.packet.initial.sourceFrame, "FRAME_CARDINALITY_MISMATCH", "Surface initial frame differs from playback frame 1.");
  const sequential = exactObject(transitions.sequential, ["offsetsBase64", "faceIndexDeltas", "stateIndexDeltas"], "INVALID_SURFACE_STATE", "Surface sequential transitions");
  integerArray(sequential.faceIndexDeltas, limits.maxPreparedChanges, "STATE_CHANGE_LIMIT", "Surface face deltas", { minimum: 0, upper: Math.max(0, playback.packet.leafCount - 1) });
  integerArray(sequential.stateIndexDeltas, limits.maxPreparedChanges, "STATE_CHANGE_LIMIT", "Surface state deltas", { minimum: 0, upper: 65_535 });
  require(sequential.faceIndexDeltas.length === sequential.stateIndexDeltas.length, "STATE_COLUMN_MISMATCH", "Surface transition columns differ in length.");
  const offsets = base64Integers(sequential.offsetsBase64, 4, packet.frameCount + 1, "INVALID_SURFACE_STATE", "Surface transition offsets");
  require(offsets.length === packet.frameCount + 1 && offsets[0] === 0 && offsets.at(-1) === sequential.faceIndexDeltas.length && offsets.every((offset, index) => index === 0 || offsets[index - 1] <= offset), "STATE_COLUMN_MISMATCH", "Surface transition offsets are invalid.");
  const currentStates = new Uint32Array(playback.packet.leafCount);
  const lightingSegments = [];
  for (let frame = 0; frame < packet.frameCount; frame += 1) {
    let face = 0;
    let previous = -1;
    const faces = [];
    const states = [];
    for (let cursor = offsets[frame]; cursor < offsets[frame + 1]; cursor += 1) {
      face += sequential.faceIndexDeltas[cursor];
      require(face >= 0 && face < surface.faces.length && face > previous, "INVALID_SURFACE_STATE", `Surface transition ${frame} face order is invalid.`);
      currentStates[face] += sequential.stateIndexDeltas[cursor];
      require(currentStates[face] < surface.faces[face].stateCount, "INVALID_SURFACE_STATE", `Surface transition ${frame} exceeds state count.`);
      faces.push(face);
      states.push(currentStates[face]);
      previous = face;
    }
    lightingSegments.push({ faces, states });
  }
  require(Array.isArray(transitions.nonInteractiveJumps) && transitions.nonInteractiveJumps.length <= packet.frameCount, "INVALID_SURFACE_STATE", "Surface jumps are invalid or excessive.");
  const jumpPairs = new Set();
  const lightingJumps = new Map();
  for (const [index, jump] of transitions.nonInteractiveJumps.entries()) {
    exactObject(jump, ["fromFrame", "toFrame", "faceIndicesBase64", "stateIndicesBase64"], "INVALID_SURFACE_STATE", `Surface jump ${index}`);
    require(Number.isSafeInteger(jump.fromFrame) && jump.fromFrame >= 1 && jump.fromFrame <= packet.frameCount && Number.isSafeInteger(jump.toFrame) && jump.toFrame >= 1 && jump.toFrame <= packet.frameCount && jump.fromFrame !== jump.toFrame, "INVALID_SURFACE_STATE", `Surface jump ${index} frames are invalid.`);
    const pair = `${jump.fromFrame}>${jump.toFrame}`;
    require(!jumpPairs.has(pair), "INVALID_SURFACE_STATE", `Surface jump ${pair} is duplicated.`);
    jumpPairs.add(pair);
    const faces = base64Integers(jump.faceIndicesBase64, 2, playback.packet.leafCount, "INVALID_SURFACE_STATE", `Surface jump ${index} faces`);
    const states = base64Integers(jump.stateIndicesBase64, 2, playback.packet.leafCount, "INVALID_SURFACE_STATE", `Surface jump ${index} states`);
    require(faces.length === states.length && faces.every((face, cursor) => face < surface.faces.length && (cursor === 0 || faces[cursor - 1] < face) && states[cursor] < surface.faces[face].stateCount), "INVALID_SURFACE_STATE", `Surface jump ${index} rows are invalid.`);
    lightingJumps.set(pair, { faces, states });
  }

  const visibility = exactObject(packet.visibility, ["initialFrame", "initialVisibleBitsBase64", "sequential", "nonInteractiveJumps"], "INVALID_SURFACE_STATE", "Surface visibility");
  require(visibility.initialFrame === transitions.initialFrame, "FRAME_CARDINALITY_MISMATCH", "Surface visibility initial frame differs.");
  const initialBits = base64Integers(visibility.initialVisibleBitsBase64, 1, Math.ceil(playback.packet.leafCount / 8), "INVALID_SURFACE_STATE", "Surface initial visibility");
  require(initialBits.length === Math.ceil(playback.packet.leafCount / 8), "INVALID_SURFACE_STATE", "Surface initial visibility is truncated.");
  for (let index = playback.packet.leafCount; index < initialBits.length * 8; index += 1) require(((initialBits[index >> 3] >> (index & 7)) & 1) === 0, "INVALID_SURFACE_STATE", "Surface visibility has nonzero unused bits.");
  const visibilitySequential = exactObject(visibility.sequential, ["offsetsBase64", "faceIndicesBase64"], "INVALID_SURFACE_STATE", "Surface sequential visibility");
  const visibilityOffsets = base64Integers(visibilitySequential.offsetsBase64, 4, packet.frameCount + 1, "INVALID_SURFACE_STATE", "Surface visibility offsets");
  const visibilityFaces = base64Integers(visibilitySequential.faceIndicesBase64, 2, limits.maxPreparedChanges, "INVALID_SURFACE_STATE", "Surface visibility faces");
  require(visibilityOffsets.length === packet.frameCount + 1 && visibilityOffsets[0] === 0 && visibilityOffsets.at(-1) === visibilityFaces.length && visibilityOffsets.every((offset, index) => index === 0 || visibilityOffsets[index - 1] <= offset), "STATE_COLUMN_MISMATCH", "Surface visibility offsets are invalid.");
  for (let frame = 0; frame < packet.frameCount; frame += 1) for (let cursor = visibilityOffsets[frame]; cursor < visibilityOffsets[frame + 1]; cursor += 1) require(visibilityFaces[cursor] < playback.packet.leafCount && (cursor === visibilityOffsets[frame] || visibilityFaces[cursor - 1] < visibilityFaces[cursor]), "INVALID_SURFACE_STATE", `Surface visibility segment ${frame} is invalid.`);
  require(playback.packet.leafCount * packet.frameCount <= limits.maxVisibilityCells, "VISIBILITY_ALLOCATION_LIMIT", "Surface visibility allocation is excessive.");
  const visibilityRows = new Uint8Array(playback.packet.leafCount * packet.frameCount);
  for (let index = 0; index < playback.packet.leafCount; index += 1) visibilityRows[index] = (initialBits[index >> 3] >> (index & 7)) & 1;
  for (let targetFrame = 2; targetFrame <= packet.frameCount; targetFrame += 1) {
    const previousOffset = (targetFrame - 2) * playback.packet.leafCount;
    const targetOffset = (targetFrame - 1) * playback.packet.leafCount;
    visibilityRows.copyWithin(targetOffset, previousOffset, previousOffset + playback.packet.leafCount);
    for (let cursor = visibilityOffsets[targetFrame - 1]; cursor < visibilityOffsets[targetFrame]; cursor += 1) visibilityRows[targetOffset + visibilityFaces[cursor]] ^= 1;
  }
  const wrapped = visibilityRows.slice((packet.frameCount - 1) * playback.packet.leafCount);
  for (let cursor = visibilityOffsets[0]; cursor < visibilityOffsets[1]; cursor += 1) wrapped[visibilityFaces[cursor]] ^= 1;
  require(wrapped.every((value, index) => value === visibilityRows[index]), "SURFACE_TRANSITION_MISMATCH", "Surface visibility wrap does not reproduce frame 1.");
  require(Array.isArray(visibility.nonInteractiveJumps) && visibility.nonInteractiveJumps.length <= packet.frameCount, "INVALID_SURFACE_STATE", "Surface visibility jumps are invalid or excessive.");
  const visibilityPairs = new Set();
  const visibilityJumps = new Map();
  for (const [index, jump] of visibility.nonInteractiveJumps.entries()) {
    exactObject(jump, ["fromFrame", "toFrame", "faceIndicesBase64"], "INVALID_SURFACE_STATE", `Surface visibility jump ${index}`);
    const pair = `${jump.fromFrame}>${jump.toFrame}`;
    require(Number.isSafeInteger(jump.fromFrame) && jump.fromFrame >= 1 && jump.fromFrame <= packet.frameCount && Number.isSafeInteger(jump.toFrame) && jump.toFrame >= 1 && jump.toFrame <= packet.frameCount && jump.fromFrame !== jump.toFrame && !visibilityPairs.has(pair), "INVALID_SURFACE_STATE", `Surface visibility jump ${index} is invalid or duplicated.`);
    visibilityPairs.add(pair);
    const faces = base64Integers(jump.faceIndicesBase64, 2, playback.packet.leafCount, "INVALID_SURFACE_STATE", `Surface visibility jump ${index} faces`);
    require(faces.every((face, cursor) => face < playback.packet.leafCount && (cursor === 0 || faces[cursor - 1] < face)), "INVALID_SURFACE_STATE", `Surface visibility jump ${index} faces are invalid.`);
    visibilityJumps.set(pair, faces);
  }
  require([...jumpPairs].every((pair) => visibilityPairs.has(pair)) && [...visibilityPairs].every((pair) => jumpPairs.has(pair)), "INVALID_SURFACE_STATE", "Surface lighting and visibility jump pairs differ.");

  const expectedTransition = (fromFrame, toFrame) => {
    const fromOffset = (fromFrame - 1) * playback.packet.leafCount;
    const toOffset = (toFrame - 1) * playback.packet.leafCount;
    const changedVisibility = [];
    const changedFaces = [];
    const changedStates = [];
    for (let face = 0; face < playback.packet.leafCount; face += 1) {
      const fromVisible = visibilityRows[fromOffset + face];
      const toVisible = visibilityRows[toOffset + face];
      if (fromVisible !== toVisible) changedVisibility.push(face);
      const fromState = surfaceStateAt(sourceFramesByFace[face], fromFrame - 1);
      const toState = surfaceStateAt(sourceFramesByFace[face], toFrame - 1);
      if (toVisible === 1 && (fromVisible === 0 || fromState !== toState)) { changedFaces.push(face); changedStates.push(toState); }
    }
    return { changedVisibility, changedFaces, changedStates };
  };
  for (let toFrame = 1; toFrame <= packet.frameCount; toFrame += 1) {
    const fromFrame = toFrame === 1 ? packet.frameCount : toFrame - 1;
    const expected = expectedTransition(fromFrame, toFrame);
    const actualLighting = lightingSegments[toFrame - 1];
    const actualVisibility = visibilityFaces.slice(visibilityOffsets[toFrame - 1], visibilityOffsets[toFrame]);
    require(exactEqualArray(actualLighting.faces, expected.changedFaces) && exactEqualArray(actualLighting.states, expected.changedStates), "SURFACE_TRANSITION_MISMATCH", `Surface lighting transition ${fromFrame}>${toFrame} is not closed.`);
    require(exactEqualArray(actualVisibility, expected.changedVisibility), "SURFACE_TRANSITION_MISMATCH", `Surface visibility transition ${fromFrame}>${toFrame} is not closed.`);
  }
  for (const pair of jumpPairs) {
    const [fromFrame, toFrame] = pair.split(">").map(Number);
    const expected = expectedTransition(fromFrame, toFrame);
    const lighting = lightingJumps.get(pair);
    require(exactEqualArray(lighting.faces, expected.changedFaces) && exactEqualArray(lighting.states, expected.changedStates), "SURFACE_JUMP_MISMATCH", `Surface lighting jump ${pair} contradicts target state.`);
    require(exactEqualArray(visibilityJumps.get(pair), expected.changedVisibility), "SURFACE_JUMP_MISMATCH", `Surface visibility jump ${pair} contradicts target state.`);
  }
  return packet;
}

function validatePresentation(state, binding, records, inputs) {
  const viewportHeight = inputs.get("viewport.height");
  const viewportWidth = inputs.get("viewport.width");
  require(viewportHeight?.type === "float" && viewportWidth?.type === "float" && !Object.hasOwn(viewportHeight, "default") && !Object.hasOwn(viewportWidth, "default"), "INVALID_PRESENTATION_BINDING", "Presentation viewport inputs must be un-defaulted floats.");
  exactObject(state.data, ["packet"], "INVALID_PRESENTATION_STATE", "Presentation state");
  const packet = exactObject(state.data.packet, ["version", "camera", "background"], "INVALID_PRESENTATION_STATE", "Presentation packet", ["version", "camera"]);
  exactObject(packet.camera, ["baseSceneTransform", "fitWidth", "fitHeight", "sourceWidth", "sourceHeight", "perspective"], "INVALID_PRESENTATION_STATE", "Presentation camera");
  exactObject(binding.targets, ["host", "camera", "cursorLayer", "cursorStates"], "INVALID_PRESENTATION_BINDING", "Presentation targets", ["host", "camera"]);
  exactObject(binding.parameters, ["fitWidth", "fitHeight", "sourceWidth", "sourceHeight"], "INVALID_PRESENTATION_BINDING", "Presentation parameters");
  stableId(binding.targets.camera, "Presentation camera target");
  const hasCursorLayer = Object.hasOwn(binding.targets, "cursorLayer");
  const hasCursorStates = Object.hasOwn(binding.targets, "cursorStates");
  require(hasCursorLayer === hasCursorStates, "INVALID_PRESENTATION_BINDING", "Presentation cursor layer and states must appear together.");
  if (hasCursorLayer) {
    exactObject(binding.targets.cursorStates, ["open", "closed"], "INVALID_PRESENTATION_BINDING", "Presentation cursor states");
    stableId(binding.targets.cursorLayer, "Presentation cursor layer target");
    stableId(binding.targets.cursorStates.open, "Presentation open cursor target");
    stableId(binding.targets.cursorStates.closed, "Presentation closed cursor target");
    require(binding.targets.cursorStates.open !== binding.targets.cursorStates.closed, "INVALID_PRESENTATION_BINDING", "Presentation cursor targets must be distinct.");
  }
  require(packet.version === 0 && binding.targets.host === "$host" && ["fitWidth", "fitHeight", "sourceWidth", "sourceHeight"].every((name) => Number.isSafeInteger(packet.camera[name]) && packet.camera[name] > 0 && packet.camera[name] === binding.parameters[name]) && typeof packet.camera.perspective === "number" && Number.isFinite(packet.camera.perspective) && packet.camera.perspective > 0, "INVALID_PRESENTATION_STATE", "Presentation packet/binding is invalid.");
  safeStyle(packet.camera.baseSceneTransform, "Presentation base scene transform");
  const hasBackground = Object.hasOwn(packet, "background");
  if (hasBackground) {
    exactObject(packet.background, ["resource", "opacity", "position", "repeat", "size"], "INVALID_PRESENTATION_STATE", "Presentation background");
    assertResourceId(packet.background.resource, "Presentation background resource");
    require(records.get(packet.background.resource)?.kind === "image", "RESOURCE_ROLE_MISMATCH", "Presentation background must be an image.");
    require(typeof packet.background.opacity === "number" && Number.isFinite(packet.background.opacity) && packet.background.opacity >= 0 && packet.background.opacity <= 1, "INVALID_PRESENTATION_STATE", "Presentation background opacity is invalid.");
    for (const name of ["position", "repeat", "size"]) safeStyle(packet.background[name], `Presentation background ${name}`);
  }
  exactArray(binding.sinks, [
    ...(hasBackground ? ["host.style.backgroundColor", "host.style.backgroundImage", "host.style.backgroundPosition", "host.style.backgroundRepeat", "host.style.backgroundSize"] : []),
    "style.height", "style.left", "style.top", "style.transform",
    ...(hasCursorLayer ? ["style.visibility"] : []),
    "style.width",
  ], "INVALID_PRESENTATION_BINDING", "Presentation sinks");
  return packet;
}

function validateEffects(state, binding, playback, inputs, limits) {
  exactObject(state.data, ["packet"], "INVALID_EFFECTS_STATE", "Effects state");
  const packet = exactObject(state.data.packet, ["version", "arithmetic", "frameCount", "biases", "particle", "spawnStream", "stars", "emitters"], "INVALID_EFFECTS_STATE", "Effects packet");
  exactObject(binding.targets, ["stars", "emitters"], "INVALID_EFFECTS_BINDING", "Effects targets");
  exactObject(binding.parameters, ["frameCount"], "INVALID_EFFECTS_BINDING", "Effects parameters");
  const inputDefinitions = [
    ["interaction.grab-active", "boolean", false],
    ["interaction.grab-x", "float", 0],
    ["interaction.grab-y", "float", 0],
    ["interaction.grab-z", "float", 0],
    ["time.source-frame", "uint", undefined],
  ];
  for (const [id, type, defaultValue] of inputDefinitions) {
    const input = inputs.get(id);
    require(input?.type === type && (defaultValue === undefined ? !Object.hasOwn(input, "default") : input.default === defaultValue), "INVALID_EFFECTS_BINDING", `Effects input ${id} is invalid.`);
  }
  require(playback && packet.version === 0 && packet.arithmetic === "ieee754-f32-per-operation" && Number.isSafeInteger(packet.frameCount) && packet.frameCount > 0 && packet.frameCount <= limits.maxFrames && packet.frameCount === binding.parameters.frameCount && packet.frameCount === playback.binding.parameters.frameCount, "FRAME_CARDINALITY_MISMATCH", "Effects frame closure is invalid.");
  const biases = exactObject(packet.biases, ["continuous", "grab"], "INVALID_EFFECTS_STATE", "Effects biases");
  finiteF32Array(biases.continuous, 3, "INVALID_EFFECTS_STATE", "Effects continuous bias");
  finiteF32Array(biases.grab, 3, "INVALID_EFFECTS_STATE", "Effects grab bias");
  const particle = exactObject(packet.particle, ["damping", "gravityY", "sparkleFrameTable"], "INVALID_EFFECTS_STATE", "Effects particle contract");
  require(finiteF32(particle.damping) && particle.damping >= 0 && particle.damping <= 1 && finiteF32(particle.gravityY), "INVALID_EFFECTS_STATE", "Effects particle arithmetic is invalid.");
  require(Array.isArray(particle.sparkleFrameTable) && particle.sparkleFrameTable.length > 0 && particle.sparkleFrameTable.length <= 256 && particle.sparkleFrameTable.every((value) => Number.isSafeInteger(value) && value >= 0), "INVALID_EFFECTS_STATE", "Effects sparkle frames are invalid.");
  const spawn = exactObject(packet.spawnStream, ["count", "tuples"], "INVALID_EFFECTS_STATE", "Effects spawn stream");
  require(Number.isSafeInteger(spawn.count) && spawn.count > 0 && spawn.count <= limits.maxEffectSpawnTuples && Array.isArray(spawn.tuples) && spawn.tuples.length === spawn.count, "EFFECT_STATE_LIMIT", "Effects spawn stream is invalid or excessive.");
  for (const [index, tuple] of spawn.tuples.entries()) {
    finiteF32Array(tuple, 4, "INVALID_EFFECTS_STATE", `Effects spawn tuple ${index}`);
    require(tuple[0] > 0 && Math.trunc(tuple[0]) <= particle.sparkleFrameTable.length, "INVALID_EFFECTS_STATE", `Effects spawn tuple ${index} lifetime is invalid.`);
    for (const bias of [biases.continuous, biases.grab]) require([0, 1, 2].every((component) => Number.isFinite(Math.fround(tuple[component + 1] + bias[component]))), "INVALID_EFFECTS_STATE", `Effects spawn tuple ${index} overflows with a bias.`);
  }
  require(Array.isArray(packet.stars) && packet.stars.length <= limits.maxNodes && packet.stars.length === binding.targets.stars.length, "TARGET_CARDINALITY_MISMATCH", "Effects stars differ from targets.");
  require(Array.isArray(packet.emitters) && packet.emitters.length > 0 && packet.emitters.length <= limits.maxNodes && packet.emitters.length === binding.targets.emitters.length, "TARGET_CARDINALITY_MISMATCH", "Effects emitters differ from targets.");
  uniqueTargets(binding.targets.stars, "Effects star");
  let totalParticles = 0;
  for (const [index, emitter] of packet.emitters.entries()) {
    closedObject(emitter, ["mode", "sourceStar", "poolSize", "backgroundPositions"], "INVALID_EFFECTS_STATE", `Effects emitter ${index}`);
    require(Object.hasOwn(emitter, "mode") && Object.hasOwn(emitter, "poolSize") && Object.hasOwn(emitter, "backgroundPositions"), "INVALID_EFFECTS_STATE", `Effects emitter ${index} is incomplete.`);
    require(emitter.mode === "grab" || emitter.mode === "follow-star", "INVALID_EFFECTS_STATE", `Effects emitter ${index} mode is unsupported.`);
    if (emitter.mode === "grab") require(!Object.hasOwn(emitter, "sourceStar"), "INVALID_EFFECTS_STATE", `Grab emitter ${index} declares sourceStar.`);
    else require(Number.isSafeInteger(emitter.sourceStar) && emitter.sourceStar >= 0 && emitter.sourceStar < packet.stars.length, "INVALID_EFFECTS_STATE", `Follow-star emitter ${index} source is invalid.`);
    require(Number.isSafeInteger(emitter.poolSize) && emitter.poolSize > 0, "INVALID_EFFECTS_STATE", `Effects emitter ${index} pool size is invalid.`);
    totalParticles += emitter.poolSize;
    require(totalParticles <= limits.maxEffectParticles, "EFFECT_PARTICLE_LIMIT", "Effects particle count is excessive.");
    require(Array.isArray(emitter.backgroundPositions) && emitter.backgroundPositions.length > 0 && emitter.backgroundPositions.length <= 256, "INVALID_EFFECTS_STATE", `Effects emitter ${index} background positions are invalid.`);
    emitter.backgroundPositions.forEach((value) => safeStyle(value, `Effects emitter ${index} background position`));
    require(particle.sparkleFrameTable.every((frame) => frame < emitter.backgroundPositions.length), "INVALID_EFFECTS_STATE", `Effects emitter ${index} lacks a sparkle frame.`);
    uniqueTargets(binding.targets.emitters[index], `Effects emitter ${index}`);
    require(binding.targets.emitters[index].length === emitter.poolSize, "TARGET_CARDINALITY_MISMATCH", `Effects emitter ${index} pool differs from targets.`);
  }
  for (const [index, star] of packet.stars.entries()) {
    exactObject(star, ["positions", "transforms", "frameIndices", "backgroundPositions"], "INVALID_EFFECTS_STATE", `Effects star ${index}`);
    finiteF32Array(star.positions, packet.frameCount * 3, "INVALID_EFFECTS_STATE", `Effects star ${index} positions`);
    require(Array.isArray(star.transforms) && star.transforms.length === packet.frameCount, "FRAME_CARDINALITY_MISMATCH", `Effects star ${index} transforms differ from frameCount.`);
    star.transforms.forEach((value) => safeStyle(value, `Effects star ${index} transform`));
    require(Array.isArray(star.backgroundPositions) && star.backgroundPositions.length > 0 && star.backgroundPositions.length <= limits.maxFrames, "INVALID_EFFECTS_STATE", `Effects star ${index} background positions are invalid.`);
    star.backgroundPositions.forEach((value) => safeStyle(value, `Effects star ${index} background position`));
    require(Array.isArray(star.frameIndices) && star.frameIndices.length === packet.frameCount && star.frameIndices.every((frame) => Number.isSafeInteger(frame) && frame >= 0 && frame < star.backgroundPositions.length), "FRAME_CARDINALITY_MISMATCH", `Effects star ${index} frame indices are invalid.`);
  }
  let maximumLifetime = 0;
  const maximumVelocity = [0, 0, 0];
  for (const tuple of spawn.tuples) {
    maximumLifetime = Math.max(maximumLifetime, Math.trunc(tuple[0]));
    for (let component = 0; component < 3; component += 1) maximumVelocity[component] = Math.max(maximumVelocity[component], Math.abs(Math.fround(tuple[component + 1] + biases.continuous[component])));
  }
  const maximumStart = [0, 0, 0];
  for (const star of packet.stars) for (let index = 0; index < star.positions.length; index += 1) maximumStart[index % 3] = Math.max(maximumStart[index % 3], Math.abs(star.positions[index]));
  for (let component = 0; component < 3; component += 1) {
    const gravity = component === 1 ? Math.abs(particle.gravityY) * maximumLifetime * (maximumLifetime + 1) / 2 : 0;
    require(Number.isFinite(Math.fround(maximumStart[component] + maximumVelocity[component] * maximumLifetime + gravity)), "INVALID_EFFECTS_STATE", `Effects component ${component} can overflow.`);
  }
  return packet;
}

function validateInteraction(state, binding, playback, presentation, inputs, limits) {
  exactObject(state.data, ["packet"], "INVALID_INTERACTION_STATE", "Interaction state");
  const packet = exactObject(state.data.packet, ["version", "arithmetic", "input", "animator", "source", "triangle", "objects", "shapes", "leaves", "controls"], "INVALID_INTERACTION_STATE", "Interaction packet");
  exactObject(binding.targets, ["shapes", "leaves", "cursorLayer", "cursorStates"], "INVALID_INTERACTION_BINDING", "Interaction targets");
  exactObject(binding.targets.cursorStates, ["open", "closed"], "INVALID_INTERACTION_BINDING", "Interaction cursor states");
  exactObject(binding.parameters, ["initialFrame", "tickRateHz"], "INVALID_INTERACTION_BINDING", "Interaction parameters");
  uniqueTargets(binding.targets.shapes, "Interaction shape");
  uniqueTargets(binding.targets.leaves, "Interaction leaf");
  stableId(binding.targets.cursorLayer, "Interaction cursor layer");
  stableId(binding.targets.cursorStates.open, "Interaction open cursor");
  stableId(binding.targets.cursorStates.closed, "Interaction closed cursor");
  require(binding.targets.cursorStates.open !== binding.targets.cursorStates.closed && binding.parameters.tickRateHz === 30, "INVALID_INTERACTION_BINDING", "Interaction cursor or timing binding is invalid.");
  const defaultInputs = [
    ["axis.x", "float", 0],
    ["axis.y", "float", 0],
    ["button.hold", "boolean", false],
    ["pointer.positioned", "boolean", false],
    ["pointer.pressed", "boolean", false],
  ];
  for (const [id, type, defaultValue] of defaultInputs) {
    const input = inputs.get(id);
    require(input?.type === type && input.default === defaultValue, "INVALID_INTERACTION_BINDING", `Interaction input ${id} is invalid.`);
  }
  require(packet.version === 0 && packet.arithmetic === "ieee754-f32-per-operation", "INVALID_INTERACTION_STATE", "Interaction version or arithmetic is unsupported.");
  if (playback) require(exactEqualArray(binding.targets.shapes, playback.binding.targets.shapes) && exactEqualArray(binding.targets.leaves, playback.binding.targets.leaves), "TARGET_ORDER_MISMATCH", "Interaction and playback target order differs.");

  const input = exactObject(packet.input, ["sourceWidth", "sourceHeight", "cursorBounds", "cursorInitial", "pointerQuantization", "stickRange", "stickDeadzone", "stickScale", "grabButton", "holdButton", "hitRadius", "cursorVisibleTicks", "mirrorX"], "INVALID_INTERACTION_STATE", "Interaction input contract");
  require(Number.isSafeInteger(input.sourceWidth) && input.sourceWidth > 0 && Number.isSafeInteger(input.sourceHeight) && input.sourceHeight > 0, "INVALID_INTERACTION_STATE", "Interaction viewport is invalid.");
  const pointerDefaults = [["pointer.x", input.sourceWidth / 2], ["pointer.y", input.sourceHeight / 2]];
  for (const [id, defaultValue] of pointerDefaults) {
    const definition = inputs.get(id);
    require(definition?.type === "float" && definition.default === defaultValue, "INVALID_INTERACTION_BINDING", `Interaction input ${id} does not use the source-centre default.`);
  }
  finiteF32Array(input.cursorBounds, 4, "INVALID_INTERACTION_STATE", "Interaction cursor bounds");
  finiteF32Array(input.cursorInitial, 2, "INVALID_INTERACTION_STATE", "Interaction initial cursor");
  require(input.cursorBounds[0] <= input.cursorBounds[1] && input.cursorBounds[2] <= input.cursorBounds[3]
    && input.cursorInitial[0] === pointerDefaults[0][1] && input.cursorInitial[1] === pointerDefaults[1][1]
    && input.cursorInitial[0] >= input.cursorBounds[0] && input.cursorInitial[0] <= input.cursorBounds[1]
    && input.cursorInitial[1] >= input.cursorBounds[2] && input.cursorInitial[1] <= input.cursorBounds[3], "INVALID_INTERACTION_STATE", "Interaction cursor bounds or initial position are invalid.");
  require(input.pointerQuantization === "trunc-toward-zero-then-clamp", "INVALID_INTERACTION_STATE", "Interaction pointer quantization is unsupported.");
  finiteF32Array(input.stickRange, 2, "INVALID_INTERACTION_STATE", "Interaction stick range");
  require(input.stickRange[0] < 0 && input.stickRange[1] > 0 && input.stickRange[0] < input.stickRange[1]
    && finiteF32(input.stickDeadzone) && input.stickDeadzone >= 0
    && finiteF32(input.stickScale) && input.stickScale > 0, "INVALID_INTERACTION_STATE", "Interaction stick contract is invalid.");
  require(Number.isSafeInteger(input.grabButton) && input.grabButton > 0 && input.grabButton <= 0xffff
    && Number.isSafeInteger(input.holdButton) && input.holdButton > 0 && input.holdButton <= 0xffff
    && (input.grabButton & input.holdButton) === 0, "INVALID_INTERACTION_STATE", "Interaction button masks are invalid.");
  require(finiteF32(input.hitRadius) && input.hitRadius > 0
    && Number.isSafeInteger(input.cursorVisibleTicks) && input.cursorVisibleTicks > 0
    && finiteF32(input.mirrorX), "INVALID_INTERACTION_STATE", "Interaction picking or cursor timing is invalid.");
  if (presentation) require(input.sourceWidth === presentation.packet.camera.sourceWidth && input.sourceHeight === presentation.packet.camera.sourceHeight
    && binding.targets.cursorLayer === presentation.binding.targets.cursorLayer
    && binding.targets.cursorStates.open === presentation.binding.targets.cursorStates.open
    && binding.targets.cursorStates.closed === presentation.binding.targets.cursorStates.closed, "PRESENTATION_TREE_MISMATCH", "Interaction and presentation closure differs.");

  const animatorKeys = ["initialState", "initialFrame", "introState", "dozeState", "sleepState", "wakeState", "convergeState", "exitEyeState", "eyeState", "dozeLoopCount", "dozeLoopStartFrame", "dozeLoopEndFrame", "sleepEndFrame", "wakeStartFrame", "eyeFrame", "convergeStillTicks", "eyeStillTicks"];
  const animator = exactObject(packet.animator, animatorKeys, "INVALID_INTERACTION_STATE", "Interaction animator");
  require(animatorKeys.every((key) => Number.isSafeInteger(animator[key]) && animator[key] >= 0), "INVALID_INTERACTION_STATE", "Interaction animator contains invalid integers.");
  const stateIds = [animator.introState, animator.dozeState, animator.sleepState, animator.wakeState, animator.convergeState, animator.exitEyeState, animator.eyeState];
  const frameCount = playback?.binding.parameters.frameCount ?? limits.maxFrames;
  require(new Set(stateIds).size === stateIds.length && stateIds.includes(animator.initialState)
    && animator.initialState === animator.eyeState && animator.initialFrame === animator.eyeFrame
    && animator.initialFrame > 0 && animator.initialFrame <= frameCount
    && animator.dozeLoopCount > 0 && animator.dozeLoopStartFrame > 0 && animator.dozeLoopStartFrame < animator.dozeLoopEndFrame && animator.dozeLoopEndFrame <= frameCount
    && animator.sleepEndFrame > 0 && animator.sleepEndFrame <= frameCount
    && animator.wakeStartFrame > 0 && animator.wakeStartFrame <= frameCount
    && animator.convergeStillTicks > 0 && animator.eyeStillTicks > 0
    && binding.parameters.initialFrame === animator.initialFrame, "INVALID_INTERACTION_STATE", "Interaction animator state or timing closure is invalid.");

  const source = exactObject(packet.source, ["cameraViewMatrix", "cameraWorldPosition", "inverseCameraMatrix", "projection", "displacementMagnitude", "eyeGain", "eyeMaximumOffset", "spring"], "INVALID_INTERACTION_STATE", "Interaction source contract");
  finiteF32Array(source.cameraViewMatrix, 16, "INVALID_INTERACTION_STATE", "Interaction camera view matrix");
  finiteF32Array(source.inverseCameraMatrix, 16, "INVALID_INTERACTION_STATE", "Interaction inverse camera matrix");
  finiteF32Array(source.cameraWorldPosition, 3, "INVALID_INTERACTION_STATE", "Interaction camera world position");
  require(inverseMatrixPair(source.cameraViewMatrix, source.inverseCameraMatrix), "INVALID_INTERACTION_STATE", "Interaction camera matrices are not a finite inverse pair.");
  const projection = exactObject(source.projection, ["scale", "origin"], "INVALID_INTERACTION_STATE", "Interaction projection");
  require(finiteF32(projection.scale) && projection.scale > 0, "INVALID_INTERACTION_STATE", "Interaction projection scale is invalid.");
  finiteF32Array(projection.origin, 2, "INVALID_INTERACTION_STATE", "Interaction projection origin");
  require(finiteF32(source.displacementMagnitude) && source.displacementMagnitude > 0
    && finiteF32(source.eyeGain) && source.eyeGain > 0
    && finiteF32(source.eyeMaximumOffset) && source.eyeMaximumOffset >= 0, "INVALID_INTERACTION_STATE", "Interaction displacement or eye-follow values are invalid.");
  const springKeys = ["cursorResistance", "grabbedFlag", "pickedResistance", "releaseAcceleration", "snapOffsetL1", "snapVelocityL1", "velocityDecay"];
  const spring = exactObject(source.spring, springKeys, "INVALID_INTERACTION_STATE", "Interaction spring");
  for (const key of springKeys.filter((key) => key !== "grabbedFlag")) require(finiteF32(spring[key]), "INVALID_INTERACTION_STATE", `Interaction spring ${key} is invalid.`);
  require(spring.cursorResistance >= 0 && spring.cursorResistance <= 1
    && spring.pickedResistance >= -1 && spring.pickedResistance < 0
    && spring.releaseAcceleration > 0 && spring.releaseAcceleration <= 1
    && spring.velocityDecay > 0 && spring.velocityDecay < 1
    && spring.snapOffsetL1 >= 0 && spring.snapVelocityL1 >= 0
    && Number.isSafeInteger(spring.grabbedFlag) && spring.grabbedFlag > 0, "INVALID_INTERACTION_STATE", "Interaction spring constraints are invalid.");
  const displacementBounds = grabDisplacementBounds(input, source);
  require(displacementBounds, "INVALID_INTERACTION_STATE", "Interaction cursor displacement overflows binary32 arithmetic.");
  const selectedOffsetBounds = displacementBounds.map((bound) => operationF32(bound / -spring.pickedResistance));
  require(selectedOffsetBounds.every(Number.isFinite), "INVALID_INTERACTION_STATE", "Interaction selected-grab envelope overflows binary32 arithmetic.");

  const triangle = exactObject(packet.triangle, ["basisEpsilon", "primitive", "fallbackAmount", "sharedEdgeAmount"], "INVALID_INTERACTION_STATE", "Interaction triangle kernel");
  require(triangle.basisEpsilon === 1e-9 && triangle.primitive === "corner-bevel"
    && finiteF32(triangle.fallbackAmount) && triangle.fallbackAmount >= 0
    && finiteF32(triangle.sharedEdgeAmount) && triangle.sharedEdgeAmount >= 0, "INVALID_INTERACTION_STATE", "Interaction triangle kernel is unsupported.");
  const objects = exactObject(packet.objects, ["rotationMatrices"], "INVALID_INTERACTION_STATE", "Interaction objects");
  require(Array.isArray(objects.rotationMatrices) && objects.rotationMatrices.length % 16 === 0
    && objects.rotationMatrices.length / 16 <= limits.maxInteractionObjects
    && objects.rotationMatrices.every(finiteF32), "INTERACTION_STATE_LIMIT", "Interaction object matrices are invalid or excessive.");
  const objectCount = objects.rotationMatrices.length / 16;
  const shapes = exactObject(packet.shapes, ["baseMatrices"], "INVALID_INTERACTION_STATE", "Interaction shapes");
  require(Array.isArray(shapes.baseMatrices) && shapes.baseMatrices.length === binding.targets.shapes.length * 16 && shapes.baseMatrices.every(finiteF32), "TARGET_CARDINALITY_MISMATCH", "Interaction shape matrices differ from targets.");
  require(Array.isArray(packet.leaves) && packet.leaves.length === binding.targets.leaves.length && packet.leaves.length <= limits.maxNodes, "TARGET_CARDINALITY_MISMATCH", "Interaction leaf plans differ from targets.");
  for (const [index, leaf] of packet.leaves.entries()) {
    exactObject(leaf, ["basis", "canonicalSize", "matrixDecimals", "seamEdgeMask", "width", "height"], "INVALID_INTERACTION_STATE", `Interaction leaf ${index}`);
    require(Array.isArray(leaf.basis) && [[0, 1, 2], [1, 2, 0], [2, 0, 1]].some((basis) => exactEqualArray(leaf.basis, basis))
      && Number.isSafeInteger(leaf.canonicalSize) && leaf.canonicalSize > 0
      && Number.isSafeInteger(leaf.matrixDecimals) && leaf.matrixDecimals >= 0 && leaf.matrixDecimals <= 6
      && Number.isSafeInteger(leaf.seamEdgeMask) && leaf.seamEdgeMask >= 0 && leaf.seamEdgeMask <= 7
      && Number.isSafeInteger(leaf.width) && leaf.width > 0
      && Number.isSafeInteger(leaf.height) && leaf.height > 0, "INVALID_INTERACTION_STATE", `Interaction leaf ${index} is invalid.`);
  }

  require(Array.isArray(packet.controls) && packet.controls.length > 0 && packet.controls.length <= limits.maxInteractionControls, "INTERACTION_STATE_LIMIT", "Interaction controls are missing or excessive.");
  const ids = new Set();
  const roles = new Set();
  let totalVertices = 0;
  let totalWeights = 0;
  let totalReferences = 0;
  let totalLeafRows = 0;
  let grabControls = 0;
  for (const [controlIndex, control] of packet.controls.entries()) {
    exactObject(control, ["id", "role", "mode", "sourceOrder", "sourcePosition", "screenPosition", "cameraDistance", "attachmentObjectIndices", "closure"], "INVALID_INTERACTION_STATE", `Interaction control ${controlIndex}`);
    const id = stableId(control.id, `Interaction control ${controlIndex} id`);
    const role = stableId(control.role, `Interaction control ${controlIndex} role`);
    require(!ids.has(id) && !roles.has(role) && control.sourceOrder === controlIndex && (control.mode === "grab" || control.mode === "eye-follow"), "INVALID_INTERACTION_STATE", `Interaction control ${controlIndex} identity, order, or mode is invalid.`);
    ids.add(id);
    roles.add(role);
    if (control.mode === "grab") grabControls += 1;
    finiteF32Array(control.sourcePosition, 3, "INVALID_INTERACTION_STATE", `Interaction control ${controlIndex} source position`);
    finiteF32Array(control.screenPosition, 2, "INVALID_INTERACTION_STATE", `Interaction control ${controlIndex} screen position`);
    require(finiteF32(control.cameraDistance) && control.cameraDistance > 0, "INVALID_INTERACTION_STATE", `Interaction control ${controlIndex} camera distance is invalid.`);
    integerArray(control.attachmentObjectIndices, limits.maxInteractionObjects, "INTERACTION_STATE_LIMIT", `Interaction control ${controlIndex} attachments`, { minimum: 0, upper: Math.max(0, objectCount - 1), unique: true });
    require(control.attachmentObjectIndices.length > 0 && (control.mode !== "eye-follow" || control.attachmentObjectIndices.length === 1), "INVALID_INTERACTION_STATE", `Interaction control ${controlIndex} attachments are invalid.`);
    const closure = exactObject(control.closure, ["shapeIndices", "vertexRows", "vertexPositions", "weightActiveFlags", "weightScalars", "weightLinearContributions", "weightBaseTranslations", "leafIndices", "leafRows", "safeVisibleLeafIndices", "rigidRootInverseMatrix"], "INVALID_INTERACTION_STATE", `Interaction control ${controlIndex} closure`);
    integerArray(closure.shapeIndices, binding.targets.shapes.length, "INTERACTION_STATE_LIMIT", `Interaction control ${controlIndex} shape indices`, { minimum: 0, upper: Math.max(0, binding.targets.shapes.length - 1), unique: true });
    require(closure.shapeIndices.length > 0 && Array.isArray(closure.vertexRows) && closure.vertexRows.length % 4 === 0, "INVALID_INTERACTION_STATE", `Interaction control ${controlIndex} shape or vertex closure is invalid.`);
    const vertexCount = closure.vertexRows.length / 4;
    totalVertices += vertexCount;
    require(totalVertices <= limits.maxInteractionVertices && Array.isArray(closure.vertexPositions) && closure.vertexPositions.length === vertexCount * 3 && closure.vertexPositions.every(finiteF32), "INTERACTION_STATE_LIMIT", `Interaction control ${controlIndex} vertices are invalid or excessive.`);
    const shapeSet = new Set(closure.shapeIndices);
    let maximumWeight = 0;
    for (let row = 0; row < vertexCount; row += 1) {
      const offset = row * 4;
      const rowValues = closure.vertexRows.slice(offset, offset + 4);
      require(rowValues.every(Number.isSafeInteger) && shapeSet.has(rowValues[0]) && rowValues[1] >= 0 && rowValues[2] >= 0 && rowValues[3] >= 0, "INVALID_INTERACTION_STATE", `Interaction control ${controlIndex} vertex row ${row} is invalid.`);
      const rowEnd = rowValues[2] + rowValues[3];
      require(Number.isSafeInteger(rowEnd), "INVALID_INTERACTION_STATE", `Interaction control ${controlIndex} vertex row ${row} overflows.`);
      maximumWeight = Math.max(maximumWeight, rowEnd);
      totalReferences += rowValues[3];
      require(Number.isSafeInteger(totalReferences) && totalReferences <= limits.maxInteractionWeightReferences, "INTERACTION_STATE_LIMIT", "Interaction weight references are excessive.");
    }
    require(Array.isArray(closure.weightScalars) && Array.isArray(closure.weightActiveFlags) && Array.isArray(closure.weightLinearContributions) && Array.isArray(closure.weightBaseTranslations), "INTERACTION_STATE_LIMIT", `Interaction control ${controlIndex} weight tables are missing.`);
    const weightCount = closure.weightScalars.length;
    totalWeights += weightCount;
    require(Number.isSafeInteger(weightCount) && totalWeights <= limits.maxInteractionWeights && maximumWeight <= weightCount
      && closure.weightActiveFlags.length === weightCount
      && closure.weightLinearContributions.length === weightCount * 3
      && closure.weightBaseTranslations.length === weightCount * 3
      && closure.weightScalars.every(finiteF32)
      && closure.weightLinearContributions.every(finiteF32)
      && closure.weightBaseTranslations.every(finiteF32)
      && closure.weightActiveFlags.every((flag) => flag === 0 || flag === 1), "INTERACTION_STATE_LIMIT", `Interaction control ${controlIndex} weight tables are invalid or excessive.`);
    integerArray(closure.leafIndices, packet.leaves.length, "INTERACTION_STATE_LIMIT", `Interaction control ${controlIndex} leaf indices`, { minimum: 0, upper: Math.max(0, packet.leaves.length - 1), unique: true });
    require(Array.isArray(closure.leafRows) && closure.leafRows.length === closure.leafIndices.length * 4, "INVALID_INTERACTION_STATE", `Interaction control ${controlIndex} leaf rows are invalid.`);
    totalLeafRows += closure.leafIndices.length;
    require(totalLeafRows <= limits.maxInteractionLeafRows, "INTERACTION_STATE_LIMIT", "Interaction leaf rows are excessive.");
    for (let row = 0; row < closure.leafIndices.length; row += 1) {
      const values = closure.leafRows.slice(row * 4, row * 4 + 4);
      require(values.every(Number.isSafeInteger) && values[0] === closure.leafIndices[row] && values.slice(1).every((value) => value >= 0 && value < vertexCount), "INVALID_INTERACTION_STATE", `Interaction control ${controlIndex} leaf row ${row} is invalid.`);
    }
    integerArray(closure.safeVisibleLeafIndices, closure.leafIndices.length, "INTERACTION_STATE_LIMIT", `Interaction control ${controlIndex} safe-visible leaves`, { minimum: 0, upper: Math.max(0, packet.leaves.length - 1), unique: true });
    const leafSet = new Set(closure.leafIndices);
    require(closure.safeVisibleLeafIndices.every((index) => leafSet.has(index)), "INVALID_INTERACTION_STATE", `Interaction control ${controlIndex} safe-visible leaves escape its closure.`);
    if (control.mode === "eye-follow") finiteF32Array(closure.rigidRootInverseMatrix, 16, "INVALID_INTERACTION_STATE", `Interaction control ${controlIndex} rigid inverse matrix`);
    else require(Array.isArray(closure.rigidRootInverseMatrix) && closure.rigidRootInverseMatrix.length === 0, "INVALID_INTERACTION_STATE", `Grab control ${controlIndex} declares a rigid inverse matrix.`);
    if (control.mode === "eye-follow") {
      const projected = projectedF32(control.sourcePosition, source);
      require(projected, "INVALID_INTERACTION_STATE", `Interaction eye control ${controlIndex} projection overflows.`);
      for (const cursorX of [input.cursorBounds[0], input.cursorBounds[1]]) {
        for (const cursorY of [input.cursorBounds[2], input.cursorBounds[3]]) {
          const eyeOffset = [multiplyF32(addF32(cursorX, -projected[0]), source.eyeGain), multiplyF32(addF32(projected[1], -cursorY), source.eyeGain), 0];
          require(eyeOffset.every(Number.isFinite) && finiteMagnitudeF32(eyeOffset), "INVALID_INTERACTION_STATE", `Interaction eye control ${controlIndex} offset overflows.`);
        }
      }
      const cameraPlane = [
        Math.fround(Math.fround(source.cameraViewMatrix[2] * control.sourcePosition[0]) + Math.fround(source.cameraViewMatrix[6] * control.sourcePosition[1])),
        source.cameraViewMatrix[10] * control.sourcePosition[2],
        source.cameraViewMatrix[14],
      ].reduce((value, component) => Math.fround(value + Math.fround(component)), 0);
      require(Number.isFinite(cameraPlane) && Math.abs(cameraPlane) > 1e-6, "INVALID_INTERACTION_STATE", `Interaction eye control ${controlIndex} lies on the camera plane.`);
    } else {
      for (let component = 0; component < 3; component += 1) require(Number.isFinite(addF32(control.sourcePosition[component], selectedOffsetBounds[component])) && Number.isFinite(addF32(control.sourcePosition[component], -selectedOffsetBounds[component])), "INVALID_INTERACTION_STATE", `Interaction grab control ${controlIndex} position envelope overflows.`);
    }
  }
  require(grabControls > 0, "INVALID_INTERACTION_STATE", "Interaction requires a grab control.");
  return packet;
}

function exactEqualArray(left, right) {
  return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((entry, index) => entry === right[index]);
}

function validateTargetOwnership(channels, limits) {
  const byInterpreter = new Map([...channels.values()].map((channel) => [channel.interpreter, channel]));
  const targetsOf = (channel) => new Set(collectTargets(channel.targets, limits.maxNodes + 1, limits.maxTreeDepth));
  const effects = byInterpreter.get("polycss-effects@0");
  if (effects) {
    const owned = targetsOf(effects);
    for (const channel of channels.values()) {
      if (channel === effects) continue;
      for (const target of targetsOf(channel)) require(!owned.has(target), "TARGET_OWNERSHIP_CONFLICT", `Effects target ${target} is also owned by ${channel.interpreter}.`);
    }
  }
  const playback = byInterpreter.get("polycss-playback@0");
  const presentation = byInterpreter.get("static-presentation@0");
  if (playback && presentation) {
    const owned = targetsOf(playback);
    for (const target of targetsOf(presentation)) if (target !== "$host") require(!owned.has(target), "TARGET_OWNERSHIP_CONFLICT", `Presentation target ${target} overlaps playback ownership.`);
  }
}

function validateInitialSurfaceClosure(packet, playback, tree) {
  const packed = Uint8Array.from(globalThis.atob(packet.visibility.initialVisibleBitsBase64), (character) => character.charCodeAt(0));
  const targetFrame = packet.transitions.initialFrame - 1;
  for (const [index, target] of playback.binding.targets.leaves.entries()) {
    const node = tree.byId.get(target);
    const expectedVisibility = ((packed[index >> 3] >> (index & 7)) & 1) === 1 ? "visible" : "hidden";
    require(node?.styles?.visibility === expectedVisibility, "SURFACE_TREE_MISMATCH", `Surface leaf ${index} initial visibility differs from TREE.`);
    const face = packet.surface.faces[index];
    let sourceFrame = 0;
    let selectedFrame = 0;
    for (let local = 0; local < face.stateCount; local += 1) {
      sourceFrame += packet.surface.statePacking.sourceFrameDeltas[face.stateOffset + local];
      if (sourceFrame > targetFrame) break;
      selectedFrame = sourceFrame;
    }
    const actual = node.styles.backgroundPositionY;
    const expected = selectedFrame === 0 ? "0" : `${-selectedFrame * face.leafHeight}px`;
    require(selectedFrame === 0 ? actual === undefined || actual === "0" || actual === "0px" || actual === "0%" : actual === expected, "SURFACE_TREE_MISMATCH", `Surface leaf ${index} initial atlas position differs from TREE.`);
  }
}

function validateCodecClosure(document, context, tree, records, limits) {
  const byInterpreter = new Map([...context.channels.values()].map((binding) => [binding.interpreter, { binding, state: context.states.get(binding.state) }]));
  let playback = null;
  if (byInterpreter.has("polycss-playback@0")) {
    const value = byInterpreter.get("polycss-playback@0");
    playback = { ...value, packet: validatePlayback(value.state, value.binding, context.inputs, limits) };
  }
  let presentation = null;
  if (byInterpreter.has("static-presentation@0")) {
    const value = byInterpreter.get("static-presentation@0");
    presentation = { ...value, packet: validatePresentation(value.state, value.binding, records, context.inputs) };
  }
  let surface = null;
  if (byInterpreter.has("polycss-surface@0")) {
    require(playback, "MISSING_POLYCSS_CHANNEL", "Prepared surface requires executable playback.");
    const value = byInterpreter.get("polycss-surface@0");
    surface = { ...value, packet: validateSurface(value.state, value.binding, playback, context.inputs, limits) };
  }
  if (playback?.packet.leafCount > 0) require(surface, "MISSING_POLYCSS_CHANNEL", "Playback with leaf targets requires prepared surface state and binding.");
  let effects = null;
  if (byInterpreter.has("polycss-effects@0")) {
    require(playback, "MISSING_POLYCSS_CHANNEL", "Prepared effects require executable playback.");
    const value = byInterpreter.get("polycss-effects@0");
    effects = { ...value, packet: validateEffects(value.state, value.binding, playback, context.inputs, limits) };
  }
  if (byInterpreter.has("polycss-pointer-grab@0")) {
    require(playback && presentation && effects, "MISSING_POLYCSS_CHANNEL", "Prepared pointer interaction requires playback, presentation, and effects.");
    const value = byInterpreter.get("polycss-pointer-grab@0");
    validateInteraction(value.state, value.binding, playback, presentation, context.inputs, limits);
    require(value.binding.parameters.tickRateHz === playback.binding.parameters.tickRateHz, "INVALID_INTERACTION_BINDING", "Interaction and playback tick rates differ.");
  }
  validateTargetOwnership(context.channels, limits);
  if (surface) validateInitialSurfaceClosure(surface.packet, playback, tree);

  if (presentation) {
    const { packet, binding } = presentation;
    const mountResource = document.tree.mount.resourceStyles?.backgroundImage;
    if (packet.background) {
      require(mountResource?.resource === packet.background.resource && mountResource.syntax === "overlay-url" && mountResource.overlayOpacity === packet.background.opacity && document.tree.mount.styles?.backgroundPosition === packet.background.position && document.tree.mount.styles?.backgroundRepeat === packet.background.repeat && document.tree.mount.styles?.backgroundSize === packet.background.size, "PRESENTATION_TREE_MISMATCH", "Presentation background does not match TREE mount.");
    } else {
      require(mountResource === undefined && ["backgroundPosition", "backgroundRepeat", "backgroundSize"].every((name) => document.tree.mount.styles?.[name] === undefined), "PRESENTATION_TREE_MISMATCH", "Presentation without a background cannot declare TREE mount background bindings.");
    }
    const camera = tree.byId.get(binding.targets.camera);
    require(camera?.styles?.perspective === `${packet.camera.perspective}px` && camera.styles.perspectiveOrigin === `${packet.camera.sourceWidth / 2}px ${packet.camera.sourceHeight / 2}px` && camera.styles.position === "relative" && camera.styles.width === `${packet.camera.sourceWidth}px` && camera.styles.height === `${packet.camera.sourceHeight}px` && camera.styles.transformOrigin === undefined && camera.styles.transformStyle === undefined, "PRESENTATION_TREE_MISMATCH", "Presentation camera does not match TREE.");
    if (playback) require(playback.binding.parameters.baseSceneTransform === packet.camera.baseSceneTransform && tree.byId.get(playback.binding.targets.model)?.styles?.transform === packet.camera.baseSceneTransform, "PRESENTATION_TREE_MISMATCH", "Presentation scene transform differs from playback/TREE.");
    const interaction = byInterpreter.get("polycss-pointer-grab@0");
    if (interaction) require(Object.hasOwn(binding.targets, "cursorLayer") && Object.hasOwn(binding.targets, "cursorStates") && interaction.binding.targets.cursorLayer === binding.targets.cursorLayer && interaction.binding.targets.cursorStates.open === binding.targets.cursorStates.open && interaction.binding.targets.cursorStates.closed === binding.targets.cursorStates.closed, "PRESENTATION_TREE_MISMATCH", "Presentation and interaction cursor targets differ.");
  }

  if (document.meta.counts) {
    if (Object.hasOwn(document.meta.counts, "nodes")) require(document.meta.counts.nodes === document.tree.nodes.length, "META_COUNT_MISMATCH", "META node count is inaccurate.");
    if (playback) for (const [name, value] of [["shapes", playback.binding.targets.shapes.length], ["leaves", playback.binding.targets.leaves.length], ["sourceFrames", playback.binding.parameters.frameCount]]) if (Object.hasOwn(document.meta.counts, name)) require(document.meta.counts[name] === value, "META_COUNT_MISMATCH", `META ${name} count is inaccurate.`);
  }

  const expectedCapabilities = [...BASE_CAPABILITIES, ...CAPABILITY_ORDER.filter(([interpreter]) => context.interpreters.has(interpreter)).map(([, capability]) => capability)];
  exactArray(document.meta.capabilities, expectedCapabilities, "CAPABILITY_CLOSURE_MISMATCH", "META capabilities");
  const expectedConformance = ["retained-tree", ...CONFORMANCE_ORDER.filter(([interpreter]) => context.interpreters.has(interpreter)).map(([, role]) => role)];
  exactArray(document.meta.conformance.executable, expectedConformance, "CONFORMANCE_CLOSURE_MISMATCH", "META conformance");
  if (document.meta.initialExperience === "interaction") require(context.interpreters.has("polycss-pointer-grab@0") && document.meta.capabilities.includes("prepared-pointer-grab-interaction"), "MISSING_INITIAL_EXPERIENCE", "Interaction initial experience is not executable.");

  const used = new Set();
  const useResourceStyles = (styles) => { for (const binding of Object.values(styles ?? {})) used.add(binding.resource); };
  useResourceStyles(document.tree.mount.resourceStyles);
  for (const node of document.tree.nodes) {
    for (const resource of Object.values(node.resourceAttributes ?? {})) used.add(resource);
    useResourceStyles(node.resourceStyles);
  }
  for (const binding of document.cssBinding.stylesheets) {
    used.add(binding.resource);
    for (const token of binding.assetTokens) used.add(token.resource);
  }
  if (presentation?.packet.background) used.add(presentation.packet.background.resource);
  require(records.size === used.size && [...records.keys()].every((id) => used.has(id)), "UNUSED_RESOURCE", "RCRD contains an unreachable resource.");
}

export function validateNVersionDocument(document, limits) {
  exactObject(document, ["meta", "tree", "cssBinding", "state", "bindings", "resources"], "INVALID_DOCUMENT", "Decoded document", ["meta", "tree", "cssBinding", "state", "bindings", "resources"]);
  validateMeta(document.meta);
  const records = validateResourceCatalog(document.resources, limits);
  const tree = validateTree(document.tree, records, limits);
  validateCssBinding(document.cssBinding, records, document.tree.mount, limits);
  const context = validateStateAndBindings(document.state, document.bindings, tree.ids, limits);
  validateCodecClosure(document, context, tree, records, limits);
  return Object.freeze({ records, tree, context });
}
