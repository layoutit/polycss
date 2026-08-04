import { requireContract as invariant } from "./errors.js";
import { createInteractionInput } from "./input.js";
import { createPolycssEffects } from "./effects.js";
import { createPolycssInteraction } from "./interaction.js";
import { createPolycssPlayback, materializePolycssState } from "./playback.js";

// This is deliberately outside the package exports.  It is an independently
// wired executable consumer used to challenge the normative profile and the
// production viewer.  Imports from src/ are forbidden by the release tests.

const PHASES = Object.freeze(["validate", "construct", "bind", "initialize", "publish", "destroy"]);
const REQUIRED_INTERPRETERS = Object.freeze([
  "static-presentation@0",
]);
const KNOWN_CAPABILITIES = new Set([
  "css-semantic-closure",
  "deterministic-json",
  "explicit-retained-tree",
  "logical-assets",
  "prepared-particle-effects",
  "prepared-playback",
  "prepared-pointer-grab-interaction",
  "prepared-surface-lighting",
]);
const BOUNDARY_STYLES = Object.freeze({
  display: "block",
  position: "relative",
  inset: "0",
  width: "100%",
  height: "100%",
  maxWidth: "none",
  margin: "0",
  padding: "0",
  border: "0",
  boxSizing: "border-box",
  overflow: "hidden",
  contain: "strict",
  isolation: "isolate",
  transform: "none",
  zIndex: "auto",
  opacity: "1",
  visibility: "visible",
  pointerEvents: "auto",
});
const SNAPSHOT_STYLE_PROPERTIES = Object.freeze([
  "backgroundColor", "backgroundImage", "backgroundPosition", "backgroundPositionY",
  "backgroundRepeat", "backgroundSize", "border", "borderBottomLeftRadius",
  "borderBottomRightRadius", "borderShape", "borderTopLeftRadius", "borderTopRightRadius",
  "boxSizing", "color", "contain", "cornerBottomLeftShape", "cornerBottomRightShape",
  "cornerTopLeftShape", "cornerTopRightShape", "display",
  "height", "inset", "isolation", "left", "margin", "maxWidth", "objectFit",
  "objectPosition", "opacity", "overflow", "padding", "perspective", "perspectiveOrigin",
  "pointerEvents", "position", "top", "transform", "transformOrigin", "transformStyle",
  "visibility", "width", "zIndex",
]);
let scopeSequence = 0;

function lifecycle(observer) {
  invariant(observer === undefined || typeof observer === "function", "INVALID_LIFECYCLE_OBSERVER", "onLifecyclePhase must be a function.");
  let phase = null;
  const history = [];
  const notify = (next) => {
    history.push(next);
    phase = next;
    observer?.(next);
  };
  const view = Object.freeze({
    get phase() { return phase; },
    get history() { return Object.freeze([...history]); },
  });
  return Object.freeze({
    view,
    get phase() { return phase; },
    advance(next) {
      const expected = phase === null ? "validate" : PHASES[PHASES.indexOf(phase) + 1];
      invariant(next !== "destroy" && next === expected, "LIFECYCLE_ORDER", `Lifecycle expected ${expected}, not ${String(next)}.`);
      notify(next);
    },
    destroy() {
      if (phase === "destroy") return false;
      history.push("destroy");
      phase = "destroy";
      try { observer?.("destroy"); } catch {}
      return true;
    },
    assertPublished() {
      invariant(phase === "publish", phase === "destroy" ? "MOUNT_DESTROYED" : "LIFECYCLE_PRECONDITION", `Operation requires publish phase; current phase is ${phase ?? "start"}.`);
    },
  });
}

function aborted(signal) {
  invariant(!signal?.aborted, "OPERATION_ABORTED", "The conformance viewer operation was aborted by its host.");
}

function bytes(value, label) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  invariant(false, "INVALID_RESOURCE_BYTES", `${label} is not a byte buffer.`);
}

async function digestHex(value) {
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", value));
  return [...digest].map((entry) => entry.toString(16).padStart(2, "0")).join("");
}

