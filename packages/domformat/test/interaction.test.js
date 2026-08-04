import test from "node:test";
import assert from "node:assert/strict";
import { buildDom } from "../src/writer.js";
import { createPolycssInteraction } from "../src/state/interaction.js";
import { errorCode, syntheticExecutableInteractionInput as interactionInput, syntheticPolycssInput } from "./helpers.js";

async function mismatchedComposedInput() {
  const input = await syntheticPolycssInput();
  const interactionFixture = await interactionInput();
  const packet = structuredClone(interactionFixture.state.channels.find((channel) => channel.id === "interaction").data.packet);
  input.bindings.inputs.push(
    { id: "axis.x", type: "float", default: 0 },
    { id: "axis.y", type: "float", default: 0 },
    { id: "button.hold", type: "boolean", default: false },
    { id: "pointer.positioned", type: "boolean", default: false },
    { id: "pointer.pressed", type: "boolean", default: false },
    { id: "pointer.x", type: "float", default: 160 },
    { id: "pointer.y", type: "float", default: 120 },
  );
  input.bindings.inputs.sort((left, right) => left.id.localeCompare(right.id));
  input.state.channels.push({ id: "interaction", codec: "polycss-pointer-grab-prepared@0", data: { packet } });
  input.state.channels.sort((left, right) => left.id.localeCompare(right.id));
  input.bindings.channels.push({
    id: "interaction",
    state: "interaction",
    interpreter: "polycss-pointer-grab@0",
    status: "executable",
    inputs: ["axis.x", "axis.y", "button.hold", "pointer.positioned", "pointer.pressed", "pointer.x", "pointer.y"],
    targets: {
      shapes: [],
      leaves: ["synthetic-polycss/model"],
      cursorLayer: "synthetic-polycss/cursor",
      cursorStates: { open: "synthetic-polycss/cursor:open", closed: "synthetic-polycss/cursor:closed" },
    },
    sinks: ["style.transform", "style.visibility"],
    parameters: { initialFrame: 3, tickRateHz: 30 },
  });
  input.bindings.channels.sort((left, right) => left.id.localeCompare(right.id));
  input.meta.capabilities.splice(5, 0, "prepared-pointer-grab-interaction");
  input.meta.conformance.executable.splice(3, 0, "pointer-grab-interaction");
  return input;
}

function runtime(input) {
  const binding = input.bindings.channels.find((channel) => channel.id === "interaction");
  const ids = [
    ...binding.targets.shapes,
    ...binding.targets.leaves,
    binding.targets.cursorLayer,
    ...Object.values(binding.targets.cursorStates),
  ];
  const byId = new Map(ids.map((id) => [id, { style: {} }]));
  const mounted = {
    byId,
    host: { clientWidth: 320, clientHeight: 240 },
  };
  const calls = { surfaces: [], forced: [], leaves: [], restores: [], seeks: [] };
  const playback = {
    seek(frame) { calls.seeks.push(frame); return frame; },
    applySurfaceFrame(frame) { calls.surfaces.push(frame); return frame; },
    forceVisible(indices) { calls.forced.push([...indices]); },
    applyInteractionLeaf(index, transform) {
      calls.leaves.push([index, transform]);
      byId.get(binding.targets.leaves[index]).style.transform = transform ?? "degenerate";
    },
    restoreInteraction(shapes, leaves) { calls.restores.push([[...shapes], [...leaves]]); },
  };
  const interaction = createPolycssInteraction(input.state, input.bindings, mounted, playback, {
    presentation: { sourceWidth: 320, sourceHeight: 240, fitWidth: 320, fitHeight: 240 },
    viewportWidth: 320,
    viewportHeight: 240,
  });
  return { interaction, mounted, calls };
}

function snapshot(value) {
  return [...value.mounted.byId].map(([id, element]) => [id, { ...element.style }]);
}

