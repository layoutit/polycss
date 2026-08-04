import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { readDomFile } from "../src/reader.js";
import { buildDom } from "../src/writer.js";
import { errorCode, projectRoot, syntheticInput } from "./helpers.js";

async function writeSplitPackage(root, built, overrides = new Map()) {
  const packageDirectory = join(root, "package");
  const model = join(packageDirectory, "synthetic.json");
  await mkdir(packageDirectory, { recursive: true });
  await writeFile(model, built.bytes);
  for (const [relative, bytes] of built.externalResources) {
    if (overrides.has(relative)) continue;
    const target = join(packageDirectory, ...relative.split("/"));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes);
  }
  return { model, packageDirectory };
}

test("file reader rejects an oversized package from metadata before parsing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "domformat-file-limit-"));
  try {
    const built = buildDom(await syntheticInput());
    const file = join(directory, "synthetic.json");
    await writeFile(file, built.bytes);
    await assert.rejects(
      readDomFile(file, { limits: { maxFileBytes: built.bytes.length - 1 } }),
      errorCode("FILE_LIMIT"),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("file readers reject sibling-resource symlink escapes outside the document directory", async () => {
  const directory = await mkdtemp(join(tmpdir(), "domformat-symlink-"));
  try {
    const built = buildDom(await syntheticInput());
    const checkerRecord = built.document.resources.resources.find((record) => record.id === "checker");
    const checkerBytes = built.externalResources.get(checkerRecord.path);
    const { model, packageDirectory } = await writeSplitPackage(
      directory,
      built,
      new Map([[checkerRecord.path, true]]),
    );
    const outside = join(directory, "outside-checker.png");
    const target = join(packageDirectory, ...checkerRecord.path.split("/"));
    await writeFile(outside, checkerBytes);
    await mkdir(dirname(target), { recursive: true });
    await symlink(outside, target);

    await assert.rejects(readDomFile(model), errorCode("UNSAFE_RESOURCE_PATH"));
    const python = spawnSync("python3", ["-B", "conformance/reader.py", "validate", model], {
      cwd: projectRoot,
      encoding: "utf8",
    });
    assert.notEqual(python.status, 0);
    assert.match(python.stderr, /UNSAFE_RESOURCE_PATH/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("file readers reject symlinked sibling path components even when they stay inside the document directory", async () => {
  const directory = await mkdtemp(join(tmpdir(), "domformat-component-link-"));
  try {
    const built = buildDom(await syntheticInput());
    const { model, packageDirectory } = await writeSplitPackage(directory, built);
    await rename(join(packageDirectory, "assets"), join(packageDirectory, "real-assets"));
    await symlink("real-assets", join(packageDirectory, "assets"));

    await assert.rejects(readDomFile(model), errorCode("UNSAFE_RESOURCE_PATH"));
    const python = spawnSync("python3", ["-B", "conformance/reader.py", "validate", model], {
      cwd: projectRoot,
      encoding: "utf8",
    });
    assert.notEqual(python.status, 0);
    assert.match(python.stderr, /UNSAFE_RESOURCE_PATH/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("file readers reject recorded-size mismatch before reading sibling resource contents", async () => {
  const directory = await mkdtemp(join(tmpdir(), "domformat-resource-size-"));
  try {
    const built = buildDom(await syntheticInput());
    const checkerRecord = built.document.resources.resources.find((record) => record.id === "checker");
    const { model, packageDirectory } = await writeSplitPackage(directory, built);
    const target = join(packageDirectory, ...checkerRecord.path.split("/"));
    const oversized = new Uint8Array(checkerRecord.byteLength + 1);
    await writeFile(target, oversized);

    await assert.rejects(readDomFile(model), errorCode("RESOURCE_SIZE_MISMATCH"));
    const python = spawnSync("python3", ["-B", "conformance/reader.py", "validate", model], {
      cwd: projectRoot,
      encoding: "utf8",
    });
    assert.notEqual(python.status, 0);
    assert.match(python.stderr, /RESOURCE_SIZE_MISMATCH/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("file readers report a missing sibling resource without leaking raw filesystem errors", async () => {
  const directory = await mkdtemp(join(tmpdir(), "domformat-resource-missing-"));
  try {
    const built = buildDom(await syntheticInput());
    const checkerRecord = built.document.resources.resources.find((record) => record.id === "checker");
    const { model, packageDirectory } = await writeSplitPackage(directory, built);
    await rm(join(packageDirectory, ...checkerRecord.path.split("/")));

    await assert.rejects(readDomFile(model), errorCode("MISSING_EXTERNAL_RESOURCE"));
    const python = spawnSync("python3", ["-B", "conformance/reader.py", "validate", model], {
      cwd: projectRoot,
      encoding: "utf8",
    });
    assert.equal(python.status, 1);
    assert.match(python.stderr, /MISSING_EXTERNAL_RESOURCE/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
