import { DEFAULT_LIMITS } from "./constants.js";
import { rewriteCss, validateCssClosure } from "./css.js";
import { invariant } from "./errors.js";
import { crc32 } from "./crc32.js";

const RESOURCE_ID = /^[a-z][a-z0-9._-]{0,63}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/u;
const SUPPORTED_MEDIA_TYPES = new Set([
  "image/png",
  "image/webp",
  "text/css;charset=utf-8",
]);

function plainRecord(value, code, label) {
  invariant(value && typeof value === "object" && !Array.isArray(value), code, `${label} must be an object.`);
  const prototype = Object.getPrototypeOf(value);
  invariant(prototype === Object.prototype || prototype === null, code, `${label} must be a plain object.`);
  return value;
}

function knownRecordKeys(value, allowed, code, label) {
  for (const key in value) {
    if (Object.hasOwn(value, key)) invariant(allowed.has(key), code, `${label} contains unsupported field ${key}.`);
  }
}

export function assertResourceId(value, label = "resource id") {
  invariant(typeof value === "string" && RESOURCE_ID.test(value), "INVALID_RESOURCE_ID", `${label} is invalid.`);
  return value;
}

export function assertSafeRelativePath(value, label = "resource path") {
  invariant(typeof value === "string" && value.length > 0 && value.length <= 240, "UNSAFE_RESOURCE_PATH", `${label} must be a short relative path.`);
  invariant(!value.startsWith("/") && !value.startsWith("\\") && !value.includes("\\"), "UNSAFE_RESOURCE_PATH", `${label} must use portable relative POSIX syntax.`);
  invariant(!value.includes(":") && !value.includes("%") && !value.includes("?") && !value.includes("#"), "UNSAFE_RESOURCE_PATH", `${label} must not be a URL or encoded path.`);
  const segments = value.split("/");
  invariant(segments.every((segment) => {
    const stem = segment.split(".", 1)[0].toLowerCase();
    return segment !== "."
      && segment !== ".."
      && SAFE_SEGMENT.test(segment)
      && !segment.endsWith(".")
      && !WINDOWS_DEVICE.test(stem);
  }), "UNSAFE_RESOURCE_PATH", `${label} contains an unsafe or nonportable segment.`);
  return value;
}