test("prepared pointer/grab executes on stable targets with source-ordered publication", async () => {
  const input = await interactionInput();
  buildDom(input);
  const value = runtime(input);
  const identities = [...value.mounted.byId];
  const first = value.interaction.step({ pressed: true, pointer: { x: 160, y: 120 } });
  assert.equal(first.selectedId, "grab-triangle");
  assert.equal(first.selectedMatrix[12], 0);
  assert.deepEqual(first.safeVisibleLeaves, new Uint16Array(0));
  const initialTransform = value.mounted.byId.get("synthetic/leaf").style.transform;
  const second = value.interaction.step({ pressed: true, pointer: { x: 170, y: 120 } });
  assert.equal(second.selectedMatrix[12], 0, "the selected matrix is source-ordered with the published movement");
  assert.equal(value.mounted.byId.get("synthetic/leaf").style.transform, initialTransform, "the movement is published before the newly sampled displacement");
  assert.equal(value.mounted.byId.get("synthetic/eye-shape").style.transform, "matrix3d(1,0,0,0,0,1,0,0,0,0,1,0,0,-16,0,1)");
  const third = value.interaction.step({ pressed: true, pointer: { x: 170, y: 120 } });
  assert.equal(third.selectedMatrix[12], -6);
  assert.notEqual(value.mounted.byId.get("synthetic/leaf").style.transform, initialTransform);
  assert.deepEqual([...third.safeVisibleLeaves], [0]);
  const released = value.interaction.step({ pressed: false });
  assert.equal(released.selectedId, null);
  assert.equal(released.selectedMatrix[12], -10.5);
  assert.equal(value.interaction.settling, true);
  assert.equal(value.mounted.byId.get("synthetic/cursor:open").style.visibility, "visible");
  assert.equal(value.mounted.byId.get("synthetic/cursor:closed").style.visibility, "hidden");
  assert.equal(value.mounted.byId.size, identities.length);
  for (const [id, element] of identities) assert.equal(value.mounted.byId.get(id), element);
});

test("prepared pointer/grab replay is deterministic including eye-follow and release", async () => {
  const input = await interactionInput();
  const first = runtime(input);
  const second = runtime(input);
  const samples = [
    { pressed: true, pointer: { x: 160, y: 120 } },
    { pressed: true, pointer: { x: 170, y: 125 } },
    { pressed: true, pointer: { x: 180, y: 130 } },
    { pressed: false, hold: true },
    { pressed: false },
  ];
  for (const sample of samples) {
    first.interaction.step(sample);
    second.interaction.step(sample);
  }
  assert.deepEqual(first.interaction.inspect(), second.interaction.inspect());
  assert.deepEqual(first.calls, second.calls);
  assert.deepEqual(snapshot(first), snapshot(second));
});

test("prepared pointer samples use declared source quantization and bounds", async () => {
  const input = await interactionInput();
  const value = runtime(input);
  value.interaction.step({ pointer: { x: 170.9, y: 125.9 } });
  assert.deepEqual(value.interaction.inspect().cursor, [170, 125]);
  value.interaction.step({ pointer: { x: -99.5, y: 999.5 } });
  assert.deepEqual(value.interaction.inspect().cursor, [48, 208]);
});

test("prepared idle animation advances without being reset every tick", async () => {
  const value = runtime(await interactionInput());
  const states = [];
  const frames = [];
  for (let tick = 0; tick < 12; tick += 1) {
    value.interaction.step();
    const inspected = value.interaction.inspect();
    states.push(inspected.animatorState);
    frames.push(inspected.sourceFrame);
  }
  assert.ok(states.includes(2), "idle animation reaches the fixed doze state");
  assert.ok(states.includes(3), "idle animation reaches the fixed sleep state");
  assert.ok(new Set(frames).size > 1, "idle animation publishes more than its initial source frame");
});

test("interaction viewport defaults are source-derived and composed targets must match playback", async () => {
  const rescaled = await interactionInput();
  const packet = rescaled.state.channels.find((channel) => channel.id === "interaction").data.packet;
  packet.input.sourceWidth = 640;
  packet.input.sourceHeight = 480;
  packet.input.cursorBounds = [16, 624, 16, 464];
  packet.input.cursorInitial = [320, 240];
  packet.input.mirrorX = 640;
  rescaled.bindings.inputs.find((input) => input.id === "pointer.x").default = 320;
  rescaled.bindings.inputs.find((input) => input.id === "pointer.y").default = 240;
  const presentationBinding = rescaled.bindings.channels.find((channel) => channel.id === "presentation");
  const presentationPacket = rescaled.state.channels.find((channel) => channel.id === "presentation").data.packet;
  presentationBinding.parameters.sourceWidth = 640;
  presentationBinding.parameters.sourceHeight = 480;
  presentationPacket.camera.sourceWidth = 640;
  presentationPacket.camera.sourceHeight = 480;
  Object.assign(rescaled.tree.nodes.find((node) => node.id === "synthetic/camera").styles, {
    height: "480px",
    perspectiveOrigin: "320px 240px",
    width: "640px",
  });
  assert.doesNotThrow(() => buildDom(rescaled));

  const staleDefault = structuredClone(rescaled);
  staleDefault.bindings.inputs.find((input) => input.id === "pointer.x").default = 160;
  assert.throws(() => buildDom(staleDefault), errorCode("INVALID_INTERACTION_BINDING"));

  const mismatched = await mismatchedComposedInput();
  assert.throws(() => buildDom(mismatched), errorCode("INTERACTION_TARGET_MISMATCH"));
});

