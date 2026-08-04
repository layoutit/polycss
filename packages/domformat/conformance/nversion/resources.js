import { NVersionError, requireContract as require } from "./errors.js";

const RESOURCE_ID = /^[a-z][a-z0-9._-]{0,63}$/u;
const DIGEST = /^[0-9a-f]{64}$/u;
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/u;
const CSS_PROPERTIES = new Set(`
  -webkit-backface-visibility backface-visibility background background-clip
  background-color background-image background-position-x background-position-y
  background-repeat background-size border border-bottom-left-radius
  border-bottom-right-radius border-color border-shape border-top-left-radius
  border-top-right-radius box-sizing color contain content corner-bottom-left-shape
  corner-bottom-right-shape corner-top-left-shape corner-top-right-shape cursor display font font-style font-weight height
  image-rendering inset isolation left line-height margin max-width object-fit
  object-position opacity overflow padding pointer-events position text-decoration
  top touch-action transform transform-origin transform-style user-select
  visibility width will-change z-index
`.trim().split(/\s+/u));
const CSS_FUNCTIONS = new Set(`
  abs acos asin atan atan2 blur brightness calc circle clamp color color-mix
  conic-gradient contrast cos counter counters cubic-bezier drop-shadow ellipse
  exp fit-content grayscale hsl hsla hwb hypot hue-rotate inset invert is lab
  lch light-dark linear-gradient log matrix matrix3d max min minmax mod not
  nth-child nth-last-child nth-last-of-type nth-of-type oklab oklch opacity path
  perspective polygon pow radial-gradient rem repeat repeating-conic-gradient
  repeating-linear-gradient repeating-radial-gradient rgb rgba rotate rotate3d
  rotatex rotatey rotatez round saturate scale scale3d scalex scaley scalez
  sepia sign sin skew skewx skewy sqrt steps tan translate translate3d
  translatex translatey translatez url where
`.trim().split(/\s+/u));

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function exactKeys(value, allowed, code, label, required = allowed) {
  require(value && typeof value === "object" && !Array.isArray(value), code, `${label} must be an object.`);
  for (const key of Object.keys(value)) require(allowed.includes(key), code, `${label} contains unknown field ${key}.`);
  for (const key of required) require(Object.hasOwn(value, key), code, `${label} is missing ${key}.`);
  return value;
}

function uint24Le(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

function uint32(bytes, offset, littleEndian) {
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, littleEndian);
}

function ascii(bytes, offset, length) {
  let value = "";
  for (let index = 0; index < length; index += 1) value += String.fromCharCode(bytes[offset + index]);
  return value;
}

export function assertResourceId(value, label = "resource id") {
  require(typeof value === "string" && RESOURCE_ID.test(value), "INVALID_RESOURCE_ID", `${label} is invalid.`);
  return value;
}

