// Repository-only differential harness. It receives release-controlled valid
// fixtures; it is not a public loader or a replacement for validateDocument.
const host = document.querySelector("#viewer");
const status = document.querySelector("#status");
const parameters = new URLSearchParams(location.search);
const modelUrl = parameters.get("model");
const comparison = parameters.get("compare");
let referenceRuntime = null;
let probeRuntime = null;

try {
  if (!modelUrl) throw new Error("Missing required ?model=/path/to/model.json URL.");
  if (comparison && comparison !== "reference") throw new Error(`Unsupported comparison ${comparison}.`);
  const { readDomNVersionUrl } = await import("../conformance/nversion/reader.js");
  const { mountConformanceDom } = await import("../conformance/viewer/mount.js");
  const probeResult = await readDomNVersionUrl(modelUrl);
  const mountOptions = {
    animate: parameters.get("animate") !== "0",
    viewportWidth: comparison ? innerWidth / 2 : innerWidth,
    viewportHeight: innerHeight,
  };
  let probeHost = host;
  if (comparison) {
    const production = await import("../src/browser.js");
    const referenceResult = await production.readDomBrowserUrl(modelUrl);
    host.style.width = "50%";
    host.style.right = "50%";
    referenceRuntime = await production.mountDom(referenceResult, host, mountOptions);
    probeHost = document.createElement("main");
    probeHost.setAttribute("aria-label", "N-version DOM model");
    Object.assign(probeHost.style, {
      position: "fixed",
      top: "0",
      right: "0",
      bottom: "0",
      width: "50%",
      overflow: "hidden",
    });
    document.body.insertBefore(probeHost, status);
  }
  probeRuntime = await mountConformanceDom(probeResult, probeHost, mountOptions);
  const playback = probeResult.document.bindings.channels.find((channel) => channel.interpreter === "polycss-playback@0");
  const leaves = playback?.targets.leaves.length
    ?? probeResult.document.meta.counts?.leaves
    ?? probeResult.document.tree.nodes.filter((node) => !probeResult.document.tree.nodes.some((candidate) => candidate.parent === node.index)).length;
  document.documentElement.dataset.domformatReady = "";
  globalThis.domformatProof = Object.freeze({
    format: probeResult.document.meta.format,
    profile: probeResult.document.meta.profile,
    documentType: "json-with-sibling-resources",
    nodes: probeResult.document.tree.nodes.length,
    leaves,
    implementation: comparison ? "nversion-comparison" : probeResult.implementation,
    destroy() {
      referenceRuntime?.destroy();
      probeRuntime?.destroy();
      document.documentElement.removeAttribute("data-domformat-ready");
      document.documentElement.dataset.domformatDestroyed = "";
      status.textContent = "destroyed";
    },
  });
  addEventListener("pagehide", () => {
    referenceRuntime?.destroy();
    probeRuntime?.destroy();
  }, { once: true });
  status.textContent = `${probeResult.document.meta.format} · ${probeResult.document.tree.nodes.length} nodes · ${leaves} leaves`;
} catch (error) {
  referenceRuntime?.destroy();
  probeRuntime?.destroy();
  document.documentElement.dataset.domformatError = "";
  status.textContent = error instanceof Error ? error.message : String(error);
  console.error(error);
}
