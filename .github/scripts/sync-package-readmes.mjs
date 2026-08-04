import { copyFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const source = resolve(repoRoot, "README.md");
const targets = [
  "packages/core/README.md",
  "packages/polycss/README.md",
  "packages/react/README.md",
  "packages/vue/README.md",
];
const packageSpecificTargets = [
  "packages/domformat/README.md",
  "packages/fonts/README.md",
  "packages/morph/README.md",
];

const invokedFrom = relative(repoRoot, process.cwd()).split(sep).join("/");
const invokedFromPackageReadme = invokedFrom.startsWith("packages/")
  ? `${invokedFrom}/README.md`
  : undefined;

if (
  invokedFromPackageReadme !== undefined
  && packageSpecificTargets.includes(invokedFromPackageReadme)
) {
  console.log(`[sync-package-readmes] preserved ${invokedFromPackageReadme}`);
  process.exit(0);
}

if (invokedFromPackageReadme !== undefined && !targets.includes(invokedFromPackageReadme)) {
  console.log(`[sync-package-readmes] skipped for ${invokedFromPackageReadme}`);
  process.exit(0);
}

for (const target of targets) {
  copyFileSync(source, resolve(repoRoot, target));
}

console.log(`[sync-package-readmes] copied README.md to ${targets.length} package READMEs`);