export function assertSafePath(value, label = "resource path") {
  require(typeof value === "string" && value.length > 0 && value.length <= 240, "UNSAFE_RESOURCE_PATH", `${label} is not a short relative path.`);
  require(!value.startsWith("/") && !value.startsWith("\\") && !value.includes("\\") && !/[:%?#]/u.test(value), "UNSAFE_RESOURCE_PATH", `${label} is URL-like or nonportable.`);
  require(value.split("/").every((part) => {
    const stem = part.split(".", 1)[0].toLowerCase();
    return part !== "." && part !== ".." && SEGMENT.test(part) && !part.endsWith(".") && !WINDOWS_DEVICE.test(stem);
  }), "UNSAFE_RESOURCE_PATH", `${label} has an unsafe or nonportable segment.`);
  return value;
}

export function validateResourceCatalog(catalog, limits) {
  exactKeys(catalog, ["version", "resources"], "INVALID_RESOURCES", "RCRD");
  require(catalog.version === 0, "UNSUPPORTED_RESOURCE_SCHEMA", "RCRD version must be 0.");
  require(Array.isArray(catalog.resources) && catalog.resources.length <= limits.maxResources, "RESOURCE_COUNT_LIMIT", "RCRD resource count exceeds its limit.");
  const records = new Map();
  const paths = new Set();
  let previous = "";
  let bytes = 0;
  let pixels = 0;
  for (const [index, record] of catalog.resources.entries()) {
    exactKeys(record, ["id", "kind", "mediaType", "byteLength", "dimensions", "digest", "path"], "INVALID_RESOURCE", `Resource ${index}`, ["id", "kind", "mediaType", "byteLength", "digest", "path"]);
    const id = assertResourceId(record.id, `Resource ${index} id`);
    require(id > previous && !records.has(id), "RESOURCE_ORDER", "Resources must have unique sorted ids.");
    previous = id;
    require(record.kind === "image" || record.kind === "stylesheet", "INVALID_RESOURCE_KIND", `Resource ${id} has an invalid kind.`);
    require((record.kind === "stylesheet" && record.mediaType === "text/css;charset=utf-8") || (record.kind === "image" && (record.mediaType === "image/png" || record.mediaType === "image/webp")), "RESOURCE_KIND_MEDIA_MISMATCH", `Resource ${id} has an invalid media pairing.`);
    require(Number.isSafeInteger(record.byteLength) && record.byteLength >= 0 && record.byteLength <= limits.maxResourceBytes, "INVALID_RESOURCE_SIZE", `Resource ${id} length is invalid.`);
    bytes += record.byteLength;
    require(bytes <= limits.maxAggregateResourceBytes, "AGGREGATE_RESOURCE_LIMIT", "Aggregate resource bytes exceed their limit.");
    if (record.kind === "image") {
      exactKeys(record.dimensions, ["width", "height"], "INVALID_RESOURCE_DIMENSIONS", `Resource ${id} dimensions`);
      const { width, height } = record.dimensions;
      require(Number.isSafeInteger(width) && Number.isSafeInteger(height) && width > 0 && height > 0 && width <= limits.maxImageWidth && height <= limits.maxImageHeight && width * height <= limits.maxImagePixels, "IMAGE_DIMENSION_LIMIT", `Resource ${id} dimensions exceed limits.`);
      pixels += width * height;
      require(pixels <= limits.maxAggregateImagePixels, "AGGREGATE_IMAGE_PIXEL_LIMIT", "Aggregate decoded pixels exceed their limit.");
    } else require(record.dimensions === undefined, "UNEXPECTED_RESOURCE_DIMENSIONS", `Stylesheet ${id} declares dimensions.`);
    exactKeys(record.digest, ["algorithm", "value"], "INVALID_RESOURCE_DIGEST", `Resource ${id} digest`);
    require(record.digest.algorithm === "sha256" && typeof record.digest.value === "string" && DIGEST.test(record.digest.value), "INVALID_RESOURCE_DIGEST", `Resource ${id} digest is invalid.`);
    const path = assertSafePath(record.path, `Resource ${id} path`);
    const portablePath = path.toLowerCase();
    require(!paths.has(portablePath), "DUPLICATE_RESOURCE_PATH", `Resource path ${path} has a case-insensitive alias.`);
    for (const existing of paths) require(!portablePath.startsWith(`${existing}/`) && !existing.startsWith(`${portablePath}/`), "RESOURCE_PATH_COLLISION", `Resource path ${path} collides with a file/directory path.`);
    paths.add(portablePath);
    records.set(id, record);
  }
  return records;
}

async function sha256(bytes) {
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes));
  let value = "";
  for (const byte of digest) value += byte.toString(16).padStart(2, "0");
  return value;
}

