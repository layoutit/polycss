import { NVersionError, requireContract as require } from "./errors.js";

const NUMBER = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
function scalarNfc(value, code, label) {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      require(next >= 0xdc00 && next <= 0xdfff, code, `${label} contains a lone surrogate.`);
      index += 1;
    } else require(unit < 0xdc00 || unit > 0xdfff, code, `${label} contains a lone surrogate.`);
  }
  require(value.normalize("NFC") === value, "NON_NFC_STRING", `${label} is not NFC.`);
  return value;
}

class Parser {
  constructor(text, limits, label) {
    this.text = text;
    this.limits = limits;
    this.label = label;
    this.offset = 0;
  }

  fail(message, code = "MALFORMED_JSON") {
    throw new NVersionError(code, `${this.label}: ${message}`);
  }

  whitespace() {
    while (this.offset < this.text.length) {
      const code = this.text.charCodeAt(this.offset);
      if (code !== 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) break;
      this.offset += 1;
    }
  }

  string(key = false) {
    const start = this.offset;
    require(this.text[this.offset] === '"', "MALFORMED_JSON", `${this.label}: expected a string.`);
    this.offset += 1;
    let escaped = false;
    while (this.offset < this.text.length) {
      const code = this.text.charCodeAt(this.offset);
      if (!escaped && code === 0x22) {
        this.offset += 1;
        let value;
        try {
          value = JSON.parse(this.text.slice(start, this.offset));
        } catch {
          this.fail("invalid string escape.");
        }
        scalarNfc(value, key ? "INVALID_JSON_KEY" : "INVALID_JSON_STRING", key ? "JSON key" : "JSON string");
        if (key) require(value.length <= this.limits.maxKeyCodeUnits, "JSON_KEY_LIMIT", "JSON key is too long.");
        return value;
      }
      if (!escaped && code < 0x20) this.fail("unescaped control character in string.");
      if (escaped) {
        if (this.text[this.offset] === "u") {
          for (let count = 1; count <= 4; count += 1) {
            const digit = this.text[this.offset + count];
            if (!digit || !/[0-9a-fA-F]/u.test(digit)) this.fail("invalid Unicode escape.");
          }
          this.offset += 4;
        } else if (!'"\\/bfnrt'.includes(this.text[this.offset])) this.fail("invalid string escape.");
        escaped = false;
      } else if (code === 0x5c) escaped = true;
      this.offset += 1;
    }
    this.fail("unterminated string.");
  }

  number() {
    NUMBER.lastIndex = this.offset;
    const match = NUMBER.exec(this.text);
    if (!match) this.fail("invalid number.", "INVALID_NUMBER");
    this.offset = NUMBER.lastIndex;
    const next = this.text[this.offset];
    if (next && !/[\s,\]}]/u.test(next)) this.fail("invalid number suffix.", "INVALID_NUMBER");
    const value = Number(match[0]);
    require(Number.isFinite(value) && !Object.is(value, -0), "INVALID_NUMBER", `${this.label}: number is non-finite or negative zero.`);
    return value;
  }

  value(depth = 0) {
    require(depth <= this.limits.maxDepth, "JSON_DEPTH_LIMIT", `${this.label}: JSON nesting exceeds ${this.limits.maxDepth}.`);
    this.whitespace();
    const token = this.text[this.offset];
    if (token === '"') return this.string(false);
    if (token === "[") return this.array(depth + 1);
    if (token === "{") return this.object(depth + 1);
    if (this.text.startsWith("true", this.offset)) { this.offset += 4; return true; }
    if (this.text.startsWith("false", this.offset)) { this.offset += 5; return false; }
    if (this.text.startsWith("null", this.offset)) { this.offset += 4; return null; }
    if (token === "-" || (token >= "0" && token <= "9")) return this.number();
    this.fail("unexpected token.");
  }

  array(depth) {
    this.offset += 1;
    this.whitespace();
    const output = [];
    if (this.text[this.offset] === "]") { this.offset += 1; return output; }
    while (true) {
      require(output.length < this.limits.maxArrayItems, "JSON_ARRAY_LIMIT", `${this.label}: JSON array has too many items.`);
      output.push(this.value(depth));
      this.whitespace();
      const token = this.text[this.offset++];
      if (token === "]") return output;
      if (token !== ",") this.fail("expected comma or closing bracket.");
      this.whitespace();
      if (this.text[this.offset] === "]") this.fail("trailing array comma.");
    }
  }

  object(depth) {
    this.offset += 1;
    this.whitespace();
    const output = Object.create(null);
    const keys = new Set();
    if (this.text[this.offset] === "}") { this.offset += 1; return output; }
    while (true) {
      require(keys.size < this.limits.maxObjectMembers, "JSON_OBJECT_LIMIT", `${this.label}: JSON object has too many members.`);
      if (this.text[this.offset] !== '"') this.fail("object key is not a string.");
      const key = this.string(true);
      require(!keys.has(key), "DUPLICATE_NORMALIZED_KEY", `${this.label}: duplicate object key ${key}.`);
      keys.add(key);
      this.whitespace();
      if (this.text[this.offset++] !== ":") this.fail("expected colon after object key.");
      output[key] = this.value(depth);
      this.whitespace();
      const token = this.text[this.offset++];
      if (token === "}") return output;
      if (token !== ",") this.fail("expected comma or closing brace.");
      this.whitespace();
      if (this.text[this.offset] === "}") this.fail("trailing object comma.");
    }
  }

  parse() {
    const value = this.value(0);
    this.whitespace();
    if (this.offset !== this.text.length) this.fail("trailing data.", "TRAILING_JSON_DATA");
    return value;
  }
}

function freeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const entry of Object.values(value)) freeze(entry);
  return Object.freeze(value);
}

export function parseJsonBytes(bytes, limits, label = "domformat JSON") {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new NVersionError("MALFORMED_UTF8", `${label} is not strict UTF-8.`);
  }
  require(text.charCodeAt(0) !== 0xfeff, "MALFORMED_UTF8", `${label} begins with a byte-order mark.`);
  return freeze(new Parser(text, limits, label).parse());
}

export async function decodeTransport(input, limits) {
  const bytes = input instanceof Uint8Array
    ? input
    : input instanceof ArrayBuffer
      ? new Uint8Array(input)
      : ArrayBuffer.isView(input)
        ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
        : null;
  require(bytes && bytes.byteLength <= limits.maxFileBytes, "FILE_SIZE_LIMIT", `Package exceeds ${limits.maxFileBytes} bytes.`);
  require(bytes.length < 2 || bytes[0] !== 0x1f || bytes[1] !== 0x8b, "UNSUPPORTED_TRANSPORT", "domformat@0 accepts plain JSON only.");
  require(bytes.length <= limits.maxDecodedInputBytes, "DECODED_SIZE_LIMIT", `JSON exceeds ${limits.maxDecodedInputBytes} bytes.`);
  return Object.freeze({ encoding: "json", bytes: bytes.slice(), fileBytes: bytes.length });
}
