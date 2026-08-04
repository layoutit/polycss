export class DomFormatError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "DomFormatError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export function fail(code, message, details) {
  throw new DomFormatError(code, message, details);
}

export function invariant(condition, code, message, details) {
  if (!condition) fail(code, message, details);
}
