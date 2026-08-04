import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { buildDom } from "./writer.js";
import { encodeCanonicalJson } from "./canonical-json.js";
import { readDomFile } from "./reader.js";
import { formatInspection, inspection } from "./inspect.js";
import { loadManifest } from "./manifest.js";
import { DomFormatError, invariant } from "./errors.js";
import { writeDomFiles } from "./package-files.js";
import { assertRealDirectory } from "./path-security.js";

const HELP = `domformat@0

Usage:
  domformat encode <manifest.json> --output <document.json>
  domformat decode <document.json> --output <new-directory>
  domformat inspect <document.json> [--json] [--no-resources]
  domformat validate <document.json>

Encoding writes integrity-bound resources beside the JSON document and
publishes the document last. Decode refuses to reuse an existing output
directory. Portable domformat@0 documents contain no network URLs or
executable code.
`;

function argumentsOf(argv) {
  const positional = [];
  const flags = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("--")) {
      positional.push(value);
      continue;
    }
    const name = value.slice(2);
    invariant(!flags.has(name), "CLI_ARGUMENT", `${value} must not be repeated.`);
    if (value === "--json" || value === "--help" || value === "--no-resources") {
      flags.set(name, true);
      continue;
    }
    const next = argv[index + 1];
    invariant(next !== undefined && !next.startsWith("--"), "CLI_ARGUMENT", `${value} requires a value.`);
    flags.set(name, next);
    index += 1;
  }
  return { positional, flags };
}

const COMMAND_FLAGS = Object.freeze({
  encode: new Set(["output"]),
  decode: new Set(["output"]),
  inspect: new Set(["json", "no-resources"]),
  validate: new Set(),
});

function validateFlags(command, flags) {
  const allowed = COMMAND_FLAGS[command];
  invariant(allowed, "CLI_ARGUMENT", `Unknown command ${command}.`);
  for (const name of flags.keys()) invariant(allowed.has(name), "CLI_ARGUMENT", `--${name} is not valid for ${command}.`);
}

function requiredFlag(flags, name) {
  const value = flags.get(name);
  invariant(typeof value === "string" && value.length > 0, "CLI_ARGUMENT", `--${name} is required.`);
  return value;
}

async function encodeManifest(input, flags) {
  const output = requiredFlag(flags, "output");
  invariant(extname(output) === ".json", "CLI_ARGUMENT", "Encode output must use the .json extension.");
  const document = await loadManifest(input);
  const built = buildDom(document);
  await writeDomFiles(output, built);
  return built;
}

function extensionFor(record) {
  if (record.kind === "stylesheet") return ".css";
  if (record.mediaType === "image/webp") return ".webp";
  if (record.mediaType === "image/png") return ".png";
  invariant(false, "UNSUPPORTED_MEDIA_TYPE", `Cannot decode unsupported resource media type ${record.mediaType}.`);
}

async function decodeFile(input, flags) {
  const output = resolve(requiredFlag(flags, "output"));
  const result = await readDomFile(input, { requireResources: true });
  await assertRealDirectory(dirname(output), "UNSAFE_OUTPUT_PATH", "Decode output parent");
  await mkdir(output);
  try {
    const sections = {
      meta: result.document.meta,
      tree: result.document.tree,
      "css-binding": result.document.cssBinding,
      state: result.document.state,
      bindings: result.document.bindings,
      resources: result.document.resources,
    };
    for (const [name, value] of Object.entries(sections)) {
      await writeFile(join(output, `${name}.json`), encodeCanonicalJson(value), { flag: "wx" });
    }
    const resourceDirectory = join(output, "resource-by-id");
    await mkdir(resourceDirectory);
    for (const record of result.document.resources.resources) {
      await writeFile(join(resourceDirectory, `${record.id}${extensionFor(record)}`), result.resourceBytes.get(record.id), { flag: "wx" });
    }
  } catch (error) {
    try { await rm(output, { recursive: true, force: true }); } catch {}
    throw error;
  }
  return result;
}

export async function runCli(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv;
  if (!command || command === "--help" || command === "help") {
    process.stdout.write(HELP);
    return 0;
  }
  const { positional, flags } = argumentsOf(rest);
  if (flags.has("help")) {
    process.stdout.write(HELP);
    return 0;
  }
  validateFlags(command, flags);
  invariant(positional.length === 1, "CLI_ARGUMENT", `${command} requires exactly one input path.`);
  const input = positional[0];
  if (command === "encode") {
    const built = await encodeManifest(input, flags);
    process.stdout.write(`wrote ${resolve(requiredFlag(flags, "output"))} (${built.bytes.length} JSON bytes, ${built.externalResources.size} resources)\n`);
  } else if (command === "decode") {
    const result = await decodeFile(input, flags);
    process.stdout.write(`decoded ${result.document.meta.format} to ${resolve(requiredFlag(flags, "output"))}\n`);
  } else if (command === "inspect") {
    const result = await readDomFile(input, {
      loadExternal: !flags.has("no-resources"),
    });
    const value = inspection(result);
    process.stdout.write(flags.has("json") ? `${JSON.stringify(value, null, 2)}\n` : formatInspection(value));
  } else if (command === "validate") {
    const result = await readDomFile(input, {
      requireResources: true,
    });
    process.stdout.write(`valid ${result.document.meta.format} ${result.document.meta.profile}; ${result.transport.totalLength} bytes; ${result.document.tree.nodes.length} nodes; ${result.document.resources.resources.length} resources verified\n`);
  } else {
    invariant(false, "CLI_ARGUMENT", `Unknown command ${command}.`);
  }
  return 0;
}

export async function main(argv = process.argv.slice(2)) {
  try {
    return await runCli(argv);
  } catch (error) {
    if (error instanceof DomFormatError) {
      process.stderr.write(`domformat: ${error.code}: ${error.message}\n`);
      return 1;
    }
    const code = typeof error?.code === "string" && /^[A-Z][A-Z0-9_]*$/u.test(error.code) ? error.code : "INTERNAL_ERROR";
    process.stderr.write(`domformat: ${code}: The operation failed without a safe domformat diagnostic.\n`);
    return 1;
  }
}
