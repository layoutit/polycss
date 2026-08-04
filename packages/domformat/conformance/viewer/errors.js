// This implementation is intentionally independent of src/.  It is a second
// executable consumer of the normative domformat contract, not a public API.
export class ConformanceViewerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ConformanceViewerError";
    this.code = code;
  }
}

export function requireContract(condition, code, message) {
  if (!condition) throw new ConformanceViewerError(code, message);
}