export function validateResourceCatalog(catalog, limits) {
  plainRecord(catalog, "INVALID_RESOURCES", "RCRD");
  knownRecordKeys(catalog, new Set(["version", "resources"]), "INVALID_RESOURCES", "RCRD");
  invariant(catalog.version === 0, "UNSUPPORTED_RESOURCE_SCHEMA", "RCRD schema version must be 0.");
  invariant(Array.isArray(catalog.resources), "INVALID_RESOURCES", "RCRD.resources must be an array.");
  invariant(catalog.resources.length <= limits.maxResources, "RESOURCE_COUNT_LIMIT", `Resource count exceeds ${limits.maxResources}.`);
  const ids = new Set();
  const externalPaths = new Set();
  let previousId = "";
  let aggregateBytes = 0;
  let aggregateImagePixels = 0;
  for (const [index, record] of catalog.resources.entries()) {
    plainRecord(record, "INVALID_RESOURCE", `Resource ${index}`);
    knownRecordKeys(record, new Set(["id", "kind", "mediaType", "byteLength", "dimensions", "digest", "path"]), "INVALID_RESOURCE", `Resource ${index}`);
    const id = assertResourceId(record.id, `Resource ${index} id`);
    invariant(!ids.has(id), "DUPLICATE_RESOURCE_ID", `Resource id ${id} is duplicated.`);
    invariant(id > previousId, "RESOURCE_ORDER", "Resource records must be sorted by id.");
    previousId = id;
    ids.add(id);
    invariant(record.kind === "stylesheet" || record.kind === "image", "INVALID_RESOURCE_KIND", `Resource ${id} has invalid kind ${record.kind}.`);
    invariant(SUPPORTED_MEDIA_TYPES.has(record.mediaType), "UNSUPPORTED_MEDIA_TYPE", `Resource ${id} has unsupported media type ${record.mediaType}.`);
    invariant(
      (record.kind === "stylesheet" && record.mediaType === "text/css;charset=utf-8")
      || (record.kind === "image" && record.mediaType.startsWith("image/")),
      "RESOURCE_KIND_MEDIA_MISMATCH",
      `Resource ${id} kind and media type disagree.`,
    );
    invariant(Number.isSafeInteger(record.byteLength) && record.byteLength >= 0 && record.byteLength <= limits.maxResourceBytes, "INVALID_RESOURCE_SIZE", `Resource ${id} has invalid or excessive byteLength.`);
    aggregateBytes += record.byteLength;
    invariant(aggregateBytes <= limits.maxAggregateResourceBytes, "AGGREGATE_RESOURCE_LIMIT", "Aggregate resource bytes exceed their limit.");
    if (record.kind === "image") {
      plainRecord(record.dimensions, "INVALID_RESOURCE_DIMENSIONS", `Resource ${id} dimensions`);
      knownRecordKeys(record.dimensions, new Set(["width", "height"]), "INVALID_RESOURCE_DIMENSIONS", `Resource ${id} dimensions`);
      invariant(
        Number.isSafeInteger(record.dimensions?.width)
        && Number.isSafeInteger(record.dimensions?.height)
        && record.dimensions.width > 0
        && record.dimensions.height > 0
        && record.dimensions.width <= limits.maxImageWidth
        && record.dimensions.height <= limits.maxImageHeight
        && record.dimensions.width * record.dimensions.height <= limits.maxImagePixels,
        "IMAGE_DIMENSION_LIMIT",
        `Resource ${id} image dimensions are invalid or excessive.`,
      );
      aggregateImagePixels += record.dimensions.width * record.dimensions.height;
      invariant(
        aggregateImagePixels <= limits.maxAggregateImagePixels,
        "AGGREGATE_IMAGE_PIXEL_LIMIT",
        "Aggregate decoded image pixels exceed their limit.",
      );
    } else {
      invariant(record.dimensions === undefined, "UNEXPECTED_RESOURCE_DIMENSIONS", `Non-image resource ${id} must not declare dimensions.`);
    }
    plainRecord(record.digest, "INVALID_RESOURCE_DIGEST", `Resource ${id} digest`);
    knownRecordKeys(record.digest, new Set(["algorithm", "value"]), "INVALID_RESOURCE_DIGEST", `Resource ${id} digest`);
    invariant(record.digest.algorithm === "sha256" && typeof record.digest.value === "string" && SHA256.test(record.digest.value), "INVALID_RESOURCE_DIGEST", `Resource ${id} needs a lowercase SHA-256 digest.`);
    assertSafeRelativePath(record.path, `Resource ${id} path`);
    const portablePath = record.path.toLowerCase();
    invariant(!externalPaths.has(portablePath), "DUPLICATE_RESOURCE_PATH", `External resource path ${record.path} has a case-insensitive alias.`);
    for (const existing of externalPaths) {
      invariant(
        !portablePath.startsWith(`${existing}/`) && !existing.startsWith(`${portablePath}/`),
        "RESOURCE_PATH_COLLISION",
        `External resource path ${record.path} has a file/directory collision.`,
      );
    }
    externalPaths.add(portablePath);
  }
  return ids;
}

function ascii(bytes, offset, length) {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

function uint24(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

function uint32Le(bytes, offset) {
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, true);
}

function uint32Be(bytes, offset) {
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, false);
}