function pngDimensions(bytes) {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  require(bytes.length >= 45 && signature.every((byte, index) => bytes[index] === byte), "IMAGE_MEDIA_MISMATCH", "PNG signature is invalid.");
  let offset = 8;
  let dimensions = null;
  let sawPalette = false;
  let sawImageData = false;
  let imageDataEnded = false;
  let sawEnd = false;
  let colorType = -1;
  while (offset < bytes.length) {
    require(offset + 12 <= bytes.length, "IMAGE_MEDIA_MISMATCH", "PNG chunk header is truncated.");
    const length = uint32(bytes, offset, false);
    const type = ascii(bytes, offset + 4, 4);
    const payload = offset + 8;
    const end = payload + length;
    require(end + 4 <= bytes.length && crc32(bytes.subarray(offset + 4, end)) === uint32(bytes, end, false), "IMAGE_MEDIA_MISMATCH", `PNG ${type} chunk is invalid.`);
    if (!dimensions) {
      require(type === "IHDR" && length === 13, "IMAGE_MEDIA_MISMATCH", "PNG IHDR is invalid.");
      dimensions = { width: uint32(bytes, payload, false), height: uint32(bytes, payload + 4, false) };
      const bitDepth = bytes[payload + 8];
      colorType = bytes[payload + 9];
      const depths = new Map([
        [0, new Set([1, 2, 4, 8, 16])],
        [2, new Set([8, 16])],
        [3, new Set([1, 2, 4, 8])],
        [4, new Set([8, 16])],
        [6, new Set([8, 16])],
      ]);
      require(dimensions.width > 0 && dimensions.height > 0 && depths.get(colorType)?.has(bitDepth), "IMAGE_MEDIA_MISMATCH", "PNG dimensions, color type, or bit depth are invalid.");
      require(bytes[payload + 10] === 0 && bytes[payload + 11] === 0 && (bytes[payload + 12] === 0 || bytes[payload + 12] === 1), "IMAGE_MEDIA_MISMATCH", "PNG compression, filtering, or interlace method is invalid.");
    } else if (["acTL", "fcTL", "fdAT"].includes(type)) throw new NVersionError("IMAGE_ANIMATION_UNSUPPORTED", "Animated PNG is unsupported.");
    else if (type === "PLTE") {
      require(!sawPalette && !sawImageData && length > 0 && length % 3 === 0 && length <= 768, "IMAGE_MEDIA_MISMATCH", "PNG palette is invalid or out of order.");
      sawPalette = true;
    } else if (type === "IDAT") {
      require(!imageDataEnded && length > 0, "IMAGE_MEDIA_MISMATCH", "PNG image-data chunks must be nonempty and consecutive.");
      sawImageData = true;
    } else if (type === "IEND") {
      require(length === 0 && sawImageData && end + 4 === bytes.length, "IMAGE_MEDIA_MISMATCH", "PNG IEND is invalid.");
      sawEnd = true;
    } else {
      if (sawImageData) imageDataEnded = true;
      require(type !== "IHDR" && !(type.charCodeAt(0) >= 65 && type.charCodeAt(0) <= 90), "IMAGE_MEDIA_MISMATCH", `PNG critical chunk ${type} is unsupported.`);
    }
    offset = end + 4;
    if (sawEnd) break;
  }
  require(sawEnd && sawImageData && (colorType !== 3 || sawPalette), "IMAGE_MEDIA_MISMATCH", "PNG is incomplete.");
  return dimensions;
}

function webpDimensions(bytes) {
  require(bytes.length >= 26 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP" && uint32(bytes, 4, true) + 8 === bytes.length, "IMAGE_MEDIA_MISMATCH", "WebP RIFF envelope is invalid.");
  let offset = 12;
  let canvas = null;
  let primary = null;
  let primaryType = null;
  const auxiliary = new Set(["ALPH", "ICCP", "EXIF", "XMP "]);
  while (offset < bytes.length) {
    require(offset + 8 <= bytes.length, "IMAGE_MEDIA_MISMATCH", "WebP chunk is truncated.");
    const type = ascii(bytes, offset, 4);
    const length = uint32(bytes, offset + 4, true);
    const payload = offset + 8;
    const end = payload + length;
    require(Number.isSafeInteger(end) && end <= bytes.length && end + (length & 1) <= bytes.length, "IMAGE_MEDIA_MISMATCH", `WebP ${type} exceeds the RIFF envelope.`);
    if (length & 1) require(bytes[end] === 0, "IMAGE_MEDIA_MISMATCH", `WebP ${type} padding is nonzero.`);
    if (type === "VP8X") {
      require(offset === 12 && length === 10 && !canvas && !primary, "IMAGE_MEDIA_MISMATCH", "WebP VP8X is invalid.");
      require((bytes[payload] & 0x02) === 0, "IMAGE_ANIMATION_UNSUPPORTED", "Animated WebP is unsupported.");
      require((bytes[payload] & 0xc1) === 0 && bytes[payload + 1] === 0 && bytes[payload + 2] === 0 && bytes[payload + 3] === 0, "IMAGE_MEDIA_MISMATCH", "WebP VP8X reserved bits are invalid.");
      canvas = { width: uint24Le(bytes, payload + 4) + 1, height: uint24Le(bytes, payload + 7) + 1 };
    } else if (type === "VP8L") {
      require(!primary && length >= 6 && bytes[payload] === 0x2f, "IMAGE_MEDIA_MISMATCH", "WebP VP8L is invalid.");
      const bits = uint32(bytes, payload + 1, true);
      require((bits >>> 29) === 0, "IMAGE_MEDIA_MISMATCH", "WebP VP8L version is invalid.");
      primary = { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
      primaryType = type;
    } else if (type === "VP8 ") {
      require(!primary && length >= 11, "IMAGE_MEDIA_MISMATCH", "WebP VP8 frame is truncated or duplicated.");
      const frameTag = bytes[payload] | (bytes[payload + 1] << 8) | (bytes[payload + 2] << 16);
      const firstPartitionLength = frameTag >>> 5;
      require((frameTag & 1) === 0 && (frameTag & 0x10) !== 0 && firstPartitionLength > 0 && 10 + firstPartitionLength <= length, "IMAGE_MEDIA_MISMATCH", "WebP VP8 frame tag is invalid.");
      require(bytes[payload + 3] === 0x9d && bytes[payload + 4] === 1 && bytes[payload + 5] === 0x2a, "IMAGE_MEDIA_MISMATCH", "WebP VP8 key-frame header is invalid.");
      const view = new DataView(bytes.buffer, bytes.byteOffset + payload + 6, 4);
      primary = { width: view.getUint16(0, true) & 0x3fff, height: view.getUint16(2, true) & 0x3fff };
      require(primary.width > 0 && primary.height > 0, "IMAGE_MEDIA_MISMATCH", "WebP VP8 dimensions are invalid.");
      primaryType = type;
    } else require(canvas && auxiliary.has(type), "IMAGE_MEDIA_MISMATCH", `WebP chunk ${type} is unsupported.`);
    offset = end + (length & 1);
  }
  require(offset === bytes.length && primary && primary.width > 0 && primary.height > 0, "IMAGE_MEDIA_MISMATCH", "WebP primary image is missing.");
  if (canvas) require(canvas.width === primary.width && canvas.height === primary.height, "IMAGE_MEDIA_MISMATCH", `WebP canvas and ${primaryType} dimensions disagree.`);
  return canvas ?? primary;
}

function splitTopLevel(value, delimiter) {
  const output = [];
  let start = 0;
  let quote = "";
  let parens = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quote) { if (character === quote) quote = ""; continue; }
    if (character === '"' || character === "'") quote = character;
    else if (character === "(") parens += 1;
    else if (character === ")") { parens -= 1; require(parens >= 0, "UNSAFE_CSS", "CSS has unmatched parentheses."); }
    else if (character === delimiter && parens === 0) { output.push(value.slice(start, index)); start = index + 1; }
  }
  require(!quote && parens === 0, "UNSAFE_CSS", "CSS has unterminated strings or functions.");
  output.push(value.slice(start));
  return output;
}

