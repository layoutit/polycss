import { invariant } from "../errors.js";

export function checkedF32(value, code = "INVALID_NUMERIC_PUBLICATION", label = "Prepared numeric result") {
  const rounded = Math.fround(value);
  invariant(Number.isFinite(rounded), code, `${label} is not a finite IEEE-754 binary32 value.`);
  return rounded;
}

export function cssNumber(value) {
  invariant(Number.isFinite(value), "INVALID_STYLE_PUBLICATION", "A prepared CSS number is non-finite.");
  const rounded = Math.round(value * 1e6) / 1e6;
  invariant(Number.isFinite(rounded), "INVALID_STYLE_PUBLICATION", "A prepared CSS number overflows during formatting.");
  return String(Object.is(rounded, -0) ? 0 : rounded);
}