function pngDimensions(bytes) {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  invariant(bytes.length >= 45 && signature.every((byte, index) => bytes[index] === byte), "IMAGE_MEDIA_MISMATCH", "PNG resource has an invalid signature or is truncated.");
  let offset = 8;
  let dimensions;
  let sawPalette = false;
  let sawImageData = false;
  let imageDataEnded = false;
  let sawEnd = false;
  let colorType;
  while (offset < bytes.length) {
    invariant(offset + 12 <= bytes.length, "IMAGE_MEDIA_MISMATCH", "PNG chunk header is truncated.");
    const length = uint32Be(bytes, offset);
    const type = ascii(bytes, offset + 4, 4);
    const payloadStart = offset + 8;
    const payloadEnd = payloadStart + length;
    invariant(Number.isSafeInteger(payloadEnd) && payloadEnd + 4 <= bytes.length, "IMAGE_MEDIA_MISMATCH", `PNG ${type} chunk exceeds the resource bytes.`);
    const expectedCrc = uint32Be(bytes, payloadEnd);
    invariant(crc32(bytes.subarray(offset + 4, payloadEnd)) === expectedCrc, "IMAGE_MEDIA_MISMATCH", `PNG ${type} chunk CRC is invalid.`);
    if (!dimensions) {
      invariant(type === "IHDR" && length === 13, "IMAGE_MEDIA_MISMATCH", "PNG IHDR must be the first chunk and exactly 13 bytes.");
      const width = uint32Be(bytes, payloadStart);
      const height = uint32Be(bytes, payloadStart + 4);
      const bitDepth = bytes[payloadStart + 8];
      colorType = bytes[payloadStart + 9];
      const validDepths = new Map([
        [0, new Set([1, 2, 4, 8, 16])],
        [2, new Set([8, 16])],
        [3, new Set([1, 2, 4, 8])],
        [4, new Set([8, 16])],
        [6, new Set([8, 16])],
      ]);
      invariant(width > 0 && height > 0 && validDepths.get(colorType)?.has(bitDepth), "IMAGE_MEDIA_MISMATCH", "PNG IHDR dimensions, color type, or bit depth are invalid.");
      invariant(bytes[payloadStart + 10] === 0 && bytes[payloadStart + 11] === 0 && (bytes[payloadStart + 12] === 0 || bytes[payloadStart + 12] === 1), "IMAGE_MEDIA_MISMATCH", "PNG IHDR compression, filtering, or interlace method is unsupported.");
      dimensions = { width, height };
    } else if (type === "IHDR") {
      invariant(false, "IMAGE_MEDIA_MISMATCH", "PNG contains a duplicate IHDR chunk.");
    } else if (type === "PLTE") {
      invariant(!sawPalette && !sawImageData && length > 0 && length % 3 === 0 && length <= 768, "IMAGE_MEDIA_MISMATCH", "PNG palette chunk is invalid or out of order.");
      sawPalette = true;
    } else if (type === "IDAT") {
      invariant(!imageDataEnded && length > 0, "IMAGE_MEDIA_MISMATCH", "PNG image-data chunks must be nonempty and consecutive.");
      sawImageData = true;
    } else if (type === "IEND") {
      invariant(length === 0 && sawImageData && payloadEnd + 4 === bytes.length, "IMAGE_MEDIA_MISMATCH", "PNG IEND is invalid, early, or followed by trailing bytes.");
      sawEnd = true;
    } else if (type === "acTL" || type === "fcTL" || type === "fdAT") {
      invariant(false, "IMAGE_ANIMATION_UNSUPPORTED", "Animated PNG resources are outside polycss-3d@0.");
    } else {
      if (sawImageData) imageDataEnded = true;
      const critical = type.charCodeAt(0) >= 0x41 && type.charCodeAt(0) <= 0x5a;
      invariant(!critical, "IMAGE_MEDIA_MISMATCH", `PNG critical chunk ${type} is unsupported.`);
    }
    offset = payloadEnd + 4;
    if (sawEnd) break;
  }
  invariant(sawEnd && sawImageData && (colorType !== 3 || sawPalette), "IMAGE_MEDIA_MISMATCH", "PNG is missing required image, palette, or end chunks.");
  return dimensions;
}

