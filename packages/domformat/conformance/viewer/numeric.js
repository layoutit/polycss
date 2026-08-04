import { requireContract } from "./errors.js";

export function f32(value, code = "INVALID_NUMERIC_PUBLICATION", label = "Prepared numeric result") {
  const rounded = Math.fround(value);
  requireContract(Number.isFinite(rounded), code, `${label} is not a finite IEEE-754 binary32 value.`);
  return rounded;
}

export const checkedF32 = f32;

export function cssNumber(value) {
  requireContract(Number.isFinite(value), "INVALID_STYLE_PUBLICATION", "A prepared CSS number is non-finite.");
  const rounded = Math.round(value * 1e6) / 1e6;
  requireContract(Number.isFinite(rounded), "INVALID_STYLE_PUBLICATION", "A prepared CSS number overflows during formatting.");
  return String(Object.is(rounded, -0) ? 0 : rounded);
}
