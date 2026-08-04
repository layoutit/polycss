import { jsonStructureLimits, mergeLimits, validateLimitOverrides } from "./constants.js";
import { decodeJson, deepFreezeJson } from "./canonical-json.js";
import { fail, invariant } from "./errors.js";
import { validateDocumentInternal } from "./schema.js";
import {
  assertSafeRelativePath,
  validateCssBytes,
  materializeCss,
  validateResourceBytes,
} from "./resources.js";
import { applyInitialResources, instantiateTree } from "./retained-dom.js";
import { createLifecycle } from "./lifecycle.js";
import { createInteractionInput } from "./browser-input.js";
import { createPolycssEffects } from "./state/effects.js";
import { createPolycssInteraction } from "./state/interaction.js";
import { createPolycssPlayback, materializePolycssState } from "./state/polycss.js";

const RUNTIME_SCOPE_ATTRIBUTE = "data-domformat-instance";
const validatedBrowserResults = new WeakMap();
let runtimeScopeSequence = 0;
const BROWSER_DEFAULT_LIMITS = Object.freeze({
  maxFileBytes: 32 * 1024 * 1024,
  maxDecodedInputBytes: 32 * 1024 * 1024,
  maxAggregateDecodedBytes: 32 * 1024 * 1024,
  maxNodes: 10_000,
  maxResources: 64,
  maxResourceBytes: 8 * 1024 * 1024,
  maxAggregateResourceBytes: 16 * 1024 * 1024,
  maxImagePixels: 16 * 1024 * 1024,
  maxAggregateImagePixels: 16 * 1024 * 1024,
  maxCssBytes: 1024 * 1024,
  maxFrames: 2_000,
  maxTimelineTicks: 200_000,
  maxPreparedTransforms: 500_000,
  maxPreparedStates: 500_000,
  maxPreparedChanges: 1_000_000,
  maxVisibilityCells: 4 * 1024 * 1024,
  maxEffectParticles: 2_000,
  maxEffectSpawnTuples: 100_000,
  maxInteractionObjects: 4_096,
  maxInteractionVertices: 100_000,
  maxInteractionWeights: 250_000,
  maxInteractionWeightReferences: 1_000_000,
  maxInteractionLeafRows: 250_000,
});

function mergeBrowserLimits(overrides = {}) {
  validateLimitOverrides(overrides);
  return mergeLimits({ ...BROWSER_DEFAULT_LIMITS, ...overrides });
}

function throwIfAborted(signal) {
  invariant(!signal?.aborted, "OPERATION_ABORTED", "The browser domformat operation was aborted by its host.");
}

function runtimeScope(document) {
  let value;
  do {
    value = `d${(runtimeScopeSequence++).toString(36)}`;
  } while (document.querySelector?.(`[${RUNTIME_SCOPE_ATTRIBUTE}="${value}"]`));
  return Object.freeze({
    name: RUNTIME_SCOPE_ATTRIBUTE,
    selector: `[${RUNTIME_SCOPE_ATTRIBUTE}="${value}"]`,
    value,
  });
}

async function sha256Hex(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function externalBytes(value, label) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  invariant(false, "INVALID_RESOURCE_BYTES", `${label} did not return bytes.`);
}

const JSON_DOCUMENT_FIELDS = Object.freeze(["meta", "tree", "cssBinding", "state", "bindings", "resources"]);
function browserPlainRecord(value, code, label) {
  invariant(value && typeof value === "object" && !Array.isArray(value), code, `${label} must be an object.`);
  const prototype = Object.getPrototypeOf(value);
  invariant(prototype === Object.prototype || prototype === null, code, `${label} must be a plain object.`);
  return value;
}

async function decodeBrowserJsonTransport(value, limits, signal) {
  throwIfAborted(signal);
  const bytes = externalBytes(value, "Model");
  invariant(bytes.length <= limits.maxFileBytes, "FILE_LIMIT", "Browser JSON exceeds its file byte limit.");
  invariant(!(bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b), "UNSUPPORTED_TRANSPORT", "domformat@0 accepts plain JSON only.");
  invariant(bytes.length <= limits.maxAggregateDecodedBytes, "DOCUMENT_DECODED_LIMIT", "Browser JSON exceeds its byte limit.");
  return Object.freeze({ encoding: "json", totalLength: bytes.length, decodedLength: bytes.length, bytes: bytes.slice() });
}

