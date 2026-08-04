import { FORMAT_ID, PROFILE_ID, mergeLimits } from "./constants.js";
import { canonicalBase64DecodedLength } from "./base64.js";
import { cssScopeAttribute } from "./css.js";
import { invariant } from "./errors.js";
import { assertResourceId, validateResourceCatalog } from "./resources.js";

const XHTML = "http://www.w3.org/1999/xhtml";
const NODE_ID = /^[a-z][A-Za-z0-9._:/-]{0,127}$/u;
const CLASS_TOKEN = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/u;
const DATA_ATTRIBUTE = /^data-[a-z][a-z0-9._:-]{0,63}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const SHORT_TOKEN = /^[a-z][a-z0-9-]{0,63}$/u;
const KNOWN_REQUIRED_CAPABILITIES = new Set([
  "css-semantic-closure",
  "deterministic-json",
  "explicit-retained-tree",
  "logical-assets",
  "prepared-particle-effects",
  "prepared-playback",
  "prepared-pointer-grab-interaction",
  "prepared-surface-lighting",
]);
const BASE_REQUIRED_CAPABILITIES = Object.freeze([
  "css-semantic-closure",
  "deterministic-json",
  "explicit-retained-tree",
  "logical-assets",
]);
const CAPABILITY_BY_INTERPRETER = Object.freeze({
  "polycss-effects@0": "prepared-particle-effects",
  "polycss-playback@0": "prepared-playback",
  "polycss-pointer-grab@0": "prepared-pointer-grab-interaction",
  "polycss-surface@0": "prepared-surface-lighting",
});
const CONFORMANCE_BY_INTERPRETER = Object.freeze({
  "polycss-effects@0": "particle-effects",
  "polycss-playback@0": "playback",
  "polycss-pointer-grab@0": "pointer-grab-interaction",
  "polycss-surface@0": "surface-lighting",
  "static-presentation@0": "presentation",
});
const CAPABILITY_INTERPRETER_ORDER = Object.freeze([
  "polycss-effects@0",
  "polycss-pointer-grab@0",
  "polycss-playback@0",
  "polycss-surface@0",
]);
const CONFORMANCE_INTERPRETER_ORDER = Object.freeze([
  "polycss-effects@0",
  "polycss-playback@0",
  "polycss-pointer-grab@0",
  "static-presentation@0",
  "polycss-surface@0",
]);
const VIEWER_OWNED_ATTRIBUTES = new Set(["data-domformat-instance", "data-domformat-mount-surface"]);
const ALLOWED_ELEMENTS = new Set(["b", "div", "i", "img", "s", "span", "u"]);
const ALLOWED_ATTRIBUTES = new Set(["alt", "aria-hidden", "class", "decoding", "draggable", "height", "id", "role", "width"]);
const ALLOWED_RESOURCE_ATTRIBUTES = new Set(["src"]);
const ALLOWED_STYLES = new Set([
  "backgroundColor",
  "backgroundPosition",
  "backgroundPositionY",
  "backgroundRepeat",
  "backgroundSize",
  "borderBottomLeftRadius",
  "borderBottomRightRadius",
  "borderShape",
  "borderTopLeftRadius",
  "borderTopRightRadius",
  "color",
  "cornerBottomLeftShape",
  "cornerBottomRightShape",
  "cornerTopLeftShape",
  "cornerTopRightShape",
  "height",
  "left",
  "objectFit",
  "objectPosition",
  "opacity",
  "perspective",
  "perspectiveOrigin",
  "position",
  "top",
  "transform",
  "transformOrigin",
  "transformStyle",
  "visibility",
  "width",
]);
const ALLOWED_MOUNT_STYLES = new Set([
  "backgroundColor",
  "backgroundPosition",
  "backgroundRepeat",
  "backgroundSize",
  "position",
]);
const ALLOWED_RESOURCE_STYLES = new Set(["backgroundImage"]);
const ALLOWED_CODECS = new Set([
  "polycss-effects-prepared@0",
  "polycss-playback-packed@0",
  "polycss-pointer-grab-prepared@0",
  "polycss-surface-packed@0",
  "static-presentation@0",
]);
const ALLOWED_INTERPRETERS = new Set([
  "polycss-effects@0",
  "polycss-playback@0",
  "polycss-pointer-grab@0",
  "polycss-surface@0",
  "static-presentation@0",
]);
const INTERPRETER_CODECS = Object.freeze({
  "polycss-effects@0": "polycss-effects-prepared@0",
  "polycss-playback@0": "polycss-playback-packed@0",
  "polycss-pointer-grab@0": "polycss-pointer-grab-prepared@0",
  "polycss-surface@0": "polycss-surface-packed@0",
  "static-presentation@0": "static-presentation@0",
});
const ALLOWED_SINKS = new Set([
  "host.style.backgroundColor",
  "host.style.backgroundImage",
  "host.style.backgroundPosition",
  "host.style.backgroundRepeat",
  "host.style.backgroundSize",
  "style.backgroundPosition",
  "style.backgroundPositionY",
  "style.height",
  "style.left",
  "style.opacity",
  "style.top",
  "style.transform",
  "style.visibility",
  "style.width",
]);
const INLINE_SAFE_FUNCTIONS = new Set([
  "abs", "acos", "asin", "atan", "atan2", "calc", "clamp", "color", "color-mix", "cos", "exp", "hsl", "hsla", "hwb", "hypot", "lab", "lch", "linear-gradient", "log", "matrix", "matrix3d", "max", "min", "mod", "oklab", "oklch", "polygon", "pow", "radial-gradient", "rem", "rgb", "rgba", "rotate", "rotate3d", "rotatex", "rotatey", "rotatez", "round", "scale", "scale3d", "scalex", "scaley", "scalez", "sign", "sin", "skew", "skewx", "skewy", "sqrt", "tan", "translate", "translate3d", "translatex", "translatey", "translatez",
]);

function plainObject(value, code, label) {
  invariant(value && typeof value === "object" && !Array.isArray(value), code, `${label} must be an object.`);
  const prototype = Object.getPrototypeOf(value);
  invariant(prototype === Object.prototype || prototype === null, code, `${label} must be a plain object.`);
  return value;
}

function knownKeys(value, allowed, code, label) {
  for (const key in value) {
    if (Object.hasOwn(value, key)) invariant(allowed.has(key), code, `${label} contains unsupported field ${key}.`);
  }
}

function boundedOwnPropertyCount(value, maximum, code, label) {
  let count = 0;
  for (const key in value) {
    if (!Object.hasOwn(value, key)) continue;
    count += 1;
    invariant(count <= maximum, code, `${label} has too many properties.`);
  }
  return count;
}

function boundedCodePointLength(value, maximum) {
  let length = 0;
  for (const _character of value) {
    length += 1;
    if (length > maximum) return length;
  }
  return length;
}

function stableId(value, label) {
  invariant(typeof value === "string" && NODE_ID.test(value) && !value.includes("..") && !value.includes("//"), "INVALID_STABLE_ID", `${label} is invalid.`);
  return value;
}

function safeStyleValue(value, label) {
  invariant(typeof value === "string" && value.length <= 4096, "INVALID_STYLE_VALUE", `${label} must be a short string.`);
  const lower = value.toLowerCase();
  invariant(
    !value.includes("\\")
    && !value.includes("/*")
    && !value.includes("*/")
    && !lower.includes("url(")
    && !lower.includes("javascript:")
    && !lower.includes("expression(")
    && !lower.includes("@import")
    && !lower.includes("!important")
    && !value.includes(";")
    && !value.includes("{")
    && !value.includes("}")
    && !value.includes("--"),
    "UNSAFE_STYLE_VALUE",
    `${label} contains an unsafe CSS value.`,
  );
  let quote = "";
  let depth = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    invariant(code >= 0x20 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d, "UNSAFE_STYLE_VALUE", `${label} contains a forbidden control character.`);
    const character = value[index];
    if (quote) {
      if (character === quote) quote = "";
      continue;
    }
    if (character === "\"" || character === "'") {
      quote = character;
      continue;
    }
    if (character === "(") depth += 1;
    else if (character === ")") depth -= 1;
    invariant(depth >= 0, "UNSAFE_STYLE_VALUE", `${label} has unbalanced function delimiters.`);
    if (!/[A-Za-z_-]/u.test(character)) continue;
    let cursor = index + 1;
    while (cursor < value.length && /[A-Za-z0-9_-]/u.test(value[cursor])) cursor += 1;
    if (value[cursor] === "(") {
      const name = value.slice(index, cursor).toLowerCase();
      invariant(INLINE_SAFE_FUNCTIONS.has(name), "UNSAFE_STYLE_VALUE", `${label} uses context-dependent or unsupported function ${name}().`);
    }
    index = cursor - 1;
  }
  invariant(!quote && depth === 0, "UNSAFE_STYLE_VALUE", `${label} has unterminated strings or functions.`);
}

function validateTree(tree, resources, limits) {
  plainObject(tree, "INVALID_TREE", "TREE");
  knownKeys(tree, new Set(["version", "mount", "nodes"]), "INVALID_TREE", "TREE");
  invariant(tree.version === 0, "UNSUPPORTED_TREE_SCHEMA", "TREE schema version must be 0.");
  plainObject(tree.mount, "INVALID_MOUNT", "TREE.mount");
  knownKeys(tree.mount, new Set(["behavior", "attributes", "styles", "resourceStyles"]), "INVALID_MOUNT", "TREE.mount");
  invariant(tree.mount.behavior === "replace-children", "INVALID_MOUNT", "polycss-3d@0 only supports replace-children mounting.");
  invariant(Array.isArray(tree.mount.attributes) && tree.mount.attributes.length <= limits.maxAttributesPerNode, "INVALID_MOUNT", "TREE.mount.attributes must be a bounded array.");
  const mountAttributes = new Set();
  for (const entry of tree.mount.attributes) {
    invariant(Array.isArray(entry) && entry.length === 2, "INVALID_MOUNT", "TREE.mount.attributes entries must be two-item arrays.");
    const [name, value] = entry;
    invariant(typeof name === "string" && !VIEWER_OWNED_ATTRIBUTES.has(name) && (ALLOWED_ATTRIBUTES.has(name) || DATA_ATTRIBUTE.test(name)), "UNSAFE_ATTRIBUTE", `Mount attribute ${name} is forbidden.`);
    invariant(typeof value === "string" && value.length <= 1024, "INVALID_ATTRIBUTE", `Mount attribute ${name} is invalid.`);
    invariant(!mountAttributes.has(name), "INVALID_ATTRIBUTE", `Mount attribute ${name} is duplicated.`);
    mountAttributes.add(name);
  }
  if (tree.mount.styles !== undefined) {
    plainObject(tree.mount.styles, "INVALID_MOUNT", "TREE.mount.styles");
    for (const [property, value] of Object.entries(tree.mount.styles)) {
      invariant(ALLOWED_MOUNT_STYLES.has(property), "UNSAFE_STYLE_PROPERTY", `Mount style ${property} is forbidden.`);
      safeStyleValue(value, `Mount style ${property}`);
      if (property === "position") invariant(value === "relative", "INVALID_MOUNT", "Mount position, when declared, must be relative.");
    }
  }
  if (tree.mount.resourceStyles !== undefined) validateResourceStyles(tree.mount.resourceStyles, resources, "Mount");
  invariant(Array.isArray(tree.nodes) && tree.nodes.length <= limits.maxNodes, "NODE_COUNT_LIMIT", `TREE node count exceeds ${limits.maxNodes}.`);
  const ids = new Set();
  const nodesById = new Map();
  const nextSibling = new Map();
  const parentIndices = new Set();
  const depths = [];
  for (const [index, node] of tree.nodes.entries()) {
    plainObject(node, "INVALID_NODE", `TREE node ${index}`);
    knownKeys(node, new Set(["index", "id", "parent", "sibling", "namespace", "name", "classes", "attributes", "styles", "resourceAttributes", "resourceStyles"]), "INVALID_NODE", `TREE node ${index}`);
    invariant(node.index === index, "NODE_INDEX", `TREE node ${index} has a noncanonical index.`);
    const id = stableId(node.id, `TREE node ${index} id`);
    invariant(!ids.has(id), "DUPLICATE_NODE_ID", `TREE node id ${id} is duplicated.`);
    ids.add(id);
    nodesById.set(id, node);
    invariant(node.namespace === XHTML, "UNSUPPORTED_NAMESPACE", `TREE node ${id} uses an unsupported namespace.`);
    invariant(ALLOWED_ELEMENTS.has(node.name), "FORBIDDEN_ELEMENT", `TREE node ${id} uses forbidden element ${node.name}.`);
    invariant(Number.isSafeInteger(node.parent) && node.parent >= -1 && node.parent < index, "INVALID_PARENT", `TREE node ${id} has invalid parent ${node.parent}.`);
    if (node.parent >= 0) parentIndices.add(node.parent);
    invariant(Number.isSafeInteger(node.sibling) && node.sibling >= 0, "INVALID_SIBLING", `TREE node ${id} has invalid sibling order.`);
    const expectedSibling = nextSibling.get(node.parent) ?? 0;
    invariant(node.sibling === expectedSibling, "INVALID_SIBLING", `TREE node ${id} sibling order must be ${expectedSibling}.`);
    nextSibling.set(node.parent, expectedSibling + 1);
    const depth = node.parent === -1 ? 1 : depths[node.parent] + 1;
    invariant(depth <= limits.maxTreeDepth, "TREE_DEPTH_LIMIT", `TREE node ${id} exceeds depth ${limits.maxTreeDepth}.`);
    depths.push(depth);
    const classes = node.classes ?? [];
    invariant(Array.isArray(classes) && classes.length <= limits.maxClassesPerNode, "CLASS_COUNT_LIMIT", `TREE node ${id} has too many classes.`);
    invariant(new Set(classes).size === classes.length && classes.every((token) => typeof token === "string" && CLASS_TOKEN.test(token)), "INVALID_CLASS", `TREE node ${id} has invalid class tokens.`);
    const attributes = node.attributes ?? {};
    plainObject(attributes, "INVALID_ATTRIBUTES", `TREE node ${id} attributes`);
    boundedOwnPropertyCount(attributes, limits.maxAttributesPerNode, "ATTRIBUTE_COUNT_LIMIT", `TREE node ${id} attributes`);
    for (const [name, value] of Object.entries(attributes)) {
      invariant(!name.toLowerCase().startsWith("on") && name !== "class" && name !== "srcdoc" && name !== "style" && !VIEWER_OWNED_ATTRIBUTES.has(name), "UNSAFE_ATTRIBUTE", `TREE node ${id} attribute ${name} is forbidden.`);
      invariant(ALLOWED_ATTRIBUTES.has(name) || DATA_ATTRIBUTE.test(name), "UNSAFE_ATTRIBUTE", `TREE node ${id} attribute ${name} is unsupported.`);
      invariant(typeof value === "string" && value.length <= 1024, "INVALID_ATTRIBUTE", `TREE node ${id} attribute ${name} is invalid.`);
    }
    const resourceAttributes = node.resourceAttributes ?? {};
    plainObject(resourceAttributes, "INVALID_RESOURCE_ATTRIBUTES", `TREE node ${id} resourceAttributes`);
    for (const [name, resource] of Object.entries(resourceAttributes)) {
      invariant(ALLOWED_RESOURCE_ATTRIBUTES.has(name), "UNSAFE_ATTRIBUTE", `TREE node ${id} resource attribute ${name} is forbidden.`);
      assertResourceId(resource, `TREE node ${id} resource attribute`);
      invariant(resources.has(resource), "MISSING_RESOURCE", `TREE node ${id} references missing resource ${resource}.`);
      invariant(resources.get(resource).kind === "image", "RESOURCE_ROLE_MISMATCH", `TREE node ${id} resource attribute ${name} must reference an image.`);
    }
    const styles = node.styles ?? {};
    plainObject(styles, "INVALID_STYLES", `TREE node ${id} styles`);
    boundedOwnPropertyCount(styles, limits.maxStylesPerNode, "STYLE_COUNT_LIMIT", `TREE node ${id} styles`);
    for (const [property, value] of Object.entries(styles)) {
      invariant(ALLOWED_STYLES.has(property), "UNSAFE_STYLE_PROPERTY", `TREE node ${id} style ${property} is forbidden.`);
      safeStyleValue(value, `TREE node ${id} style ${property}`);
    }
    validateResourceStyles(node.resourceStyles ?? {}, resources, `TREE node ${id}`);
  }
  for (const node of tree.nodes) {
    if (!parentIndices.has(node.index)) {
      invariant(node.attributes?.["aria-hidden"] === "true", "ACCESSIBILITY_REQUIRED", `Terminal visual node ${node.id} must be aria-hidden.`);
    }
  }
  return { ids, nodesById };
}