function declarationColon(value) {
  let quote = "";
  let parens = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quote) { if (character === quote) quote = ""; continue; }
    if (character === '"' || character === "'") quote = character;
    else if (character === "(") parens += 1;
    else if (character === ")") parens -= 1;
    else if (character === ":" && parens === 0) return index;
  }
  return -1;
}

export function validateStylesheet(bytes, binding, resources, limits) {
  require(bytes.length <= limits.maxCssBytes, "CSS_SIZE_LIMIT", "Stylesheet exceeds its byte limit.");
  let css;
  try { css = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new NVersionError("MALFORMED_UTF8", `Stylesheet ${binding.id} is not strict UTF-8.`); }
  require(!css.includes("\\"), "UNSAFE_CSS_ESCAPE", "Stylesheet contains a CSS escape.");
  require(!css.includes("/*") && !css.includes("*/"), "UNSAFE_CSS_COMMENT", "Stylesheet contains a CSS comment.");
  require(!css.includes("@"), "UNSAFE_CSS_AT_RULE", "Stylesheet contains an at-rule.");
  require(!css.includes("<!--") && !css.includes("-->"), "UNSAFE_CSS", "Stylesheet contains CDO/CDC syntax.");
  const tokens = new Map(binding.assetTokens.map((entry) => [entry.token, entry.resource]));
  const used = new Set();
  let cursor = 0;
  let rules = 0;
  let selectors = 0;
  let declarations = 0;
  while (cursor < css.length) {
    while (/\s/u.test(css[cursor] ?? "")) cursor += 1;
    if (cursor === css.length) break;
    const open = css.indexOf("{", cursor);
    require(open >= 0, "UNSAFE_CSS", "Stylesheet rule is truncated.");
    const selectorText = css.slice(cursor, open);
    for (const raw of splitTopLevel(selectorText, ",")) {
      const selector = raw.trim();
      selectors += 1;
      require(selector.length > 0 && new TextEncoder().encode(selector).length <= limits.maxCssSelectorBytes, "CSS_SELECTOR_LIMIT", "CSS selector is empty or over limit.");
      require(selector.startsWith(binding.scope), "CSS_SCOPE_ESCAPE", "Selector does not begin with its declared scope.");
      const suffix = selector.slice(binding.scope.length).trimStart();
      require(!suffix.startsWith("+") && !suffix.startsWith("~") && !suffix.startsWith("||"), "CSS_SCOPE_ESCAPE", "Selector escapes through a sibling combinator.");
    }
    const close = css.indexOf("}", open + 1);
    const nestedOpen = css.indexOf("{", open + 1);
    require(close >= 0 && (nestedOpen === -1 || nestedOpen > close), "UNSAFE_CSS_NESTING", "Nested CSS is forbidden.");
    const block = css.slice(open + 1, close);
    for (const raw of splitTopLevel(block, ";")) {
      if (!raw.trim()) continue;
      declarations += 1;
      const colon = declarationColon(raw);
      require(colon > 0, "UNSAFE_CSS", "CSS declaration is malformed.");
      const property = raw.slice(0, colon).trim().toLowerCase();
      const value = raw.slice(colon + 1).trim();
      require(CSS_PROPERTIES.has(property) && value.length > 0, "UNSAFE_CSS_PROPERTY", `CSS property ${property} is unsupported.`);
      const functionPattern = /([A-Za-z][A-Za-z0-9-]*)\s*\(/gy;
      for (let index = 0; index < value.length;) {
        const quote = value[index] === '"' || value[index] === "'" ? value[index] : "";
        if (quote) {
          const end = value.indexOf(quote, index + 1);
          require(end >= 0, "UNSAFE_CSS", "CSS string is unterminated.");
          index = end + 1;
          continue;
        }
        functionPattern.lastIndex = index;
        const match = functionPattern.exec(value);
        if (!match) { index += 1; continue; }
        const name = match[1].toLowerCase();
        require(CSS_FUNCTIONS.has(name), "UNSAFE_CSS_FUNCTION", `CSS function ${name} is unsupported.`);
        if (name === "url") {
          const end = value.indexOf(")", functionPattern.lastIndex);
          require(end >= 0, "UNSAFE_CSS_URL", "CSS url() is truncated.");
          let token = value.slice(functionPattern.lastIndex, end).trim();
          if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))) token = token.slice(1, -1);
          require(token.startsWith("dom-asset:"), "UNSAFE_CSS", "CSS url() is not a logical asset token.");
          require(tokens.has(token) && resources.get(tokens.get(token))?.kind === "image", "UNBOUND_CSS_URL", `CSS token ${token} is not declared.`);
          used.add(token);
          index = end + 1;
        } else index = functionPattern.lastIndex;
      }
    }
    rules += 1;
    require(rules <= limits.maxCssRules && selectors <= limits.maxCssSelectors && declarations <= limits.maxCssDeclarations, "CSS_STRUCTURE_LIMIT", "Stylesheet structure exceeds limits.");
    cursor = close + 1;
  }
  require([...tokens.keys()].every((token) => used.has(token)), "UNUSED_CSS_TOKEN", "A declared CSS token is unused.");
  return css;
}

