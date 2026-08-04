import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { buildDom } from "../src/writer.js";
import { createPolycssEffects } from "../src/state/effects.js";
import { errorCode, projectRoot, syntheticInput } from "./helpers.js";

const fixturePath = resolve(projectRoot, "fixtures/synthetic-effects/packet.json");

async function effectInput() {
  const input = await syntheticInput();
  const packet = JSON.parse(await readFile(fixturePath, "utf8"));
  const node = (id, parent, sibling, name, styles = {}) => ({
    index: input.tree.nodes.length,
    id,
    parent,
    sibling,
    namespace: "http://www.w3.org/1999/xhtml",
    name,
    classes: [],
    attributes: name === "s" ? { "aria-hidden": "true" } : {},
    styles,
    resourceAttributes: {},
    resourceStyles: {},
  });
  input.tree.nodes.push(node("synthetic/effects", 0, 1, "div"));
  input.tree.nodes.push(node("synthetic/effects/star:0", 3, 0, "s", { backgroundPosition: "0px 0px", transform: "translate3d(0px, 0px, 0px)" }));
  input.tree.nodes.push(node("synthetic/effects/emitter:0", 3, 1, "div"));
  input.tree.nodes.push(node("synthetic/effects/emitter:0/particle:0", 5, 0, "s", { backgroundPosition: "0px 0px", opacity: "0", transform: "translate3d(0px, 0px, 0px)", visibility: "hidden" }));
  input.tree.nodes.push(node("synthetic/effects/emitter:1", 3, 2, "div"));
  input.tree.nodes.push(node("synthetic/effects/emitter:1/particle:0", 7, 0, "s", { backgroundPosition: "0px 0px", opacity: "0", transform: "translate3d(0px, 0px, 0px)", visibility: "hidden" }));
  input.state.channels.unshift({ id: "effects", codec: "polycss-effects-prepared@0", data: { packet } });
  input.bindings.inputs.unshift(
    { id: "interaction.grab-active", type: "boolean", default: false },
    { id: "interaction.grab-x", type: "float", default: 0 },
    { id: "interaction.grab-y", type: "float", default: 0 },
    { id: "interaction.grab-z", type: "float", default: 0 },
    { id: "time.source-frame", type: "uint" },
  );
  input.bindings.channels.unshift({
    id: "effects",
    state: "effects",
    interpreter: "polycss-effects@0",
    status: "executable",
    inputs: ["interaction.grab-active", "interaction.grab-x", "interaction.grab-y", "interaction.grab-z", "time.source-frame"],
    targets: {
      stars: ["synthetic/effects/star:0"],
      emitters: [
        ["synthetic/effects/emitter:0/particle:0"],
        ["synthetic/effects/emitter:1/particle:0"],
      ],
    },
    sinks: ["style.backgroundPosition", "style.opacity", "style.transform", "style.visibility"],
    parameters: { frameCount: 3 },
  });
  input.tree.nodes[0].styles.transform = "translate3d(0px, 0px, 0px)";
  input.state.channels.push({
    id: "playback",
    codec: "polycss-playback-packed@0",
    data: {
      leafFit: [],
      packet: {
        version: 0,
        layout: "delta-component-streams@0",
        shapeCount: 0,
        leafCount: 0,
        appearances: [["default", 1, 0]],
        timeline: { introTicks: 0, loopTicks: 3, frames: [1, 2, 3] },
        initial: {
          sourceFrame: 1,
          appearance: 0,
          modelTransform: 0,
          shapes: { count: 0, transforms: [], visibility: [] },
          leaves: { count: 0, transforms: [] },
        },
        frameRows: [
          [1, 0, -1, 0, 0, 0, 0],
          [2, 0, -1, 0, 0, 0, 0],
          [3, 0, -1, 0, 0, 0, 0],
        ],
        shapeChanges: { sources: [], transforms: [], visibility: [] },
        leafChanges: { sources: [], transforms: [] },
        transforms: {
          count: 1,
          groups: [{
            encoding: "decimal-component-streams",
            empty: [0],
            scales: new Array(12).fill(0),
            columns: Array.from({ length: 12 }, () => []),
          }],
        },
      },
    },
  });
  input.bindings.inputs.push({ id: "time.tick", type: "uint" });
  input.bindings.channels.push({
    id: "playback",
    state: "playback",
    interpreter: "polycss-playback@0",
    status: "executable",
    inputs: ["time.tick"],
    targets: { model: "synthetic/scene", shapes: [], leaves: [] },
    sinks: ["style.transform", "style.visibility"],
    parameters: {
      baseSceneTransform: "translate3d(0px, 0px, 0px)",
      frameCount: 3,
      tickRateHz: 30,
    },
  });
  input.meta.capabilities.push("prepared-particle-effects");
  input.meta.capabilities.push("prepared-playback");
  input.meta.conformance.executable.push("particle-effects");
  input.meta.conformance.executable.push("playback");
  return input;
}

function fakeMounted(bindings) {
  const targets = bindings.channels.find((channel) => channel.id === "effects").targets;
  const ids = [...targets.stars, ...targets.emitters.flat()];
  return {
    byId: new Map(ids.map((id) => [id, { style: {} }])),
  };
}