function validateResourceStyles(styles, resources, label) {
  plainObject(styles, "INVALID_RESOURCE_STYLES", `${label} resourceStyles`);
  for (const [property, binding] of Object.entries(styles)) {
    invariant(ALLOWED_RESOURCE_STYLES.has(property), "UNSAFE_STYLE_PROPERTY", `${label} resource style ${property} is forbidden.`);
    plainObject(binding, "INVALID_RESOURCE_STYLE", `${label} resource style ${property}`);
    knownKeys(binding, new Set(["resource", "syntax", "overlayOpacity"]), "INVALID_RESOURCE_STYLE", `${label} resource style ${property}`);
    assertResourceId(binding.resource, `${label} resource style ${property}`);
    invariant(resources.has(binding.resource), "MISSING_RESOURCE", `${label} references missing resource ${binding.resource}.`);
    invariant(resources.get(binding.resource).kind === "image", "RESOURCE_ROLE_MISMATCH", `${label} resource style ${property} must reference an image.`);
    invariant(binding.syntax === "url" || binding.syntax === "overlay-url", "INVALID_RESOURCE_STYLE", `${label} resource style ${property} syntax is unsupported.`);
    if (binding.syntax === "overlay-url") invariant(typeof binding.overlayOpacity === "number" && Number.isFinite(binding.overlayOpacity) && binding.overlayOpacity >= 0 && binding.overlayOpacity <= 1, "INVALID_RESOURCE_STYLE", `${label} overlay opacity is invalid.`);
    else invariant(!Object.hasOwn(binding, "overlayOpacity"), "INVALID_RESOURCE_STYLE", `${label} plain URL resource style must not declare overlayOpacity.`);
  }
}

function validateCssBinding(value, resources, mount, limits) {
  plainObject(value, "INVALID_CSS_BINDING", "CSSB");
  knownKeys(value, new Set(["version", "stylesheets"]), "INVALID_CSS_BINDING", "CSSB");
  invariant(value.version === 0, "UNSUPPORTED_CSS_BINDING_SCHEMA", "CSSB schema version must be 0.");
  invariant(Array.isArray(value.stylesheets) && value.stylesheets.length > 0 && value.stylesheets.length <= resources.size, "INVALID_CSS_BINDING", "CSSB.stylesheets must be nonempty and bounded by the resource catalog.");
  const ids = new Set();
  for (const binding of value.stylesheets) {
    plainObject(binding, "INVALID_CSS_BINDING", "Stylesheet binding");
    knownKeys(binding, new Set(["id", "resource", "scope", "assetTokens"]), "INVALID_CSS_BINDING", `Stylesheet binding ${binding.id ?? "<missing>"}`);
    assertResourceId(binding.id, "Stylesheet binding id");
    invariant(!ids.has(binding.id), "DUPLICATE_CSS_BINDING", `Stylesheet binding ${binding.id} is duplicated.`);
    ids.add(binding.id);
    assertResourceId(binding.resource, `Stylesheet ${binding.id} resource`);
    invariant(resources.has(binding.resource), "MISSING_CSS_RESOURCE", `Stylesheet ${binding.id} references missing resource ${binding.resource}.`);
    invariant(resources.get(binding.resource).kind === "stylesheet", "RESOURCE_ROLE_MISMATCH", `Stylesheet ${binding.id} must reference a stylesheet resource.`);
    const scope = cssScopeAttribute(binding.scope);
    invariant(mount.attributes.some(([name, value]) => name === scope.name && value === scope.value), "CSS_SCOPE_MISMATCH", `Stylesheet ${binding.id} scope is not an exact TREE mount attribute.`);
    invariant(Array.isArray(binding.assetTokens) && binding.assetTokens.length <= limits.maxCssAssetTokens, "CSS_TOKEN_LIMIT", `Stylesheet ${binding.id} exceeds ${limits.maxCssAssetTokens} asset tokens.`);
    const tokens = new Set();
    for (const entry of binding.assetTokens) {
      plainObject(entry, "INVALID_CSS_BINDING", `Stylesheet ${binding.id} asset token`);
      knownKeys(entry, new Set(["token", "resource"]), "INVALID_CSS_BINDING", `Stylesheet ${binding.id} asset token`);
      invariant(typeof entry.token === "string" && /^dom-asset:[a-z][a-z0-9._-]{0,63}$/u.test(entry.token), "INVALID_CSS_TOKEN", `Stylesheet ${binding.id} has invalid asset token.`);
      invariant(!tokens.has(entry.token), "DUPLICATE_CSS_TOKEN", `Stylesheet ${binding.id} token ${entry.token} is duplicated.`);
      tokens.add(entry.token);
      assertResourceId(entry.resource, `Stylesheet ${binding.id} token resource`);
      invariant(resources.has(entry.resource), "MISSING_CSS_ASSET", `Stylesheet ${binding.id} token references missing resource ${entry.resource}.`);
      invariant(resources.get(entry.resource).kind === "image", "RESOURCE_ROLE_MISMATCH", `Stylesheet ${binding.id} asset token must reference an image.`);
    }
  }
}

function validateState(value, limits) {
  plainObject(value, "INVALID_STATE", "STAT");
  knownKeys(value, new Set(["version", "channels"]), "INVALID_STATE", "STAT");
  invariant(value.version === 0, "UNSUPPORTED_STATE_SCHEMA", "STAT schema version must be 0.");
  invariant(Array.isArray(value.channels) && value.channels.length <= limits.maxStateChannels, "STATE_CHANNEL_LIMIT", `STAT channels exceed ${limits.maxStateChannels}.`);
  const channels = new Map();
  let previous = "";
  for (const channel of value.channels) {
    plainObject(channel, "INVALID_STATE", "State channel");
    knownKeys(channel, new Set(["id", "codec", "data"]), "INVALID_STATE", `State channel ${channel.id ?? "<missing>"}`);
    const id = stableId(channel.id, "State channel id");
    invariant(id > previous, "STATE_CHANNEL_ORDER", "STAT channels must be sorted by id.");
    previous = id;
    invariant(!channels.has(id), "DUPLICATE_STATE_CHANNEL", `State channel ${id} is duplicated.`);
    invariant(ALLOWED_CODECS.has(channel.codec), "UNSUPPORTED_STATE_CODEC", `State channel ${id} codec ${channel.codec} is unsupported.`);
    invariant(channel.data !== undefined, "MISSING_STATE_DATA", `State channel ${id} data is missing.`);
    channels.set(id, channel);
  }
  return channels;
}

function collectTargets(value, output = [], maximum = Number.MAX_SAFE_INTEGER, label = "Binding targets", maximumDepth = 64) {
  const stack = [{ value, depth: 0 }];
  const visited = new WeakSet();
  const structuralMaximum = Math.min(Number.MAX_SAFE_INTEGER, maximum * 4 + maximumDepth);
  let containers = 0;
  let entries = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    if (typeof current.value === "string") {
      output.push(current.value);
      invariant(output.length <= maximum, "TARGET_CARDINALITY_MISMATCH", `${label} exceeds its target limit.`);
      continue;
    }
    invariant(current.value && typeof current.value === "object", "INVALID_TARGETS", `${label} must contain only target strings and target groups.`);
    invariant(current.depth < maximumDepth, "TARGET_DEPTH_LIMIT", `${label} exceeds its nesting limit.`);
    invariant(!visited.has(current.value), "INVALID_TARGETS", `${label} must not contain cyclic or repeated object references.`);
    visited.add(current.value);
    containers += 1;
    invariant(containers <= structuralMaximum, "TARGET_CARDINALITY_MISMATCH", `${label} has too many target containers.`);
    const prototype = Object.getPrototypeOf(current.value);
    invariant(Array.isArray(current.value) || prototype === Object.prototype || prototype === null, "INVALID_TARGETS", `${label} must contain only arrays and plain target groups.`);
    if (Array.isArray(current.value)) {
      entries += current.value.length;
      invariant(entries <= structuralMaximum, "TARGET_CARDINALITY_MISMATCH", `${label} has too many target entries.`);
      for (let index = current.value.length - 1; index >= 0; index -= 1) {
        invariant(Object.hasOwn(current.value, index), "INVALID_TARGETS", `${label} must not contain sparse target arrays.`);
        stack.push({ value: current.value[index], depth: current.depth + 1 });
      }
    } else {
      const keys = [];
      for (const key in current.value) {
        if (!Object.hasOwn(current.value, key)) continue;
        entries += 1;
        invariant(entries <= structuralMaximum, "TARGET_CARDINALITY_MISMATCH", `${label} has too many target entries.`);
        keys.push(key);
      }
      for (let index = keys.length - 1; index >= 0; index -= 1) stack.push({ value: current.value[keys[index]], depth: current.depth + 1 });
    }
  }
  return output;
}

function validateBindings(value, stateChannels, nodeIds, limits) {
  plainObject(value, "INVALID_BINDINGS", "BIND");
  knownKeys(value, new Set(["version", "inputs", "channels"]), "INVALID_BINDINGS", "BIND");
  invariant(value.version === 0, "UNSUPPORTED_BINDING_SCHEMA", "BIND schema version must be 0.");
  invariant(Array.isArray(value.inputs) && value.inputs.length <= limits.maxBindingInputs, "BINDING_INPUT_LIMIT", `BIND inputs exceed ${limits.maxBindingInputs}.`);
  const inputIds = new Set();
  let previousInput = "";
  for (const input of value.inputs) {
    plainObject(input, "INVALID_BINDINGS", "Binding input");
    knownKeys(input, new Set(["id", "type", "default"]), "INVALID_BINDINGS", `Binding input ${input.id ?? "<missing>"}`);
    const id = stableId(input.id, "Binding input id");
    invariant(id > previousInput, "INPUT_ORDER", "BIND inputs must be sorted by id.");
    previousInput = id;
    invariant(!inputIds.has(id), "DUPLICATE_INPUT", `Binding input ${id} is duplicated.`);
    inputIds.add(id);
    invariant(["boolean", "float", "uint"].includes(input.type), "INVALID_INPUT_TYPE", `Binding input ${id} type is invalid.`);
    if (Object.hasOwn(input, "default")) {
      const valid = input.type === "boolean"
        ? typeof input.default === "boolean"
        : input.type === "float"
          ? Number.isFinite(input.default)
          : Number.isSafeInteger(input.default) && input.default >= 0;
      invariant(valid, "INVALID_INPUT_DEFAULT", `Binding input ${id} default does not match type ${input.type}.`);
    }
  }
  invariant(Array.isArray(value.channels) && value.channels.length <= limits.maxBindingChannels, "BINDING_CHANNEL_LIMIT", `BIND channels exceed ${limits.maxBindingChannels}.`);
  const ids = new Set();
  const channels = new Map();
  const boundStates = new Set();
  const interpreters = new Set();
  const usedInputs = new Set();
  let previous = "";
  for (const channel of value.channels) {
    plainObject(channel, "INVALID_BINDINGS", "Binding channel");
    knownKeys(channel, new Set(["id", "state", "interpreter", "status", "inputs", "targets", "sinks", "parameters"]), "INVALID_BINDINGS", `Binding channel ${channel.id ?? "<missing>"}`);
    const id = stableId(channel.id, "Binding channel id");
    invariant(id > previous, "BINDING_CHANNEL_ORDER", "BIND channels must be sorted by id.");
    previous = id;
    invariant(!ids.has(id), "DUPLICATE_BINDING_CHANNEL", `Binding channel ${id} is duplicated.`);
    ids.add(id);
    channels.set(id, channel);
    const stateChannel = stateChannels.get(channel.state);
    invariant(stateChannel, "MISSING_STATE_CHANNEL", `Binding channel ${id} references missing state ${channel.state}.`);
    invariant(ALLOWED_INTERPRETERS.has(channel.interpreter), "UNSUPPORTED_INTERPRETER", `Binding channel ${id} interpreter ${channel.interpreter} is unsupported.`);
    invariant(stateChannel.codec === INTERPRETER_CODECS[channel.interpreter], "STATE_INTERPRETER_MISMATCH", `Binding channel ${id} cannot interpret state codec ${stateChannel.codec}.`);
    invariant(!boundStates.has(channel.state), "DUPLICATE_STATE_BINDING", `State channel ${channel.state} is bound more than once.`);
    invariant(!interpreters.has(channel.interpreter), "DUPLICATE_INTERPRETER", `Interpreter ${channel.interpreter} is declared more than once.`);
    boundStates.add(channel.state);
    interpreters.add(channel.interpreter);
    invariant(channel.status === "executable", "INVALID_BINDING_STATUS", `Binding channel ${id} must be executable in polycss-3d@0.`);
    invariant(Array.isArray(channel.inputs) && channel.inputs.length <= limits.maxBindingInputs, "BINDING_INPUT_LIMIT", `Binding channel ${id} has excessive inputs.`);
    invariant(new Set(channel.inputs).size === channel.inputs.length && channel.inputs.every((input) => inputIds.has(input)), "MISSING_INPUT", `Binding channel ${id} has duplicate or undeclared inputs.`);
    for (const input of channel.inputs) usedInputs.add(input);
    plainObject(channel.targets, "INVALID_TARGETS", `Binding channel ${id} targets`);
    const targets = collectTargets(channel.targets, [], nodeIds.size + 1, `Binding channel ${id} targets`, limits.maxTreeDepth);
    invariant(targets.length > 0 || channel.interpreter === "polycss-surface@0", "INVALID_TARGETS", `Binding channel ${id} must declare at least one target.`);
    invariant(new Set(targets).size === targets.length, "DUPLICATE_TARGET", `Binding channel ${id} repeats a DOM target.`);
    for (const target of targets) {
      if (target === "$host") continue;
      invariant(nodeIds.has(target), "MISSING_TARGET_NODE", `Binding channel ${id} targets missing node ${target}.`);
    }
    invariant(Array.isArray(channel.sinks) && channel.sinks.length > 0 && channel.sinks.length <= ALLOWED_SINKS.size, "UNSUPPORTED_SINK", `Binding channel ${id} has an invalid number of DOM sinks.`);
    invariant(new Set(channel.sinks).size === channel.sinks.length && channel.sinks.every((sink) => ALLOWED_SINKS.has(sink)), "UNSUPPORTED_SINK", `Binding channel ${id} has a duplicate or unsupported DOM sink.`);
  }
  for (const id of stateChannels.keys()) invariant(boundStates.has(id), "UNBOUND_STATE_CHANNEL", `State channel ${id} has no DOM binding.`);
  for (const id of inputIds) invariant(usedInputs.has(id), "UNUSED_INPUT", `Binding input ${id} is declared but unused.`);
  return channels;
}

function uniqueTargets(values, label) {
  invariant(Array.isArray(values) && new Set(values).size === values.length, "TARGET_CARDINALITY_MISMATCH", `${label} targets must be a unique array.`);
  for (const [index, value] of values.entries()) stableId(value, `${label} target ${index}`);
}

function validateBindingTargetOwnership(bindingChannels, limits) {
  const byInterpreter = new Map([...bindingChannels.values()].map((channel) => [channel.interpreter, channel]));
  const targetsOf = (channel) => new Set(collectTargets(channel.targets, [], limits.maxNodes + 1, `${channel.interpreter} targets`, limits.maxTreeDepth));
  const effects = byInterpreter.get("polycss-effects@0");
  if (effects) {
    const owned = targetsOf(effects);
    for (const channel of bindingChannels.values()) {
      if (channel === effects) continue;
      for (const target of targetsOf(channel)) invariant(!owned.has(target), "TARGET_OWNERSHIP_CONFLICT", `Effect target ${target} is also owned by ${channel.interpreter}.`);
    }
  }
  const playback = byInterpreter.get("polycss-playback@0");
  const presentation = byInterpreter.get("static-presentation@0");
  if (playback && presentation) {
    const playbackTargets = targetsOf(playback);
    for (const target of targetsOf(presentation)) {
      if (target === "$host") continue;
      invariant(!playbackTargets.has(target), "TARGET_OWNERSHIP_CONFLICT", `Presentation target ${target} overlaps playback ownership.`);
    }
  }
}

function sameArray(left, right) {
  return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, index) => value === right[index]);
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

function finiteF32(value) {
  return typeof value === "number" && Number.isFinite(value) && Number.isFinite(Math.fround(value));
}

