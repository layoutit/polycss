import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { loadManifest } from "../src/manifest.js";

const here = dirname(fileURLToPath(import.meta.url));
export const projectRoot = resolve(here, "..");
export const syntheticManifestPath = resolve(projectRoot, "fixtures/synthetic/manifest.json");
export const syntheticPolycssManifestPath = resolve(projectRoot, "fixtures/synthetic-polycss/manifest.json");
export const syntheticInteractionPacketPath = resolve(projectRoot, "fixtures/synthetic-interaction/packet.json");

export async function syntheticInput() {
  return loadManifest(syntheticManifestPath);
}

export async function syntheticPolycssInput() {
  return loadManifest(syntheticPolycssManifestPath);
}

export async function syntheticEmptySurfaceInput() {
  const input = await syntheticPolycssInput();
  const playbackBinding = input.bindings.channels.find((channel) => channel.interpreter === "polycss-playback@0");
  const surfaceBinding = input.bindings.channels.find((channel) => channel.interpreter === "polycss-surface@0");
  const playback = input.state.channels.find((channel) => channel.codec === "polycss-playback-packed@0").data;
  const surface = input.state.channels.find((channel) => channel.codec === "polycss-surface-packed@0").data.packet;
  playback.packet.leafCount = 0;
  playback.packet.initial.leaves = { count: 0, transforms: [] };
  playback.packet.transforms = {
    count: 1,
    groups: [{
      encoding: "decimal-component-streams",
      empty: [0],
      scales: new Array(12).fill(0),
      columns: Array.from({ length: 12 }, () => []),
    }],
  };
  playback.leafFit = [];
  playbackBinding.targets.leaves = [];
  surfaceBinding.targets.leaves = [];
  surface.surface = { faces: [], statePacking: { stateCount: 0, sourceFrameDeltas: [] } };
  surface.visibility.initialVisibleBitsBase64 = "";
  input.meta.counts.leaves = 0;
  return input;
}

export async function syntheticPlaybackWithoutSurfaceInput() {
  const input = await syntheticEmptySurfaceInput();
  input.state.channels = input.state.channels.filter((channel) => channel.codec !== "polycss-surface-packed@0");
  input.bindings.channels = input.bindings.channels.filter((channel) => channel.interpreter !== "polycss-surface@0");
  input.meta.capabilities = input.meta.capabilities.filter((capability) => capability !== "prepared-surface-lighting");
  input.meta.conformance.executable = input.meta.conformance.executable.filter((role) => role !== "surface-lighting");
  return input;
}

export async function syntheticAnimationWithoutEffectsInput() {
  const input = await syntheticPolycssInput();
  input.state.channels = input.state.channels.filter((channel) => channel.codec !== "polycss-effects-prepared@0");
  input.bindings.channels = input.bindings.channels.filter((channel) => channel.interpreter !== "polycss-effects@0");
  input.bindings.inputs = input.bindings.inputs.filter((definition) => !definition.id.startsWith("interaction.grab-"));
  input.meta.capabilities = input.meta.capabilities.filter((capability) => capability !== "prepared-particle-effects");
  input.meta.conformance.executable = input.meta.conformance.executable.filter((role) => role !== "particle-effects");
  return input;
}

export async function syntheticEffectsWithoutPlaybackInput() {
  const input = await syntheticPolycssInput();
  input.state.channels = input.state.channels.filter((channel) => !["polycss-playback-packed@0", "polycss-surface-packed@0"].includes(channel.codec));
  input.bindings.channels = input.bindings.channels.filter((channel) => !["polycss-playback@0", "polycss-surface@0"].includes(channel.interpreter));
  input.bindings.inputs = input.bindings.inputs.filter((definition) => definition.id !== "time.tick");
  input.meta.capabilities = input.meta.capabilities.filter((capability) => !["prepared-playback", "prepared-surface-lighting"].includes(capability));
  input.meta.conformance.executable = input.meta.conformance.executable.filter((role) => !["playback", "surface-lighting"].includes(role));
  input.meta.counts = { nodes: input.tree.nodes.length };
  return input;
}

export async function syntheticStaticPresentationInput() {
  const input = await syntheticPolycssInput();
  input.tree.nodes = input.tree.nodes.slice(0, 3);
  delete input.tree.mount.resourceStyles.backgroundImage;
  delete input.tree.mount.styles.backgroundPosition;
  delete input.tree.mount.styles.backgroundRepeat;
  delete input.tree.mount.styles.backgroundSize;
  const presentationState = input.state.channels.find((channel) => channel.codec === "static-presentation@0");
  delete presentationState.data.packet.background;
  input.state.channels = [presentationState];
  const presentationBinding = input.bindings.channels.find((channel) => channel.interpreter === "static-presentation@0");
  presentationBinding.targets = { host: "$host", camera: "synthetic-polycss/camera" };
  presentationBinding.sinks = ["style.height", "style.left", "style.top", "style.transform", "style.width"];
  input.bindings.channels = [presentationBinding];
  input.bindings.inputs = input.bindings.inputs.filter((definition) => definition.id.startsWith("viewport."));
  input.meta.capabilities = ["css-semantic-closure", "deterministic-json", "explicit-retained-tree", "logical-assets"];
  input.meta.conformance.executable = ["retained-tree", "presentation"];
  input.meta.counts = { nodes: input.tree.nodes.length };
  return input;
}