function captureHost(host, document) {
  const children = [...host.childNodes];
  const attributeNames = new Set(["tabindex", ...document.tree.mount.attributes.map(([name]) => name)]);
  const attributes = new Map([...attributeNames].map((name) => [name, {
    present: host.hasAttribute(name),
    value: host.getAttribute(name),
  }]));
  const styleNames = new Set([
    ...Object.keys(document.tree.mount.styles ?? {}),
    ...Object.keys(document.tree.mount.resourceStyles ?? {}),
  ]);
  for (const channel of document.bindings.channels) {
    for (const sink of channel.sinks) if (sink.startsWith("host.style.")) styleNames.add(sink.slice("host.style.".length));
  }
  const styles = new Map([...styleNames].map((name) => [name, host.style[name]]));
  const styleAttribute = { present: host.hasAttribute("style"), value: host.getAttribute("style") };
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    host.replaceChildren(...children);
    for (const [name, prior] of attributes) {
      if (prior.present) host.setAttribute(name, prior.value);
      else host.removeAttribute(name);
    }
    for (const [name, value] of styles) host.style[name] = value;
    if (styleAttribute.present) host.setAttribute("style", styleAttribute.value);
    else host.removeAttribute("style");
  };
}

function styleMap(element, declarations) {
  for (const [name, value] of Object.entries(declarations ?? {})) element.style[name] = value;
}

function resourceValue(binding, urls) {
  const url = urls.get(binding.resource);
  invariant(typeof url === "string", "MISSING_RESOURCE_URL", `Resource URL ${binding.resource} is unavailable.`);
  if (binding.syntax === "url") return `url(${JSON.stringify(url)})`;
  const alpha = 1 - binding.overlayOpacity;
  return `linear-gradient(rgba(0,0,0,${alpha}),rgba(0,0,0,${alpha})),url(${JSON.stringify(url)})`;
}

function resourceStyles(element, declarations, urls) {
  for (const [name, binding] of Object.entries(declarations ?? {})) element.style[name] = resourceValue(binding, urls);
}

function constructTree(ownerDocument, surface, tree) {
  surface.replaceChildren();
  for (const [name, value] of tree.mount.attributes) surface.setAttribute(name, value);
  styleMap(surface, tree.mount.styles);
  const elements = [];
  const byId = new Map();
  for (const node of tree.nodes) {
    const element = ownerDocument.createElementNS(node.namespace, node.name);
    if (node.classes?.length) element.classList.add(...node.classes);
    for (const [name, value] of Object.entries(node.attributes ?? {})) element.setAttribute(name, value);
    styleMap(element, node.styles);
    (node.parent === -1 ? surface : elements[node.parent]).appendChild(element);
    elements.push(element);
    byId.set(node.id, element);
  }
  return Object.freeze({ host: surface, tree, elements: Object.freeze(elements), byId });
}

function bindResources(mounted, urls) {
  resourceStyles(mounted.host, mounted.tree.mount.resourceStyles, urls);
  for (const node of mounted.tree.nodes) {
    const element = mounted.elements[node.index];
    for (const [name, id] of Object.entries(node.resourceAttributes ?? {})) {
      invariant(urls.has(id), "MISSING_RESOURCE_URL", `Resource URL ${id} is unavailable.`);
      element.setAttribute(name, urls.get(id));
    }
    resourceStyles(element, node.resourceStyles, urls);
  }
}

