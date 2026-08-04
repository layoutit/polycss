import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { encodeCanonicalJson } from "../src/canonical-json.js";
import { sha256Hex } from "../src/hash.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const corpus = resolve(root, "conformance/corpus");
const casesPath = resolve(corpus, "cases.json");
const manifest = JSON.parse(await readFile(casesPath, "utf8"));
const temporary = await mkdtemp(join(tmpdir(), "domformat-conformance-update-"));

try {
  const model = join(temporary, "positive.json");
  const python = process.platform === "win32" ? "python" : "python3";
  const produced = spawnSync(python, ["-B", resolve(root, "conformance/producer.py"), model], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  if (produced.error) throw produced.error;
  if (produced.status !== 0) throw new Error(`${produced.stdout}${produced.stderr}`.trim());

  const bytes = await readFile(model);
  const document = JSON.parse(bytes.toString("utf8"));
  const construction = document.tree.nodes.map((node) => [node.id, node.parent, node.sibling, node.namespace, node.name]);
  const bindings = document.bindings.channels.map((channel) => [channel.id, channel.state, channel.interpreter, channel.targets, channel.sinks]);
  manifest.fixture.byteLength = bytes.length;
  manifest.fixture.sha256 = sha256Hex(bytes);
  manifest.fixture.constructionPlanSha256 = sha256Hex(encodeCanonicalJson(construction));
  manifest.fixture.bindingPlanSha256 = sha256Hex(encodeCanonicalJson(bindings));

  await writeFile(resolve(corpus, manifest.fixture.json), bytes);
  for (const relative of manifest.fixture.resources) {
    const target = resolve(corpus, relative);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, await readFile(resolve(temporary, relative)));
  }
  await writeFile(casesPath, `${JSON.stringify(manifest, null, 2)}\n`);
  process.stdout.write(`updated ${manifest.fixture.json}: ${bytes.length} bytes ${manifest.fixture.sha256}\n`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