function webpDimensions(bytes) {
  invariant(bytes.length >= 26 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP", "IMAGE_MEDIA_MISMATCH", "WebP resource has invalid RIFF/WEBP magic or is truncated.");
  const riffSize = new DataView(bytes.buffer, bytes.byteOffset + 4, 4).getUint32(0, true);
  invariant(riffSize + 8 === bytes.length, "IMAGE_MEDIA_MISMATCH", "WebP RIFF length does not match resource bytes.");
  let offset = 12;
  let extended;
  let primary;
  let primaryType;
  const allowedAuxiliary = new Set(["ALPH", "ICCP", "EXIF", "XMP "]);
  while (offset < bytes.length) {
    invariant(offset + 8 <= bytes.length, "IMAGE_MEDIA_MISMATCH", "WebP chunk header is truncated.");
    const type = ascii(bytes, offset, 4);
    const length = uint32Le(bytes, offset + 4);
    const payload = offset + 8;
    const end = payload + length;
    invariant(Number.isSafeInteger(end) && end <= bytes.length && end + (length & 1) <= bytes.length, "IMAGE_MEDIA_MISMATCH", `WebP ${type} chunk exceeds the RIFF bytes.`);
    if (length & 1) invariant(bytes[end] === 0, "IMAGE_MEDIA_MISMATCH", `WebP ${type} padding byte must be zero.`);
    if (type === "VP8X") {
      invariant(offset === 12 && length === 10 && !extended && !primary, "IMAGE_MEDIA_MISMATCH", "WebP VP8X chunk is duplicated, misplaced, or malformed.");
      const flags = bytes[payload];
      invariant((flags & 0xc3) === 0 && bytes[payload + 1] === 0 && bytes[payload + 2] === 0 && bytes[payload + 3] === 0, "IMAGE_MEDIA_MISMATCH", "WebP VP8X reserved bits are nonzero or animation is requested.");
      extended = { width: uint24(bytes, payload + 4) + 1, height: uint24(bytes, payload + 7) + 1 };
    } else if (type === "VP8L") {
      invariant(!primary && length >= 6 && bytes[payload] === 0x2f, "IMAGE_MEDIA_MISMATCH", "WebP VP8L image chunk is duplicated or malformed.");
      const bits = uint32Le(bytes, payload + 1);
      invariant((bits >>> 29) === 0, "IMAGE_MEDIA_MISMATCH", "WebP VP8L version bits are unsupported.");
      primary = { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
      primaryType = type;
    } else if (type === "VP8 ") {
      invariant(!primary && length >= 11, "IMAGE_MEDIA_MISMATCH", "WebP VP8 image chunk is duplicated or truncated.");
      const frameTag = bytes[payload] | (bytes[payload + 1] << 8) | (bytes[payload + 2] << 16);
      const firstPartitionLength = frameTag >>> 5;
      invariant((frameTag & 1) === 0 && (frameTag & 0x10) !== 0 && firstPartitionLength > 0 && 10 + firstPartitionLength <= length, "IMAGE_MEDIA_MISMATCH", "WebP VP8 frame tag or first partition is invalid.");
      invariant(bytes[payload + 3] === 0x9d && bytes[payload + 4] === 0x01 && bytes[payload + 5] === 0x2a, "IMAGE_MEDIA_MISMATCH", "WebP VP8 key-frame header is invalid.");
      const view = new DataView(bytes.buffer, bytes.byteOffset + payload + 6, 4);
      primary = { width: view.getUint16(0, true) & 0x3fff, height: view.getUint16(2, true) & 0x3fff };
      invariant(primary.width > 0 && primary.height > 0, "IMAGE_MEDIA_MISMATCH", "WebP VP8 dimensions are invalid.");
      primaryType = type;
    } else {
      invariant(allowedAuxiliary.has(type), "IMAGE_MEDIA_MISMATCH", `WebP chunk ${type} is unsupported by polycss-3d@0.`);
      invariant(extended, "IMAGE_MEDIA_MISMATCH", `WebP auxiliary chunk ${type} requires VP8X.`);
    }
    offset = end + (length & 1);
  }
  invariant(offset === bytes.length && primary, "IMAGE_MEDIA_MISMATCH", "WebP has no complete primary image bitstream.");
  if (extended) invariant(extended.width === primary.width && extended.height === primary.height, "IMAGE_MEDIA_MISMATCH", `WebP VP8X canvas and ${primaryType} dimensions disagree.`);
  return extended ?? primary;
}

export function imageDimensions(bytes, mediaType) {
  if (mediaType === "image/png") return pngDimensions(bytes);
  if (mediaType === "image/webp") return webpDimensions(bytes);
  invariant(false, "UNSUPPORTED_MEDIA_TYPE", `Cannot inspect image media type ${mediaType}.`);
}

export function validateResourceBytes(record, bytes, limits) {
  invariant(bytes.length === record.byteLength, "RESOURCE_SIZE_MISMATCH", `Resource ${record.id} byte length does not match RCRD.`);
  if (record.kind === "image") {
    const dimensions = imageDimensions(bytes, record.mediaType);
    invariant(
      dimensions.width === record.dimensions.width && dimensions.height === record.dimensions.height,
      "IMAGE_DIMENSION_MISMATCH",
      `Resource ${record.id} decoded header dimensions do not match RCRD.`,
    );
    invariant(
      dimensions.width <= limits.maxImageWidth
      && dimensions.height <= limits.maxImageHeight
      && dimensions.width * dimensions.height <= limits.maxImagePixels,
      "IMAGE_DIMENSION_LIMIT",
      `Resource ${record.id} exceeds image dimension limits.`,
    );
  }
}

export function validateCssBytes(bytes, binding, resources, limits) {
  invariant(bytes.length <= limits.maxCssBytes, "CSS_SIZE_LIMIT", `Stylesheet exceeds ${limits.maxCssBytes} bytes.`);
  let css;
  try {
    css = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    invariant(false, "MALFORMED_UTF8", `Stylesheet ${binding.id} is not valid UTF-8.`);
  }
  validateCssClosure(css, binding, resources, limits);
  return css;
}

export function materializeCss(css, binding, urls, options = {}) {
  return rewriteCss(css, binding, urls, options, options.limits ?? DEFAULT_LIMITS);
}