function boundary(surface) {
  for (const [name, value] of Object.entries(BOUNDARY_STYLES)) {
    const kebab = name.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`);
    if (typeof surface.style.setProperty === "function") surface.style.setProperty(kebab, value, "important");
    else surface.style[name] = value;
  }
  surface.setAttribute("data-domformat-mount-surface", "");
}

function selectorSegments(css, start, end) {
  const ranges = [];
  let segment = start;
  let depth = 0;
  let quote = null;
  for (let index = start; index < end; index += 1) {
    const character = css[index];
    if (quote !== null) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if (character === "(") depth += 1;
    else if (character === ")") depth -= 1;
    else if (character === "," && depth === 0) {
      ranges.push([segment, index]);
      segment = index + 1;
    }
  }
  ranges.push([segment, end]);
  return ranges;
}

function closingBrace(css, open) {
  let depth = 1;
  let quote = null;
  for (let index = open + 1; index < css.length; index += 1) {
    const character = css[index];
    if (quote !== null) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if (character === "{") depth += 1;
    else if (character === "}" && --depth === 0) return index;
  }
  return -1;
}

function urlArgumentEnd(css, start, blockEnd) {
  let quote = null;
  for (let index = start; index < blockEnd; index += 1) {
    const character = css[index];
    if (quote !== null) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if (character === ")") return index;
  }
  return -1;
}

function closedCss(css, binding, urls, runtimeSelector) {
  const replacements = [];
  const tokenResources = new Map(binding.assetTokens.map((entry) => [entry.token, entry.resource]));
  let cursor = 0;
  while (cursor < css.length) {
    while (/\s/u.test(css[cursor] ?? "")) cursor += 1;
    if (cursor >= css.length) break;
    const open = css.indexOf("{", cursor);
    invariant(open >= 0, "INVALID_CSS", "A stylesheet rule is truncated.");
    for (const [start, end] of selectorSegments(css, cursor, open)) {
      let scopeStart = start;
      while (scopeStart < end && /\s/u.test(css[scopeStart])) scopeStart += 1;
      invariant(css.startsWith(binding.scope, scopeStart), "INVALID_CSS_SCOPE", "A selector does not begin with its declared scope.");
      replacements.push([scopeStart, scopeStart + binding.scope.length, runtimeSelector]);
    }
    const close = closingBrace(css, open);
    invariant(close >= 0, "INVALID_CSS", "A stylesheet rule block is truncated.");
    let declarationQuote = null;
    for (let index = open + 1; index < close; index += 1) {
      const character = css[index];
      if (declarationQuote !== null) {
        if (character === declarationQuote) declarationQuote = null;
        continue;
      }
      if (character === '"' || character === "'") {
        declarationQuote = character;
        continue;
      }
      if (css.slice(index, index + 4).toLowerCase() !== "url(") continue;
      const end = urlArgumentEnd(css, index + 4, close);
      invariant(end >= 0, "INVALID_CSS_URL", "A CSS url() is truncated.");
      const raw = css.slice(index + 4, end).trim();
      const token = (raw[0] === '"' && raw.at(-1) === '"') || (raw[0] === "'" && raw.at(-1) === "'")
        ? raw.slice(1, -1)
        : raw;
      const resource = tokenResources.get(token);
      invariant(resource && urls.has(resource), "INVALID_CSS_URL", `CSS token ${token} has no resource URL.`);
      let argumentStart = index + 4;
      while (/\s/u.test(css[argumentStart])) argumentStart += 1;
      let argumentEnd = end;
      while (argumentEnd > argumentStart && /\s/u.test(css[argumentEnd - 1])) argumentEnd -= 1;
      replacements.push([argumentStart, argumentEnd, JSON.stringify(urls.get(resource))]);
      index = end;
    }
    cursor = close + 1;
  }
  replacements.sort((left, right) => right[0] - left[0]);
  let output = css;
  for (const [start, end, value] of replacements) output = output.slice(0, start) + value + output.slice(end);
  return output;
}

function target(value, mounted) {
  if (typeof value === "string") {
    const element = value === "$host" ? mounted.host : mounted.byId.get(value);
    invariant(element, "MISSING_TARGET_NODE", `Binding target ${value} is absent.`);
    return element;
  }
  if (Array.isArray(value)) return Object.freeze(value.map((entry) => target(entry, mounted)));
  const output = {};
  for (const [name, entry] of Object.entries(value)) output[name] = target(entry, mounted);
  return Object.freeze(output);
}

function bindChannels(bindings, mounted) {
  const output = new Map();
  for (const channel of bindings.channels) {
    output.set(channel.id, Object.freeze({ targets: target(channel.targets, mounted), sinks: Object.freeze([...channel.sinks]) }));
  }
  return output;
}

async function decodeImages(document, resourceBytes, win, BlobClass, signal) {
  const decode = win.createImageBitmap ?? globalThis.createImageBitmap;
  invariant(typeof decode === "function", "MISSING_BROWSER_API", "Image decoding is required before publication.");
  for (const record of document.resources.resources) {
    if (record.kind !== "image") continue;
    aborted(signal);
    let bitmap;
    try {
      bitmap = await decode.call(win, new BlobClass([resourceBytes.get(record.id)], { type: record.mediaType }));
    } catch (error) {
      invariant(false, "IMAGE_DECODE_FAILED", `Image decoder rejected ${record.id}: ${String(error)}`);
    }
    try {
      invariant(bitmap.width === record.dimensions.width && bitmap.height === record.dimensions.height, "IMAGE_DIMENSION_MISMATCH", `Image ${record.id} dimensions differ from its record.`);
    } finally {
      try { bitmap?.close?.(); } catch {}
    }
  }
}

function normalized(value, urls) {
  if (typeof value !== "string") return value;
  let output = value;
  for (const [id, url] of urls) output = output.split(url).join(`dom-resource:${id}`);
  return output;
}

function classesOf(element) {
  if (Array.isArray(element.classes)) return [...element.classes];
  if (typeof element.className === "string") return element.className.split(/\s+/u).filter(Boolean);
  return [];
}

function snapshotTree(mounted, urls) {
  const captureStyles = (element) => Object.fromEntries(SNAPSHOT_STYLE_PROPERTIES
    .map((name) => [name, normalized(element.style[name], urls)])
    .filter(([, value]) => value !== undefined && value !== ""));
  return Object.freeze({
    mount: Object.freeze({
      attributes: Object.freeze(mounted.tree.mount.attributes.map(([name]) => [name, mounted.host.getAttribute(name)])),
      styles: Object.freeze(captureStyles(mounted.host)),
    }),
    nodes: Object.freeze(mounted.tree.nodes.map((node) => {
      const element = mounted.elements[node.index];
      const parent = element.parentNode === mounted.host ? -1 : mounted.elements.indexOf(element.parentNode);
      const attributeNames = [...Object.keys(node.attributes ?? {}), ...Object.keys(node.resourceAttributes ?? {})].sort();
      return Object.freeze({
        id: node.id,
        index: node.index,
        parent,
        sibling: element.parentNode?.childNodes?.indexOf?.(element) ?? node.sibling,
        namespace: element.namespaceURI ?? node.namespace,
        name: element.localName,
        classes: Object.freeze(classesOf(element)),
        attributes: Object.freeze(Object.fromEntries(attributeNames.map((name) => [name, normalized(element.getAttribute(name), urls)]))),
        styles: Object.freeze(captureStyles(element)),
      });
    })),
  });
}

export async function mountConformanceDom(result, host, options = {}) {
  const phases = lifecycle(options.onLifecyclePhase);
  let ownerDocument;
  let win;
  let urlApi;
  let BlobClass;
  let restoreHost = null;
  let hostMutated = false;
  let mounted = null;
  let boundTargets = null;
  let playback = null;
  let effects = null;
  let interaction = null;
  let input = null;
  let resizeObserver = null;
  let request = null;
  let mode = null;
  const urls = new Map();
  const styles = [];

  const cleanup = () => {
    if (phases.phase === "destroy") return false;
    const attempt = (operation) => { try { operation?.(); } catch {} };
    if (request !== null) attempt(() => win?.cancelAnimationFrame(request));
    request = null;
    attempt(() => resizeObserver?.disconnect());
    attempt(() => input?.destroy());
    attempt(() => interaction?.destroy());
    attempt(() => effects?.destroy());
    interaction = null;
    for (const element of styles) attempt(() => element.remove());
    for (const url of urls.values()) attempt(() => urlApi?.revokeObjectURL(url));
    if (hostMutated) attempt(restoreHost);
    phases.destroy();
    return true;
  };
  const assertPublished = () => phases.assertPublished();

  try {
    aborted(options.signal);
    invariant(result && typeof result === "object" && result.document && result.resourceBytes instanceof Map, "LIFECYCLE_PRECONDITION", "The conformance viewer requires a browser reader result.");
    const document = result.document;
    const resourceBytes = new Map([...result.resourceBytes].map(([id, value]) => [id, bytes(value, `Resource ${id}`).slice()]));
    invariant(document.meta.format === "domformat@0" && document.meta.profile === "polycss-3d@0", "UNSUPPORTED_PROFILE", "The conformance viewer supports only domformat@0/polycss-3d@0.");
    for (const capability of document.meta.capabilities) invariant(KNOWN_CAPABILITIES.has(capability), "UNSUPPORTED_REQUIRED_CAPABILITY", `Required capability ${capability} is unsupported.`);
    mode = options.mode ?? document.meta.initialExperience ?? "animation";
    invariant(mode === "animation" || mode === "interaction", "INVALID_EXPERIENCE_MODE", "Mode must be animation or interaction.");
    const interpreters = new Set(document.bindings.channels.map((channel) => channel.interpreter));
    invariant(REQUIRED_INTERPRETERS.every((name) => interpreters.has(name)), "UNSUPPORTED_MOUNT_CONTRACT", "Executable static presentation is required.");
    if (mode === "interaction") invariant(interpreters.has("polycss-pointer-grab@0"), "UNSUPPORTED_MOUNT_CONTRACT", "Interaction mode requires the pointer-grab interpreter.");
    invariant(resourceBytes.size === document.resources.resources.length, "RESOURCE_CARDINALITY_MISMATCH", "Resource count differs from RCRD.");
    for (const record of document.resources.resources) {
      const value = resourceBytes.get(record.id);
      invariant(value && value.byteLength === record.byteLength, "RESOURCE_SIZE_MISMATCH", `Resource ${record.id} has the wrong length.`);
      invariant(await digestHex(value) === record.digest.value, "RESOURCE_DIGEST_MISMATCH", `Resource ${record.id} has the wrong digest.`);
      aborted(options.signal);
    }
    phases.advance("validate");

    ownerDocument = host?.ownerDocument;
    win = ownerDocument?.defaultView;
    invariant(ownerDocument && win && typeof host?.replaceChildren === "function", "INVALID_DOCUMENT_HOST", "A connected browser host is required.");
    urlApi = win.URL ?? globalThis.URL;
    BlobClass = win.Blob ?? globalThis.Blob;
    invariant(typeof urlApi?.createObjectURL === "function" && typeof urlApi?.revokeObjectURL === "function" && typeof BlobClass === "function", "MISSING_BROWSER_API", "Object URL and Blob support are required.");
    restoreHost = captureHost(host, document);
    const surface = ownerDocument.createElement("div");
    surface.setAttribute("data-domformat-instance", `c${(scopeSequence++).toString(36)}`);
    mounted = constructTree(ownerDocument, surface, document.tree);
    boundary(surface);
    phases.advance("construct");

    for (const record of document.resources.resources) {
      if (record.kind !== "stylesheet") urls.set(record.id, urlApi.createObjectURL(new BlobClass([resourceBytes.get(record.id)], { type: record.mediaType })));
    }
    await decodeImages(document, resourceBytes, win, BlobClass, options.signal);
    aborted(options.signal);
    bindResources(mounted, urls);
    const runtimeSelector = `[data-domformat-instance=${JSON.stringify(surface.getAttribute("data-domformat-instance"))}]`;
    for (const binding of document.cssBinding.stylesheets) {
      const element = ownerDocument.createElement("style");
      element.dataset.domformatStylesheet = binding.id;
      const css = new TextDecoder().decode(resourceBytes.get(binding.resource));
      element.textContent = closedCss(css, binding, urls, runtimeSelector);
      ownerDocument.head.appendChild(element);
      styles.push(element);
    }
    boundTargets = bindChannels(document.bindings, mounted);
    phases.advance("bind");

    const materialized = materializePolycssState(document.state);
    playback = createPolycssPlayback(materialized, document.bindings, mounted, { ...options, boundTargets });
    effects = interpreters.has("polycss-effects@0")
      ? createPolycssEffects(materialized, document.bindings, mounted, { boundTargets })
      : null;
    const presentation = document.bindings.channels.find((channel) => channel.interpreter === "static-presentation@0")?.parameters;
    invariant(presentation, "MISSING_POLYCSS_BINDING", "Presentation parameters are required.");
    input = interpreters.has("polycss-pointer-grab@0") ? createInteractionInput(host, presentation) : null;
    const makeInteraction = () => createPolycssInteraction(materialized, document.bindings, mounted, playback, {
      ...options,
      boundTargets,
      presentation,
    });
    if (mode === "interaction") interaction = makeInteraction();
    const ResizeObserverClass = win.ResizeObserver;
    resizeObserver = typeof ResizeObserverClass === "function"
      ? new ResizeObserverClass(() => {
          if (phases.phase !== "publish") return;
          try { playback.resize(); } catch { cleanup(); }
        })
      : null;
    phases.advance("initialize");

    playback.publishInitial();
    if (mode === "interaction") {
      const binding = document.bindings.channels.find((channel) => channel.interpreter === "polycss-pointer-grab@0");
      playback.seek(binding.parameters.initialFrame);
      input?.setEnabled(true);
    } else input?.setEnabled(false);
    effects?.publish(playback.sourceFrame);
    if (mode === "interaction") interaction.publishInitial();
    hostMutated = true;
    if (interpreters.has("polycss-pointer-grab@0") && !host.hasAttribute("tabindex")) host.setAttribute("tabindex", "0");
    host.replaceChildren(surface);
    playback.resize();
    resizeObserver?.observe(host);

    const publishEffects = (frame, selected = null) => {
      if (selected) effects?.publish(frame, selected);
      else if (effects && effects.sourceFrame !== frame) effects.publish(frame);
      return frame;
    };
    const stepInteraction = (sample = input?.sample()) => {
      assertPublished();
      invariant(interaction, "INVALID_EXPERIENCE_MODE", "Interaction mode is not active.");
      const frame = interaction.step(sample);
      publishEffects(frame.sourceFrame, frame.selectedId && frame.selectedMatrix
        ? { active: true, x: frame.selectedMatrix[12], y: frame.selectedMatrix[13], z: frame.selectedMatrix[14] }
        : { active: false, x: 0, y: 0, z: 0 });
      return frame;
    };
    let nextTick = null;
    const playbackBinding = document.bindings.channels.find((channel) => channel.interpreter === "polycss-playback@0");
    const tickMs = playbackBinding ? 1000 / playbackBinding.parameters.tickRateHz : null;
    const loop = (timestamp) => {
      if (phases.phase === "destroy") return;
      try {
        if (nextTick === null) nextTick = timestamp + tickMs;
        else while (timestamp >= nextTick - 0.5) {
          if (mode === "interaction") stepInteraction();
          else publishEffects(playback.advance());
          nextTick += tickMs;
        }
      } catch (error) {
        cleanup();
        throw error;
      }
      if (phases.phase !== "destroy") request = win.requestAnimationFrame(loop);
    };
    if (options.animate !== false && playbackBinding) {
      invariant(typeof win.requestAnimationFrame === "function" && typeof win.cancelAnimationFrame === "function", "MISSING_BROWSER_API", "Animation-frame support is required.");
      request = win.requestAnimationFrame(loop);
    }
    phases.advance("publish");

    return Object.freeze({
      lifecycle: phases.view,
      get mode() { return mode; },
      get sourceFrame() { assertPublished(); return playback.sourceFrame; },
      advance() { assertPublished(); invariant(mode === "animation", "INVALID_EXPERIENCE_MODE", "Animation mode is not active."); return publishEffects(playback.advance()); },
      seek(frame) { assertPublished(); invariant(mode === "animation", "INVALID_EXPERIENCE_MODE", "Animation mode is not active."); return publishEffects(playback.seek(frame)); },
      stepInteraction,
      snapshot() { assertPublished(); return snapshotTree(mounted, urls); },
      node(id) { assertPublished(); return mounted.byId.get(id); },
      setMode(next) {
        assertPublished();
        invariant(next === "animation" || next === "interaction", "INVALID_EXPERIENCE_MODE", "Mode must be animation or interaction.");
        if (next === mode) return mode;
        try {
          if (next === "interaction") {
            const binding = document.bindings.channels.find((channel) => channel.interpreter === "polycss-pointer-grab@0");
            invariant(binding, "MISSING_POLYCSS_BINDING", "The pointer interaction binding is absent.");
            const candidate = makeInteraction();
            try {
              playback.seek(binding.parameters.initialFrame);
              publishEffects(playback.sourceFrame);
              input?.setEnabled(true);
              candidate.publishInitial();
            } catch (error) {
              candidate.destroy();
              throw error;
            }
            interaction?.destroy();
            interaction = candidate;
          } else {
            input?.setEnabled(false);
            const modified = interaction?.restore() ?? { shapeIndices: [], leafIndices: [] };
            interaction?.destroy();
            interaction = null;
            publishEffects(playback.restart(modified.shapeIndices, modified.leafIndices));
          }
          mode = next;
          return mode;
        } catch (error) {
          cleanup();
          throw error;
        }
      },
      destroy: cleanup,
    });
  } catch (error) {
    cleanup();
    throw error;
  }
}
