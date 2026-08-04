import { fail, invariant } from "./errors.js";
import { DEFAULT_JSON_STRUCTURE_LIMITS } from "./constants.js";

const MAX_CANONICAL_DEPTH = 256;

function assertUnicodeScalarString(value, label) {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      invariant(
        next >= 0xdc00 && next <= 0xdfff,
        "INVALID_UNICODE",
        `${label} contains an unpaired high surrogate.`,
      );
      index += 1;
    } else {
      invariant(
        unit < 0xdc00 || unit > 0xdfff,
        "INVALID_UNICODE",
        `${label} contains an unpaired low surrogate.`,
      );
    }
  }
}

function normalize(value, path, depth, seen, structureLimits) {
  invariant(depth <= MAX_CANONICAL_DEPTH, "JSON_DEPTH", "Canonical JSON nesting is too deep.");
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    assertUnicodeScalarString(value, path);
    return value.normalize("NFC");
  }
  if (typeof value === "number") {
    invariant(Number.isFinite(value), "INVALID_NUMBER", `${path} must be a finite JSON number.`);
    return Object.is(value, -0) ? 0 : value;
  }
  invariant(typeof value === "object", "INVALID_JSON_VALUE", `${path} is not a JSON value.`);
  invariant(!seen.has(value), "JSON_CYCLE", `${path} contains a cycle.`);
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      invariant(value.length <= structureLimits.maxArrayItems, "JSON_ARRAY_LIMIT", `${path} has too many array items.`);
      const output = [];
      for (let index = 0; index < value.length; index += 1) {
        invariant(Object.hasOwn(value, index), "INVALID_JSON_ARRAY", `${path} contains a sparse array slot at ${index}.`);
        output.push(normalize(value[index], `${path}[${index}]`, depth + 1, seen, structureLimits));
      }
      return output;
    }
    const prototype = Object.getPrototypeOf(value);
    invariant(prototype === Object.prototype || prototype === null, "INVALID_JSON_OBJECT", `${path} must be a plain JSON object.`);
    const output = {};
    const normalizedKeys = new Set();
    const rawKeys = [];
    for (const rawKey in value) {
      if (!Object.hasOwn(value, rawKey)) continue;
      invariant(rawKey.length <= (structureLimits.maxKeyCodeUnits ?? 256), "JSON_KEY_LIMIT", `${path} has an excessive object key.`);
      rawKeys.push(rawKey);
      invariant(rawKeys.length <= structureLimits.maxObjectMembers, "JSON_OBJECT_LIMIT", `${path} has too many object members.`);
    }
    rawKeys.sort();
    for (const rawKey of rawKeys) {
      assertUnicodeScalarString(rawKey, `${path} key`);
      const key = rawKey.normalize("NFC");
      invariant(!normalizedKeys.has(key), "DUPLICATE_NORMALIZED_KEY", `${path} has colliding normalized keys.`);
      normalizedKeys.add(key);
      const entry = value[rawKey];
      invariant(entry !== undefined, "UNDEFINED_JSON_VALUE", `${path}.${key} is undefined.`);
      // Defining an own data property keeps keys such as "__proto__" from
      // invoking Object.prototype setters while returning the same ordinary
      // object shape produced by JSON.parse.
      Object.defineProperty(output, key, {
        configurable: true,
        enumerable: true,
        value: normalize(entry, `${path}.${key}`, depth + 1, seen, structureLimits),
        writable: true,
      });
    }
    return output;
  } finally {
    seen.delete(value);
  }
}

export function canonicalize(value, structureLimits = DEFAULT_JSON_STRUCTURE_LIMITS) {
  return normalize(value, "$", 0, new Set(), structureLimits);
}

export function deepFreezeJson(value) {
  if (value === null || typeof value !== "object") return value;
  const stack = [value];
  const seen = new WeakSet();
  while (stack.length > 0) {
    const current = stack.pop();
    if (seen.has(current)) continue;
    seen.add(current);
    for (const entry of Array.isArray(current) ? current : Object.values(current)) {
      if (entry !== null && typeof entry === "object") stack.push(entry);
    }
    Object.freeze(current);
  }
  return value;
}

function serializeCanonical(value) {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(serializeCanonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${serializeCanonical(value[key])}`).join(",")}}`;
}

export function encodeCanonicalJson(value, structureLimits = DEFAULT_JSON_STRUCTURE_LIMITS) {
  // JSON.stringify applies the ECMAScript property-enumeration special case
  // for array-index-looking object keys.  Serializing entries ourselves keeps
  // every object in the format's declared UTF-16 lexical order, including
  // objects such as { "10": ..., "2": ... }.
  return new TextEncoder().encode(serializeCanonical(canonicalize(value, structureLimits)));
}

function decodeUtf8(bytes, label) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    fail("MALFORMED_UTF8", `${label} is not valid UTF-8.`, { cause: String(error) });
  }
}

