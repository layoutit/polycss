import { constants as fsConstants } from "node:fs";
import { open } from "node:fs/promises";
import { invariant } from "./errors.js";

export async function readCappedFile(path, options) {
  const flags = fsConstants.O_RDONLY | (options.noFollow ? (fsConstants.O_NOFOLLOW ?? 0) : 0);
  const handle = await open(path, flags);
  try {
    const metadata = await handle.stat();
    invariant(metadata.isFile(), "UNSAFE_FILE_TYPE", `${options.label} is not a regular file.`);
    invariant(Number.isSafeInteger(metadata.size) && metadata.size >= 0, options.limitCode, `${options.label} has an invalid size.`);
    if (options.expectedLength !== undefined) {
      invariant(metadata.size === options.expectedLength, options.mismatchCode, `${options.label} size does not match its package record.`);
    }
    invariant(metadata.size <= options.maximum, options.limitCode, `${options.label} exceeds its byte limit.`);
    const bytes = new Uint8Array(metadata.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      invariant(bytesRead > 0, "FILE_CHANGED_DURING_READ", `${options.label} changed while it was read.`);
      offset += bytesRead;
    }
    const extra = new Uint8Array(1);
    const { bytesRead: extraBytes } = await handle.read(extra, 0, 1, offset);
    invariant(extraBytes === 0, "FILE_CHANGED_DURING_READ", `${options.label} grew while it was read.`);
    const finalMetadata = await handle.stat();
    invariant(
      finalMetadata.dev === metadata.dev
      && finalMetadata.ino === metadata.ino
      && finalMetadata.size === metadata.size
      && finalMetadata.mtimeMs === metadata.mtimeMs
      && finalMetadata.ctimeMs === metadata.ctimeMs,
      "FILE_CHANGED_DURING_READ",
      `${options.label} metadata changed while it was read.`,
    );
    return Object.freeze({ bytes, metadata });
  } finally {
    await handle.close();
  }
}
