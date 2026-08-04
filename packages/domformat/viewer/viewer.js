const host = document.querySelector("#viewer");
const status = document.querySelector("#status");
const parameters = new URLSearchParams(location.search);
const modelUrl = parameters.get("model");
const implementation = parameters.get("implementation") ?? "reference";
const comparison = parameters.get("compare");
let runtime = null;
let comparisonRuntime = null;

try {
  if (!modelUrl) throw new Error("Missing required ?model=/path/to/model.json URL.");
  if (implementation !== "reference" && implementation !== "conformance") throw new Error(`Unsupported viewer implementation ${implementation}.`);
  if (comparison && comparison !== "conformance") throw new Error(`Unsupported viewer comparison ${comparison}.`);
  const production = await import("../src/browser.js");
  const conformanceMount = implementation === "conformance" || comparison
    ? (await import("../conformance/viewer/mount.js")).mountConformanceDom
    : null;
  const result = await production.readDomBrowserUrl(modelUrl);
  const mount = implementation === "reference" ? production.mountDom : conformanceMount;
  const mountOptions = {
    animate: parameters.get("animate") !== "0",
    ...(parameters.has("mode") ? { mode: parameters.get("mode") } : {}),
    viewportWidth: comparison ? innerWidth / 2 : innerWidth,
    viewportHeight: innerHeight,
  };
  if (comparison) {
    host.style.width = "50%";
    host.style.right = "50%";
  }
  runtime = await mount(result, host, mountOptions);
  if (comparison) {
    const comparisonHost = document.createElement("main");
    comparisonHost.setAttribute("aria-label", "Independent DOM model");
    Object.assign(comparisonHost.style, {
      position: "fixed",
      top: "0",
      right: "0",
      bottom: "0",
      width: "50%",
      overflow: "hidden",
    });
    document.body.insertBefore(comparisonHost, status);
    comparisonRuntime = await conformanceMount(result, comparisonHost, {
      ...mountOptions,
      viewportWidth: innerWidth / 2,
    });
  }
  const playback = result.document.bindings.channels.find((channel) => channel.interpreter === "polycss-playback@0");
  if (!playback) throw new Error("The package has no executable polycss-playback@0 binding.");
  const leaves = playback.targets.leaves.length;
  document.documentElement.dataset.domformatReady = "";
  globalThis.domformatProof = Object.freeze({
    format: result.document.meta.format,
    profile: result.document.meta.profile,
    documentType: "json-with-sibling-resources",
    nodes: result.document.tree.nodes.length,
    leaves,
    implementation: comparison
      ? "comparison"
      : implementation,
    get lifecycle() { return runtime.lifecycle; },
    get mode() { return runtime.mode; },
    setMode(mode) { return runtime.setMode(mode); },
    destroy() {
      runtime.destroy();
      comparisonRuntime?.destroy();
      document.documentElement.removeAttribute("data-domformat-ready");
      document.documentElement.dataset.domformatDestroyed = "";
      status.textContent = "destroyed";
    },
  });
  addEventListener("pagehide", () => {
    runtime.destroy();
    comparisonRuntime?.destroy();
  }, { once: true });
  status.textContent = `${result.document.meta.format} · ${result.document.tree.nodes.length} nodes · ${leaves} leaves`;
} catch (error) {
  runtime?.destroy();
  comparisonRuntime?.destroy();
  document.documentElement.dataset.domformatError = "";
  status.textContent = error instanceof Error ? error.message : String(error);
  console.error(error);
}