function browserDocumentEnvelope(value) {
  const document = browserPlainRecord(value, "INVALID_DOCUMENT", "Decoded document");
  const allowed = new Set(JSON_DOCUMENT_FIELDS);
  for (const key of Object.keys(document)) invariant(allowed.has(key), "INVALID_DOCUMENT", `Decoded document contains unsupported field ${key}.`);
  return Object.fromEntries(JSON_DOCUMENT_FIELDS.map((name) => [name, document[name]]));
}

async function readResponseBytes(response, { expectedLength, label, limit, limitCode, mismatchCode, signal }) {
  invariant(response && typeof response.ok === "boolean", "INVALID_FETCH_RESPONSE", `${label} fetch did not return a Response-like object.`);
  try {
    const contentEncoding = response.headers?.get?.("content-encoding")?.trim().toLowerCase() ?? "";
    const contentLength = response.headers?.get?.("content-length");
    if ((!contentEncoding || contentEncoding === "identity") && contentLength !== null && /^\d+$/u.test(contentLength)) {
      const declared = Number(contentLength);
      invariant(Number.isSafeInteger(declared) && declared <= limit, limitCode, `${label} response exceeds its byte limit.`);
      if (expectedLength !== undefined) invariant(declared === expectedLength, mismatchCode, `${label} HTTP length does not match its declared package length.`);
    }
  } catch (error) {
    try { await response.body?.cancel?.(); } catch {}
    throw error;
  }

  const chunks = [];
  let total = 0;
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    try {
      while (true) {
        throwIfAborted(signal);
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = externalBytes(value, label);
        total += chunk.byteLength;
        invariant(total <= limit, limitCode, `${label} response exceeds its byte limit.`);
        chunks.push(chunk);
      }
    } catch (error) {
      try { await reader.cancel(); } catch {}
      throw error;
    }
  } else {
    const chunk = new Uint8Array(await response.arrayBuffer());
    throwIfAborted(signal);
    total = chunk.byteLength;
    invariant(total <= limit, limitCode, `${label} response exceeds its byte limit.`);
    chunks.push(chunk);
  }
  if (expectedLength !== undefined) invariant(total === expectedLength, mismatchCode, `${label} response length does not match its declared package length.`);
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function resolveModelUrl(value, baseUrl) {
  let url;
  try {
    url = baseUrl === undefined ? new URL(value) : new URL(value, baseUrl);
  } catch {
    invariant(false, "UNSAFE_MODEL_URL", "The domformat JSON URL is invalid or lacks a trusted base URL.");
  }
  invariant((url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password, "UNSAFE_MODEL_URL", "The domformat JSON URL must use HTTP(S) without credentials.");
  return url;
}

async function fetchBytes(fetcher, url, options) {
  throwIfAborted(options.signal);
  let response;
  try {
    response = await fetcher(url.href, {
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      signal: options.signal,
    });
  } catch (error) {
    throwIfAborted(options.signal);
    invariant(false, options.fetchCode, `${options.label} request failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  invariant(response && typeof response.ok === "boolean", "INVALID_FETCH_RESPONSE", `${options.label} fetch did not return a Response-like object.`);
  if (!response.ok) {
    try { await response.body?.cancel?.(); } catch {}
    invariant(false, options.fetchCode, `${options.label} request failed with HTTP ${response.status}.`);
  }
  return readResponseBytes(response, options);
}

export async function readDomBrowser(value, options = {}) {
  const limits = mergeBrowserLimits(options.limits);
  throwIfAborted(options.signal);
  const transport = await decodeBrowserJsonTransport(value, limits, options.signal);
  const parsed = decodeJson(transport.bytes, "domformat JSON document", jsonStructureLimits(limits));
  throwIfAborted(options.signal);
  const document = browserDocumentEnvelope(parsed);
  const validated = validateDocumentInternal(document, { limits });
  const resourceBytes = new Map();
  const provided = options.externalResources;
  const loader = options.loadExternalResource;
  invariant(provided === undefined || provided instanceof Map, "INVALID_EXTERNAL_RESOURCES", "externalResources must be a Map keyed by logical resource id.");
  invariant(document.resources.resources.length === 0 || provided instanceof Map || typeof loader === "function", "MISSING_EXTERNAL_RESOURCE", "Browser loading requires external resource bytes or a trusted loader.");
  if (provided instanceof Map) {
    const declared = new Set(document.resources.resources.map((record) => record.id));
    for (const id of provided.keys()) invariant(declared.has(id), "UNEXPECTED_EXTERNAL_RESOURCE", `External resource ${String(id)} is not declared by this document.`);
  }
  for (const record of document.resources.resources) {
    throwIfAborted(options.signal);
    const loaded = provided?.get(record.id) ?? await loader?.(record);
    throwIfAborted(options.signal);
    invariant(loaded !== undefined, "MISSING_EXTERNAL_RESOURCE", `External resource ${record.id} is missing.`);
    resourceBytes.set(record.id, externalBytes(loaded, `Resource ${record.id}`).slice());
  }
  for (const record of document.resources.resources) {
    throwIfAborted(options.signal);
    const bytes = resourceBytes.get(record.id);
    invariant(bytes.length === record.byteLength, "RESOURCE_SIZE_MISMATCH", `Resource ${record.id} byte length does not match RCRD.`);
    invariant(await sha256Hex(bytes) === record.digest.value, "RESOURCE_DIGEST_MISMATCH", `Resource ${record.id} integrity failed.`);
    throwIfAborted(options.signal);
    validateResourceBytes(record, bytes, validated.limits);
  }
  for (const binding of document.cssBinding.stylesheets) validateCssBytes(resourceBytes.get(binding.resource), binding, validated.resourceIds, validated.limits);
  deepFreezeJson(document);
  const publicResourceBytes = new Map([...resourceBytes].map(([id, bytes]) => [id, bytes.slice()]));
  const result = Object.freeze({ transport, document, resourceBytes: publicResourceBytes });
  validatedBrowserResults.set(result, Object.freeze({ document, limits: validated.limits, resourceBytes }));
  return result;
}

export async function readDomBrowserUrl(modelUrl, options = {}) {
  const limits = mergeBrowserLimits(options.limits);
  const baseUrl = options.baseUrl ?? globalThis.document?.baseURI;
  const resolvedModel = resolveModelUrl(modelUrl, baseUrl);
  const fetcher = options.fetch ?? globalThis.fetch;
  invariant(typeof fetcher === "function", "MISSING_FETCH", "Browser URL loading requires fetch.");
  const modelBytes = await fetchBytes(fetcher, resolvedModel, {
    fetchCode: "MODEL_FETCH_FAILED",
    label: "Model",
    limit: limits.maxFileBytes,
    limitCode: "FILE_LIMIT",
    mismatchCode: "TOTAL_LENGTH_MISMATCH",
    signal: options.signal,
  });
  const defaultLoader = async (record) => {
    const relative = assertSafeRelativePath(record.path, `Resource ${record.id} path`);
    const resourceUrl = new URL(relative, resolvedModel);
    invariant(resourceUrl.origin === resolvedModel.origin && !resourceUrl.username && !resourceUrl.password, "UNSAFE_RESOURCE_URL", `Resource ${record.id} escapes the model origin.`);
    return fetchBytes(fetcher, resourceUrl, {
      expectedLength: record.byteLength,
      fetchCode: "RESOURCE_FETCH_FAILED",
      label: `Resource ${record.id}`,
      limit: record.byteLength,
      limitCode: "RESOURCE_SIZE_MISMATCH",
      mismatchCode: "RESOURCE_SIZE_MISMATCH",
      signal: options.signal,
    });
  };
  return readDomBrowser(modelBytes, {
    ...options,
    limits,
    loadExternalResource: options.loadExternalResource ?? defaultLoader,
  });
}

function captureHostState(host, document) {
  invariant(host && typeof host.replaceChildren === "function" && host.style, "INVALID_DOCUMENT_HOST", "A mount host is required.");
  const children = [...host.childNodes];
  const attributeNames = new Set([
    ...document.tree.mount.attributes.map(([name]) => name),
    RUNTIME_SCOPE_ATTRIBUTE,
    "tabindex",
  ]);
  const attributes = new Map([...attributeNames].map((name) => [name, {
    present: host.hasAttribute(name),
    value: host.getAttribute(name),
  }]));
  const styleNames = new Set([
    ...Object.keys(document.tree.mount.styles ?? {}),
    ...Object.keys(document.tree.mount.resourceStyles ?? {}),
  ]);
  for (const channel of document.bindings.channels) {
    for (const sink of channel.sinks) {
      if (sink.startsWith("host.style.")) styleNames.add(sink.slice("host.style.".length));
    }
  }
  const styles = new Map([...styleNames].map((name) => [name, host.style[name]]));
  const styleAttribute = {
    present: host.hasAttribute("style"),
    value: host.getAttribute("style"),
  };
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    host.replaceChildren(...children);
    for (const [name, previous] of attributes) {
      if (previous.present) host.setAttribute(name, previous.value);
      else host.removeAttribute(name);
    }
    for (const [name, value] of styles) host.style[name] = value;
    if (styleAttribute.present) host.setAttribute("style", styleAttribute.value);
    else host.removeAttribute("style");
  };
}

function applyMountBoundary(surface) {
  const declarations = [
    ["display", "block"],
    ["position", "relative"],
    ["inset", "0"],
    ["width", "100%"],
    ["height", "100%"],
    ["max-width", "none"],
    ["margin", "0"],
    ["padding", "0"],
    ["border", "0"],
    ["box-sizing", "border-box"],
    ["overflow", "hidden"],
    ["contain", "strict"],
    ["isolation", "isolate"],
    ["transform", "none"],
    ["z-index", "auto"],
    ["opacity", "1"],
    ["visibility", "visible"],
    ["pointer-events", "auto"],
  ];
  const camel = (name) => name.replace(/-([a-z])/gu, (_match, letter) => letter.toUpperCase());
  for (const [name, value] of declarations) {
    if (typeof surface.style.setProperty === "function") surface.style.setProperty(name, value, "important");
    else surface.style[camel(name)] = value;
  }
  surface.setAttribute("data-domformat-mount-surface", "");
}

async function decodeImageResources(document, resourceBytes, win, BlobClass, signal) {
  const decode = win.createImageBitmap ?? globalThis.createImageBitmap;
  invariant(typeof decode === "function", "MISSING_BROWSER_API", "Image decoding support is required before a package can publish.");
  for (const record of document.resources.resources) {
    if (record.kind !== "image") continue;
    throwIfAborted(signal);
    let bitmap;
    try {
      bitmap = await decode.call(win, new BlobClass([resourceBytes.get(record.id)], { type: record.mediaType }));
    } catch (error) {
      throwIfAborted(signal);
      fail("IMAGE_DECODE_FAILED", `Browser decoding rejected image resource ${record.id}.`, { cause: String(error) });
    }
    try {
      throwIfAborted(signal);
      invariant(bitmap && bitmap.width === record.dimensions.width && bitmap.height === record.dimensions.height, "IMAGE_DIMENSION_MISMATCH", `Browser-decoded image ${record.id} dimensions do not match RCRD.`);
    } finally {
      try { bitmap?.close?.(); } catch {}
    }
  }
}

function bindTargetGraph(value, mounted) {
  if (typeof value === "string") {
    const element = value === "$host" ? mounted.host : mounted.byId.get(value);
    invariant(element, "MISSING_TARGET_NODE", `Declared binding target ${value} is not mounted.`);
    return element;
  }
  if (Array.isArray(value)) return Object.freeze(value.map((entry) => bindTargetGraph(entry, mounted)));
  const bound = {};
  for (const [name, entry] of Object.entries(value)) bound[name] = bindTargetGraph(entry, mounted);
  return Object.freeze(bound);
}

function bindMountedChannels(bindings, mounted) {
  const channels = new Map();
  for (const channel of bindings.channels) {
    const targets = bindTargetGraph(channel.targets, mounted);
    for (const sink of channel.sinks) {
      const property = sink.slice(sink.lastIndexOf(".") + 1);
      invariant(typeof property === "string" && property.length > 0, "UNSUPPORTED_SINK", `Binding ${channel.id} contains an invalid sink.`);
    }
    channels.set(channel.id, Object.freeze({ targets, sinks: Object.freeze([...channel.sinks]) }));
  }
  return channels;
}

export async function mountDom(result, host, options = {}) {
  const lifecycle = createLifecycle(options.onLifecyclePhase);
  let ownerDocument;
  let win;
  let urlApi;
  let BlobClass;
  let restoreHost = null;
  let hostMutated = false;
  const urls = new Map();
  const styles = [];
  let mountSurface;
  let mounted;
  let boundTargets;
  let materialized;
  let preparedPlayback;
  let effects;
  let input;
  let resizeObserver = null;
  let request = null;
  let mode;
  let interaction = null;
  const cleanup = () => {
    if (lifecycle.phase === "destroy") return false;
    const attempt = (operation) => {
      try { operation?.(); } catch {}
    };
    if (request !== null) attempt(() => win?.cancelAnimationFrame(request));
    request = null;
    attempt(() => resizeObserver?.disconnect());
    attempt(() => input?.destroy());
    attempt(() => interaction?.destroy());
    interaction = null;
    attempt(() => effects?.destroy());
    boundTargets = null;
    for (const style of styles) attempt(() => style.remove());
    for (const url of urls.values()) attempt(() => urlApi?.revokeObjectURL(url));
    if (hostMutated) attempt(restoreHost);
    lifecycle.destroy();
    return true;
  };
  const assertMounted = () => {
    invariant(lifecycle.phase !== "destroy", "MOUNT_DESTROYED", "The mounted DOM runtime is destroyed.");
    lifecycle.assertPublished();
  };

  try {
    throwIfAborted(options.signal);
    const validated = result && typeof result === "object" ? validatedBrowserResults.get(result) : undefined;
    invariant(validated, "LIFECYCLE_PRECONDITION", "mountDom requires a result returned by readDomBrowser or readDomBrowserUrl.");
    const packageDocument = validated.document;
    const packageResources = validated.resourceBytes;
    mode = options.mode ?? packageDocument.meta.initialExperience ?? "animation";
    invariant(mode === "animation" || mode === "interaction", "INVALID_EXPERIENCE_MODE", "Browser mode must be animation or interaction.");
    ownerDocument = host?.ownerDocument;
    win = ownerDocument?.defaultView;
    invariant(ownerDocument && win, "INVALID_DOCUMENT_HOST", "A connected browser document host is required.");
    urlApi = win.URL ?? globalThis.URL;
    BlobClass = win.Blob ?? globalThis.Blob;
    invariant(typeof urlApi?.createObjectURL === "function" && typeof urlApi?.revokeObjectURL === "function" && typeof BlobClass === "function", "MISSING_BROWSER_API", "Object URL and Blob support are required.");

    const mountValidation = validateDocumentInternal(packageDocument, { limits: validated.limits });
    throwIfAborted(options.signal);
    const interpreters = new Set(packageDocument.bindings.channels.map((channel) => channel.interpreter));
    invariant(interpreters.has("static-presentation@0"), "UNSUPPORTED_MOUNT_CONTRACT", "mountDom requires executable static presentation.");
    if (mode === "interaction") invariant(interpreters.has("polycss-pointer-grab@0"), "UNSUPPORTED_MOUNT_CONTRACT", "The interaction experience requires an executable pointer interaction channel.");
    invariant(packageResources instanceof Map, "LIFECYCLE_PRECONDITION", "The validated browser result has no private resource snapshot.");
    invariant(packageResources.size === packageDocument.resources.resources.length, "RESOURCE_CARDINALITY_MISMATCH", "Mounted resource count does not match RCRD.");
    for (const record of packageDocument.resources.resources) {
      const bytes = externalBytes(packageResources.get(record.id), `Resource ${record.id}`);
      invariant(bytes.length === record.byteLength, "RESOURCE_SIZE_MISMATCH", `Resource ${record.id} byte length does not match RCRD.`);
      invariant(await sha256Hex(bytes) === record.digest.value, "RESOURCE_DIGEST_MISMATCH", `Resource ${record.id} integrity failed before mounting.`);
      throwIfAborted(options.signal);
      validateResourceBytes(record, bytes, mountValidation.limits);
    }
    for (const binding of packageDocument.cssBinding.stylesheets) {
      validateCssBytes(packageResources.get(binding.resource), binding, mountValidation.resourceIds, mountValidation.limits);
    }
    lifecycle.advance("validate");

    const isolation = runtimeScope(ownerDocument);
    restoreHost = captureHostState(host, packageDocument);
    mountSurface = ownerDocument.createElement("div");
    mountSurface.setAttribute(isolation.name, isolation.value);
    mounted = instantiateTree(ownerDocument, mountSurface, { tree: packageDocument.tree });
    applyMountBoundary(mountSurface);
    lifecycle.advance("construct");

    for (const record of packageDocument.resources.resources) {
      if (record.kind === "stylesheet") continue;
      urls.set(record.id, urlApi.createObjectURL(new BlobClass([packageResources.get(record.id)], { type: record.mediaType })));
    }
    await decodeImageResources(packageDocument, packageResources, win, BlobClass, options.signal);
    throwIfAborted(options.signal);
    applyInitialResources(mounted, urls);
    for (const binding of packageDocument.cssBinding.stylesheets) {
      const css = new TextDecoder().decode(packageResources.get(binding.resource));
      const element = ownerDocument.createElement("style");
      element.dataset.domformatStylesheet = binding.id;
      element.textContent = materializeCss(css, binding, urls, { scope: isolation.selector, limits: mountValidation.limits });
      ownerDocument.head.appendChild(element);
      styles.push(element);
    }
    boundTargets = bindMountedChannels(packageDocument.bindings, mounted);
    lifecycle.advance("bind");

    materialized = materializePolycssState(packageDocument.state);
    throwIfAborted(options.signal);
    preparedPlayback = createPolycssPlayback(materialized, packageDocument.bindings, mounted, { ...options, boundTargets });
    effects = interpreters.has("polycss-effects@0")
      ? createPolycssEffects(materialized, packageDocument.bindings, mounted, { boundTargets })
      : null;
    const publishPlaybackFrame = (frame) => {
      if (effects && effects.sourceFrame !== frame) effects.publish(frame);
      return frame;
    };
    const playback = Object.freeze({
      get tick() { return preparedPlayback.tick; },
      get sourceFrame() { return preparedPlayback.sourceFrame; },
      advance() {
        assertMounted();
        return publishPlaybackFrame(preparedPlayback.advance());
      },
      seek(frame) {
        assertMounted();
        return publishPlaybackFrame(preparedPlayback.seek(frame));
      },
    });
    const presentationBinding = packageDocument.bindings.channels.find((channel) => channel.interpreter === "static-presentation@0");
    const presentation = presentationBinding?.parameters;
    invariant(presentation, "MISSING_POLYCSS_BINDING", "Executable presentation parameters are required.");
    input = interpreters.has("polycss-pointer-grab@0") ? createInteractionInput(host, presentation) : null;
    const ResizeObserverClass = win.ResizeObserver;
    resizeObserver = typeof ResizeObserverClass === "function"
      ? new ResizeObserverClass(() => {
          if (lifecycle.phase !== "publish") return;
          try { preparedPlayback.resize(); } catch { cleanup(); }
        })
      : null;
    const makeInteraction = () => {
      const interactionBinding = packageDocument.bindings.channels.find((channel) => channel.interpreter === "polycss-pointer-grab@0");
      invariant(interactionBinding, "MISSING_POLYCSS_BINDING", "Executable pointer interaction parameters are required.");
      return Object.freeze({
        binding: interactionBinding,
        interpreter: createPolycssInteraction(materialized, packageDocument.bindings, mounted, preparedPlayback, {
          ...options,
          boundTargets,
          presentation,
        }),
      });
    };
    const activateInteraction = () => {
      assertMounted();
      const next = makeInteraction();
      try {
        preparedPlayback.seek(next.binding.parameters.initialFrame);
        publishPlaybackFrame(preparedPlayback.sourceFrame);
        input?.setEnabled(true);
      } catch (error) {
        next.interpreter.destroy();
        throw error;
      }
      interaction?.destroy();
      interaction = next.interpreter;
    };
    if (mode === "interaction") interaction = makeInteraction().interpreter;
    lifecycle.advance("initialize");

    preparedPlayback.publishInitial();
    if (mode === "interaction") {
      const interactionBinding = packageDocument.bindings.channels.find((channel) => channel.interpreter === "polycss-pointer-grab@0");
      preparedPlayback.seek(interactionBinding.parameters.initialFrame);
      input?.setEnabled(true);
    } else input?.setEnabled(false);
    effects?.publish(preparedPlayback.sourceFrame);
    if (mode === "interaction") interaction.publishInitial();
    throwIfAborted(options.signal);
    hostMutated = true;
    if (interpreters.has("polycss-pointer-grab@0") && !host.hasAttribute("tabindex")) host.setAttribute("tabindex", "0");
    host.replaceChildren(mountSurface);
    preparedPlayback.resize();
    resizeObserver?.observe(host);
    const stepInteraction = (sample = input.sample()) => {
      assertMounted();
      invariant(interaction, "INVALID_EXPERIENCE_MODE", "Interaction mode is not active.");
      const frame = interaction.step(sample ?? input.sample());
      effects?.publish(frame.sourceFrame, frame.selectedId && frame.selectedMatrix
        ? { active: true, x: frame.selectedMatrix[12], y: frame.selectedMatrix[13], z: frame.selectedMatrix[14] }
        : { active: false, x: 0, y: 0, z: 0 });
      return frame;
    };
    let nextTick = null;
    const playbackBinding = packageDocument.bindings.channels.find((channel) => channel.interpreter === "polycss-playback@0");
    const tickMs = playbackBinding ? 1000 / playbackBinding.parameters.tickRateHz : null;
    const loop = (timestamp) => {
      if (lifecycle.phase === "destroy") return;
      try {
        if (nextTick === null) nextTick = timestamp + tickMs;
        else while (timestamp >= nextTick - 0.5) {
          if (mode === "interaction") stepInteraction();
          else playback.advance();
          nextTick += tickMs;
        }
      } catch (error) {
        cleanup();
        throw error;
      }
      if (lifecycle.phase !== "destroy") request = win.requestAnimationFrame(loop);
    };
    if (options.animate !== false && playbackBinding) {
      invariant(typeof win.requestAnimationFrame === "function" && typeof win.cancelAnimationFrame === "function", "MISSING_BROWSER_API", "Animation-frame support is required for animated mounting.");
      request = win.requestAnimationFrame(loop);
    }
    lifecycle.advance("publish");
    return Object.freeze({
      lifecycle: lifecycle.view,
      get mode() { return mode; },
      get sourceFrame() { return playback.sourceFrame; },
      seek(frame) {
        assertMounted();
        return playback.seek(frame);
      },
      setMode(next) {
        assertMounted();
        invariant(next === "animation" || next === "interaction", "INVALID_EXPERIENCE_MODE", "Browser mode must be animation or interaction.");
        if (next === mode) return mode;
        try {
          if (next === "interaction") {
            activateInteraction();
            interaction.publishInitial();
          } else {
            input?.setEnabled(false);
            const modified = interaction?.restore() ?? { shapeIndices: [], leafIndices: [] };
            interaction?.destroy();
            interaction = null;
            const sourceFrame = preparedPlayback.restart(modified.shapeIndices, modified.leafIndices);
            if (effects && effects.sourceFrame !== sourceFrame) effects.publish(sourceFrame);
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