test("prepared pointer/grab schema rejects implicit semantics, escaped rows, and allocation excess", async () => {
  const base = await interactionInput();
  const declared = structuredClone(base);
  declared.bindings.channels.find((channel) => channel.id === "interaction").status = "declared";
  assert.throws(() => buildDom(declared), errorCode("INVALID_BINDING_STATUS"));
  const arithmetic = structuredClone(base);
  arithmetic.state.channels.find((channel) => channel.id === "interaction").data.packet.arithmetic = "host-number";
  assert.throws(() => buildDom(arithmetic), errorCode("INVALID_INTERACTION_STATE"));
  const pointerQuantization = structuredClone(base);
  pointerQuantization.state.channels.find((channel) => channel.id === "interaction").data.packet.input.pointerQuantization = "host-number";
  assert.throws(() => buildDom(pointerQuantization), errorCode("INVALID_INTERACTION_STATE"));
  const overlongBasis = structuredClone(base);
  overlongBasis.state.channels.find((channel) => channel.id === "interaction").data.packet.leaves[0].basis.push(0);
  assert.throws(() => buildDom(overlongBasis), errorCode("INVALID_INTERACTION_STATE"));
  const singularCamera = structuredClone(base);
  singularCamera.state.channels.find((channel) => channel.id === "interaction").data.packet.source.cameraViewMatrix.fill(0);
  assert.throws(() => buildDom(singularCamera), errorCode("INVALID_INTERACTION_STATE"));
  const guards = structuredClone(base);
  guards.state.channels.find((channel) => channel.id === "interaction").data.packet.animator.guards = ["Math.random()"];
  assert.throws(() => buildDom(guards), errorCode("INVALID_INTERACTION_STATE"));
  const expressions = structuredClone(base);
  expressions.state.channels.find((channel) => channel.id === "interaction").data.packet.animator.expression = "dragging && Math.random()";
  assert.throws(() => buildDom(expressions), errorCode("INVALID_INTERACTION_STATE"));
  const escaped = structuredClone(base);
  escaped.state.channels.find((channel) => channel.id === "interaction").data.packet.controls[0].closure.leafRows[1] = 99;
  assert.throws(() => buildDom(escaped), errorCode("INVALID_INTERACTION_STATE"));
  const target = structuredClone(base);
  target.bindings.channels.find((channel) => channel.id === "interaction").targets.leaves.pop();
  assert.throws(() => buildDom(target), errorCode("INTERACTION_TARGET_MISMATCH"));
  for (const field of ["vertexPositions", "weightScalars", "weightActiveFlags", "weightLinearContributions", "weightBaseTranslations"]) {
    const malformed = structuredClone(base);
    const closure = malformed.state.channels.find((channel) => channel.id === "interaction").data.packet.controls[0].closure;
    closure[field] = { length: closure[field].length, every: null };
    assert.throws(() => buildDom(malformed), (error) => {
      assert.equal(error?.name, "DomFormatError");
      assert.equal(error?.code, "INTERACTION_STATE_LIMIT");
      return true;
    });
  }
  assert.throws(() => buildDom(base, { limits: { maxInteractionVertices: 5 } }), errorCode("INTERACTION_STATE_LIMIT"));
  assert.throws(() => buildDom(base, { limits: { maxInteractionWeightReferences: 2 } }), errorCode("INTERACTION_STATE_LIMIT"));
});

test("interaction validation rejects runtime arithmetic overflow envelopes", async () => {
  const displacement = await interactionInput();
  displacement.state.channels.find((channel) => channel.id === "interaction").data.packet.source.displacementMagnitude = Math.fround(3e38);
  assert.throws(() => buildDom(displacement), errorCode("INVALID_INTERACTION_STATE"));

  const eye = await interactionInput();
  eye.state.channels.find((channel) => channel.id === "interaction").data.packet.source.eyeGain = Math.fround(3e38);
  assert.throws(() => buildDom(eye), errorCode("INVALID_INTERACTION_STATE"));

  const unstable = await interactionInput();
  unstable.state.channels.find((channel) => channel.id === "interaction").data.packet.source.spring.pickedResistance = 0;
  assert.throws(() => buildDom(unstable), errorCode("INVALID_INTERACTION_STATE"));
});
