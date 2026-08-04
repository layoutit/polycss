import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { errorCode, projectRoot, syntheticManifestPath } from "./helpers.js";
import { loadManifest } from "../src/manifest.js";
import { writeDomFiles } from "../src/package-files.js";

const execFileAsync = promisify(execFile);
const cli = join(projectRoot, "bin/domformat.js");

test("CLI encode, validate, inspect, and decode commands run end to end", async () => {
  const root = await mkdtemp(join(tmpdir(), "domformat-cli-"));
  const file = join(root, "synthetic.json");
  const encoded = await execFileAsync(process.execPath, [cli, "encode", syntheticManifestPath, "--output", file]);
  assert.match(encoded.stdout, /wrote .*synthetic\.json/u);
  const validated = await execFileAsync(process.execPath, [cli, "validate", file]);
  assert.match(validated.stdout, /valid domformat@0 polycss-3d@0/u);
  const inspected = await execFileAsync(process.execPath, [cli, "inspect", file, "--json"]);
  const summary = JSON.parse(inspected.stdout);
  assert.equal(summary.tree.nodes, 3);
  const decodedDirectory = join(root, "decoded");
  const decoded = await execFileAsync(process.execPath, [cli, "decode", file, "--output", decodedDirectory]);
  assert.match(decoded.stdout, /decoded domformat@0/u);
  const tree = JSON.parse(await readFile(join(decodedDirectory, "tree.json"), "utf8"));
  assert.equal(tree.nodes.length, 3);
});

test("encode preflights every sibling target and leaves no partial document", async () => {
  const root = await mkdtemp(join(tmpdir(), "domformat-cli-collision-"));
  const assetDirectory = join(root, "assets");
  const existing = join(assetDirectory, "checker.png");
  const model = join(root, "synthetic.json");
  await mkdir(assetDirectory, { recursive: true });
  await writeFile(existing, "user-owned\n");
  await assert.rejects(
    execFileAsync(process.execPath, [cli, "encode", syntheticManifestPath, "--output", model]),
    (error) => /OUTPUT_EXISTS/u.test(error.stderr),
  );
  assert.equal(await readFile(existing, "utf8"), "user-owned\n");
  await assert.rejects(access(model), (error) => error?.code === "ENOENT");
  await assert.rejects(access(join(root, "model.css")), (error) => error?.code === "ENOENT");
});

test("writer rejects case-folded and file-directory output collisions before creating paths", async () => {
  const variants = [
    new Map([["MODEL.JSON", new Uint8Array()]]),
    new Map([["model.json/assets/checker.png", new Uint8Array()]]),
    new Map([["assets", new Uint8Array()], ["assets/checker.png", new Uint8Array()]]),
  ];
  for (const externalResources of variants) {
    const root = await mkdtemp(join(tmpdir(), "domformat-cli-portable-collision-"));
    await assert.rejects(
      writeDomFiles(join(root, "model.json"), { bytes: new Uint8Array(), externalResources }),
      errorCode("OUTPUT_COLLISION"),
    );
    assert.deepEqual(await readdir(root), []);
  }
});

test("encode rejects symlinked resource directories without writing outside the document directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "domformat-cli-output-link-"));
  const outside = await mkdtemp(join(tmpdir(), "domformat-cli-output-outside-"));
  await symlink(outside, join(root, "assets"));
  await assert.rejects(
    execFileAsync(process.execPath, [cli, "encode", syntheticManifestPath, "--output", join(root, "synthetic.json")]),
    (error) => /UNSAFE_OUTPUT_PATH/u.test(error.stderr),
  );
  await assert.rejects(access(join(root, "synthetic.json")), (error) => error?.code === "ENOENT");
  await assert.rejects(access(join(root, "model.css")), (error) => error?.code === "ENOENT");
  await assert.rejects(access(join(outside, "checker.png")), (error) => error?.code === "ENOENT");
});

test("encode rejects a symlink selected as the document base", async () => {
  const root = await mkdtemp(join(tmpdir(), "domformat-cli-base-link-"));
  const realBase = join(root, "real-base");
  const linkedBase = join(root, "linked-base");
  await mkdir(realBase);
  await symlink("real-base", linkedBase);
  await assert.rejects(
    execFileAsync(process.execPath, [cli, "encode", syntheticManifestPath, "--output", join(linkedBase, "synthetic.json")]),
    (error) => /UNSAFE_OUTPUT_PATH/u.test(error.stderr),
  );
  await assert.rejects(access(join(realBase, "synthetic.json")), (error) => error?.code === "ENOENT");
  await assert.rejects(access(join(realBase, "assets", "checker.png")), (error) => error?.code === "ENOENT");
});