function finiteF32Result(value) {
  return Number.isFinite(Math.fround(value));
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

function interactionOperationF32(value) {
  const result = Math.fround(value);
  return Number.isFinite(result) ? result : Number.NaN;
}

function interactionAddF32(left, right) {
  return interactionOperationF32(interactionOperationF32(left) + interactionOperationF32(right));
}

function interactionMulF32(left, right) {
  return interactionOperationF32(interactionOperationF32(left) * interactionOperationF32(right));
}

function interactionTransformF32(value, source) {
  return [0, 1, 2].map((column) => {
    let result = interactionMulF32(source[column], value[0]);
    result = interactionAddF32(result, interactionMulF32(source[4 + column], value[1]));
    return interactionAddF32(result, interactionMulF32(source[8 + column], value[2]));
  });
}

function interactionGrabDisplacementBounds(input, source) {
  const spanX = interactionOperationF32(input.cursorBounds[1] - input.cursorBounds[0]);
  const spanY = interactionOperationF32(input.cursorBounds[3] - input.cursorBounds[2]);
  if (!Number.isFinite(spanX) || !Number.isFinite(spanY)) return null;
  const bounds = [0, 0, 0];
  for (const deltaX of [-spanX, spanX]) {
    for (const deltaY of [-spanY, spanY]) {
      const transformed = interactionTransformF32([
        interactionMulF32(deltaX, source.displacementMagnitude),
        interactionMulF32(deltaY, source.displacementMagnitude),
        0,
      ], source.inverseCameraMatrix);
      if (!transformed.every(Number.isFinite)) return null;
      for (let component = 0; component < 3; component += 1) {
        bounds[component] = Math.max(bounds[component], Math.abs(transformed[component]));
      }
    }
  }
  return bounds;
}

function interactionProjectedF32(position, source) {
  const camera = interactionTransformF32(position, source.cameraViewMatrix);
  for (let component = 0; component < 3; component += 1) {
    camera[component] = interactionAddF32(camera[component], source.cameraViewMatrix[12 + component]);
  }
  if (!camera.every(Number.isFinite) || Math.abs(camera[2]) <= 1e-6) return null;
  const xScale = interactionOperationF32(source.projection.scale / interactionOperationF32(-camera[2]));
  const yScale = interactionOperationF32(source.projection.scale / camera[2]);
  const projected = [
    interactionAddF32(interactionMulF32(camera[0], xScale), source.projection.origin[0]),
    interactionAddF32(interactionMulF32(camera[1], yScale), source.projection.origin[1]),
  ];
  return projected.every(Number.isFinite) ? projected : null;
}

function interactionMagnitudeF32(value) {
  let squared = interactionMulF32(value[0], value[0]);
  squared = interactionAddF32(squared, interactionMulF32(value[1], value[1]));
  squared = interactionAddF32(squared, interactionMulF32(value[2], value[2]));
  return Number.isFinite(squared) && squared >= 0 && Number.isFinite(interactionOperationF32(Math.sqrt(squared)));
}

function finiteF32Array(value, length, label) {
  invariant(Array.isArray(value) && value.length === length && value.every(finiteF32), "INVALID_EFFECTS_STATE", `${label} must contain ${length} finite f32 values.`);
  return value;
}

function interactionF32Array(value, length, label) {
  invariant(Array.isArray(value) && value.length === length && value.every(finiteF32), "INVALID_INTERACTION_STATE", `${label} must contain ${length} finite f32 values.`);
  return value;
}

function interactionIntegerArray(value, maximum, label, options = {}) {
  invariant(Array.isArray(value) && value.length <= maximum, "INTERACTION_STATE_LIMIT", `${label} is missing or excessive.`);
  const minimum = options.minimum ?? 0;
  const upper = options.upper ?? Number.MAX_SAFE_INTEGER;
  invariant(value.every((entry) => Number.isSafeInteger(entry) && entry >= minimum && entry <= upper), "INVALID_INTERACTION_STATE", `${label} contains an invalid integer.`);
  if (options.unique) invariant(new Set(value).size === value.length, "INVALID_INTERACTION_STATE", `${label} must not contain duplicates.`);
  return value;
}

function integerArray(value, maximum, code, label, options = {}) {
  invariant(Array.isArray(value) && value.length <= maximum, code, `${label} is missing or excessive.`);
  const minimum = options.minimum ?? Number.MIN_SAFE_INTEGER;
  const upper = options.upper ?? Number.MAX_SAFE_INTEGER;
  invariant(value.every((entry) => Number.isSafeInteger(entry) && entry >= minimum && entry <= upper), code, `${label} contains an invalid integer.`);
  return value;
}

function base64Integers(value, width, maximum, code, label) {
  const maximumDecodedLength = maximum * width;
  invariant(Number.isSafeInteger(maximumDecodedLength), code, `${label} is excessive.`);
  const decodedLength = canonicalBase64DecodedLength(value, label, code);
  invariant(decodedLength % width === 0 && decodedLength / width <= maximum, code, `${label} is truncated or excessive.`);
  let binary;
  try {
    binary = globalThis.atob(value);
  } catch {
    invariant(false, code, `${label} is not valid base64.`);
  }
  invariant(binary.length === decodedLength, code, `${label} has a noncanonical decoded length.`);
  return Array.from({ length: decodedLength / width }, (_, index) => {
    let result = 0;
    for (let byte = 0; byte < width; byte += 1) result += binary.charCodeAt(index * width + byte) * 2 ** (byte * 8);
    return result;
  });
}

function exactArray(value, expected, code, message) {
  invariant(Array.isArray(value) && value.length === expected.length && value.every((entry, index) => entry === expected[index]), code, message);
}

function cumulativeReferences(deltas, count, code, label) {
  integerArray(deltas, count, code, label);
  invariant(deltas.length === count, code, `${label} does not match its declared count.`);
  let current = 0;
  return deltas.map((delta, index) => {
    current += delta;
    invariant(Number.isSafeInteger(current) && current >= 0, code, `${label} reference ${index} is invalid.`);
    return current;
  });
}

function validatePlaybackContract(playbackState, playbackBinding, bindingInputs, limits) {
  invariant(playbackBinding.status === "executable", "INVALID_PLAYBACK_BINDING", "polycss-playback@0 must be executable.");
  exactArray(playbackBinding.inputs, ["time.tick"], "INVALID_PLAYBACK_BINDING", "polycss-playback@0 inputs are incomplete or noncanonical.");
  const tickInput = bindingInputs.get("time.tick");
  invariant(tickInput?.type === "uint" && !Object.hasOwn(tickInput, "default"), "INVALID_PLAYBACK_BINDING", "Playback input time.tick must have type uint and no package default.");
  exactArray(playbackBinding.sinks, ["style.transform", "style.visibility"], "INVALID_PLAYBACK_BINDING", "polycss-playback@0 sinks are incomplete or noncanonical.");
  const targets = plainObject(playbackBinding.targets, "INVALID_PLAYBACK_BINDING", "Playback targets");
  knownKeys(targets, new Set(["model", "shapes", "leaves"]), "INVALID_PLAYBACK_BINDING", "Playback targets");
  stableId(targets.model, "Playback model target");
  uniqueTargets(targets.shapes, "Playback shape");
  uniqueTargets(targets.leaves, "Playback leaf");
  const parameters = plainObject(playbackBinding.parameters, "INVALID_PLAYBACK_BINDING", "Playback parameters");
  knownKeys(parameters, new Set(["baseSceneTransform", "frameCount", "tickRateHz"]), "INVALID_PLAYBACK_BINDING", "Playback parameters");
  safeStyleValue(parameters.baseSceneTransform, "Playback base scene transform");
  invariant(Number.isSafeInteger(parameters.frameCount) && parameters.frameCount > 0 && parameters.frameCount <= limits.maxFrames, "FRAME_CARDINALITY_MISMATCH", "Playback frameCount is invalid or excessive.");
  invariant(parameters.tickRateHz === 30, "INVALID_PLAYBACK_BINDING", "polycss-playback@0 tickRateHz must be 30.");

  const data = plainObject(playbackState.data, "INVALID_PLAYBACK_STATE", "Playback state data");
  knownKeys(data, new Set(["packet", "leafFit"]), "INVALID_PLAYBACK_STATE", "Playback state data");
  const packet = plainObject(data.packet, "INVALID_PLAYBACK_STATE", "Playback packet");
  knownKeys(packet, new Set(["version", "layout", "shapeCount", "leafCount", "appearances", "timeline", "initial", "frameRows", "shapeChanges", "leafChanges", "transforms"]), "INVALID_PLAYBACK_STATE", "Playback packet");
  invariant(packet.version === 0 && packet.layout === "delta-component-streams@0", "INVALID_PLAYBACK_STATE", "Playback packet version or layout is unsupported.");
  invariant(Number.isSafeInteger(packet.shapeCount) && packet.shapeCount >= 0 && packet.shapeCount <= limits.maxNodes, "TARGET_CARDINALITY_MISMATCH", "Playback shapeCount is invalid or excessive.");
  invariant(Number.isSafeInteger(packet.leafCount) && packet.leafCount >= 0 && packet.leafCount <= Math.min(limits.maxNodes, 0x10000), "TARGET_CARDINALITY_MISMATCH", "Playback leafCount is invalid or excessive for the uint16 surface codec.");
  invariant(targets.shapes.length === packet.shapeCount && targets.leaves.length === packet.leafCount, "TARGET_CARDINALITY_MISMATCH", "Playback targets do not match declared counts.");
  invariant(packet.leafCount * parameters.frameCount <= limits.maxVisibilityCells, "VISIBILITY_ALLOCATION_LIMIT", "Playback visibility matrix exceeds its allocation limit.");

  invariant(Array.isArray(data.leafFit) && data.leafFit.length === packet.leafCount, "TARGET_CARDINALITY_MISMATCH", "Playback leaf-fit rows do not match leafCount.");
  for (const [index, fit] of data.leafFit.entries()) {
    plainObject(fit, "INVALID_PLAYBACK_STATE", `Playback leaf-fit row ${index}`);
    knownKeys(fit, new Set(["canonicalSize"]), "INVALID_PLAYBACK_STATE", `Playback leaf-fit row ${index}`);
    invariant(Number.isSafeInteger(fit.canonicalSize) && fit.canonicalSize > 0 && fit.canonicalSize <= 0xffff, "INVALID_PLAYBACK_STATE", `Playback leaf-fit row ${index} is invalid.`);
  }

  invariant(Array.isArray(packet.appearances) && packet.appearances.length > 0 && packet.appearances.length <= limits.maxFrames, "INVALID_PLAYBACK_STATE", "Playback appearances are missing or excessive.");
  const appearanceIds = new Set();
  for (const [index, appearance] of packet.appearances.entries()) {
    invariant(Array.isArray(appearance) && appearance.length === 3, "INVALID_PLAYBACK_STATE", `Playback appearance ${index} is malformed.`);
    const id = stableId(appearance[0], `Playback appearance ${index} id`);
    invariant(!appearanceIds.has(id), "INVALID_PLAYBACK_STATE", `Playback appearance id ${id} is duplicated.`);
    appearanceIds.add(id);
    invariant(finiteF32(appearance[1]) && appearance[1] > 0 && finiteF32(appearance[2]), "INVALID_PLAYBACK_STATE", `Playback appearance ${index} has invalid binary32 scale or translation.`);
  }

  const transformTable = plainObject(packet.transforms, "INVALID_PLAYBACK_STATE", "Playback transform table");
  knownKeys(transformTable, new Set(["count", "groups"]), "INVALID_PLAYBACK_STATE", "Playback transform table");
  invariant(Number.isSafeInteger(transformTable.count) && transformTable.count > 0 && transformTable.count <= limits.maxPreparedTransforms, "TRANSFORM_ALLOCATION_LIMIT", "Playback transform count is invalid or excessive.");
  invariant(Array.isArray(transformTable.groups) && transformTable.groups.length <= limits.maxNodes, "TRANSFORM_ALLOCATION_LIMIT", "Playback transform groups are missing or excessive.");

  const initial = plainObject(packet.initial, "INVALID_PLAYBACK_STATE", "Playback initial state");
  knownKeys(initial, new Set(["sourceFrame", "appearance", "modelTransform", "shapes", "leaves"]), "INVALID_PLAYBACK_STATE", "Playback initial state");
  invariant(Number.isSafeInteger(initial.sourceFrame) && initial.sourceFrame >= 1 && initial.sourceFrame <= parameters.frameCount, "FRAME_CARDINALITY_MISMATCH", "Playback initial source frame is invalid.");
  invariant(Number.isSafeInteger(initial.appearance) && initial.appearance >= 0 && initial.appearance < packet.appearances.length, "INVALID_PLAYBACK_STATE", "Playback initial appearance is invalid.");
  invariant(Number.isSafeInteger(initial.modelTransform) && initial.modelTransform >= 0 && initial.modelTransform < transformTable.count, "INVALID_PLAYBACK_STATE", "Playback initial model transform is invalid.");
  const initialShapes = plainObject(initial.shapes, "INVALID_PLAYBACK_STATE", "Playback initial shapes");
  knownKeys(initialShapes, new Set(["count", "transforms", "visibility"]), "INVALID_PLAYBACK_STATE", "Playback initial shapes");
  invariant(initialShapes.count === packet.shapeCount, "TARGET_CARDINALITY_MISMATCH", "Playback initial shapes do not match shapeCount.");
  const initialShapeTransforms = cumulativeReferences(initialShapes.transforms, packet.shapeCount, "INVALID_PLAYBACK_STATE", "Playback initial shape transforms");
  integerArray(initialShapes.visibility, packet.shapeCount, "INVALID_PLAYBACK_STATE", "Playback initial shape visibility", { minimum: 0, upper: 1 });
  invariant(initialShapes.visibility.length === packet.shapeCount, "TARGET_CARDINALITY_MISMATCH", "Playback initial shape visibility does not match shapeCount.");
  const initialLeaves = plainObject(initial.leaves, "INVALID_PLAYBACK_STATE", "Playback initial leaves");
  knownKeys(initialLeaves, new Set(["count", "transforms"]), "INVALID_PLAYBACK_STATE", "Playback initial leaves");
  invariant(initialLeaves.count === packet.leafCount, "TARGET_CARDINALITY_MISMATCH", "Playback initial leaves do not match leafCount.");
  const initialLeafTransforms = cumulativeReferences(initialLeaves.transforms, packet.leafCount, "INVALID_PLAYBACK_STATE", "Playback initial leaf transforms");
  invariant([...initialShapeTransforms, ...initialLeafTransforms].every((index) => index < transformTable.count), "INVALID_PLAYBACK_STATE", "Playback initial state references a missing transform.");

  const timeline = plainObject(packet.timeline, "INVALID_PLAYBACK_STATE", "Playback timeline");
  knownKeys(timeline, new Set(["introTicks", "loopTicks", "frames"]), "INVALID_PLAYBACK_STATE", "Playback timeline");
  invariant(Number.isSafeInteger(timeline.introTicks) && timeline.introTicks >= 0 && Number.isSafeInteger(timeline.loopTicks) && timeline.loopTicks > 0, "TIMELINE_LIMIT", "Playback timeline ranges are invalid.");
  const timelineFrames = integerArray(timeline.frames, limits.maxTimelineTicks, "TIMELINE_LIMIT", "Playback timeline frames", { minimum: 1, upper: parameters.frameCount });
  invariant(timelineFrames.length === timeline.introTicks + timeline.loopTicks && timelineFrames[0] === initial.sourceFrame, "TIMELINE_LIMIT", "Playback timeline does not exactly cover its intro and loop or initial frame.");

  const shapeChanges = plainObject(packet.shapeChanges, "INVALID_PLAYBACK_STATE", "Playback shape changes");
  knownKeys(shapeChanges, new Set(["sources", "transforms", "visibility"]), "INVALID_PLAYBACK_STATE", "Playback shape changes");
  const leafChanges = plainObject(packet.leafChanges, "INVALID_PLAYBACK_STATE", "Playback leaf changes");
  knownKeys(leafChanges, new Set(["sources", "transforms"]), "INVALID_PLAYBACK_STATE", "Playback leaf changes");
  integerArray(shapeChanges.sources, limits.maxPreparedChanges, "STATE_CHANGE_LIMIT", "Playback shape sources");
  integerArray(shapeChanges.transforms, limits.maxPreparedChanges, "STATE_CHANGE_LIMIT", "Playback shape transform deltas");
  integerArray(shapeChanges.visibility, limits.maxPreparedChanges, "STATE_CHANGE_LIMIT", "Playback shape visibility", { minimum: 0, upper: 1 });
  integerArray(leafChanges.sources, limits.maxPreparedChanges, "STATE_CHANGE_LIMIT", "Playback leaf sources");
  integerArray(leafChanges.transforms, limits.maxPreparedChanges, "STATE_CHANGE_LIMIT", "Playback leaf transform deltas");
  invariant(shapeChanges.sources.length === shapeChanges.transforms.length && shapeChanges.sources.length === shapeChanges.visibility.length && leafChanges.sources.length === leafChanges.transforms.length, "STATE_COLUMN_MISMATCH", "Playback change-table columns have unequal lengths.");

  invariant(Array.isArray(packet.frameRows) && packet.frameRows.length === parameters.frameCount, "FRAME_CARDINALITY_MISMATCH", "Playback frame rows do not match frameCount.");
  const owners = new Array(transformTable.count);
  const claim = (index, owner, label) => {
    invariant(Number.isSafeInteger(index) && index >= 0 && index < transformTable.count, "INVALID_PLAYBACK_STATE", `${label} references missing transform ${index}.`);
    if (owners[index] === undefined) owners[index] = owner;
    else invariant(owners[index] === owner || (owners[index].startsWith("shape:") && owner.startsWith("shape:")), "TRANSFORM_GROUP_MISMATCH", `${label} aliases a fitted transform across incompatible owners.`);
  };
  claim(initial.modelTransform, "model", "Playback initial model");
  initialShapeTransforms.forEach((transform, index) => claim(transform, `shape:${index}`, `Playback initial shape ${index}`));
  initialLeafTransforms.forEach((transform, index) => claim(transform, `leaf:${index}`, `Playback initial leaf ${index}`));
  let shapeCursor = 0;
  let leafCursor = 0;
  let shapeTransform = 0;
  let leafTransform = 0;
  for (const [index, row] of packet.frameRows.entries()) {
    invariant(Array.isArray(row) && row.length === 7 && row.every(Number.isSafeInteger) && row[0] === index + 1, "INVALID_FRAME_ROW", `Playback frame row ${index} is malformed.`);
    invariant(row[1] >= 0 && row[1] < packet.appearances.length, "INVALID_FRAME_ROW", `Playback frame row ${index} appearance is invalid.`);
    invariant(row[2] === -1 || (row[2] >= 0 && row[2] < transformTable.count), "INVALID_FRAME_ROW", `Playback frame row ${index} model transform is invalid.`);
    if (row[2] !== -1) claim(row[2], "model", `Playback frame row ${index} model`);
    invariant(row[3] === shapeCursor && row[4] >= 0 && row[3] + row[4] <= shapeChanges.sources.length, "STATE_COLUMN_MISMATCH", `Playback frame row ${index} shape range is noncanonical.`);
    let shape = 0;
    for (let cursor = row[3]; cursor < row[3] + row[4]; cursor += 1) {
      shape += shapeChanges.sources[cursor];
      shapeTransform += shapeChanges.transforms[cursor];
      invariant(shape >= 0 && shape < packet.shapeCount, "STATE_COLUMN_MISMATCH", `Playback frame row ${index} has an invalid shape index.`);
      claim(shapeTransform, `shape:${shape}`, `Playback frame row ${index} shape ${shape}`);
    }
    shapeCursor += row[4];
    invariant(row[5] === leafCursor && row[6] >= 0 && row[5] + row[6] <= leafChanges.sources.length, "STATE_COLUMN_MISMATCH", `Playback frame row ${index} leaf range is noncanonical.`);
    let leaf = 0;
    for (let cursor = row[5]; cursor < row[5] + row[6]; cursor += 1) {
      leaf += leafChanges.sources[cursor];
      leafTransform += leafChanges.transforms[cursor];
      invariant(leaf >= 0 && leaf < packet.leafCount, "STATE_COLUMN_MISMATCH", `Playback frame row ${index} has an invalid leaf index.`);
      claim(leafTransform, `leaf:${leaf}`, `Playback frame row ${index} leaf ${leaf}`);
    }
    leafCursor += row[6];
  }
  invariant(shapeCursor === shapeChanges.sources.length && leafCursor === leafChanges.sources.length, "STATE_COLUMN_MISMATCH", "Playback change tables contain unreferenced rows.");
  for (let index = 0; index < owners.length; index += 1) {
    invariant(typeof owners[index] === "string", "TRANSFORM_GROUP_MISMATCH", `Playback transform ${index} is unowned.`);
  }

  const inferredGroups = new Map();
  for (let index = 0; index < owners.length; index += 1) {
    const owner = owners[index];
    const indices = inferredGroups.get(owner);
    if (indices) indices.push(index);
    else inferredGroups.set(owner, [index]);
  }
  invariant(transformTable.groups.length === inferredGroups.size, "TRANSFORM_GROUP_MISMATCH", "Playback transform groups do not match inferred owners.");
  const groupEntries = [...inferredGroups];
  for (let groupIndex = 0; groupIndex < groupEntries.length; groupIndex += 1) {
    const [owner, indices] = groupEntries[groupIndex];
    const group = plainObject(transformTable.groups[groupIndex], "INVALID_PLAYBACK_STATE", `Playback transform group ${groupIndex}`);
    knownKeys(group, new Set(["encoding", "empty", "scales", "columns"]), "INVALID_PLAYBACK_STATE", `Playback transform group ${groupIndex}`);
    invariant(group.encoding === "decimal-component-streams" || group.encoding === "source-milli-fitted-leaf", "INVALID_PLAYBACK_STATE", `Playback transform group ${groupIndex} encoding is unsupported.`);
    if (group.encoding === "source-milli-fitted-leaf") invariant(owner.startsWith("leaf:"), "TRANSFORM_GROUP_MISMATCH", `Playback fitted group ${groupIndex} does not belong to a leaf.`);
    integerArray(group.empty, indices.length, "INVALID_PLAYBACK_STATE", `Playback transform group ${groupIndex} empty rows`, { minimum: 0, upper: Math.max(0, indices.length - 1) });
    invariant(new Set(group.empty).size === group.empty.length && group.empty.every((value, index) => index === 0 || group.empty[index - 1] < value), "INVALID_PLAYBACK_STATE", `Playback transform group ${groupIndex} empty rows are not strictly sorted.`);
    invariant(Array.isArray(group.scales) && group.scales.length === 12 && group.scales.every((scale) => Number.isSafeInteger(scale) && scale >= 0), "INVALID_PLAYBACK_STATE", `Playback transform group ${groupIndex} scales are invalid.`);
    if (group.encoding === "source-milli-fitted-leaf") invariant(group.scales.every((scale) => scale === 1000), "INVALID_PLAYBACK_STATE", `Playback fitted group ${groupIndex} must use milli-unit scales.`);
    const presentCount = indices.length - group.empty.length;
    invariant(Array.isArray(group.columns) && group.columns.length === 12, "INVALID_PLAYBACK_STATE", `Playback transform group ${groupIndex} must contain 12 columns.`);
    for (let columnIndex = 0; columnIndex < 12; columnIndex += 1) {
      const column = group.columns[columnIndex];
      invariant(Array.isArray(column) && column.length === presentCount && column.every((value) => typeof value === "number" && Number.isFinite(value)), "INVALID_PLAYBACK_STATE", `Playback transform group ${groupIndex} column ${columnIndex} is invalid.`);
      if (group.scales[columnIndex] > 0) {
        let current = 0;
        for (const delta of column) {
          invariant(Number.isSafeInteger(delta), "INVALID_PLAYBACK_STATE", `Playback transform group ${groupIndex} scaled column ${columnIndex} contains a noninteger delta.`);
          current += delta;
          invariant(Number.isSafeInteger(current) && Number.isFinite(current / group.scales[columnIndex]), "INVALID_PLAYBACK_STATE", `Playback transform group ${groupIndex} scaled column ${columnIndex} overflows.`);
        }
      }
    }
  }
  return packet;
}

function validateSurfaceContract(surfaceState, surfaceBinding, playbackPacket, playbackBinding, bindingInputs, limits) {
  invariant(surfaceBinding.status === "executable", "INVALID_SURFACE_BINDING", "polycss-surface@0 must be executable.");
  exactArray(surfaceBinding.inputs, ["time.source-frame"], "INVALID_SURFACE_BINDING", "polycss-surface@0 inputs are incomplete or noncanonical.");
  const sourceFrameInput = bindingInputs.get("time.source-frame");
  invariant(sourceFrameInput?.type === "uint" && !Object.hasOwn(sourceFrameInput, "default"), "INVALID_SURFACE_BINDING", "Surface input time.source-frame must have type uint and no package default.");
  exactArray(surfaceBinding.sinks, ["style.backgroundPositionY", "style.visibility"], "INVALID_SURFACE_BINDING", "polycss-surface@0 sinks are incomplete or noncanonical.");
  invariant(!Object.hasOwn(surfaceBinding, "parameters"), "INVALID_SURFACE_BINDING", "polycss-surface@0 has no binding parameters.");
  const targets = plainObject(surfaceBinding.targets, "INVALID_SURFACE_BINDING", "Surface targets");
  knownKeys(targets, new Set(["leaves"]), "INVALID_SURFACE_BINDING", "Surface targets");
  uniqueTargets(targets.leaves, "Surface leaf");
  invariant(targets.leaves.length === playbackPacket.leafCount && targets.leaves.every((target, index) => target === playbackBinding.targets.leaves[index]), "TARGET_CARDINALITY_MISMATCH", "Surface leaf targets must exactly match playback leaf targets.");

  const data = plainObject(surfaceState.data, "INVALID_SURFACE_STATE", "Surface state data");
  knownKeys(data, new Set(["packet"]), "INVALID_SURFACE_STATE", "Surface state data");
  const packet = plainObject(data.packet, "INVALID_SURFACE_STATE", "Surface packet");
  knownKeys(packet, new Set(["version", "frameCount", "surface", "transitions", "visibility"]), "INVALID_SURFACE_STATE", "Surface packet");
  invariant(packet.version === 0 && packet.frameCount === playbackBinding.parameters.frameCount, "FRAME_CARDINALITY_MISMATCH", "Surface packet version or frameCount is invalid.");
  const surface = plainObject(packet.surface, "INVALID_SURFACE_STATE", "Surface table");
  knownKeys(surface, new Set(["faces", "statePacking"]), "INVALID_SURFACE_STATE", "Surface table");
  invariant(Array.isArray(surface.faces) && surface.faces.length === playbackPacket.leafCount, "TARGET_CARDINALITY_MISMATCH", "Surface faces do not match playback leafCount.");
  const packing = plainObject(surface.statePacking, "INVALID_SURFACE_STATE", "Surface state packing");
  knownKeys(packing, new Set(["stateCount", "sourceFrameDeltas"]), "INVALID_SURFACE_STATE", "Surface state packing");
  invariant(Number.isSafeInteger(packing.stateCount) && packing.stateCount >= 0 && packing.stateCount <= limits.maxPreparedStates, "SURFACE_STATE_LIMIT", "Surface state count is invalid or excessive.");
  integerArray(packing.sourceFrameDeltas, limits.maxPreparedStates, "SURFACE_STATE_LIMIT", "Surface source-frame deltas", { minimum: 0, upper: packet.frameCount - 1 });
  invariant(packing.sourceFrameDeltas.length === packing.stateCount, "STATE_COLUMN_MISMATCH", "Surface source-frame deltas do not match stateCount.");
  const faceIds = new Set();
  const sourceFramesByFace = [];
  let stateOffset = 0;
  for (const [index, face] of surface.faces.entries()) {
    plainObject(face, "INVALID_SURFACE_STATE", `Surface face ${index}`);
    knownKeys(face, new Set(["faceId", "sourceOrder", "stateOffset", "stateCount", "leafWidth", "leafHeight"]), "INVALID_SURFACE_STATE", `Surface face ${index}`);
    const faceId = stableId(face.faceId, `Surface face ${index} id`);
    invariant(!faceIds.has(faceId) && face.sourceOrder === index, "INVALID_SURFACE_STATE", `Surface face ${index} identity or order is invalid.`);
    faceIds.add(faceId);
    invariant(face.stateOffset === stateOffset && Number.isSafeInteger(face.stateCount) && face.stateCount > 0 && stateOffset + face.stateCount <= packing.stateCount, "STATE_COLUMN_MISMATCH", `Surface face ${index} has a noncanonical state range.`);
    invariant(Number.isSafeInteger(face.leafWidth) && face.leafWidth > 0 && face.leafWidth <= 0xffff && Number.isSafeInteger(face.leafHeight) && face.leafHeight > 0 && face.leafHeight <= 0xffff, "INVALID_SURFACE_STATE", `Surface face ${index} dimensions are invalid.`);
    let sourceFrame = 0;
    const sourceFrames = [];
    for (let local = 0; local < face.stateCount; local += 1) {
      const delta = packing.sourceFrameDeltas[stateOffset + local];
      invariant(local === 0 ? delta === 0 : delta > 0, "INVALID_SURFACE_STATE", `Surface face ${index} source-frame deltas are noncanonical.`);
      sourceFrame += delta;
      invariant(sourceFrame < packet.frameCount, "INVALID_SURFACE_STATE", `Surface face ${index} state exceeds frameCount.`);
      sourceFrames.push(sourceFrame);
    }
    sourceFramesByFace.push(sourceFrames);
    stateOffset += face.stateCount;
  }
  invariant(stateOffset === packing.stateCount, "STATE_COLUMN_MISMATCH", "Surface state table contains unreferenced rows.");

  const transitions = plainObject(packet.transitions, "INVALID_SURFACE_STATE", "Surface transitions");
  knownKeys(transitions, new Set(["initialFrame", "sequential", "nonInteractiveJumps"]), "INVALID_SURFACE_STATE", "Surface transitions");
  invariant(transitions.initialFrame === 1 && transitions.initialFrame === playbackPacket.initial.sourceFrame, "FRAME_CARDINALITY_MISMATCH", "Surface transition initial frame must be frame 1 and match playback.");
  const sequential = plainObject(transitions.sequential, "INVALID_SURFACE_STATE", "Surface sequential transitions");
  knownKeys(sequential, new Set(["offsetsBase64", "faceIndexDeltas", "stateIndexDeltas"]), "INVALID_SURFACE_STATE", "Surface sequential transitions");
  integerArray(sequential.faceIndexDeltas, limits.maxPreparedChanges, "STATE_CHANGE_LIMIT", "Surface face-index deltas", { minimum: 0, upper: Math.max(0, playbackPacket.leafCount - 1) });
  integerArray(sequential.stateIndexDeltas, limits.maxPreparedChanges, "STATE_CHANGE_LIMIT", "Surface state-index deltas", { minimum: 0, upper: 0xffff });
  invariant(sequential.faceIndexDeltas.length === sequential.stateIndexDeltas.length, "STATE_COLUMN_MISMATCH", "Surface sequential transition columns have unequal lengths.");
  const offsets = base64Integers(sequential.offsetsBase64, 4, packet.frameCount + 1, "INVALID_SURFACE_STATE", "Surface transition offsets");
  invariant(offsets.length === packet.frameCount + 1 && offsets[0] === 0 && offsets.at(-1) === sequential.faceIndexDeltas.length && offsets.every((offset, index) => index === 0 || offsets[index - 1] <= offset), "STATE_COLUMN_MISMATCH", "Surface transition offsets are invalid.");
  const currentStates = new Uint32Array(playbackPacket.leafCount);
  const lightingSegments = [];
  for (let frame = 0; frame < packet.frameCount; frame += 1) {
    let face = 0;
    let previousFace = -1;
    const segmentFaces = [];
    const segmentStates = [];
    for (let cursor = offsets[frame]; cursor < offsets[frame + 1]; cursor += 1) {
      face += sequential.faceIndexDeltas[cursor];
      invariant(face >= 0 && face < surface.faces.length && face > previousFace, "INVALID_SURFACE_STATE", `Surface transition segment ${frame} has invalid face ordering.`);
      currentStates[face] += sequential.stateIndexDeltas[cursor];
      invariant(currentStates[face] < surface.faces[face].stateCount, "INVALID_SURFACE_STATE", `Surface transition segment ${frame} exceeds face state count.`);
      segmentFaces.push(face);
      segmentStates.push(currentStates[face]);
      previousFace = face;
    }
    lightingSegments.push({ faces: segmentFaces, states: segmentStates });
  }
  invariant(Array.isArray(transitions.nonInteractiveJumps) && transitions.nonInteractiveJumps.length <= packet.frameCount, "INVALID_SURFACE_STATE", "Surface noninteractive jumps are invalid or excessive.");
  const jumpPairs = new Set();
  const lightingJumps = new Map();
  for (const [index, jump] of transitions.nonInteractiveJumps.entries()) {
    plainObject(jump, "INVALID_SURFACE_STATE", `Surface jump ${index}`);
    knownKeys(jump, new Set(["fromFrame", "toFrame", "faceIndicesBase64", "stateIndicesBase64"]), "INVALID_SURFACE_STATE", `Surface jump ${index}`);
    invariant(Number.isSafeInteger(jump.fromFrame) && jump.fromFrame >= 1 && jump.fromFrame <= packet.frameCount && Number.isSafeInteger(jump.toFrame) && jump.toFrame >= 1 && jump.toFrame <= packet.frameCount && jump.fromFrame !== jump.toFrame, "INVALID_SURFACE_STATE", `Surface jump ${index} frames are invalid.`);
    const pair = `${jump.fromFrame}>${jump.toFrame}`;
    invariant(!jumpPairs.has(pair), "INVALID_SURFACE_STATE", `Surface jump ${pair} is duplicated.`);
    jumpPairs.add(pair);
    const faces = base64Integers(jump.faceIndicesBase64, 2, playbackPacket.leafCount, "INVALID_SURFACE_STATE", `Surface jump ${index} faces`);
    const states = base64Integers(jump.stateIndicesBase64, 2, playbackPacket.leafCount, "INVALID_SURFACE_STATE", `Surface jump ${index} states`);
    invariant(faces.length === states.length && faces.every((face, cursor) => face < surface.faces.length && (cursor === 0 || faces[cursor - 1] < face) && states[cursor] < surface.faces[face].stateCount), "INVALID_SURFACE_STATE", `Surface jump ${index} rows are invalid.`);
    lightingJumps.set(pair, { faces, states });
  }

  const visibility = plainObject(packet.visibility, "INVALID_SURFACE_STATE", "Surface visibility");
  knownKeys(visibility, new Set(["initialFrame", "initialVisibleBitsBase64", "sequential", "nonInteractiveJumps"]), "INVALID_SURFACE_STATE", "Surface visibility");
  invariant(visibility.initialFrame === transitions.initialFrame, "FRAME_CARDINALITY_MISMATCH", "Surface visibility initial frame does not match transitions.");
  const initialBits = base64Integers(visibility.initialVisibleBitsBase64, 1, Math.ceil(playbackPacket.leafCount / 8), "INVALID_SURFACE_STATE", "Surface initial visibility bitset");
  invariant(initialBits.length === Math.ceil(playbackPacket.leafCount / 8), "INVALID_SURFACE_STATE", "Surface initial visibility bitset is truncated.");
  for (let index = playbackPacket.leafCount; index < initialBits.length * 8; index += 1) invariant(((initialBits[index >> 3] >> (index & 7)) & 1) === 0, "INVALID_SURFACE_STATE", "Surface visibility bitset has nonzero unused bits.");
  const visibilitySequential = plainObject(visibility.sequential, "INVALID_SURFACE_STATE", "Surface sequential visibility");
  knownKeys(visibilitySequential, new Set(["offsetsBase64", "faceIndicesBase64"]), "INVALID_SURFACE_STATE", "Surface sequential visibility");
  const visibilityOffsets = base64Integers(visibilitySequential.offsetsBase64, 4, packet.frameCount + 1, "INVALID_SURFACE_STATE", "Surface visibility offsets");
  const visibilityFaces = base64Integers(visibilitySequential.faceIndicesBase64, 2, limits.maxPreparedChanges, "INVALID_SURFACE_STATE", "Surface sequential visibility faces");
  invariant(visibilityOffsets.length === packet.frameCount + 1 && visibilityOffsets[0] === 0 && visibilityOffsets.at(-1) === visibilityFaces.length && visibilityOffsets.every((offset, index) => index === 0 || visibilityOffsets[index - 1] <= offset), "STATE_COLUMN_MISMATCH", "Surface visibility offsets are invalid.");
  for (let frame = 0; frame < packet.frameCount; frame += 1) {
    for (let cursor = visibilityOffsets[frame]; cursor < visibilityOffsets[frame + 1]; cursor += 1) invariant(visibilityFaces[cursor] < playbackPacket.leafCount && (cursor === visibilityOffsets[frame] || visibilityFaces[cursor - 1] < visibilityFaces[cursor]), "INVALID_SURFACE_STATE", `Surface visibility segment ${frame} is invalid.`);
  }
  const visibilityCells = playbackPacket.leafCount * packet.frameCount;
  const visibilityRows = new Uint8Array(visibilityCells);
  for (let index = 0; index < playbackPacket.leafCount; index += 1) visibilityRows[index] = (initialBits[index >> 3] >> (index & 7)) & 1;
  for (let targetFrame = 2; targetFrame <= packet.frameCount; targetFrame += 1) {
    const previousOffset = (targetFrame - 2) * playbackPacket.leafCount;
    const targetOffset = (targetFrame - 1) * playbackPacket.leafCount;
    visibilityRows.copyWithin(targetOffset, previousOffset, previousOffset + playbackPacket.leafCount);
    for (let cursor = visibilityOffsets[targetFrame - 1]; cursor < visibilityOffsets[targetFrame]; cursor += 1) visibilityRows[targetOffset + visibilityFaces[cursor]] ^= 1;
  }
  if (packet.frameCount > 0) {
    const wrapped = visibilityRows.slice((packet.frameCount - 1) * playbackPacket.leafCount);
    for (let cursor = visibilityOffsets[0]; cursor < visibilityOffsets[1]; cursor += 1) wrapped[visibilityFaces[cursor]] ^= 1;
    invariant(wrapped.every((value, index) => value === visibilityRows[index]), "SURFACE_TRANSITION_MISMATCH", "Surface visibility wrap transition does not reproduce frame 1.");
  }
  invariant(Array.isArray(visibility.nonInteractiveJumps) && visibility.nonInteractiveJumps.length <= packet.frameCount, "INVALID_SURFACE_STATE", "Surface visibility jumps are invalid or excessive.");
  const visibilityPairs = new Set();
  const visibilityJumps = new Map();
  for (const [index, jump] of visibility.nonInteractiveJumps.entries()) {
    plainObject(jump, "INVALID_SURFACE_STATE", `Surface visibility jump ${index}`);
    knownKeys(jump, new Set(["fromFrame", "toFrame", "faceIndicesBase64"]), "INVALID_SURFACE_STATE", `Surface visibility jump ${index}`);
    const pair = `${jump.fromFrame}>${jump.toFrame}`;
    invariant(Number.isSafeInteger(jump.fromFrame) && jump.fromFrame >= 1 && jump.fromFrame <= packet.frameCount && Number.isSafeInteger(jump.toFrame) && jump.toFrame >= 1 && jump.toFrame <= packet.frameCount && jump.fromFrame !== jump.toFrame && !visibilityPairs.has(pair), "INVALID_SURFACE_STATE", `Surface visibility jump ${index} frames are invalid or duplicated.`);
    visibilityPairs.add(pair);
    const faces = base64Integers(jump.faceIndicesBase64, 2, playbackPacket.leafCount, "INVALID_SURFACE_STATE", `Surface visibility jump ${index} faces`);
    invariant(faces.every((face, cursor) => face < playbackPacket.leafCount && (cursor === 0 || faces[cursor - 1] < face)), "INVALID_SURFACE_STATE", `Surface visibility jump ${index} faces are invalid.`);
    visibilityJumps.set(pair, faces);
  }
  invariant([...jumpPairs].every((pair) => visibilityPairs.has(pair)) && [...visibilityPairs].every((pair) => jumpPairs.has(pair)), "INVALID_SURFACE_STATE", "Surface lighting and visibility jump pairs differ.");

  const expectedTransition = (fromFrame, toFrame) => {
    const fromOffset = (fromFrame - 1) * playbackPacket.leafCount;
    const toOffset = (toFrame - 1) * playbackPacket.leafCount;
    const changedVisibility = [];
    const changedFaces = [];
    const changedStates = [];
    for (let face = 0; face < playbackPacket.leafCount; face += 1) {
      const fromVisible = visibilityRows[fromOffset + face];
      const toVisible = visibilityRows[toOffset + face];
      if (fromVisible !== toVisible) changedVisibility.push(face);
      const fromState = surfaceStateAt(sourceFramesByFace[face], fromFrame - 1);
      const toState = surfaceStateAt(sourceFramesByFace[face], toFrame - 1);
      if (toVisible === 1 && (fromVisible === 0 || fromState !== toState)) {
        changedFaces.push(face);
        changedStates.push(toState);
      }
    }
    return { changedVisibility, changedFaces, changedStates };
  };
  for (let toFrame = 1; toFrame <= packet.frameCount; toFrame += 1) {
    const fromFrame = toFrame === 1 ? packet.frameCount : toFrame - 1;
    const expected = expectedTransition(fromFrame, toFrame);
    const actualLighting = lightingSegments[toFrame - 1];
    const visibilityStart = visibilityOffsets[toFrame - 1];
    const actualVisibility = visibilityFaces.slice(visibilityStart, visibilityOffsets[toFrame]);
    invariant(sameArray(actualLighting.faces, expected.changedFaces) && sameArray(actualLighting.states, expected.changedStates), "SURFACE_TRANSITION_MISMATCH", `Surface lighting transition ${fromFrame}>${toFrame} is not semantically closed.`);
    invariant(sameArray(actualVisibility, expected.changedVisibility), "SURFACE_TRANSITION_MISMATCH", `Surface visibility transition ${fromFrame}>${toFrame} is not semantically closed.`);
  }
  for (const pair of jumpPairs) {
    const [fromFrame, toFrame] = pair.split(">").map(Number);
    const expected = expectedTransition(fromFrame, toFrame);
    const actualLighting = lightingJumps.get(pair);
    const actualVisibility = visibilityJumps.get(pair);
    invariant(sameArray(actualLighting.faces, expected.changedFaces) && sameArray(actualLighting.states, expected.changedStates), "SURFACE_JUMP_MISMATCH", `Surface lighting jump ${pair} contradicts canonical target state.`);
    invariant(sameArray(actualVisibility, expected.changedVisibility), "SURFACE_JUMP_MISMATCH", `Surface visibility jump ${pair} contradicts canonical target state.`);
  }
  return packet;
}

function validatePresentationContract(presentationState, presentationBinding, bindingInputs) {
  invariant(presentationBinding.status === "executable", "INVALID_PRESENTATION_BINDING", "static-presentation@0 must be executable.");
  exactArray(presentationBinding.inputs, ["viewport.height", "viewport.width"], "INVALID_PRESENTATION_BINDING", "static-presentation@0 inputs are incomplete or noncanonical.");
  const viewportHeight = bindingInputs.get("viewport.height");
  const viewportWidth = bindingInputs.get("viewport.width");
  invariant(viewportHeight?.type === "float" && viewportWidth?.type === "float" && !Object.hasOwn(viewportHeight, "default") && !Object.hasOwn(viewportWidth, "default"), "INVALID_PRESENTATION_BINDING", "Presentation viewport inputs must have type float and no package defaults.");
  const targets = plainObject(presentationBinding.targets, "INVALID_PRESENTATION_BINDING", "Presentation targets");
  knownKeys(targets, new Set(["camera", "cursorLayer", "cursorStates", "host"]), "INVALID_PRESENTATION_BINDING", "Presentation targets");
  invariant(targets.host === "$host", "INVALID_PRESENTATION_BINDING", "Presentation host target must be $host.");
  stableId(targets.camera, "Presentation camera target");
  const hasCursorLayer = Object.hasOwn(targets, "cursorLayer");
  const hasCursorStates = Object.hasOwn(targets, "cursorStates");
  invariant(hasCursorLayer === hasCursorStates, "INVALID_PRESENTATION_BINDING", "Presentation cursor layer and states must appear together.");
  if (hasCursorLayer) {
    stableId(targets.cursorLayer, "Presentation cursor layer target");
    const cursorStates = plainObject(targets.cursorStates, "INVALID_PRESENTATION_BINDING", "Presentation cursor states");
    knownKeys(cursorStates, new Set(["open", "closed"]), "INVALID_PRESENTATION_BINDING", "Presentation cursor states");
    invariant(Object.hasOwn(cursorStates, "open") && Object.hasOwn(cursorStates, "closed"), "INVALID_PRESENTATION_BINDING", "Presentation cursor states are incomplete.");
    stableId(cursorStates.open, "Presentation open cursor target");
    stableId(cursorStates.closed, "Presentation closed cursor target");
    invariant(cursorStates.open !== cursorStates.closed, "INVALID_PRESENTATION_BINDING", "Presentation cursor states must be distinct.");
  }
  const parameters = plainObject(presentationBinding.parameters, "INVALID_PRESENTATION_BINDING", "Presentation parameters");
  knownKeys(parameters, new Set(["fitHeight", "fitWidth", "sourceHeight", "sourceWidth"]), "INVALID_PRESENTATION_BINDING", "Presentation parameters");
  invariant(["fitHeight", "fitWidth", "sourceHeight", "sourceWidth"].every((key) => Number.isSafeInteger(parameters[key]) && parameters[key] > 0), "INVALID_PRESENTATION_BINDING", "Presentation dimensions are invalid.");

  const data = plainObject(presentationState.data, "INVALID_PRESENTATION_STATE", "Presentation state data");
  knownKeys(data, new Set(["packet"]), "INVALID_PRESENTATION_STATE", "Presentation state data");
  const packet = plainObject(data.packet, "INVALID_PRESENTATION_STATE", "Presentation packet");
  knownKeys(packet, new Set(["version", "camera", "background"]), "INVALID_PRESENTATION_STATE", "Presentation packet");
  invariant(packet.version === 0, "INVALID_PRESENTATION_STATE", "Presentation packet version must be 0.");
  const camera = plainObject(packet.camera, "INVALID_PRESENTATION_STATE", "Presentation camera");
  knownKeys(camera, new Set(["baseSceneTransform", "fitHeight", "fitWidth", "perspective", "sourceHeight", "sourceWidth"]), "INVALID_PRESENTATION_STATE", "Presentation camera");
  safeStyleValue(camera.baseSceneTransform, "Presentation base scene transform");
  invariant(typeof camera.perspective === "number" && Number.isFinite(camera.perspective) && camera.perspective > 0 && ["fitHeight", "fitWidth", "sourceHeight", "sourceWidth"].every((key) => camera[key] === parameters[key]), "INVALID_PRESENTATION_STATE", "Presentation camera values do not match binding parameters.");
  if (Object.hasOwn(packet, "background")) {
    const background = plainObject(packet.background, "INVALID_PRESENTATION_STATE", "Presentation background");
    knownKeys(background, new Set(["resource", "opacity", "position", "repeat", "size"]), "INVALID_PRESENTATION_STATE", "Presentation background");
    invariant(["resource", "opacity", "position", "repeat", "size"].every((key) => Object.hasOwn(background, key)), "INVALID_PRESENTATION_STATE", "Presentation background is incomplete.");
    assertResourceId(background.resource, "Presentation background resource");
    invariant(typeof background.opacity === "number" && Number.isFinite(background.opacity) && background.opacity >= 0 && background.opacity <= 1, "INVALID_PRESENTATION_STATE", "Presentation background opacity is invalid.");
    for (const key of ["position", "repeat", "size"]) safeStyleValue(background[key], `Presentation background ${key}`);
  }
  const expectedSinks = [
    ...(packet.background ? ["host.style.backgroundColor", "host.style.backgroundImage", "host.style.backgroundPosition", "host.style.backgroundRepeat", "host.style.backgroundSize"] : []),
    "style.height",
    "style.left",
    "style.top",
    "style.transform",
    ...(hasCursorLayer ? ["style.visibility"] : []),
    "style.width",
  ];
  exactArray(presentationBinding.sinks, expectedSinks, "INVALID_PRESENTATION_BINDING", "static-presentation@0 sinks are incomplete or noncanonical.");
  return packet;
}

function validateInitialSurfaceClosure(packet, playbackBinding, tree) {
  const packed = Uint8Array.from(globalThis.atob(packet.visibility.initialVisibleBitsBase64), (character) => character.charCodeAt(0));
  const targetFrame = packet.transitions.initialFrame - 1;
  for (const [index, target] of playbackBinding.targets.leaves.entries()) {
    const node = tree.nodesById.get(target);
    const expectedVisibility = ((packed[index >> 3] >> (index & 7)) & 1) === 1 ? "visible" : "hidden";
    invariant(node?.styles?.visibility === expectedVisibility, "SURFACE_TREE_MISMATCH", `Surface leaf ${index} initial visibility does not match TREE.`);
    const face = packet.surface.faces[index];
    let sourceFrame = 0;
    let selectedFrame = 0;
    for (let local = 0; local < face.stateCount; local += 1) {
      sourceFrame += packet.surface.statePacking.sourceFrameDeltas[face.stateOffset + local];
      if (sourceFrame > targetFrame) break;
      selectedFrame = sourceFrame;
    }
    const expectedPosition = selectedFrame === 0 ? "0" : `${-selectedFrame * face.leafHeight}px`;
    const actualPosition = node.styles.backgroundPositionY;
    const matchesInitialCssPosition = selectedFrame === 0
      ? actualPosition === undefined || actualPosition === "0" || actualPosition === "0px" || actualPosition === "0%"
      : actualPosition === expectedPosition;
    invariant(matchesInitialCssPosition, "SURFACE_TREE_MISMATCH", `Surface leaf ${index} initial atlas position does not match TREE.`);
  }
}

function validatePolycssChannelInvariants(stateChannels, bindingChannels, bindingInputs, tree, limits) {
  const playbackState = [...stateChannels.values()].find((channel) => channel.codec === "polycss-playback-packed@0");
  const surfaceState = [...stateChannels.values()].find((channel) => channel.codec === "polycss-surface-packed@0");
  const playbackBinding = [...bindingChannels.values()].find((channel) => channel.interpreter === "polycss-playback@0");
  const surfaceBinding = [...bindingChannels.values()].find((channel) => channel.interpreter === "polycss-surface@0");
  invariant(Boolean(playbackState) === Boolean(playbackBinding), "MISSING_POLYCSS_CHANNEL", "Playback state and binding must appear together.");
  invariant(Boolean(surfaceState) === Boolean(surfaceBinding), "MISSING_POLYCSS_CHANNEL", "Surface state and binding must appear together.");
  let playbackPacket;
  if (playbackBinding) playbackPacket = validatePlaybackContract(playbackState, playbackBinding, bindingInputs, limits);
  if (surfaceBinding) {
    invariant(playbackPacket, "MISSING_POLYCSS_CHANNEL", "Prepared surface requires executable playback.");
    const surfacePacket = validateSurfaceContract(surfaceState, surfaceBinding, playbackPacket, playbackBinding, bindingInputs, limits);
    validateInitialSurfaceClosure(surfacePacket, playbackBinding, tree);
  }
  if (playbackPacket?.leafCount > 0) invariant(surfaceBinding, "MISSING_POLYCSS_CHANNEL", "Playback with leaf targets requires prepared surface state and binding.");

  const presentationState = [...stateChannels.values()].find((channel) => channel.codec === "static-presentation@0");
  const presentationBinding = [...bindingChannels.values()].find((channel) => channel.interpreter === "static-presentation@0");
  if (presentationState || presentationBinding) {
    invariant(presentationState && presentationBinding, "MISSING_POLYCSS_CHANNEL", "Presentation state and binding must appear together.");
    validatePresentationContract(presentationState, presentationBinding, bindingInputs);
  }

  const effectsState = [...stateChannels.values()].find((channel) => channel.codec === "polycss-effects-prepared@0");
  const effectsBinding = [...bindingChannels.values()].find((channel) => channel.interpreter === "polycss-effects@0");
  if (effectsState || effectsBinding) {
    invariant(effectsState && effectsBinding, "MISSING_POLYCSS_CHANNEL", "Prepared effects state and binding must appear together.");
    invariant(playbackBinding, "MISSING_POLYCSS_CHANNEL", "Prepared effects require executable playback.");
    const data = plainObject(effectsState.data, "INVALID_EFFECTS_STATE", "Prepared effects state data");
    knownKeys(data, new Set(["packet"]), "INVALID_EFFECTS_STATE", "Prepared effects state data");
    const packet = plainObject(data.packet, "INVALID_EFFECTS_STATE", "Prepared effects packet");
    knownKeys(packet, new Set(["version", "arithmetic", "frameCount", "biases", "particle", "spawnStream", "stars", "emitters"]), "INVALID_EFFECTS_STATE", "Prepared effects packet");
    invariant(packet.version === 0, "INVALID_EFFECTS_STATE", "Prepared effects packet version must be 0.");
    invariant(packet.arithmetic === "ieee754-f32-per-operation", "INVALID_EFFECTS_STATE", "Prepared effects arithmetic is unsupported.");
    invariant(Number.isSafeInteger(packet.frameCount) && packet.frameCount > 0 && packet.frameCount <= limits.maxFrames, "EFFECT_STATE_LIMIT", "Prepared effects frameCount is invalid or excessive.");
    const parameters = plainObject(effectsBinding.parameters, "INVALID_EFFECTS_BINDING", "Prepared effects binding parameters");
    knownKeys(parameters, new Set(["frameCount"]), "INVALID_EFFECTS_BINDING", "Prepared effects binding parameters");
    invariant(parameters.frameCount === packet.frameCount, "FRAME_CARDINALITY_MISMATCH", "Effect binding frameCount does not match its packet.");
    invariant(playbackBinding.parameters?.frameCount === packet.frameCount, "FRAME_CARDINALITY_MISMATCH", "Effect and playback frame counts do not match.");
    invariant(effectsBinding.status === "executable", "INVALID_EFFECTS_BINDING", "polycss-effects@0 must be executable.");
    const expectedInputs = ["interaction.grab-active", "interaction.grab-x", "interaction.grab-y", "interaction.grab-z", "time.source-frame"];
    invariant(JSON.stringify(effectsBinding.inputs) === JSON.stringify(expectedInputs), "INVALID_EFFECTS_BINDING", "polycss-effects@0 inputs are incomplete or noncanonical.");
    const expectedDefinitions = [
      ["interaction.grab-active", "boolean", false],
      ["interaction.grab-x", "float", 0],
      ["interaction.grab-y", "float", 0],
      ["interaction.grab-z", "float", 0],
      ["time.source-frame", "uint", undefined],
    ];
    for (const [id, type, defaultValue] of expectedDefinitions) {
      const definition = bindingInputs.get(id);
      invariant(definition?.type === type, "INVALID_EFFECTS_BINDING", `Effect input ${id} must have type ${type}.`);
      if (defaultValue !== undefined) invariant(definition.default === defaultValue, "INVALID_EFFECTS_BINDING", `Effect input ${id} must declare default ${defaultValue}.`);
      else invariant(!Object.hasOwn(definition, "default"), "INVALID_EFFECTS_BINDING", `Effect input ${id} must not declare a package default.`);
    }
    invariant(
      JSON.stringify(effectsBinding.sinks) === JSON.stringify(["style.backgroundPosition", "style.opacity", "style.transform", "style.visibility"]),
      "INVALID_EFFECTS_BINDING",
      "polycss-effects@0 sinks are incomplete or noncanonical.",
    );
    const biases = plainObject(packet.biases, "INVALID_EFFECTS_STATE", "Prepared effects biases");
    knownKeys(biases, new Set(["continuous", "grab"]), "INVALID_EFFECTS_STATE", "Prepared effects biases");
    finiteF32Array(biases.continuous, 3, "Continuous effect bias");
    finiteF32Array(biases.grab, 3, "Grab effect bias");
    const particle = plainObject(packet.particle, "INVALID_EFFECTS_STATE", "Prepared particle contract");
    knownKeys(particle, new Set(["damping", "gravityY", "sparkleFrameTable"]), "INVALID_EFFECTS_STATE", "Prepared particle contract");
    invariant(finiteF32(particle.damping) && particle.damping >= 0 && particle.damping <= 1, "INVALID_EFFECTS_STATE", "Particle damping must be finite and between zero and one.");
    invariant(finiteF32(particle.gravityY), "INVALID_EFFECTS_STATE", "Particle gravity must be a finite f32 value.");
    invariant(Array.isArray(particle.sparkleFrameTable) && particle.sparkleFrameTable.length > 0 && particle.sparkleFrameTable.length <= 256 && particle.sparkleFrameTable.every((value) => Number.isSafeInteger(value) && value >= 0), "INVALID_EFFECTS_STATE", "Particle sparkle frame table is invalid.");
    const spawnStream = plainObject(packet.spawnStream, "INVALID_EFFECTS_STATE", "Prepared effect spawn stream");
    knownKeys(spawnStream, new Set(["count", "tuples"]), "INVALID_EFFECTS_STATE", "Prepared effect spawn stream");
    invariant(Number.isSafeInteger(spawnStream.count) && spawnStream.count > 0 && spawnStream.count <= limits.maxEffectSpawnTuples && Array.isArray(spawnStream.tuples) && spawnStream.tuples.length === spawnStream.count, "EFFECT_STATE_LIMIT", "Prepared effect spawn stream is invalid or excessive.");
    for (const [index, tuple] of spawnStream.tuples.entries()) {
      finiteF32Array(tuple, 4, `Effect spawn tuple ${index}`);
      invariant(tuple[0] > 0 && Math.trunc(tuple[0]) <= particle.sparkleFrameTable.length, "INVALID_EFFECTS_STATE", `Effect spawn tuple ${index} timeout exceeds the sparkle frame table.`);
      for (const bias of [biases.continuous, biases.grab]) {
        invariant([0, 1, 2].every((component) => finiteF32Result(tuple[component + 1] + bias[component])), "INVALID_EFFECTS_STATE", `Effect spawn tuple ${index} overflows when combined with a declared bias.`);
      }
    }
    invariant(Array.isArray(packet.stars) && packet.stars.length <= limits.maxNodes, "EFFECT_STATE_LIMIT", "Prepared effect stars are invalid or excessive.");
    invariant(Array.isArray(packet.emitters) && packet.emitters.length > 0 && packet.emitters.length <= limits.maxNodes, "EFFECT_STATE_LIMIT", "Prepared effect emitters are invalid or excessive.");
    plainObject(effectsBinding.targets, "INVALID_EFFECTS_BINDING", "Prepared effects targets");
    knownKeys(effectsBinding.targets, new Set(["stars", "emitters"]), "INVALID_EFFECTS_BINDING", "Prepared effects targets");
    uniqueTargets(effectsBinding.targets.stars, "Effect star");
    invariant(packet.stars.length === effectsBinding.targets.stars.length, "TARGET_CARDINALITY_MISMATCH", "Effect star targets do not match state.");
    invariant(Array.isArray(effectsBinding.targets.emitters) && packet.emitters.length === effectsBinding.targets.emitters.length, "TARGET_CARDINALITY_MISMATCH", "Effect emitter targets do not match state.");
    let totalParticles = 0;
    for (let index = 0; index < packet.emitters.length; index += 1) {
      const emitter = plainObject(packet.emitters[index], "INVALID_EFFECTS_STATE", `Effect emitter ${index}`);
      knownKeys(emitter, new Set(["mode", "sourceStar", "poolSize", "backgroundPositions"]), "INVALID_EFFECTS_STATE", `Effect emitter ${index}`);
      invariant(emitter.mode === "grab" || emitter.mode === "follow-star", "INVALID_EFFECTS_STATE", `Effect emitter ${index} mode is unsupported.`);
      if (emitter.mode === "grab") invariant(!Object.hasOwn(emitter, "sourceStar"), "INVALID_EFFECTS_STATE", `Grab emitter ${index} must not declare sourceStar.`);
      else invariant(Number.isSafeInteger(emitter.sourceStar) && emitter.sourceStar >= 0 && emitter.sourceStar < packet.stars.length, "INVALID_EFFECTS_STATE", `Follow-star emitter ${index} has an invalid sourceStar.`);
      invariant(Number.isSafeInteger(emitter.poolSize) && emitter.poolSize > 0, "INVALID_EFFECTS_STATE", `Effect emitter ${index} poolSize is invalid.`);
      totalParticles += emitter.poolSize;
      invariant(totalParticles <= limits.maxEffectParticles, "EFFECT_PARTICLE_LIMIT", `Prepared effects exceed ${limits.maxEffectParticles} particles.`);
      invariant(Array.isArray(emitter.backgroundPositions) && emitter.backgroundPositions.length > 0 && emitter.backgroundPositions.length <= 256 && emitter.backgroundPositions.every((value) => {
        safeStyleValue(value, `Effect emitter ${index} background position`);
        return true;
      }), "INVALID_EFFECTS_STATE", `Effect emitter ${index} background positions are invalid.`);
      invariant(particle.sparkleFrameTable.every((frame) => frame < emitter.backgroundPositions.length), "INVALID_EFFECTS_STATE", `Effect emitter ${index} lacks a referenced sparkle frame.`);
      uniqueTargets(effectsBinding.targets.emitters[index], `Effect emitter ${index}`);
      invariant(effectsBinding.targets.emitters[index].length === emitter.poolSize, "TARGET_CARDINALITY_MISMATCH", `Effect emitter ${index} pool targets do not match state.`);
    }
    for (const [index, star] of packet.stars.entries()) {
      plainObject(star, "INVALID_EFFECTS_STATE", `Effect star ${index}`);
      knownKeys(star, new Set(["positions", "transforms", "frameIndices", "backgroundPositions"]), "INVALID_EFFECTS_STATE", `Effect star ${index}`);
      finiteF32Array(star.positions, packet.frameCount * 3, `Effect star ${index} positions`);
      invariant(Array.isArray(star.transforms) && star.transforms.length === packet.frameCount, "FRAME_CARDINALITY_MISMATCH", `Effect star ${index} transforms do not match frameCount.`);
      for (const transform of star.transforms) safeStyleValue(transform, `Effect star ${index} transform`);
      invariant(Array.isArray(star.backgroundPositions) && star.backgroundPositions.length > 0 && star.backgroundPositions.length <= limits.maxFrames, "INVALID_EFFECTS_STATE", `Effect star ${index} background positions are missing or excessive.`);
      for (const position of star.backgroundPositions) safeStyleValue(position, `Effect star ${index} background position`);
      invariant(Array.isArray(star.frameIndices) && star.frameIndices.length === packet.frameCount && star.frameIndices.every((frame) => Number.isSafeInteger(frame) && frame >= 0 && frame < star.backgroundPositions.length), "FRAME_CARDINALITY_MISMATCH", `Effect star ${index} frame indices are invalid.`);
    }
    let maximumLifetime = 0;
    const continuousVelocity = [0, 0, 0];
    for (const tuple of spawnStream.tuples) {
      maximumLifetime = Math.max(maximumLifetime, Math.trunc(tuple[0]));
      for (const component of [0, 1, 2]) continuousVelocity[component] = Math.max(continuousVelocity[component], Math.abs(Math.fround(tuple[component + 1] + biases.continuous[component])));
    }
    const continuousStart = [0, 0, 0];
    for (const star of packet.stars) {
      for (let index = 0; index < star.positions.length; index += 1) {
        const component = index % 3;
        continuousStart[component] = Math.max(continuousStart[component], Math.abs(star.positions[index]));
      }
    }
    for (const component of [0, 1, 2]) {
      const gravity = component === 1 ? Math.abs(particle.gravityY) * maximumLifetime * (maximumLifetime + 1) / 2 : 0;
      const bound = continuousStart[component] + continuousVelocity[component] * maximumLifetime + gravity;
      invariant(finiteF32Result(bound), "INVALID_EFFECTS_STATE", `Prepared continuous effect component ${component} can overflow within a particle lifetime.`);
    }
  }

  const interactionState = [...stateChannels.values()].find((channel) => channel.codec === "polycss-pointer-grab-prepared@0");
  const interactionBinding = [...bindingChannels.values()].find((channel) => channel.interpreter === "polycss-pointer-grab@0");
  if (interactionState || interactionBinding) {
    invariant(interactionState && interactionBinding, "MISSING_POLYCSS_CHANNEL", "Prepared interaction state and binding must appear together.");
    invariant(playbackBinding && presentationBinding && effectsBinding, "MISSING_POLYCSS_CHANNEL", "Prepared pointer interaction requires playback, presentation, and effects.");
    invariant(interactionBinding.status === "executable", "INVALID_INTERACTION_BINDING", "polycss-pointer-grab@0 must be executable.");
    const expectedInputs = ["axis.x", "axis.y", "button.hold", "pointer.positioned", "pointer.pressed", "pointer.x", "pointer.y"];
    invariant(JSON.stringify(interactionBinding.inputs) === JSON.stringify(expectedInputs), "INVALID_INTERACTION_BINDING", "polycss-pointer-grab@0 inputs are incomplete or noncanonical.");
    const expectedDefinitions = [
      ["axis.x", "float", 0],
      ["axis.y", "float", 0],
      ["button.hold", "boolean", false],
      ["pointer.positioned", "boolean", false],
      ["pointer.pressed", "boolean", false],
    ];
    for (const [id, type, defaultValue] of expectedDefinitions) {
      const definition = bindingInputs.get(id);
      invariant(definition?.type === type && definition.default === defaultValue, "INVALID_INTERACTION_BINDING", `Interaction input ${id} must declare type ${type} and default ${defaultValue}.`);
    }
    invariant(JSON.stringify(interactionBinding.sinks) === JSON.stringify(["style.transform", "style.visibility"]), "INVALID_INTERACTION_BINDING", "polycss-pointer-grab@0 sinks are incomplete or noncanonical.");
    const targets = plainObject(interactionBinding.targets, "INVALID_INTERACTION_BINDING", "Prepared interaction targets");
    knownKeys(targets, new Set(["shapes", "leaves", "cursorLayer", "cursorStates"]), "INVALID_INTERACTION_BINDING", "Prepared interaction targets");
    uniqueTargets(interactionBinding.targets.shapes, "Interaction shape");
    uniqueTargets(interactionBinding.targets.leaves, "Interaction leaf");
    if (playbackBinding) invariant(sameArray(interactionBinding.targets.shapes, playbackBinding.targets.shapes) && sameArray(interactionBinding.targets.leaves, playbackBinding.targets.leaves), "INTERACTION_TARGET_MISMATCH", "Interaction shape and leaf targets must exactly match playback target order.");
    stableId(interactionBinding.targets.cursorLayer, "Interaction cursor layer");
    const cursorStates = plainObject(interactionBinding.targets.cursorStates, "INVALID_INTERACTION_BINDING", "Interaction cursor states");
    knownKeys(cursorStates, new Set(["open", "closed"]), "INVALID_INTERACTION_BINDING", "Interaction cursor states");
    stableId(cursorStates.open, "Interaction open cursor target");
    stableId(cursorStates.closed, "Interaction closed cursor target");
    invariant(cursorStates.open !== cursorStates.closed, "INVALID_INTERACTION_BINDING", "Interaction cursor state targets must be distinct.");
    const parameters = plainObject(interactionBinding.parameters, "INVALID_INTERACTION_BINDING", "Prepared interaction parameters");
    knownKeys(parameters, new Set(["initialFrame", "tickRateHz"]), "INVALID_INTERACTION_BINDING", "Prepared interaction parameters");
    invariant(parameters.tickRateHz === 30, "INVALID_INTERACTION_BINDING", "polycss-pointer-grab@0 tickRateHz must be 30.");
    invariant(parameters.tickRateHz === playbackBinding.parameters.tickRateHz, "INVALID_INTERACTION_BINDING", "Interaction and playback tick rates must match.");

    const data = plainObject(interactionState.data, "INVALID_INTERACTION_STATE", "Prepared interaction state data");
    knownKeys(data, new Set(["packet"]), "INVALID_INTERACTION_STATE", "Prepared interaction state data");
    const packet = plainObject(data.packet, "INVALID_INTERACTION_STATE", "Prepared interaction packet");
    knownKeys(packet, new Set(["version", "arithmetic", "input", "animator", "source", "triangle", "objects", "shapes", "leaves", "controls"]), "INVALID_INTERACTION_STATE", "Prepared interaction packet");
    invariant(packet.version === 0 && packet.arithmetic === "ieee754-f32-per-operation", "INVALID_INTERACTION_STATE", "Prepared interaction version or arithmetic is unsupported.");

    const input = plainObject(packet.input, "INVALID_INTERACTION_STATE", "Prepared interaction input contract");
    knownKeys(input, new Set(["sourceWidth", "sourceHeight", "cursorBounds", "cursorInitial", "pointerQuantization", "stickRange", "stickDeadzone", "stickScale", "grabButton", "holdButton", "hitRadius", "cursorVisibleTicks", "mirrorX"]), "INVALID_INTERACTION_STATE", "Prepared interaction input contract");
    invariant(Number.isSafeInteger(input.sourceWidth) && input.sourceWidth > 0 && Number.isSafeInteger(input.sourceHeight) && input.sourceHeight > 0, "INVALID_INTERACTION_STATE", "Interaction source viewport is invalid.");
    if (presentationBinding) invariant(input.sourceWidth === presentationBinding.parameters.sourceWidth && input.sourceHeight === presentationBinding.parameters.sourceHeight, "INTERACTION_VIEWPORT_MISMATCH", "Interaction source viewport must match static presentation.");
    const pointerDefaults = [["pointer.x", input.sourceWidth / 2], ["pointer.y", input.sourceHeight / 2]];
    for (const [id, defaultValue] of pointerDefaults) {
      const definition = bindingInputs.get(id);
      invariant(definition?.type === "float" && definition.default === defaultValue, "INVALID_INTERACTION_BINDING", `Interaction input ${id} must declare the source-centre default ${defaultValue}.`);
    }
    interactionF32Array(input.cursorBounds, 4, "Interaction cursor bounds");
    invariant(input.cursorBounds[0] <= input.cursorBounds[1] && input.cursorBounds[2] <= input.cursorBounds[3], "INVALID_INTERACTION_STATE", "Interaction cursor bounds are unordered.");
    interactionF32Array(input.cursorInitial, 2, "Interaction initial cursor");
    invariant(input.cursorInitial[0] === pointerDefaults[0][1] && input.cursorInitial[1] === pointerDefaults[1][1], "INTERACTION_VIEWPORT_MISMATCH", "Interaction initial cursor must equal the declared source-centre pointer defaults.");
    invariant(input.cursorInitial[0] >= input.cursorBounds[0] && input.cursorInitial[0] <= input.cursorBounds[1]
      && input.cursorInitial[1] >= input.cursorBounds[2] && input.cursorInitial[1] <= input.cursorBounds[3], "INVALID_INTERACTION_STATE", "Interaction initial cursor is outside its bounds.");
    invariant(input.pointerQuantization === "trunc-toward-zero-then-clamp", "INVALID_INTERACTION_STATE", "Interaction pointer quantization is unsupported.");
    interactionF32Array(input.stickRange, 2, "Interaction stick range");
    invariant(input.stickRange[0] < 0 && input.stickRange[1] > 0 && input.stickRange[0] < input.stickRange[1], "INVALID_INTERACTION_STATE", "Interaction stick range is invalid.");
    invariant(finiteF32(input.stickDeadzone) && input.stickDeadzone >= 0 && finiteF32(input.stickScale) && input.stickScale > 0, "INVALID_INTERACTION_STATE", "Interaction stick scaling is invalid.");
    invariant(Number.isSafeInteger(input.grabButton) && input.grabButton > 0 && input.grabButton <= 0xffff
      && Number.isSafeInteger(input.holdButton) && input.holdButton > 0 && input.holdButton <= 0xffff
      && (input.grabButton & input.holdButton) === 0, "INVALID_INTERACTION_STATE", "Interaction button masks are invalid.");
    invariant(finiteF32(input.hitRadius) && input.hitRadius > 0 && Number.isSafeInteger(input.cursorVisibleTicks) && input.cursorVisibleTicks > 0 && finiteF32(input.mirrorX), "INVALID_INTERACTION_STATE", "Interaction picking or cursor timing is invalid.");

    const animator = plainObject(packet.animator, "INVALID_INTERACTION_STATE", "Prepared interaction animator");
    const animatorKeys = ["initialState", "initialFrame", "introState", "dozeState", "sleepState", "wakeState", "convergeState", "exitEyeState", "eyeState", "dozeLoopCount", "dozeLoopStartFrame", "dozeLoopEndFrame", "sleepEndFrame", "wakeStartFrame", "eyeFrame", "convergeStillTicks", "eyeStillTicks"];
    knownKeys(animator, new Set(animatorKeys), "INVALID_INTERACTION_STATE", "Prepared interaction animator");
    invariant(animatorKeys.every((key) => Number.isSafeInteger(animator[key]) && animator[key] >= 0), "INVALID_INTERACTION_STATE", "Prepared interaction animator contains invalid integers.");
    const stateIds = [animator.introState, animator.dozeState, animator.sleepState, animator.wakeState, animator.convergeState, animator.exitEyeState, animator.eyeState];
    invariant(new Set(stateIds).size === stateIds.length && stateIds.includes(animator.initialState), "INVALID_INTERACTION_STATE", "Prepared interaction animator states are invalid.");
    const playbackFrameCount = playbackBinding?.parameters.frameCount ?? limits.maxFrames;
    invariant(animator.initialState === animator.eyeState && animator.initialFrame === animator.eyeFrame && animator.initialFrame > 0 && animator.initialFrame <= playbackFrameCount, "INVALID_INTERACTION_STATE", "Prepared interaction initial animator state is inconsistent.");
    invariant(animator.dozeLoopCount > 0 && animator.dozeLoopStartFrame > 0 && animator.dozeLoopStartFrame < animator.dozeLoopEndFrame && animator.dozeLoopEndFrame <= playbackFrameCount
      && animator.sleepEndFrame > 0 && animator.sleepEndFrame <= playbackFrameCount && animator.wakeStartFrame > 0 && animator.wakeStartFrame <= playbackFrameCount
      && animator.convergeStillTicks > 0 && animator.eyeStillTicks > 0, "INVALID_INTERACTION_STATE", "Prepared interaction animator timing is invalid.");
    invariant(parameters.initialFrame === animator.initialFrame, "INVALID_INTERACTION_BINDING", "Interaction binding initialFrame does not match its animator.");

    const source = plainObject(packet.source, "INVALID_INTERACTION_STATE", "Prepared interaction source contract");
    knownKeys(source, new Set(["cameraViewMatrix", "cameraWorldPosition", "inverseCameraMatrix", "projection", "displacementMagnitude", "eyeGain", "eyeMaximumOffset", "spring"]), "INVALID_INTERACTION_STATE", "Prepared interaction source contract");
    interactionF32Array(source.cameraViewMatrix, 16, "Interaction camera view matrix");
    interactionF32Array(source.inverseCameraMatrix, 16, "Interaction inverse camera matrix");
    invariant(inverseMatrixPair(source.cameraViewMatrix, source.inverseCameraMatrix), "INVALID_INTERACTION_STATE", "Interaction camera view and inverse matrices are not a finite inverse pair.");
    interactionF32Array(source.cameraWorldPosition, 3, "Interaction camera world position");
    const projection = plainObject(source.projection, "INVALID_INTERACTION_STATE", "Interaction projection");
    knownKeys(projection, new Set(["scale", "origin"]), "INVALID_INTERACTION_STATE", "Interaction projection");
    invariant(finiteF32(projection.scale) && projection.scale > 0, "INVALID_INTERACTION_STATE", "Interaction projection scale is invalid.");
    interactionF32Array(projection.origin, 2, "Interaction projection origin");
    invariant(finiteF32(source.displacementMagnitude) && source.displacementMagnitude > 0
      && finiteF32(source.eyeGain) && source.eyeGain > 0
      && finiteF32(source.eyeMaximumOffset) && source.eyeMaximumOffset >= 0, "INVALID_INTERACTION_STATE", "Interaction displacement or eye-follow values are invalid.");
    const spring = plainObject(source.spring, "INVALID_INTERACTION_STATE", "Prepared interaction spring");
    knownKeys(spring, new Set(["cursorResistance", "grabbedFlag", "pickedResistance", "releaseAcceleration", "snapOffsetL1", "snapVelocityL1", "velocityDecay"]), "INVALID_INTERACTION_STATE", "Prepared interaction spring");
    for (const key of ["cursorResistance", "pickedResistance", "releaseAcceleration", "snapOffsetL1", "snapVelocityL1", "velocityDecay"]) invariant(finiteF32(spring[key]), "INVALID_INTERACTION_STATE", `Interaction spring ${key} is invalid.`);
    invariant(spring.cursorResistance >= 0 && spring.cursorResistance <= 1
      && spring.pickedResistance >= -1 && spring.pickedResistance < 0
      && spring.releaseAcceleration > 0 && spring.releaseAcceleration <= 1
      && spring.velocityDecay > 0 && spring.velocityDecay < 1
      && spring.snapOffsetL1 >= 0 && spring.snapVelocityL1 >= 0
      && Number.isSafeInteger(spring.grabbedFlag) && spring.grabbedFlag > 0, "INVALID_INTERACTION_STATE", "Prepared interaction spring constraints are invalid.");
    const grabDisplacementBounds = interactionGrabDisplacementBounds(input, source);
    invariant(grabDisplacementBounds, "INVALID_INTERACTION_STATE", "Declared cursor displacement overflows interaction binary32 arithmetic.");
    const selectedGrabOffsetBounds = grabDisplacementBounds.map((bound) => interactionOperationF32(bound / -spring.pickedResistance));
    invariant(selectedGrabOffsetBounds.every(Number.isFinite), "INVALID_INTERACTION_STATE", "Declared selected-grab envelope overflows interaction binary32 arithmetic.");

    const triangle = plainObject(packet.triangle, "INVALID_INTERACTION_STATE", "Prepared interaction triangle kernel");
    knownKeys(triangle, new Set(["basisEpsilon", "primitive", "fallbackAmount", "sharedEdgeAmount"]), "INVALID_INTERACTION_STATE", "Prepared interaction triangle kernel");
    invariant(triangle.basisEpsilon === 1e-9 && triangle.primitive === "corner-bevel"
      && finiteF32(triangle.fallbackAmount) && triangle.fallbackAmount >= 0
      && finiteF32(triangle.sharedEdgeAmount) && triangle.sharedEdgeAmount >= 0, "INVALID_INTERACTION_STATE", "Prepared interaction triangle kernel is unsupported.");

    const objects = plainObject(packet.objects, "INVALID_INTERACTION_STATE", "Prepared interaction objects");
    knownKeys(objects, new Set(["rotationMatrices"]), "INVALID_INTERACTION_STATE", "Prepared interaction objects");
    invariant(Array.isArray(objects.rotationMatrices) && objects.rotationMatrices.length % 16 === 0
      && objects.rotationMatrices.length / 16 <= limits.maxInteractionObjects && objects.rotationMatrices.every(finiteF32), "INTERACTION_STATE_LIMIT", "Prepared interaction object matrices are invalid or excessive.");
    const objectCount = objects.rotationMatrices.length / 16;
    const shapes = plainObject(packet.shapes, "INVALID_INTERACTION_STATE", "Prepared interaction shapes");
    knownKeys(shapes, new Set(["baseMatrices"]), "INVALID_INTERACTION_STATE", "Prepared interaction shapes");
    invariant(Array.isArray(shapes.baseMatrices) && shapes.baseMatrices.length === interactionBinding.targets.shapes.length * 16 && shapes.baseMatrices.every(finiteF32), "TARGET_CARDINALITY_MISMATCH", "Interaction shape matrices do not match shape targets.");
    invariant(Array.isArray(packet.leaves) && packet.leaves.length === interactionBinding.targets.leaves.length && packet.leaves.length <= limits.maxNodes, "TARGET_CARDINALITY_MISMATCH", "Interaction leaf plans do not match leaf targets.");
    for (const [index, leaf] of packet.leaves.entries()) {
      plainObject(leaf, "INVALID_INTERACTION_STATE", `Interaction leaf plan ${index}`);
      knownKeys(leaf, new Set(["basis", "canonicalSize", "matrixDecimals", "seamEdgeMask", "width", "height"]), "INVALID_INTERACTION_STATE", `Interaction leaf plan ${index}`);
      invariant(Array.isArray(leaf.basis) && leaf.basis.length === 3 && [[0, 1, 2], [1, 2, 0], [2, 0, 1]].some((basis) => basis.every((entry, basisIndex) => leaf.basis[basisIndex] === entry)), "INVALID_INTERACTION_STATE", `Interaction leaf plan ${index} basis is invalid.`);
      invariant(Number.isSafeInteger(leaf.canonicalSize) && leaf.canonicalSize > 0
        && Number.isSafeInteger(leaf.matrixDecimals) && leaf.matrixDecimals >= 0 && leaf.matrixDecimals <= 6
        && Number.isSafeInteger(leaf.seamEdgeMask) && leaf.seamEdgeMask >= 0 && leaf.seamEdgeMask <= 7
        && Number.isSafeInteger(leaf.width) && leaf.width > 0
        && Number.isSafeInteger(leaf.height) && leaf.height > 0, "INVALID_INTERACTION_STATE", `Interaction leaf plan ${index} dimensions or update settings are invalid.`);
    }

    invariant(Array.isArray(packet.controls) && packet.controls.length > 0 && packet.controls.length <= limits.maxInteractionControls, "INTERACTION_STATE_LIMIT", "Prepared interaction controls are missing or excessive.");
    const controlIds = new Set();
    const controlRoles = new Set();
    let totalVertices = 0;
    let totalWeights = 0;
    let totalWeightReferences = 0;
    let totalLeafRows = 0;
    let grabControls = 0;
    for (const [controlIndex, control] of packet.controls.entries()) {
      plainObject(control, "INVALID_INTERACTION_STATE", `Interaction control ${controlIndex}`);
      knownKeys(control, new Set(["id", "role", "mode", "sourceOrder", "sourcePosition", "screenPosition", "cameraDistance", "attachmentObjectIndices", "closure"]), "INVALID_INTERACTION_STATE", `Interaction control ${controlIndex}`);
      const controlId = stableId(control.id, `Interaction control ${controlIndex} id`);
      const role = stableId(control.role, `Interaction control ${controlIndex} role`);
      invariant(!controlIds.has(controlId) && !controlRoles.has(role), "INVALID_INTERACTION_STATE", "Interaction control identities and roles must be unique.");
      controlIds.add(controlId);
      controlRoles.add(role);
      invariant(control.sourceOrder === controlIndex && (control.mode === "grab" || control.mode === "eye-follow"), "INVALID_INTERACTION_STATE", `Interaction control ${controlIndex} order or mode is invalid.`);
      if (control.mode === "grab") grabControls += 1;
      interactionF32Array(control.sourcePosition, 3, `Interaction control ${controlIndex} source position`);
      interactionF32Array(control.screenPosition, 2, `Interaction control ${controlIndex} screen position`);
      invariant(finiteF32(control.cameraDistance) && control.cameraDistance > 0, "INVALID_INTERACTION_STATE", `Interaction control ${controlIndex} camera distance is invalid.`);
      interactionIntegerArray(control.attachmentObjectIndices, limits.maxInteractionObjects, `Interaction control ${controlIndex} attachments`, { upper: Math.max(0, objectCount - 1), unique: true });
      invariant(control.attachmentObjectIndices.length > 0 && (control.mode !== "eye-follow" || control.attachmentObjectIndices.length === 1), "INVALID_INTERACTION_STATE", `Interaction control ${controlIndex} attachments are invalid for its mode.`);
      const closure = plainObject(control.closure, "INVALID_INTERACTION_STATE", `Interaction control ${controlIndex} closure`);
      knownKeys(closure, new Set(["shapeIndices", "vertexRows", "vertexPositions", "weightActiveFlags", "weightScalars", "weightLinearContributions", "weightBaseTranslations", "leafIndices", "leafRows", "safeVisibleLeafIndices", "rigidRootInverseMatrix"]), "INVALID_INTERACTION_STATE", `Interaction control ${controlIndex} closure`);
      interactionIntegerArray(closure.shapeIndices, interactionBinding.targets.shapes.length, `Interaction control ${controlIndex} shape indices`, { upper: Math.max(0, interactionBinding.targets.shapes.length - 1), unique: true });
      invariant(closure.shapeIndices.length > 0, "INVALID_INTERACTION_STATE", `Interaction control ${controlIndex} has no shape closure.`);
      invariant(Array.isArray(closure.vertexRows) && closure.vertexRows.length % 4 === 0, "INVALID_INTERACTION_STATE", `Interaction control ${controlIndex} vertex rows are truncated.`);
      const vertexCount = closure.vertexRows.length / 4;
      totalVertices += vertexCount;
      invariant(totalVertices <= limits.maxInteractionVertices
        && Array.isArray(closure.vertexPositions)
        && closure.vertexPositions.length === vertexCount * 3
        && closure.vertexPositions.every(finiteF32), "INTERACTION_STATE_LIMIT", `Interaction control ${controlIndex} vertices are invalid or excessive.`);
      const shapeSet = new Set(closure.shapeIndices);
      let maximumWeight = 0;
      for (let row = 0; row < vertexCount; row += 1) {
        const offset = row * 4;
        invariant(shapeSet.has(closure.vertexRows[offset])
          && Number.isSafeInteger(closure.vertexRows[offset + 1]) && closure.vertexRows[offset + 1] >= 0
          && Number.isSafeInteger(closure.vertexRows[offset + 2]) && closure.vertexRows[offset + 2] >= 0
          && Number.isSafeInteger(closure.vertexRows[offset + 3]) && closure.vertexRows[offset + 3] >= 0, "INVALID_INTERACTION_STATE", `Interaction control ${controlIndex} vertex row ${row} is invalid.`);
        const rowEnd = closure.vertexRows[offset + 2] + closure.vertexRows[offset + 3];
        invariant(Number.isSafeInteger(rowEnd), "INVALID_INTERACTION_STATE", `Interaction control ${controlIndex} vertex row ${row} weight range overflows.`);
        maximumWeight = Math.max(maximumWeight, rowEnd);
        totalWeightReferences += closure.vertexRows[offset + 3];
        invariant(Number.isSafeInteger(totalWeightReferences) && totalWeightReferences <= limits.maxInteractionWeightReferences, "INTERACTION_STATE_LIMIT", "Prepared interaction weight references are excessive.");
      }
      invariant(Array.isArray(closure.weightScalars)
        && Array.isArray(closure.weightActiveFlags)
        && Array.isArray(closure.weightLinearContributions)
        && Array.isArray(closure.weightBaseTranslations), "INTERACTION_STATE_LIMIT", `Interaction control ${controlIndex} weight tables must be arrays.`);
      const weightCount = closure.weightScalars.length;
      totalWeights += weightCount ?? 0;
      invariant(Number.isSafeInteger(weightCount) && totalWeights <= limits.maxInteractionWeights
        && maximumWeight <= weightCount
        && closure.weightActiveFlags?.length === weightCount
        && closure.weightLinearContributions?.length === weightCount * 3
        && closure.weightBaseTranslations?.length === weightCount * 3
        && closure.weightScalars.every(finiteF32)
        && closure.weightLinearContributions.every(finiteF32)
        && closure.weightBaseTranslations.every(finiteF32)
        && closure.weightActiveFlags.every((flag) => flag === 0 || flag === 1), "INTERACTION_STATE_LIMIT", `Interaction control ${controlIndex} weight tables are invalid or excessive.`);
      interactionIntegerArray(closure.leafIndices, packet.leaves.length, `Interaction control ${controlIndex} leaf indices`, { upper: Math.max(0, packet.leaves.length - 1), unique: true });
      invariant(Array.isArray(closure.leafRows) && closure.leafRows.length === closure.leafIndices.length * 4, "INVALID_INTERACTION_STATE", `Interaction control ${controlIndex} leaf rows are truncated or mismatched.`);
      totalLeafRows += closure.leafIndices.length;
      invariant(totalLeafRows <= limits.maxInteractionLeafRows, "INTERACTION_STATE_LIMIT", "Prepared interaction leaf rows are excessive.");
      for (let row = 0; row < closure.leafIndices.length; row += 1) {
        const offset = row * 4;
        invariant(closure.leafRows[offset] === closure.leafIndices[row]
          && closure.leafRows[offset + 1] >= 0 && closure.leafRows[offset + 1] < vertexCount
          && closure.leafRows[offset + 2] >= 0 && closure.leafRows[offset + 2] < vertexCount
          && closure.leafRows[offset + 3] >= 0 && closure.leafRows[offset + 3] < vertexCount
          && closure.leafRows.slice(offset, offset + 4).every(Number.isSafeInteger), "INVALID_INTERACTION_STATE", `Interaction control ${controlIndex} leaf row ${row} is invalid.`);
      }
      interactionIntegerArray(closure.safeVisibleLeafIndices, closure.leafIndices.length, `Interaction control ${controlIndex} safe-visible leaves`, { upper: Math.max(0, packet.leaves.length - 1), unique: true });
      const leafSet = new Set(closure.leafIndices);
      invariant(closure.safeVisibleLeafIndices.every((index) => leafSet.has(index)), "INVALID_INTERACTION_STATE", `Interaction control ${controlIndex} safe-visible leaves escape its closure.`);
      if (control.mode === "eye-follow") interactionF32Array(closure.rigidRootInverseMatrix, 16, `Interaction control ${controlIndex} rigid inverse matrix`);
      else invariant(Array.isArray(closure.rigidRootInverseMatrix) && closure.rigidRootInverseMatrix.length === 0, "INVALID_INTERACTION_STATE", `Grab control ${controlIndex} must not contain a rigid inverse matrix.`);
      if (control.mode === "eye-follow") {
        const projected = interactionProjectedF32(control.sourcePosition, source);
        invariant(projected, "INVALID_INTERACTION_STATE", `Interaction eye control ${controlIndex} projection overflows binary32 arithmetic.`);
        for (const cursorX of [input.cursorBounds[0], input.cursorBounds[1]]) {
          for (const cursorY of [input.cursorBounds[2], input.cursorBounds[3]]) {
            const eyeOffset = [
              interactionMulF32(interactionAddF32(cursorX, -projected[0]), source.eyeGain),
              interactionMulF32(interactionAddF32(projected[1], -cursorY), source.eyeGain),
              0,
            ];
            invariant(eyeOffset.every(Number.isFinite) && interactionMagnitudeF32(eyeOffset), "INVALID_INTERACTION_STATE", `Interaction eye control ${controlIndex} offset overflows binary32 arithmetic.`);
          }
        }
        const camera = [
          Math.fround(Math.fround(source.cameraViewMatrix[2] * control.sourcePosition[0]) + Math.fround(source.cameraViewMatrix[6] * control.sourcePosition[1])),
          source.cameraViewMatrix[10] * control.sourcePosition[2],
          source.cameraViewMatrix[14],
        ].reduce((value, component) => Math.fround(value + Math.fround(component)), 0);
        invariant(Number.isFinite(camera) && Math.abs(camera) > 1e-6, "INVALID_INTERACTION_STATE", `Interaction eye control ${controlIndex} projects on the camera plane.`);
      } else {
        for (let component = 0; component < 3; component += 1) {
          invariant(Number.isFinite(interactionAddF32(control.sourcePosition[component], selectedGrabOffsetBounds[component]))
            && Number.isFinite(interactionAddF32(control.sourcePosition[component], -selectedGrabOffsetBounds[component])), "INVALID_INTERACTION_STATE", `Interaction grab control ${controlIndex} displacement envelope overflows binary32 position arithmetic.`);
        }
      }
    }
    invariant(grabControls > 0, "INVALID_INTERACTION_STATE", "Prepared interaction needs at least one grab control.");
  }
  validateBindingTargetOwnership(bindingChannels, limits);
}

function validateMeta(meta) {
  plainObject(meta, "INVALID_META", "META");
  knownKeys(meta, new Set(["format", "profile", "title", "generator", "capabilities", "optionalCapabilities", "initialExperience", "conformance", "counts", "sourceArtifact"]), "INVALID_META", "META");
  invariant(meta.format === FORMAT_ID, "UNSUPPORTED_FORMAT", `META format must be ${FORMAT_ID}.`);
  invariant(meta.profile === PROFILE_ID, "UNSUPPORTED_PROFILE", `META profile must be ${PROFILE_ID}.`);
  const titleLength = typeof meta.title === "string" ? boundedCodePointLength(meta.title, 256) : 0;
  invariant(titleLength > 0 && titleLength <= 256, "INVALID_TITLE", "META title is invalid.");
  const generator = plainObject(meta.generator, "INVALID_META", "META generator");
  knownKeys(generator, new Set(["name", "version"]), "INVALID_META", "META generator");
  invariant(typeof generator.name === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(generator.name) && typeof generator.version === "string" && /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/u.test(generator.version), "INVALID_META", "META generator identity is invalid.");
  invariant(Array.isArray(meta.capabilities) && meta.capabilities.length > 0 && meta.capabilities.length <= 128 && new Set(meta.capabilities).size === meta.capabilities.length && meta.capabilities.every((value) => typeof value === "string" && SHORT_TOKEN.test(value)), "INVALID_META", "META required capabilities are invalid.");
  for (const capability of meta.capabilities) invariant(KNOWN_REQUIRED_CAPABILITIES.has(capability), "UNSUPPORTED_REQUIRED_CAPABILITY", `Required capability ${capability} is unsupported.`);
  if (meta.optionalCapabilities !== undefined) {
    invariant(Array.isArray(meta.optionalCapabilities) && meta.optionalCapabilities.length <= 128 && new Set(meta.optionalCapabilities).size === meta.optionalCapabilities.length && meta.optionalCapabilities.every((value) => typeof value === "string" && SHORT_TOKEN.test(value)), "INVALID_META", "META optional capabilities are invalid.");
    invariant(meta.optionalCapabilities.every((value) => !meta.capabilities.includes(value)), "INVALID_META", "META required and optional capabilities overlap.");
    invariant(meta.optionalCapabilities.every((value, index) => index === 0 || meta.optionalCapabilities[index - 1] < value), "INVALID_META", "META optional capabilities must be strictly sorted.");
  }
  if (meta.initialExperience !== undefined) invariant(meta.initialExperience === "animation" || meta.initialExperience === "interaction", "INVALID_META", "META initialExperience must be animation or interaction.");
  const conformance = plainObject(meta.conformance, "INVALID_META", "META conformance");
  knownKeys(conformance, new Set(["executable", "declaredOnly"]), "INVALID_META", "META conformance");
  const all = [];
  for (const key of ["executable", "declaredOnly"]) {
    invariant(Array.isArray(conformance[key]) && conformance[key].length <= 128 && new Set(conformance[key]).size === conformance[key].length && conformance[key].every((value) => typeof value === "string" && SHORT_TOKEN.test(value)), "INVALID_META", `META conformance ${key} is invalid.`);
    all.push(...conformance[key]);
  }
  invariant(new Set(all).size === all.length, "INVALID_META", "META executable and declared-only conformance entries overlap.");
  if (meta.counts !== undefined) {
    const counts = plainObject(meta.counts, "INVALID_META", "META counts");
    knownKeys(counts, new Set(["nodes", "shapes", "leaves", "sourceFrames"]), "INVALID_META", "META counts");
    invariant(Object.values(counts).every((value) => Number.isSafeInteger(value) && value >= 0), "INVALID_META", "META counts contain an invalid value.");
  }
  if (meta.sourceArtifact !== undefined) {
    const source = plainObject(meta.sourceArtifact, "INVALID_META", "META sourceArtifact");
    knownKeys(source, new Set(["byteLength", "decodedByteLength", "digest", "status"]), "INVALID_META", "META sourceArtifact");
    invariant(Number.isSafeInteger(source.byteLength) && source.byteLength >= 0 && Number.isSafeInteger(source.decodedByteLength) && source.decodedByteLength >= 0 && typeof source.status === "string" && source.status.length > 0 && source.status.length <= 128 && /^[a-z0-9][a-z0-9-]*$/u.test(source.status), "INVALID_META", "META sourceArtifact sizes or status are invalid.");
    const digest = plainObject(source.digest, "INVALID_META", "META sourceArtifact digest");
    knownKeys(digest, new Set(["algorithm", "value"]), "INVALID_META", "META sourceArtifact digest");
    invariant(digest.algorithm === "sha256" && typeof digest.value === "string" && SHA256.test(digest.value), "INVALID_META", "META sourceArtifact digest is invalid.");
  }
  return meta;
}

function validatePresentationClosure(document, tree, resources) {
  const state = document.state.channels.find((channel) => channel.codec === "static-presentation@0");
  const binding = document.bindings.channels.find((channel) => channel.interpreter === "static-presentation@0");
  if (!state || !binding) return;
  const packet = state.data.packet;
  const background = packet.background;
  if (background) {
    const resource = resources.get(background.resource);
    invariant(resource?.kind === "image", "RESOURCE_ROLE_MISMATCH", "Presentation background must reference an image resource.");
    const resourceStyle = document.tree.mount.resourceStyles?.backgroundImage;
    invariant(resourceStyle?.resource === background.resource && resourceStyle.syntax === "overlay-url" && resourceStyle.overlayOpacity === background.opacity, "PRESENTATION_TREE_MISMATCH", "Presentation background resource binding does not match TREE mount.");
    invariant(document.tree.mount.styles?.backgroundPosition === background.position && document.tree.mount.styles?.backgroundRepeat === background.repeat && document.tree.mount.styles?.backgroundSize === background.size, "PRESENTATION_TREE_MISMATCH", "Presentation background styles do not match TREE mount.");
  } else {
    invariant(document.tree.mount.resourceStyles?.backgroundImage === undefined, "PRESENTATION_TREE_MISMATCH", "Presentation without a background cannot bind a TREE mount background image.");
    invariant(["backgroundPosition", "backgroundRepeat", "backgroundSize"].every((key) => document.tree.mount.styles?.[key] === undefined), "PRESENTATION_TREE_MISMATCH", "Presentation without a background cannot declare TREE mount background layout styles.");
  }
  const camera = tree.nodesById.get(binding.targets.camera);
  invariant(camera?.styles?.perspective === `${packet.camera.perspective}px`
    && camera.styles.perspectiveOrigin === `${packet.camera.sourceWidth / 2}px ${packet.camera.sourceHeight / 2}px`
    && camera.styles.position === "relative"
    && camera.styles.width === `${packet.camera.sourceWidth}px`
    && camera.styles.height === `${packet.camera.sourceHeight}px`
    && camera.styles.transformOrigin === undefined
    && camera.styles.transformStyle === undefined, "PRESENTATION_TREE_MISMATCH", "Presentation camera packet does not match TREE camera styles.");
  const playback = document.bindings.channels.find((channel) => channel.interpreter === "polycss-playback@0");
  if (playback) {
    invariant(playback.parameters.baseSceneTransform === packet.camera.baseSceneTransform && tree.nodesById.get(playback.targets.model)?.styles?.transform === packet.camera.baseSceneTransform, "PRESENTATION_TREE_MISMATCH", "Presentation base scene transform does not match playback/TREE.");
  }
  const interaction = document.bindings.channels.find((channel) => channel.interpreter === "polycss-pointer-grab@0");
  if (interaction) {
    invariant(Object.hasOwn(binding.targets, "cursorLayer") && Object.hasOwn(binding.targets, "cursorStates")
      && interaction.targets.cursorLayer === binding.targets.cursorLayer
      && interaction.targets.cursorStates.open === binding.targets.cursorStates.open
      && interaction.targets.cursorStates.closed === binding.targets.cursorStates.closed, "PRESENTATION_TREE_MISMATCH", "Presentation and interaction cursor targets differ.");
  }
}

function validateResourceClosure(document, resources) {
  const used = new Set();
  for (const binding of document.cssBinding.stylesheets) {
    used.add(binding.resource);
    for (const token of binding.assetTokens) used.add(token.resource);
  }
  for (const binding of Object.values(document.tree.mount.resourceStyles ?? {})) used.add(binding.resource);
  for (const node of document.tree.nodes) {
    for (const resource of Object.values(node.resourceAttributes ?? {})) used.add(resource);
    for (const binding of Object.values(node.resourceStyles ?? {})) used.add(binding.resource);
  }
  const presentation = document.state.channels.find((channel) => channel.codec === "static-presentation@0");
  if (presentation?.data.packet.background) used.add(presentation.data.packet.background.resource);
  for (const id of resources.keys()) invariant(used.has(id), "UNUSED_RESOURCE", `Resource ${id} is not reachable from the retained-DOM contract.`);
}

function validateDeclaredCounts(meta, document, bindingChannels) {
  if (!meta.counts) return;
  if (Object.hasOwn(meta.counts, "nodes")) {
    invariant(meta.counts.nodes === document.tree.nodes.length, "META_COUNT_MISMATCH", "META node count does not match TREE.");
  }
  const playback = [...bindingChannels.values()].find((channel) => channel.interpreter === "polycss-playback@0");
  for (const [name, actual] of [
    ["shapes", playback?.targets.shapes.length],
    ["leaves", playback?.targets.leaves.length],
    ["sourceFrames", playback?.parameters.frameCount],
  ]) {
    if (Object.hasOwn(meta.counts, name)) invariant(actual !== undefined && meta.counts[name] === actual, "META_COUNT_MISMATCH", `META ${name} count does not match executable playback.`);
  }
}

function validateInitialExperience(meta, bindingChannels) {
  if (meta.initialExperience !== "interaction") return;
  invariant(meta.capabilities.includes("prepared-pointer-grab-interaction"), "MISSING_INITIAL_EXPERIENCE", "The interaction initial experience requires its declared capability.");
  const interaction = [...bindingChannels.values()].find((channel) => channel.interpreter === "polycss-pointer-grab@0");
  invariant(interaction?.status === "executable", "MISSING_INITIAL_EXPERIENCE", "The interaction initial experience requires an executable pointer interaction binding.");
}

function validateMetadataClosure(meta, bindingChannels) {
  const interpreters = new Set([...bindingChannels.values()].map((channel) => channel.interpreter));
  const capabilities = [...BASE_REQUIRED_CAPABILITIES];
  for (const interpreter of CAPABILITY_INTERPRETER_ORDER) {
    if (interpreters.has(interpreter)) capabilities.push(CAPABILITY_BY_INTERPRETER[interpreter]);
  }
  exactArray(meta.capabilities, capabilities, "CAPABILITY_CLOSURE_MISMATCH", "META required capabilities do not exactly describe the executable contract.");

  const expectedConformance = ["retained-tree"];
  for (const interpreter of CONFORMANCE_INTERPRETER_ORDER) {
    if (interpreters.has(interpreter)) expectedConformance.push(CONFORMANCE_BY_INTERPRETER[interpreter]);
  }
  exactArray(meta.conformance.executable, expectedConformance, "CONFORMANCE_CLOSURE_MISMATCH", "META executable conformance does not exactly describe the retained tree and fixed interpreters.");
  invariant(meta.conformance.declaredOnly.length === 0, "CONFORMANCE_CLOSURE_MISMATCH", "polycss-3d@0 has no declared-only interpreter surface.");
}

export function validateDocumentInternal(document, options = {}) {
  const limits = mergeLimits(options.limits);
  plainObject(document, "INVALID_DOCUMENT", "Decoded document");
  knownKeys(document, new Set(["meta", "tree", "cssBinding", "state", "bindings", "resources"]), "INVALID_DOCUMENT", "Decoded document");
  const meta = validateMeta(document.meta);
  const resourceIds = validateResourceCatalog(document.resources, limits);
  const resourceMap = new Map(document.resources.resources.map((record) => [record.id, record]));
  const tree = validateTree(document.tree, resourceMap, limits);
  validateCssBinding(document.cssBinding, resourceMap, document.tree.mount, limits);
  const stateChannels = validateState(document.state, limits);
  const bindingChannels = validateBindings(document.bindings, stateChannels, tree.ids, limits);
  const bindingInputs = new Map(document.bindings.inputs.map((input) => [input.id, input]));
  validatePolycssChannelInvariants(stateChannels, bindingChannels, bindingInputs, tree, limits);
  validatePresentationClosure(document, tree, resourceMap);
  validateResourceClosure(document, resourceMap);
  validateDeclaredCounts(meta, document, bindingChannels);
  validateInitialExperience(meta, bindingChannels);
  validateMetadataClosure(meta, bindingChannels);
  return Object.freeze({ limits, resourceIds, nodeIds: tree.ids, stateChannels });
}

export function validateDocument(document, options = {}) {
  validateDocumentInternal(document, options);
}
