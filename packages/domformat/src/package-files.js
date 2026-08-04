import { lstat, mkdir, open, realpath, rmdir, unlink } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { invariant } from "./errors.js";
import { ensureRealDirectory } from "./path-security.js";

function inside(base, target) {
  return target === base || target.startsWith(`${base}${sep}`);
}

function assertSeparatedOutputs(entries) {
  const targets = entries.map(({ target }) => resolve(target).toLowerCase());
  for (let left = 0; left < targets.length; left += 1) {
    for (let right = left + 1; right < targets.length; right += 1) {
      invariant(
        targets[left] !== targets[right]
        && !targets[left].startsWith(`${targets[right]}${sep}`)
        && !targets[right].startsWith(`${targets[left]}${sep}`),
        "OUTPUT_COLLISION",
        "The JSON document and resource output paths are not physically distinct on supported filesystems.",
      );
    }
  }
}

async function outputMustBeAbsent(path) {
  try {
    await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  invariant(false, "OUTPUT_EXISTS", `Refusing to overwrite ${path}.`);
}

async function createOutputParents(base, entries, createdDirectories) {
  const realBase = await ensureRealDirectory(base, "UNSAFE_OUTPUT_PATH", "Selected package directory", createdDirectories);
  const parents = [...new Set(entries.map(({ target }) => dirname(target)))].sort();
  for (const parent of parents) {
    const relativeParent = relative(base, parent);
    invariant(relativeParent === "" || (!relativeParent.startsWith(`..${sep}`) && relativeParent !== ".."), "UNSAFE_OUTPUT_PATH", `Output ${parent} escapes the selected package directory.`);
    let current = base;
    for (const segment of relativeParent === "" ? [] : relativeParent.split(sep)) {
      current = join(current, segment);
      try {
        const metadata = await lstat(current);
        invariant(metadata.isDirectory() && !metadata.isSymbolicLink(), "UNSAFE_OUTPUT_PATH", `Output directory ${current} must be a real directory, not a symbolic link.`);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
        await mkdir(current);
        createdDirectories.push(current);
      }
    }
    const resolvedParent = await realpath(parent);
    invariant(inside(realBase, resolvedParent), "UNSAFE_OUTPUT_PATH", `Output directory ${parent} resolves outside the selected package directory.`);
  }
}

async function writeNew(path, bytes, created) {
  const handle = await open(path, "wx");
  created.push(path);
  try {
    await handle.writeFile(bytes);
  } finally {
    await handle.close();
  }
}

export async function writeDomFiles(output, built) {
  const documentTarget = resolve(output);
  const base = dirname(documentTarget);
  const entries = [...built.externalResources].map(([path, bytes]) => ({
    target: join(base, ...path.split("/")),
    bytes,
  }));
  entries.push({ target: documentTarget, bytes: built.bytes });
  assertSeparatedOutputs(entries);
  for (const { target } of entries) await outputMustBeAbsent(target);

  const created = [];
  const createdDirectories = [];
  try {
    await createOutputParents(base, entries, createdDirectories);
    for (const { target } of entries) await outputMustBeAbsent(target);
    // Publish the JSON document last so its complete resource set already exists.
    for (const { target, bytes } of entries) await writeNew(target, bytes, created);
  } catch (error) {
    for (const target of created.reverse()) {
      try { await unlink(target); } catch {}
    }
    for (const directory of createdDirectories.reverse()) {
      try { await rmdir(directory); } catch {}
    }
    throw error;
  }
}
