import { invariant } from "./errors.js";

function isAlphabet(code) {
  return (code >= 0x41 && code <= 0x5a)
    || (code >= 0x61 && code <= 0x7a)
    || (code >= 0x30 && code <= 0x39)
    || code === 0x2b
    || code === 0x2f;
}

export function canonicalBase64DecodedLength(value, label = "Base64 value", code = "INVALID_RESOURCE_BASE64") {
  invariant(typeof value === "string" && value.length % 4 === 0, code, `${label} is not canonical base64.`);
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const bodyLength = value.length - padding;
  for (let index = 0; index < bodyLength; index += 1) {
    invariant(isAlphabet(value.charCodeAt(index)), code, `${label} is not canonical base64.`);
  }
  for (let index = bodyLength; index < value.length; index += 1) {
    invariant(value.charCodeAt(index) === 0x3d, code, `${label} is not canonical base64.`);
  }
  invariant(
    padding === 0 || (value.length >= 4 && bodyLength % 4 === (padding === 2 ? 2 : 3)),
    code,
    `${label} is not canonical base64.`,
  );
  return value.length / 4 * 3 - padding;
}
