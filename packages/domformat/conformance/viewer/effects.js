// Independent executable conformance path; do not import production runtime code.
import { requireContract as invariant } from "./errors.js";
import { checkedF32, cssNumber } from "./numeric.js";

const f32 = (value) => checkedF32(value, "INVALID_EFFECT_PUBLICATION", "Prepared effect result");

function sparkleTransform(x, y, z) {
  return "matrix3d(0,1,0,0,0,0,-1,0,1,0,0,0,"
    + `${cssNumber(z)},${cssNumber(x - 32)},${cssNumber(y + 64)},1)`;
}

function effectStateChannel(state) {
  const channels = state.channels instanceof Map ? [...state.channels.values()] : state.channels;
  return channels.find((channel) => channel.codec === "polycss-effects-prepared@0");
}

export function createPolycssEffects(state, bindings, mounted, options = {}) {
  const stateChannel = effectStateChannel(state);
  const binding = bindings.channels.find((channel) => channel.interpreter === "polycss-effects@0");
  invariant(stateChannel && binding?.status === "executable", "MISSING_POLYCSS_BINDING", "Executable prepared effects state and binding are required.");
  const packet = stateChannel.data.packet;
  const bound = options.boundTargets?.get(binding.id)?.targets;
  const starElements = bound?.stars ?? binding.targets.stars.map((id) => mounted.byId.get(id));
  invariant(starElements.every(Boolean), "MISSING_TARGET_NODE", "Effect star target nodes are not mounted.");
  const starX = new Float64Array(packet.stars.length);
  const starY = new Float64Array(packet.stars.length);
  const starZ = new Float64Array(packet.stars.length);
  const emitters = packet.emitters.map((definition, emitterIndex) => {
    const elements = bound?.emitters?.[emitterIndex] ?? binding.targets.emitters[emitterIndex].map((id) => mounted.byId.get(id));
    invariant(elements.every(Boolean), "MISSING_TARGET_NODE", `Effect emitter ${emitterIndex} target nodes are not mounted.`);
    const timeout = new Float32Array(definition.poolSize);
    timeout.fill(-1);
    return {
      definition,
      elements,
      activeParticles: new Uint8Array(definition.poolSize),
      visibleParticles: new Uint8Array(definition.poolSize),
      x: new Float32Array(definition.poolSize),
      y: new Float32Array(definition.poolSize),
      z: new Float32Array(definition.poolSize),
      vx: new Float32Array(definition.poolSize),
      vy: new Float32Array(definition.poolSize),
      vz: new Float32Array(definition.poolSize),
      timeout,
      emitterX: 0,
      emitterY: 0,
      emitterZ: 0,
      emitterVx: 0,
      emitterVy: 0,
      emitterVz: 0,
      active: 0,
      armed: false,
      emitted: false,
    };
  });
  let sourceFrame = 0;
  let spawnCursor = 0;
  let destroyed = false;

  const publishStars = (frameIndex) => {
    for (let index = 0; index < packet.stars.length; index += 1) {
      const definition = packet.stars[index];
      const position = frameIndex * 3;
      starX[index] = definition.positions[position];
      starY[index] = definition.positions[position + 1];
      starZ[index] = definition.positions[position + 2];
      const element = starElements[index];
      const transform = definition.transforms[frameIndex];
      if (element.style.transform !== transform) element.style.transform = transform;
      const backgroundPosition = definition.backgroundPositions[definition.frameIndices[frameIndex]];
      if (element.style.backgroundPosition !== backgroundPosition) element.style.backgroundPosition = backgroundPosition;
    }
  };

  const spawn = (emitter, index, bias) => {
    const tuple = packet.spawnStream.tuples[spawnCursor];
    spawnCursor = (spawnCursor + 1) % packet.spawnStream.count;
    emitter.x[index] = emitter.emitterX;
    emitter.y[index] = emitter.emitterY;
    emitter.z[index] = emitter.emitterZ;
    emitter.timeout[index] = f32(tuple[0]);
    emitter.vx[index] = f32(tuple[1] + bias[0]);
    emitter.vy[index] = f32(tuple[2] + bias[1]);
    emitter.vz[index] = f32(tuple[3] + bias[2]);
    if (emitter.activeParticles[index] === 0) emitter.active += 1;
    emitter.activeParticles[index] = 1;
  };

  const hideParticle = (emitter, index) => {
    emitter.visibleParticles[index] = 0;
    const element = emitter.elements[index];
    if (element.style.visibility !== "hidden") element.style.visibility = "hidden";
    if (emitter.activeParticles[index] === 0 && element.style.opacity !== "0") element.style.opacity = "0";
  };

  const publishParticle = (emitter, index) => {
    if (emitter.activeParticles[index] === 0 || !(emitter.timeout[index] > 0)) {
      hideParticle(emitter, index);
      return;
    }
    const displayList = Math.trunc(emitter.timeout[index]);
    if (displayList === 0) {
      hideParticle(emitter, index);
      return;
    }
    const element = emitter.elements[index];
    const transform = sparkleTransform(emitter.x[index], emitter.y[index], emitter.z[index]);
    if (element.style.transform !== transform) element.style.transform = transform;
    const frame = packet.particle.sparkleFrameTable[displayList - 1];
    const backgroundPosition = emitter.definition.backgroundPositions[frame];
    if (element.style.backgroundPosition !== backgroundPosition) element.style.backgroundPosition = backgroundPosition;
    const opacity = cssNumber(f32(emitter.timeout[index] / 10));
    if (element.style.opacity !== opacity) element.style.opacity = opacity;
    if (emitter.visibleParticles[index] === 0) {
      emitter.visibleParticles[index] = 1;
      element.style.visibility = "visible";
    }
  };

  const advanceParticles = (emitter) => {
    for (let index = 0; index < emitter.definition.poolSize; index += 1) {
      if (emitter.activeParticles[index] === 1) {
        emitter.x[index] = f32(emitter.x[index] + emitter.vx[index]);
        emitter.y[index] = f32(emitter.y[index] + emitter.vy[index]);
        emitter.z[index] = f32(emitter.z[index] + emitter.vz[index]);
        emitter.vy[index] = f32(emitter.vy[index] + packet.particle.gravityY);
        emitter.vx[index] = f32(emitter.vx[index] * packet.particle.damping);
        emitter.vy[index] = f32(emitter.vy[index] * packet.particle.damping);
        emitter.vz[index] = f32(emitter.vz[index] * packet.particle.damping);
        const timeout = emitter.timeout[index];
        emitter.timeout[index] = f32(timeout - 1);
        if (timeout <= 0) {
          emitter.activeParticles[index] = 0;
          emitter.active -= 1;
        }
      }
      publishParticle(emitter, index);
    }
  };

  const positionEmitter = (emitter, x, y, z) => {
    emitter.emitterX = f32(x + emitter.emitterVx);
    emitter.emitterY = f32(y + emitter.emitterVy);
    emitter.emitterZ = f32(z + emitter.emitterVz);
    emitter.emitterVx = f32(emitter.emitterVx * packet.particle.damping);
    emitter.emitterVy = f32(emitter.emitterVy * packet.particle.damping);
    emitter.emitterVz = f32(emitter.emitterVz * packet.particle.damping);
  };

  const publishContinuous = (emitter) => {
    const star = emitter.definition.sourceStar;
    positionEmitter(emitter, starX[star], starY[star], starZ[star]);
    for (let index = 0; index < emitter.definition.poolSize; index += 1) {
      if (emitter.timeout[index] <= 0) spawn(emitter, index, packet.biases.continuous);
    }
    advanceParticles(emitter);
  };

  const publishGrab = (emitter, grabActive, grabX, grabY, grabZ) => {
    if (!grabActive && emitter.active === 0) {
      emitter.armed = false;
      emitter.emitted = false;
      for (let index = 0; index < emitter.definition.poolSize; index += 1) hideParticle(emitter, index);
      return;
    }
    emitter.armed = grabActive;
    if (!grabActive) emitter.emitted = false;
    positionEmitter(emitter, grabActive ? grabX : 0, grabActive ? grabY : 0, grabActive ? grabZ : 0);
    if (emitter.armed && !emitter.emitted) {
      for (let index = 0; index < emitter.definition.poolSize; index += 1) {
        if (emitter.timeout[index] <= 0) spawn(emitter, index, packet.biases.grab);
      }
      emitter.emitted = true;
    }
    advanceParticles(emitter);
  };

  const inspect = () => Object.freeze({
    sourceFrame,
    spawnCursor,
    stars: packet.stars.length,
    emitters: Object.freeze(emitters.map((emitter) => Object.freeze({
      mode: emitter.definition.mode,
      poolSize: emitter.definition.poolSize,
      active: emitter.active,
      visible: emitter.visibleParticles.reduce((sum, value) => sum + value, 0),
    }))),
  });

  return Object.freeze({
    get sourceFrame() { return sourceFrame; },
    get spawnCursor() { return spawnCursor; },
    publish(nextFrame, grab = null) {
      invariant(!destroyed, "EFFECTS_DESTROYED", "Prepared effects interpreter is destroyed.");
      invariant(Number.isSafeInteger(nextFrame) && nextFrame >= 1 && nextFrame <= packet.frameCount, "FRAME_RANGE", `Prepared effects frame ${nextFrame} is out of range.`);
      const grabActive = grab !== null && grab.active === true;
      if (grab !== null) {
        invariant(grab && typeof grab === "object" && typeof grab.active === "boolean", "INVALID_EFFECT_INPUT", "Prepared grab input is invalid.");
        invariant(Number.isFinite(grab.x) && Number.isFinite(grab.y) && Number.isFinite(grab.z), "INVALID_EFFECT_INPUT", "Prepared grab coordinates must be finite.");
      }
      const frameIndex = nextFrame - 1;
      publishStars(frameIndex);
      for (let index = 0; index < emitters.length; index += 1) {
        const emitter = emitters[index];
        if (emitter.definition.mode === "grab") publishGrab(emitter, grabActive, grab?.x ?? 0, grab?.y ?? 0, grab?.z ?? 0);
        else publishContinuous(emitter);
      }
      sourceFrame = nextFrame;
      return nextFrame;
    },
    inspect,
    destroy() { destroyed = true; },
  });
}