export function builtExternalResources(built) {
  return new Map(built.document.resources.resources.map((record) => [
    record.id,
    built.externalResources.get(record.path),
  ]));
}

function appendNode(input, {
  id,
  parent,
  sibling,
  name,
  classes = [],
  attributes = {},
  styles = {},
  resourceAttributes = {},
  resourceStyles = {},
}) {
  input.tree.nodes.push({
    index: input.tree.nodes.length,
    id,
    parent,
    sibling,
    namespace: "http://www.w3.org/1999/xhtml",
    name,
    classes,
    attributes,
    styles,
    resourceAttributes,
    resourceStyles,
  });
}

export async function syntheticInteractionInput() {
  const input = await syntheticInput();
  const packet = JSON.parse(await readFile(syntheticInteractionPacketPath, "utf8"));
  appendNode(input, { id: "synthetic/eye-shape", parent: 0, sibling: 1, name: "div" });
  appendNode(input, { id: "synthetic/eye-leaf", parent: 3, sibling: 0, name: "u", attributes: { "aria-hidden": "true" }, styles: { transform: "" } });
  appendNode(input, { id: "synthetic/cursor", parent: -1, sibling: 1, name: "div" });
  appendNode(input, { id: "synthetic/cursor:open", parent: 5, sibling: 0, name: "img", attributes: { "aria-hidden": "true" }, styles: { visibility: "hidden" } });
  appendNode(input, { id: "synthetic/cursor:closed", parent: 5, sibling: 1, name: "img", attributes: { "aria-hidden": "true" }, styles: { visibility: "hidden" } });
  input.state.channels.push({ id: "interaction", codec: "polycss-pointer-grab-prepared@0", data: { packet } });
  input.bindings.inputs.unshift(
    { id: "axis.x", type: "float", default: 0 },
    { id: "axis.y", type: "float", default: 0 },
    { id: "button.hold", type: "boolean", default: false },
    { id: "pointer.positioned", type: "boolean", default: false },
    { id: "pointer.pressed", type: "boolean", default: false },
    { id: "pointer.x", type: "float", default: 160 },
    { id: "pointer.y", type: "float", default: 120 },
  );
  input.bindings.channels.push({
    id: "interaction",
    state: "interaction",
    interpreter: "polycss-pointer-grab@0",
    status: "executable",
    inputs: ["axis.x", "axis.y", "button.hold", "pointer.positioned", "pointer.pressed", "pointer.x", "pointer.y"],
    targets: {
      shapes: ["synthetic/shape", "synthetic/eye-shape"],
      leaves: ["synthetic/leaf", "synthetic/eye-leaf"],
      cursorLayer: "synthetic/cursor",
      cursorStates: { open: "synthetic/cursor:open", closed: "synthetic/cursor:closed" },
    },
    sinks: ["style.transform", "style.visibility"],
    parameters: { initialFrame: 3, tickRateHz: 30 },
  });
  input.meta.capabilities.splice(4, 0, "prepared-pointer-grab-interaction");
  input.meta.conformance.executable.push("pointer-grab-interaction");
  return input;
}