function styleSnapshot(mounted) {
  return [...mounted.byId].map(([id, element]) => [id, { ...element.style }]);
}

function runEvidence(input, mounted) {
  const effects = createPolycssEffects(input.state, input.bindings, mounted);
  const grab = { active: true, x: 100, y: 200, z: 300 };
  effects.publish(1, grab);
  effects.publish(2, grab);
  effects.publish(2, grab);
  effects.publish(2, { active: false, x: 0, y: 0, z: 0 });
  return effects;
}

test("prepared effects execute in declared order on stable retained targets", async () => {
  const input = await effectInput();
  buildDom(input);
  const mounted = fakeMounted(input.bindings);
  const identities = [...mounted.byId];
  const effects = createPolycssEffects(input.state, input.bindings, mounted);
  effects.publish(1, { active: true, x: 100, y: 200, z: 300 });
  assert.equal(effects.sourceFrame, 1);
  assert.equal(effects.spawnCursor, 2);
  assert.deepEqual(mounted.byId.get("synthetic/effects/star:0").style, {
    transform: "translate3d(10px, 20px, 30px)",
    backgroundPosition: "0px 0px",
  });
  assert.deepEqual(mounted.byId.get("synthetic/effects/emitter:0/particle:0").style, {
    transform: "matrix3d(0,1,0,0,0,0,-1,0,1,0,0,0,316,70,268,1)",
    backgroundPosition: "-8px 0px",
    opacity: "0.25",
    visibility: "visible",
  });
  assert.deepEqual(mounted.byId.get("synthetic/effects/emitter:1/particle:0").style, {
    transform: "matrix3d(0,1,0,0,0,0,-1,0,1,0,0,0,23,-21,86,1)",
    backgroundPosition: "0px 0px",
    opacity: "0.15",
    visibility: "visible",
  });
  assert.equal(mounted.byId.size, identities.length);
  for (const [id, element] of identities) assert.equal(mounted.byId.get(id), element);
});

test("prepared effects replay deterministically including same-frame and grab updates", async () => {
  const input = await effectInput();
  const firstMounted = fakeMounted(input.bindings);
  const secondMounted = fakeMounted(input.bindings);
  const first = runEvidence(input, firstMounted);
  const second = runEvidence(input, secondMounted);
  assert.deepEqual(first.inspect(), second.inspect());
  assert.deepEqual(styleSnapshot(firstMounted), styleSnapshot(secondMounted));
  assert.deepEqual(first.inspect(), {
    sourceFrame: 2,
    spawnCursor: 0,
    stars: 1,
    emitters: [
      { mode: "grab", poolSize: 1, active: 1, visible: 0 },
      { mode: "follow-star", poolSize: 1, active: 1, visible: 1 },
    ],
  });
});

test("prepared effects schema rejects implicit roles, malformed tables, limits, targets, and defaults", async () => {
  const base = await effectInput();
  const implicitRole = structuredClone(base);
  delete implicitRole.state.channels[0].data.packet.emitters[1].mode;
  assert.throws(() => buildDom(implicitRole), errorCode("INVALID_EFFECTS_STATE"));
  const positions = structuredClone(base);
  positions.state.channels[0].data.packet.stars[0].positions.pop();
  assert.throws(() => buildDom(positions), errorCode("INVALID_EFFECTS_STATE"));
  const emitterFrames = structuredClone(base);
  emitterFrames.state.channels[0].data.packet.emitters[0].backgroundPositions = new Array(257).fill("0px 0px");
  assert.throws(() => buildDom(emitterFrames), errorCode("INVALID_EFFECTS_STATE"));
  const starFrames = structuredClone(base);
  starFrames.state.channels[0].data.packet.stars[0].backgroundPositions = new Array(4).fill("0px 0px");
  assert.throws(() => buildDom(starFrames, { limits: { maxFrames: 3 } }), errorCode("INVALID_EFFECTS_STATE"));
  const timeout = structuredClone(base);
  timeout.state.channels[0].data.packet.spawnStream.tuples[0][0] = 4.5;
  assert.throws(() => buildDom(timeout), errorCode("INVALID_EFFECTS_STATE"));
  const overflow = structuredClone(base);
  overflow.state.channels[0].data.packet.biases.continuous[0] = 3e38;
  overflow.state.channels[0].data.packet.spawnStream.tuples[0][1] = 3e38;
  assert.throws(() => buildDom(overflow), errorCode("INVALID_EFFECTS_STATE"));
  const target = structuredClone(base);
  target.bindings.channels[0].targets.emitters[0].pop();
  assert.throws(() => buildDom(target), errorCode("TARGET_CARDINALITY_MISMATCH"));
  const defaults = structuredClone(base);
  defaults.bindings.inputs[0].default = true;
  assert.throws(() => buildDom(defaults), errorCode("INVALID_EFFECTS_BINDING"));
  assert.throws(() => buildDom(base, { limits: { maxEffectParticles: 1 } }), errorCode("EFFECT_PARTICLE_LIMIT"));
});