test("decode rejects a symlink selected as its output parent", async () => {
  const root = await mkdtemp(join(tmpdir(), "domformat-cli-decode-link-"));
  const file = join(root, "synthetic.json");
  await execFileAsync(process.execPath, [cli, "encode", syntheticManifestPath, "--output", file]);
  const realParent = join(root, "real-parent");
  const linkedParent = join(root, "linked-parent");
  await mkdir(realParent);
  await symlink("real-parent", linkedParent);
  await assert.rejects(
    execFileAsync(process.execPath, [cli, "decode", file, "--output", join(linkedParent, "decoded")]),
    (error) => /UNSAFE_OUTPUT_PATH/u.test(error.stderr),
  );
  await assert.rejects(access(join(realParent, "decoded")), (error) => error?.code === "ENOENT");
});

test("CLI file failures expose a closed diagnostic without paths or stacks", async () => {
  const root = await mkdtemp(join(tmpdir(), "domformat-cli-private-path-"));
  const missing = join(root, "private-name.json");
  await assert.rejects(
    execFileAsync(process.execPath, [cli, "validate", missing]),
    (error) => {
      assert.match(error.stderr, /FILE_NOT_FOUND/u);
      assert.doesNotMatch(error.stderr, /\bat\s+(?:async\s+)?[A-Za-z_$<]/u);
      assert.equal(error.stderr.includes(root), false);
      return true;
    },
  );
});

test("CLI rejects unknown, command-inapplicable, and duplicate flags", async () => {
  for (const args of [
    ["encode", syntheticManifestPath, "--output", "ignored.json", "--json"],
    ["inspect", syntheticManifestPath, "--packed"],
    ["validate", syntheticManifestPath, "--resources", "."],
    ["encode", syntheticManifestPath, "--output", "model.dom"],
    ["encode", syntheticManifestPath, "--output", "a.json", "--output", "b.json"],
  ]) {
    await assert.rejects(
      execFileAsync(process.execPath, [cli, ...args]),
      (error) => /CLI_ARGUMENT/u.test(error.stderr),
    );
  }
});

test("manifest loading rejects unknown top-level and resource fields", async () => {
  const root = await mkdtemp(join(tmpdir(), "domformat-manifest-fields-"));
  const topLevel = join(root, "top-level.json");
  await writeFile(topLevel, JSON.stringify({ resources: [], privateAdapter: true }));
  await assert.rejects(loadManifest(topLevel), (error) => error?.code === "MANIFEST");

  const resourceField = join(root, "resource-field.json");
  await writeFile(resourceField, JSON.stringify({
    resources: [{ id: "asset", kind: "image", mediaType: "image/png", path: "asset.png", source: "asset.png", url: "https://example.test/asset" }],
  }));
  await assert.rejects(loadManifest(resourceField), (error) => error?.code === "MANIFEST");

  const escapedSource = join(root, "escaped-source.json");
  await writeFile(escapedSource, JSON.stringify({
    resources: [{ id: "asset", kind: "image", mediaType: "image/png", path: "asset.png", source: "../private.bin" }],
  }));
  await assert.rejects(loadManifest(escapedSource), (error) => error?.code === "UNSAFE_MANIFEST_PATH");

  const project = join(root, "project");
  await mkdir(project);
  await writeFile(join(root, "private.bin"), "private\n");
  await symlink("../private.bin", join(project, "asset.png"));
  const linkedSource = join(project, "manifest.json");
  await writeFile(linkedSource, JSON.stringify({
    resources: [{ id: "asset", kind: "image", mediaType: "image/png", path: "asset.png", source: "asset.png" }],
  }));
  await assert.rejects(loadManifest(linkedSource), (error) => error?.code === "UNSAFE_MANIFEST_PATH");

  const componentProject = join(root, "component-project");
  await mkdir(join(componentProject, "real-assets"), { recursive: true });
  await writeFile(join(componentProject, "real-assets", "asset.png"), "asset\n");
  await symlink("real-assets", join(componentProject, "assets"));
  const componentManifest = join(componentProject, "manifest.json");
  await writeFile(componentManifest, JSON.stringify({
    resources: [{ id: "asset", kind: "image", mediaType: "image/png", path: "asset.png", source: "assets/asset.png" }],
  }));
  await assert.rejects(loadManifest(componentManifest), (error) => error?.code === "UNSAFE_MANIFEST_PATH");

  const duplicate = join(root, "duplicate.json");
  await writeFile(duplicate, '{"resources":[],"resources":[]}');
  await assert.rejects(loadManifest(duplicate), (error) => error?.code === "DUPLICATE_NORMALIZED_KEY");
});