function preflightJson(text, label, options = {}) {
  const structureLimits = options.structureLimits ?? DEFAULT_JSON_STRUCTURE_LIMITS;
  const numberPattern = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/uy;
  let offset = 0;
  const whitespace = () => {
    while (offset < text.length && (text[offset] === " " || text[offset] === "\t" || text[offset] === "\n" || text[offset] === "\r")) offset += 1;
  };
  const malformed = (message) => fail("MALFORMED_JSON", `${label} ${message}`);
  const string = (maximumCodeUnits) => {
    const start = offset;
    if (text[offset] !== '"') malformed(`has an invalid string at character ${offset}.`);
    offset += 1;
    while (offset < text.length) {
      const code = text.charCodeAt(offset);
      if (code === 0x22) {
        offset += 1;
        if (maximumCodeUnits !== undefined) {
          invariant(offset - start <= maximumCodeUnits * 6 + 2, "JSON_KEY_LIMIT", `${label} object key is excessive.`);
        }
        let value;
        try {
          value = JSON.parse(text.slice(start, offset));
        } catch (error) {
          fail("MALFORMED_JSON", `${label} has an invalid string.`, { cause: String(error) });
        }
        assertUnicodeScalarString(value, label);
        if (maximumCodeUnits !== undefined) invariant(value.length <= maximumCodeUnits, "JSON_KEY_LIMIT", `${label} object key is excessive.`);
        if (!options.allowNonNormalized) {
          invariant(value === value.normalize("NFC"), "NON_NORMALIZED_JSON", `${label} strings and keys must use NFC.`);
        }
        return value;
      }
      invariant(code >= 0x20, "MALFORMED_JSON", `${label} contains an unescaped control character.`);
      if (code === 0x5c) {
        offset += 1;
        if (offset >= text.length || !'"\\/bfnrtu'.includes(text[offset])) malformed("contains an invalid string escape.");
        if (text[offset] === "u") {
          invariant(/^[0-9a-fA-F]{4}$/u.test(text.slice(offset + 1, offset + 5)), "MALFORMED_JSON", `${label} contains an invalid Unicode escape.`);
          offset += 4;
        }
      }
      offset += 1;
    }
    malformed("contains an unterminated string.");
  };
  const number = () => {
    numberPattern.lastIndex = offset;
    const match = numberPattern.exec(text);
    if (!match) malformed(`has an invalid number at character ${offset}.`);
    offset += match[0].length;
    const value = Number(match[0]);
    invariant(Number.isFinite(value), "INVALID_NUMBER", `${label} contains a non-finite JSON number.`);
    if (!options.allowNegativeZero) invariant(!Object.is(value, -0), "INVALID_NUMBER", `${label} must not encode negative zero.`);
  };
  const literal = (value) => {
    if (!text.startsWith(value, offset)) malformed(`has an invalid token at character ${offset}.`);
    offset += value.length;
  };
  const value = (depth) => {
    invariant(depth <= MAX_CANONICAL_DEPTH, "JSON_DEPTH", `${label} nesting is too deep.`);
    whitespace();
    const token = text[offset];
    if (token === '"') {
      string();
    } else if (token === "{") {
      offset += 1;
      whitespace();
      const keys = new Set();
      let members = 0;
      if (text[offset] === "}") {
        offset += 1;
        return;
      }
      while (true) {
        whitespace();
        const key = string(structureLimits.maxKeyCodeUnits ?? 256).normalize("NFC");
        members += 1;
        invariant(members <= structureLimits.maxObjectMembers, "JSON_OBJECT_LIMIT", `${label} object has too many members.`);
        invariant(!keys.has(key), "DUPLICATE_NORMALIZED_KEY", `${label} contains duplicate object key ${JSON.stringify(key)}.`);
        keys.add(key);
        whitespace();
        if (text[offset] !== ":") malformed(`is missing ':' after an object key at character ${offset}.`);
        offset += 1;
        value(depth + 1);
        whitespace();
        if (text[offset] === "}") {
          offset += 1;
          return;
        }
        if (text[offset] !== ",") malformed(`is missing ',' between object members at character ${offset}.`);
        offset += 1;
      }
    } else if (token === "[") {
      offset += 1;
      whitespace();
      let items = 0;
      if (text[offset] === "]") {
        offset += 1;
        return;
      }
      while (true) {
        items += 1;
        invariant(items <= structureLimits.maxArrayItems, "JSON_ARRAY_LIMIT", `${label} array has too many items.`);
        value(depth + 1);
        whitespace();
        if (text[offset] === "]") {
          offset += 1;
          return;
        }
        if (text[offset] !== ",") malformed(`is missing ',' between array values at character ${offset}.`);
        offset += 1;
      }
    } else if (token === "t") {
      literal("true");
    } else if (token === "f") {
      literal("false");
    } else if (token === "n") {
      literal("null");
    } else {
      number();
    }
  };
  whitespace();
  value(0);
  whitespace();
  invariant(offset === text.length, "MALFORMED_JSON", `${label} has trailing non-whitespace data.`);
}

export function decodeJson(bytes, label = "JSON document", structureLimits = DEFAULT_JSON_STRUCTURE_LIMITS) {
  const text = decodeUtf8(bytes, label);
  preflightJson(text, label, { structureLimits });
  try {
    return JSON.parse(text);
  } catch (error) {
    fail("MALFORMED_JSON", `${label} is not valid JSON.`, { cause: String(error) });
  }
}
