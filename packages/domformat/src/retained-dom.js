import { invariant } from "./errors.js";

function resourceStyleValue(binding, urls) {
  const url = urls.get(binding.resource);
  invariant(typeof url === "string" && url.length > 0, "MISSING_RESOURCE_URL", `No URL is resolved for resource ${binding.resource}.`);
  if (binding.syntax === "url") return `url(${JSON.stringify(url)})`;
  const overlay = 1 - binding.overlayOpacity;
  return `linear-gradient(rgba(0,0,0,${overlay}),rgba(0,0,0,${overlay})),url(${JSON.stringify(url)})`;
}

function applyStyleMap(element, styles) {
  for (const [property, value] of Object.entries(styles ?? {})) element.style[property] = value;
}

function applyResourceStyles(element, styles, urls) {
  for (const [property, binding] of Object.entries(styles ?? {})) element.style[property] = resourceStyleValue(binding, urls);
}

export function applyInitialResources(mounted, urls) {
  const { host, tree, elements } = mounted;
  applyResourceStyles(host, tree.mount.resourceStyles, urls);
  for (const node of tree.nodes) {
    const element = elements[node.index];
    for (const [name, resource] of Object.entries(node.resourceAttributes ?? {})) {
      const url = urls.get(resource);
      invariant(typeof url === "string" && url.length > 0, "MISSING_RESOURCE_URL", `No URL is resolved for resource ${resource}.`);
      element.setAttribute(name, url);
    }
    applyResourceStyles(element, node.resourceStyles, urls);
  }
}

export function instantiateTree(document, host, options = {}) {
  invariant(document && typeof document.createElementNS === "function", "INVALID_DOCUMENT_HOST", "A DOM Document is required.");
  invariant(host && typeof host.replaceChildren === "function", "INVALID_DOCUMENT_HOST", "A mount host is required.");
  const tree = options.tree ?? options.document?.tree;
  invariant(tree && Array.isArray(tree.nodes), "INVALID_TREE", "A validated TREE section is required.");
  host.replaceChildren();
  for (const [name, value] of tree.mount.attributes) host.setAttribute(name, value);
  applyStyleMap(host, tree.mount.styles);
  const elements = [];
  const byId = new Map();
  for (const node of tree.nodes) {
    const element = document.createElementNS(node.namespace, node.name);
    if (node.classes?.length) element.classList.add(...node.classes);
    for (const [name, value] of Object.entries(node.attributes ?? {})) element.setAttribute(name, value);
    applyStyleMap(element, node.styles);
    const parent = node.parent === -1 ? host : elements[node.parent];
    parent.appendChild(element);
    elements.push(element);
    byId.set(node.id, element);
  }
  const mounted = Object.freeze({ document, host, tree, elements: Object.freeze(elements), byId });
  if (options.resourceUrls) applyInitialResources(mounted, options.resourceUrls);
  return mounted;
}