export async function syntheticExecutableInteractionInput() {
  const input = await syntheticInteractionInput();
  const executable = await syntheticPolycssInput();
  const playback = structuredClone(executable.state.channels.find((channel) => channel.id === "playback"));
  const surface = structuredClone(executable.state.channels.find((channel) => channel.id === "surface"));
  const effects = structuredClone(executable.state.channels.find((channel) => channel.id === "effects"));
  const presentation = structuredClone(executable.state.channels.find((channel) => channel.id === "presentation"));

  appendNode(input, {
    id: "synthetic/camera",
    parent: -1,
    sibling: 2,
    name: "div",
    classes: ["camera"],
    attributes: { "aria-hidden": "true" },
    styles: {
      height: "240px",
      perspective: "400px",
      perspectiveOrigin: "160px 120px",
      position: "relative",
      width: "320px",
    },
  });
  appendNode(input, { id: "synthetic/effects", parent: -1, sibling: 3, name: "div", classes: ["effects"] });
  appendNode(input, {
    id: "synthetic/effects/particle:0",
    parent: input.tree.nodes.length - 1,
    sibling: 0,
    name: "s",
    classes: ["leaf"],
    attributes: { "aria-hidden": "true" },
    styles: {
      backgroundPosition: "0px 0px",
      height: "2px",
      opacity: "0",
      transform: "translate3d(0px, 0px, 0px)",
      visibility: "hidden",
      width: "2px",
    },
    resourceStyles: { backgroundImage: { resource: "checker", syntax: "url" } },
  });

  Object.assign(input.tree.mount.styles, {
    backgroundColor: "#000",
    backgroundPosition: "center",
    backgroundRepeat: "repeat",
    backgroundSize: "auto",
  });
  input.tree.mount.resourceStyles = {
    backgroundImage: { resource: "checker", syntax: "overlay-url", overlayOpacity: 0.25 },
  };
  input.tree.nodes.find((node) => node.id === "synthetic/scene").styles.transform = "translate3d(0px, 0px, 0px)";
  for (const id of ["synthetic/leaf", "synthetic/eye-leaf"]) {
    const node = input.tree.nodes.find((entry) => entry.id === id);
    node.styles.backgroundPositionY = "0";
    node.styles.visibility = "visible";
  }

  const playbackPacket = playback.data.packet;
  playbackPacket.shapeCount = 2;
  playbackPacket.leafCount = 2;
  playbackPacket.timeline = { introTicks: 0, loopTicks: 8, frames: [1, 2, 3, 4, 5, 6, 7, 8] };
  playbackPacket.initial.sourceFrame = 1;
  playbackPacket.initial.shapes = { count: 2, transforms: [1, 1], visibility: [1, 1] };
  playbackPacket.initial.leaves = { count: 2, transforms: [3, 1] };
  playbackPacket.frameRows = Array.from({ length: 8 }, (_, index) => [index + 1, 0, -1, 0, 0, 0, 0]);
  const emptyTransformGroup = () => ({
    encoding: "decimal-component-streams",
    empty: [0],
    scales: new Array(12).fill(0),
    columns: Array.from({ length: 12 }, () => []),
  });
  const fittedTransformGroup = () => ({
    encoding: "source-milli-fitted-leaf",
    empty: [],
    scales: new Array(12).fill(1000),
    columns: [[1000], [0], [0], [0], [1000], [0], [0], [0], [1000], [0], [0], [0]],
  });
  playbackPacket.transforms = {
    count: 5,
    groups: [emptyTransformGroup(), emptyTransformGroup(), emptyTransformGroup(), fittedTransformGroup(), fittedTransformGroup()],
  };
  playback.data.leafFit = [{ canonicalSize: 32 }, { canonicalSize: 32 }];

  const surfacePacket = surface.data.packet;
  surfacePacket.frameCount = 8;
  surfacePacket.surface.faces = [
    { faceId: "synthetic-face", sourceOrder: 0, stateOffset: 0, stateCount: 1, leafWidth: 32, leafHeight: 32 },
    { faceId: "synthetic-eye-face", sourceOrder: 1, stateOffset: 1, stateCount: 1, leafWidth: 32, leafHeight: 32 },
  ];
  surfacePacket.surface.statePacking = { stateCount: 2, sourceFrameDeltas: [0, 0] };
  surfacePacket.transitions.initialFrame = 1;
  surfacePacket.transitions.sequential = {
    offsetsBase64: base64Integers(new Array(9).fill(0), 4),
    faceIndexDeltas: [],
    stateIndexDeltas: [],
  };
  surfacePacket.transitions.nonInteractiveJumps = [];
  surfacePacket.visibility = {
    initialFrame: 1,
    initialVisibleBitsBase64: Buffer.from([3]).toString("base64"),
    sequential: { offsetsBase64: base64Integers(new Array(9).fill(0), 4), faceIndicesBase64: "" },
    nonInteractiveJumps: [],
  };

  effects.data.packet.frameCount = 8;
  effects.data.packet.emitters = [{ mode: "grab", poolSize: 1, backgroundPositions: ["0px 0px"] }];
  presentation.data.packet.camera.baseSceneTransform = "translate3d(0px, 0px, 0px)";
  input.state.channels.push(effects, playback, presentation, surface);
  input.state.channels.sort((left, right) => left.id.localeCompare(right.id));

  input.bindings.inputs.push(
    { id: "interaction.grab-active", type: "boolean", default: false },
    { id: "interaction.grab-x", type: "float", default: 0 },
    { id: "interaction.grab-y", type: "float", default: 0 },
    { id: "interaction.grab-z", type: "float", default: 0 },
    { id: "time.source-frame", type: "uint" },
    { id: "time.tick", type: "uint" },
    { id: "viewport.height", type: "float" },
    { id: "viewport.width", type: "float" },
  );
  input.bindings.inputs.sort((left, right) => left.id.localeCompare(right.id));
  input.bindings.channels.push(
    {
      id: "effects",
      state: "effects",
      interpreter: "polycss-effects@0",
      status: "executable",
      inputs: ["interaction.grab-active", "interaction.grab-x", "interaction.grab-y", "interaction.grab-z", "time.source-frame"],
      targets: { stars: [], emitters: [["synthetic/effects/particle:0"]] },
      sinks: ["style.backgroundPosition", "style.opacity", "style.transform", "style.visibility"],
      parameters: { frameCount: 8 },
    },
    {
      id: "playback",
      state: "playback",
      interpreter: "polycss-playback@0",
      status: "executable",
      inputs: ["time.tick"],
      targets: {
        model: "synthetic/scene",
        shapes: ["synthetic/shape", "synthetic/eye-shape"],
        leaves: ["synthetic/leaf", "synthetic/eye-leaf"],
      },
      sinks: ["style.transform", "style.visibility"],
      parameters: { baseSceneTransform: "translate3d(0px, 0px, 0px)", frameCount: 8, tickRateHz: 30 },
    },
    {
      id: "presentation",
      state: "presentation",
      interpreter: "static-presentation@0",
      status: "executable",
      inputs: ["viewport.height", "viewport.width"],
      targets: {
        host: "$host",
        camera: "synthetic/camera",
        cursorLayer: "synthetic/cursor",
        cursorStates: { open: "synthetic/cursor:open", closed: "synthetic/cursor:closed" },
      },
      sinks: ["host.style.backgroundColor", "host.style.backgroundImage", "host.style.backgroundPosition", "host.style.backgroundRepeat", "host.style.backgroundSize", "style.height", "style.left", "style.top", "style.transform", "style.visibility", "style.width"],
      parameters: { fitHeight: 240, fitWidth: 320, sourceHeight: 240, sourceWidth: 320 },
    },
    {
      id: "surface",
      state: "surface",
      interpreter: "polycss-surface@0",
      status: "executable",
      inputs: ["time.source-frame"],
      targets: { leaves: ["synthetic/leaf", "synthetic/eye-leaf"] },
      sinks: ["style.backgroundPositionY", "style.visibility"],
    },
  );
  input.bindings.channels.sort((left, right) => left.id.localeCompare(right.id));
  input.meta.capabilities = [
    "css-semantic-closure",
    "deterministic-json",
    "explicit-retained-tree",
    "logical-assets",
    "prepared-particle-effects",
    "prepared-pointer-grab-interaction",
    "prepared-playback",
    "prepared-surface-lighting",
  ];
  input.meta.conformance.executable = [
    "retained-tree",
    "particle-effects",
    "playback",
    "pointer-grab-interaction",
    "presentation",
    "surface-lighting",
  ];
  input.meta.initialExperience = "interaction";
  input.meta.counts = { nodes: input.tree.nodes.length, shapes: 2, leaves: 2, sourceFrames: 8 };
  return input;
}