function imageDimensions(bytes, mediaType) {
  return mediaType === "image/png" ? pngDimensions(bytes) : webpDimensions(bytes);
}

export async function verifyResources(document, records, options, limits) {
  const bytesById = new Map();
  for (const record of records.values()) {
    let value = options.externalResources?.get?.(record.id);
    if (value === undefined && typeof options.loadResource === "function") value = await options.loadResource(record);
    require(value !== undefined, "MISSING_EXTERNAL_RESOURCE", `External resource ${record.id} is unavailable.`);
    const bytes = value instanceof Uint8Array ? value.slice() : value instanceof ArrayBuffer ? new Uint8Array(value) : ArrayBuffer.isView(value) ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice() : null;
    require(bytes, "INVALID_RESOURCE_BYTES", `External resource ${record.id} is not bytes.`);
    bytesById.set(record.id, bytes);
  }
  for (const record of records.values()) {
    const bytes = bytesById.get(record.id);
    require(bytes.length === record.byteLength, "RESOURCE_SIZE_MISMATCH", `Resource ${record.id} has the wrong length.`);
    require(await sha256(bytes) === record.digest.value, "RESOURCE_DIGEST_MISMATCH", `Resource ${record.id} has the wrong digest.`);
    if (record.kind === "image") {
      const dimensions = imageDimensions(bytes, record.mediaType);
      require(dimensions.width === record.dimensions.width && dimensions.height === record.dimensions.height, "IMAGE_DIMENSION_MISMATCH", `Resource ${record.id} dimensions disagree.`);
    }
  }
  for (const binding of document.cssBinding.stylesheets) validateStylesheet(bytesById.get(binding.resource), binding, records, limits);
  return bytesById;
}