function base64Integers(values, width) {
  const bytes = new Uint8Array(values.length * width);
  for (let index = 0; index < values.length; index += 1) {
    for (let byte = 0; byte < width; byte += 1) bytes[index * width + byte] = Math.floor(values[index] / 2 ** (byte * 8)) & 255;
  }
  return Buffer.from(bytes).toString("base64");
}

export async function syntheticTwoFramePolycssInput() {
  const input = await syntheticPolycssInput();
  const playbackBinding = input.bindings.channels.find((channel) => channel.interpreter === "polycss-playback@0");
  const playback = input.state.channels.find((channel) => channel.codec === "polycss-playback-packed@0").data.packet;
  playbackBinding.parameters.frameCount = 2;
  playback.timeline.loopTicks = 2;
  playback.timeline.frames = [1, 2];
  playback.frameRows.push([2, 0, -1, 0, 0, 0, 0]);

  const surface = input.state.channels.find((channel) => channel.codec === "polycss-surface-packed@0").data.packet;
  surface.frameCount = 2;
  surface.surface.faces[0].stateCount = 2;
  surface.surface.statePacking.stateCount = 2;
  surface.surface.statePacking.sourceFrameDeltas = [0, 1];
  surface.transitions.sequential.offsetsBase64 = base64Integers([0, 1, 2], 4);
  surface.transitions.sequential.faceIndexDeltas = [0, 0];
  surface.transitions.sequential.stateIndexDeltas = [0, 1];
  surface.visibility.sequential.offsetsBase64 = base64Integers([0, 0, 0], 4);

  const effectsBinding = input.bindings.channels.find((channel) => channel.interpreter === "polycss-effects@0");
  const effects = input.state.channels.find((channel) => channel.codec === "polycss-effects-prepared@0").data.packet;
  effectsBinding.parameters.frameCount = 2;
  effects.frameCount = 2;
  if (input.meta.counts) input.meta.counts.sourceFrames = 2;
  return input;
}

export function errorCode(code) {
  return (error) => error?.code === code;
}
