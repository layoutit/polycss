// Independent executable conformance path; do not import production runtime code.
import { requireContract as invariant } from "./errors.js";
import { checkedF32, cssNumber } from "./numeric.js";
import { triangleTransform as preparedTriangleTransform } from "./triangle.js";

const f32 = (value) => checkedF32(value, "INVALID_INTERACTION_PUBLICATION", "Prepared interaction result");
const add = (left, right) => f32(f32(left) + f32(right));
const sub = (left, right) => f32(f32(left) - f32(right));
const mul = (left, right) => f32(f32(left) * f32(right));
const div = (left, right) => f32(f32(left) / f32(right));

function vector(x, y, z) {
  return Object.freeze([f32(x), f32(y), f32(z)]);
}

function matrix(values, offset = 0) {
  return Object.freeze(Array.from({ length: 16 }, (_, index) => f32(values[offset + index])));
}

function position(value) {
  return vector(value[12], value[13], value[14]);
}

function withPosition(value, next) {
  const output = [...value];
  output[12] = next[0];
  output[13] = next[1];
  output[14] = next[2];
  return Object.freeze(output);
}

function transform(value, source, translate) {
  const component = (column) => {
    let result = mul(source[column], value[0]);
    result = add(result, mul(source[4 + column], value[1]));
    result = add(result, mul(source[8 + column], value[2]));
    if (translate) result = add(result, source[12 + column]);
    return result;
  };
  return vector(component(0), component(1), component(2));
}

function magnitude(value) {
  let squared = mul(value[0], value[0]);
  squared = add(squared, mul(value[1], value[1]));
  squared = add(squared, mul(value[2], value[2]));
  const input = f32(squared);
  return input < 1e-7 ? 0 : f32(Math.sqrt(input));
}

function normalize(value) {
  const size = magnitude(value);
  return size === 0
    ? vector(0, 0, 0)
    : vector(div(value[0], size), div(value[1], size), div(value[2], size));
}

function multiplyMatrices(left, right) {
  const output = new Array(16);
  for (let row = 0; row < 4; row += 1) {
    for (let column = 0; column < 4; column += 1) {
      let value = mul(left[row * 4], right[column]);
      value = add(value, mul(left[row * 4 + 1], right[4 + column]));
      value = add(value, mul(left[row * 4 + 2], right[8 + column]));
      value = add(value, mul(left[row * 4 + 3], right[12 + column]));
      output[row * 4 + column] = value;
    }
  }
  return Object.freeze(output);
}

function translated(source, offset) {
  const output = [...source];
  output[12] = add(output[12], offset[0]);
  output[13] = add(output[13], offset[1]);
  output[14] = add(output[14], offset[2]);
  return Object.freeze(output);
}

function projected(value, view, projection) {
  const camera = transform(value, view, true);
  invariant(Math.abs(camera[2]) > 1e-6, "INVALID_INTERACTION_PUBLICATION", "Prepared interaction projection crosses the camera plane.");
  const xScale = f32(projection.scale / f32(-camera[2]));
  const yScale = f32(projection.scale / camera[2]);
  return vector(
    add(mul(camera[0], xScale), projection.origin[0]),
    add(mul(camera[1], yScale), projection.origin[1]),
    camera[2],
  );
}

function bool(value) {
  return value ? 1 : 0;
}

const ANIMATOR_GUARDS = Object.freeze({
  "counter-exhausted": ({ value }) => value === 0,
  "drag-active": ({ control }) => control.dragging === 1,
  "drag-inactive": ({ control }) => control.dragging === 0,
  "frame-after": ({ frame, target }) => frame > target,
  "frame-reached": ({ frame, target }) => frame === target,
});

function animatorGuard(name, context) {
  const predicate = ANIMATOR_GUARDS[name];
  invariant(predicate, "INVALID_INTERACTION_GUARD", `Unknown fixed animator guard ${name}.`);
  return predicate(context);
}

function initialControl(input) {
  return Object.freeze({
    frame: 0,
    buttonMask: 0,
    stickX: 0,
    stickY: 0,
    csrX: input.cursorInitial[0],
    csrY: input.cursorInitial[1],
    dragStartX: 0,
    dragStartY: 0,
    dragStartFrame: (-1000) >>> 0,
    trgR: 0,
    dragging: 0,
    startedDragging: 0,
    cursorVisible: 0,
  });
}

function stepControl(previous, sample, contract) {
  const positioned = sample.pointer
    ? { ...previous, csrX: sample.pointer.x, csrY: sample.pointer.y }
    : previous;
  const dragging = bool((sample.buttonMask & contract.grabButton) !== 0);
  const startedDragging = bool(dragging === 1 && positioned.dragging === 0);
  let dragStartX = positioned.dragStartX;
  let dragStartY = positioned.dragStartY;
  let dragStartFrame = positioned.dragStartFrame;
  if (startedDragging) {
    dragStartX = positioned.csrX;
    dragStartY = positioned.csrY;
  }
  if (dragging) dragStartFrame = positioned.frame;
  const frame = (positioned.frame + 1) >>> 0;
  let csrX = positioned.csrX;
  let csrY = positioned.csrY;
  if (Math.abs(sample.stickX) >= contract.stickDeadzone) csrX = Math.trunc(csrX + sample.stickX * contract.stickScale);
  if (Math.abs(sample.stickY) >= contract.stickDeadzone) csrY = Math.trunc(csrY - sample.stickY * contract.stickScale);
  csrX = Math.max(contract.cursorBounds[0], Math.min(contract.cursorBounds[1], csrX));
  csrY = Math.max(contract.cursorBounds[2], Math.min(contract.cursorBounds[3], csrY));
  return Object.freeze({
    frame,
    buttonMask: sample.buttonMask,
    stickX: sample.stickX,
    stickY: sample.stickY,
    csrX,
    csrY,
    dragStartX,
    dragStartY,
    dragStartFrame,
    trgR: bool((sample.buttonMask & contract.holdButton) !== 0),
    dragging,
    startedDragging,
    cursorVisible: bool(((frame - dragStartFrame) >>> 0) < contract.cursorVisibleTicks),
  });
}

function mirrorStick(value) {
  if (value === -128) return 127;
  if (value === 127) return -128;
  return -value;
}

function mirrorControl(value, input) {
  const x = (coordinate) => Math.max(input.cursorBounds[0], Math.min(input.cursorBounds[1], input.mirrorX - coordinate));
  return Object.freeze({
    ...value,
    stickX: mirrorStick(value.stickX),
    csrX: x(value.csrX),
    dragStartX: x(value.dragStartX),
  });
}

function sourceSample(sample, input) {
  return Object.freeze({
    stickX: Math.max(input.stickRange[0], Math.min(input.stickRange[1], -sample.stickX)),
    stickY: sample.stickY,
    buttonMask: sample.buttonMask,
    pointer: sample.pointer
      ? Object.freeze({
          x: Math.max(input.cursorBounds[0], Math.min(input.cursorBounds[1], input.mirrorX - sample.pointer.x)),
          y: sample.pointer.y,
        })
      : null,
  });
}

function stepAnimator(previous, control, config) {
  let state = null;
  let frame = previous.frame;
  let nods = previous.nods;
  let stillTimer = previous.stillTimer;
  if (previous.state === config.introState) {
    frame = 1;
    state = config.dozeState;
    nods = config.dozeLoopCount;
  } else if (previous.state === config.dozeState) {
    if (animatorGuard("drag-active", { control })) state = config.convergeState;
    frame = add(frame, 1);
    if (animatorGuard("frame-reached", { frame, target: config.dozeLoopEndFrame })) {
      frame = config.dozeLoopStartFrame;
      nods -= 1;
      if (animatorGuard("counter-exhausted", { value: nods })) state = config.sleepState;
    }
  } else if (previous.state === config.sleepState) {
    frame = add(frame, 1);
    if (animatorGuard("frame-reached", { frame, target: config.sleepEndFrame })) {
      frame = config.wakeStartFrame;
      state = config.wakeState;
    }
  } else if (previous.state === config.wakeState) {
    frame = add(frame, 1);
    if (animatorGuard("frame-reached", { frame, target: config.eyeFrame })) {
      frame = config.eyeFrame + 1;
      state = config.dozeState;
      nods = config.dozeLoopCount;
    }
  } else if (previous.state === config.convergeState) {
    if (animatorGuard("frame-reached", { frame, target: config.eyeFrame })) state = config.eyeState;
    else if (animatorGuard("frame-after", { frame, target: config.eyeFrame })) frame = sub(frame, 1);
    else frame = add(frame, 1);
    stillTimer = config.convergeStillTicks;
  } else if (previous.state === config.eyeState) {
    if (animatorGuard("drag-active", { control })) stillTimer = config.eyeStillTicks;
    else if (animatorGuard("drag-inactive", { control })) {
      stillTimer -= 1;
      if (animatorGuard("counter-exhausted", { value: stillTimer })) state = config.exitEyeState;
    }
    frame = config.eyeFrame;
  } else if (previous.state === config.exitEyeState) {
    state = config.dozeState;
    nods = config.dozeLoopCount;
  }
  return Object.freeze({ state: state ?? previous.state, frame, nods, stillTimer });
}

function initialMatrix(packet, index) {
  const source = packet.controls[index].sourcePosition;
  return Object.freeze([
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    f32(source[0]), f32(source[1]), f32(source[2]), 1,
  ]);
}

function offsetFrom(packet, index, value) {
  const start = packet.controls[index].sourcePosition;
  return vector(sub(value[12], start[0]), sub(value[13], start[1]), sub(value[14], start[2]));
}

function moveGrab(packet, active, parsed) {
  const spring = packet.source.spring;
  const start = packet.controls[active.index].sourcePosition;
  let current = active.matrix;
  let currentPosition = position(current);
  let offset = offsetFrom(packet, active.index, current);
  let velocity = active.velocity;
  let flags = active.flags;
  let snapped = false;
  if (active.selected) {
    velocity = vector(
      mul(offset[0], spring.pickedResistance),
      mul(offset[1], spring.pickedResistance),
      mul(offset[2], spring.pickedResistance),
    );
    flags |= spring.grabbedFlag;
  } else if (parsed.trgR === 0) {
    velocity = vector(
      mul(sub(velocity[0], mul(offset[0], spring.releaseAcceleration)), spring.velocityDecay),
      mul(sub(velocity[1], mul(offset[1], spring.releaseAcceleration)), spring.velocityDecay),
      mul(sub(velocity[2], mul(offset[2], spring.releaseAcceleration)), spring.velocityDecay),
    );
    const speed = add(add(Math.abs(velocity[0]), Math.abs(velocity[1])), Math.abs(velocity[2]));
    const distance = add(add(Math.abs(offset[0]), Math.abs(offset[1])), Math.abs(offset[2]));
    if (speed < spring.snapVelocityL1 && distance < spring.snapOffsetL1) {
      velocity = vector(0, 0, 0);
      currentPosition = vector(start[0], start[1], start[2]);
      current = withPosition(current, currentPosition);
      offset = vector(0, 0, 0);
      snapped = true;
    }
    flags &= ~spring.grabbedFlag;
  } else velocity = vector(0, 0, 0);
  currentPosition = vector(
    add(currentPosition[0], velocity[0]),
    add(currentPosition[1], velocity[1]),
    add(currentPosition[2], velocity[2]),
  );
  current = withPosition(current, currentPosition);
  const control = active.selected
    ? Object.freeze({
        ...parsed,
        csrX: Math.trunc(parsed.csrX - (parsed.csrX - parsed.dragStartX) * spring.cursorResistance),
        csrY: Math.trunc(parsed.csrY - (parsed.csrY - parsed.dragStartY) * spring.cursorResistance),
      })
    : parsed;
  offset = offsetFrom(packet, active.index, current);
  return Object.freeze({ index: active.index, control, matrix: current, velocity, flags, snapped, offset });
}

function pick(packet, control, movement, grabIndices, view) {
  const camera = packet.source.cameraWorldPosition;
  const hits = [];
  for (const index of grabIndices) {
    const definition = packet.controls[index];
    let screen = vector(definition.screenPosition[0], definition.screenPosition[1], 0);
    let distance = definition.cameraDistance;
    if (movement?.index === index) {
      const world = position(movement.matrix);
      screen = projected(world, view, packet.source.projection);
      distance = magnitude(vector(sub(world[0], camera[0]), sub(world[1], camera[1]), sub(world[2], camera[2])));
    }
    if (Math.abs(control.csrX - screen[0]) < packet.input.hitRadius
      && Math.abs(control.csrY - screen[1]) < packet.input.hitRadius) {
      hits.push({ index, screen, distance });
    }
  }
  let selected = null;
  let nearest = f32(10_000_000);
  for (const hit of hits) {
    if (hit.distance < nearest) {
      nearest = hit.distance;
      selected = hit.index;
    }
  }
  return Object.freeze({ index: selected, snap: hits.at(-1)?.screen ?? null });
}

function applyGrab(packet, previous, movement, input, grabIndices, view) {
  let control = input;
  let selected = previous?.selected ? previous.index : null;
  let picked = null;
  if (control.dragging === 0) selected = null;
  else if (control.startedDragging === 1) {
    const hit = pick(packet, control, movement, grabIndices, view);
    selected = hit.index;
    picked = hit.index;
    if (selected !== null && hit.snap) {
      const x = Math.trunc(hit.snap[0]);
      const y = Math.trunc(hit.snap[1]);
      control = Object.freeze({ ...control, csrX: x, csrY: y, dragStartX: x, dragStartY: y });
    }
  }
  let nextMatrix = null;
  if (selected !== null) {
    nextMatrix = movement?.index === selected ? movement.matrix : initialMatrix(packet, selected);
    const displacement = transform(
      vector(
        mul(control.csrX - control.dragStartX, packet.source.displacementMagnitude),
        mul(-(control.csrY - control.dragStartY), packet.source.displacementMagnitude),
        0,
      ),
      matrix(packet.source.inverseCameraMatrix),
      false,
    );
    nextMatrix = withPosition(nextMatrix, vector(
      add(nextMatrix[12], displacement[0]),
      add(nextMatrix[13], displacement[1]),
      add(nextMatrix[14], displacement[2]),
    ));
  }
  let active = null;
  if (selected !== null && nextMatrix) {
    active = Object.freeze({
      index: selected,
      selected: true,
      matrix: nextMatrix,
      velocity: movement?.index === selected ? movement.velocity : vector(0, 0, 0),
      flags: movement?.index === selected ? movement.flags : 0,
    });
  } else if (movement && !movement.snapped) {
    active = Object.freeze({
      index: movement.index,
      selected: false,
      matrix: movement.matrix,
      velocity: movement.velocity,
      flags: movement.flags,
    });
  }
  return Object.freeze({ control, active, picked });
}

function reconstruct(closure, row, offset, target) {
  const weightOffset = closure.vertexRows[row * 4 + 2];
  const weightCount = closure.vertexRows[row * 4 + 3];
  target[0] = f32(closure.vertexPositions[row * 3]);
  target[1] = f32(closure.vertexPositions[row * 3 + 1]);
  target[2] = f32(closure.vertexPositions[row * 3 + 2]);
  for (let index = weightOffset; index < weightOffset + weightCount; index += 1) {
    const active = closure.weightActiveFlags[index] === 1;
    for (let component = 0; component < 3; component += 1) {
      const translation = add(
        closure.weightBaseTranslations[index * 3 + component],
        active ? offset[component] : 0,
      );
      const contribution = add(closure.weightLinearContributions[index * 3 + component], translation);
      target[component] = add(target[component], mul(contribution, closure.weightScalars[index]));
    }
  }
}

function sourceMatrixTransform(value) {
  const identity = value.every((entry, index) => entry === (index % 5 === 0 ? 1 : 0));
  if (identity) return "";
  const order = [2, 0, 1, 3];
  return `matrix3d(${order.flatMap((row) => order.map((column) => value[row * 4 + column])).join(",")})`;
}

function createBuffers(packet) {
  return packet.controls.map((definition) => {
    const closure = definition.closure;
    return {
      vertices: Array.from({ length: closure.vertexRows.length / 4 }, (_, row) => ({
        row,
        shapeIndex: closure.vertexRows[row * 4],
        sourceVertexIndex: closure.vertexRows[row * 4 + 1],
        position: [0, 0, 0],
      })),
      shapeMatrices: closure.shapeIndices.map((shapeIndex) => ({ shapeIndex, matrix: new Array(16).fill(0) })),
    };
  });
}

function normalizeSample(value, packet) {
  const sample = value ?? {};
  const stickX = sample.stickX ?? 0;
  const stickY = sample.stickY ?? 0;
  invariant(Number.isFinite(stickX) && Number.isFinite(stickY), "INVALID_INTERACTION_INPUT", "Interaction axes must be finite.");
  invariant(stickX >= packet.input.stickRange[0] && stickX <= packet.input.stickRange[1]
    && stickY >= packet.input.stickRange[0] && stickY <= packet.input.stickRange[1], "INVALID_INTERACTION_INPUT", "Interaction axes exceed their declared range.");
  invariant(typeof (sample.pressed ?? false) === "boolean" && typeof (sample.hold ?? false) === "boolean", "INVALID_INTERACTION_INPUT", "Interaction buttons must be boolean.");
  let pointer = sample.pointer ?? null;
  if (pointer !== null) {
    invariant(pointer && Number.isFinite(pointer.x) && Number.isFinite(pointer.y), "INVALID_INTERACTION_INPUT", "Interaction pointer coordinates must be finite.");
    invariant(packet.input.pointerQuantization === "trunc-toward-zero-then-clamp", "INVALID_INTERACTION_INPUT", "Interaction pointer quantization is unsupported.");
    pointer = Object.freeze({
      x: Math.max(packet.input.cursorBounds[0], Math.min(packet.input.cursorBounds[1], Math.trunc(pointer.x))),
      y: Math.max(packet.input.cursorBounds[2], Math.min(packet.input.cursorBounds[3], Math.trunc(pointer.y))),
    });
  }
  return Object.freeze({
    stickX,
    stickY,
    buttonMask: (sample.pressed ? packet.input.grabButton : 0) | (sample.hold ? packet.input.holdButton : 0),
    pointer,
  });
}

function publishCursor(control, binding, mounted, options, bound) {
  const layer = bound?.cursorLayer ?? mounted.byId.get(binding.targets.cursorLayer);
  const open = bound?.cursorStates?.open ?? mounted.byId.get(binding.targets.cursorStates.open);
  const closed = bound?.cursorStates?.closed ?? mounted.byId.get(binding.targets.cursorStates.closed);
  const presentation = options.presentation;
  if (!layer || !open || !closed || !presentation || !mounted.host) return;
  const width = mounted.host.clientWidth || options.viewportWidth || presentation.sourceWidth;
  const height = mounted.host.clientHeight || options.viewportHeight || presentation.sourceHeight;
  const scale = Math.min(width / presentation.fitWidth, height / presentation.fitHeight);
  const offsetX = (width - presentation.sourceWidth * scale) / 2;
  const offsetY = (height - presentation.sourceHeight * scale) / 2;
  layer.style.transform = `translate3d(${cssNumber(offsetX + control.csrX * scale)}px, ${cssNumber(offsetY + control.csrY * scale)}px, 0) scale(${cssNumber(scale)})`;
  open.style.visibility = control.dragging === 1 ? "hidden" : "visible";
  closed.style.visibility = control.dragging === 1 ? "visible" : "hidden";
}

export function createPolycssInteraction(state, bindings, mounted, playback, options = {}) {
  const stateChannel = state.channels instanceof Map
    ? [...state.channels.values()].find((channel) => channel.codec === "polycss-pointer-grab-prepared@0")
    : state.channels.find((channel) => channel.codec === "polycss-pointer-grab-prepared@0");
  const binding = bindings.channels.find((channel) => channel.interpreter === "polycss-pointer-grab@0");
  invariant(stateChannel && binding?.status === "executable", "MISSING_POLYCSS_BINDING", "Executable prepared interaction state and binding are required.");
  invariant(playback
    && typeof playback.applySurfaceFrame === "function"
    && typeof playback.forceVisible === "function"
    && typeof playback.applyInteractionLeaf === "function"
    && typeof playback.restoreInteraction === "function", "MISSING_POLYCSS_BINDING", "Prepared interaction requires the surface publication interface.");
  const packet = stateChannel.data.packet;
  const bound = options.boundTargets?.get(binding.id)?.targets;
  const shapes = bound?.shapes ?? binding.targets.shapes.map((id) => mounted.byId.get(id));
  const leaves = bound?.leaves ?? binding.targets.leaves.map((id) => mounted.byId.get(id));
  invariant(shapes.every(Boolean) && leaves.every(Boolean), "MISSING_TARGET_NODE", "Interaction targets are not mounted.");
  const buffers = createBuffers(packet);
  const view = matrix(packet.source.cameraViewMatrix);
  const grabIndices = packet.controls.map((control, index) => control.mode === "grab" ? index : -1).filter((index) => index >= 0);
  const eyeIndices = packet.controls.map((control, index) => control.mode === "eye-follow" ? index : -1).filter((index) => index >= 0);
  const coordinates = Array.from({ length: packet.leaves.length }, () => new Float64Array(9));
  const coordinatesReady = new Uint8Array(packet.leaves.length);
  const modifiedShapes = new Set();
  const modifiedLeaves = new Set();
  let control = mirrorControl(initialControl(packet.input), packet.input);
  let active = null;
  let animator = Object.freeze({
    state: packet.animator.initialState,
    frame: packet.animator.initialFrame,
    nods: packet.animator.dozeLoopCount,
    stillTimer: packet.animator.eyeStillTicks,
  });
  let ticks = 0;
  let destroyed = false;

  const resetProgram = (restore) => {
    const display = mirrorControl(control, packet.input);
    playback.seek(packet.animator.initialFrame);
    playback.forceVisible(new Uint16Array(0));
    if (restore) {
      playback.restoreInteraction(
        [...modifiedShapes].sort((left, right) => left - right),
        [...modifiedLeaves].sort((left, right) => left - right),
      );
      modifiedShapes.clear();
      modifiedLeaves.clear();
    }
    coordinatesReady.fill(0);
    control = mirrorControl(display, packet.input);
    active = null;
    animator = Object.freeze({
      state: packet.animator.initialState,
      frame: packet.animator.initialFrame,
      nods: packet.animator.dozeLoopCount,
      stillTimer: packet.animator.eyeStillTicks,
    });
  };

  const publish = (controlIndex, offset) => {
    const definition = packet.controls[controlIndex];
    const closure = definition.closure;
    const buffer = buffers[controlIndex];
    for (const vertex of buffer.vertices) reconstruct(closure, vertex.row, offset, vertex.position);
    for (const output of buffer.shapeMatrices) {
      let source = matrix(packet.shapes.baseMatrices, output.shapeIndex * 16);
      if (definition.mode === "eye-follow") {
        const objectIndex = definition.attachmentObjectIndices[0];
        const rotation = matrix(packet.objects.rotationMatrices, objectIndex * 16);
        source = multiplyMatrices(translated(rotation, offset), matrix(closure.rigidRootInverseMatrix));
      }
      for (let index = 0; index < 16; index += 1) output.matrix[index] = source[index];
      const transformText = sourceMatrixTransform(output.matrix);
      if (shapes[output.shapeIndex].style.transform !== transformText) shapes[output.shapeIndex].style.transform = transformText;
      modifiedShapes.add(output.shapeIndex);
    }
    for (let row = 0; row < closure.leafRows.length; row += 4) {
      const leafIndex = closure.leafRows[row];
      const p0 = buffer.vertices[closure.leafRows[row + 1]]?.position;
      const p1 = buffer.vertices[closure.leafRows[row + 2]]?.position;
      const p2 = buffer.vertices[closure.leafRows[row + 3]]?.position;
      invariant(p0 && p1 && p2, "INVALID_INTERACTION_PUBLICATION", `${definition.id} escaped its prepared leaf closure.`);
      const cached = coordinates[leafIndex];
      const values = [...p0, ...p1, ...p2];
      const changed = coordinatesReady[leafIndex] === 0 || values.some((value, index) => cached[index] !== value);
      if (!changed) continue;
      cached.set(values);
      coordinatesReady[leafIndex] = 1;
      const next = preparedTriangleTransform(packet.leaves[leafIndex], [p0, p1, p2], packet.triangle);
      playback.applyInteractionLeaf(leafIndex, next);
      modifiedLeaves.add(leafIndex);
    }
    return Object.freeze({ controlId: definition.id, closure, vertices: buffer.vertices, shapeMatrices: buffer.shapeMatrices });
  };

  const publishEyes = (eyeControl) => {
    const publications = [];
    for (const index of eyeIndices) {
      const eye = packet.controls[index];
      const screen = projected(vector(...eye.sourcePosition), view, packet.source.projection);
      let eyeOffset = vector(0, 0, 0);
      if (animator.state === packet.animator.eyeState) {
        eyeOffset = vector(
          mul(sub(eyeControl.csrX, screen[0]), packet.source.eyeGain),
          mul(sub(screen[1], eyeControl.csrY), packet.source.eyeGain),
          0,
        );
        if (magnitude(eyeOffset) > packet.source.eyeMaximumOffset) {
          const direction = normalize(eyeOffset);
          eyeOffset = vector(
            mul(direction[0], packet.source.eyeMaximumOffset),
            mul(direction[1], packet.source.eyeMaximumOffset),
            mul(direction[2], packet.source.eyeMaximumOffset),
          );
        }
      }
      publications.push(publish(index, eyeOffset));
    }
    return publications;
  };

  return Object.freeze({
    get control() { return mirrorControl(control, packet.input); },
    get playback() { return active === null && control.dragging === 0; },
    get settling() { return active !== null && !active.selected && control.dragging === 0; },
    get ticks() { return ticks; },
    inspect() {
      return Object.freeze({
        ticks,
        sourceFrame: animator.frame,
        animatorState: animator.state,
        selectedId: active?.selected ? packet.controls[active.index].id : null,
        settling: active !== null && !active.selected,
        cursor: Object.freeze([this.control.csrX, this.control.csrY]),
      });
    },
    restore() {
      invariant(!destroyed, "INTERACTION_DESTROYED", "Prepared interaction interpreter is destroyed.");
      const shapeIndices = [...modifiedShapes].sort((left, right) => left - right);
      const leafIndices = [...modifiedLeaves].sort((left, right) => left - right);
      playback.forceVisible(new Uint16Array(0));
      playback.restoreInteraction(shapeIndices, leafIndices);
      modifiedShapes.clear();
      modifiedLeaves.clear();
      coordinatesReady.fill(0);
      return Object.freeze({ shapeIndices: Object.freeze(shapeIndices), leafIndices: Object.freeze(leafIndices) });
    },
    publishInitial() {
      invariant(!destroyed, "INTERACTION_DESTROYED", "Prepared interaction interpreter is destroyed.");
      playback.applySurfaceFrame(animator.frame, true);
      playback.forceVisible(new Uint16Array(0));
      const publications = publishEyes(control);
      publishCursor(mirrorControl(control, packet.input), binding, mounted, options, bound);
      return Object.freeze({
        sourceFrame: animator.frame,
        control: mirrorControl(control, packet.input),
        selectedId: null,
        selectedMatrix: null,
        publications: Object.freeze(publications),
        safeVisibleLeaves: new Uint16Array(0),
      });
    },
    step(value = {}) {
      invariant(!destroyed, "INTERACTION_DESTROYED", "Prepared interaction interpreter is destroyed.");
      const sample = normalizeSample(value, packet);
      if (active !== null && !active.selected && control.dragging === 0 && sample.buttonMask & packet.input.grabButton) resetProgram(true);
      const parsed = stepControl(control, sourceSample(sample, packet.input), packet.input);
      const sourceFrame = animator.frame;
      animator = stepAnimator(animator, parsed, packet.animator);
      const movement = active ? moveGrab(packet, active, parsed) : null;
      const movedControl = movement?.control ?? parsed;
      const eyeControl = movedControl;
      const grab = applyGrab(packet, active, movement, movedControl, grabIndices, view);
      active = grab.active;
      const grabIndex = movement?.index ?? grab.picked;
      const grabDefinition = grabIndex === null ? null : packet.controls[grabIndex];
      const safeVisibleLeaves = grabDefinition?.mode === "grab"
        && (movement?.offset.some((component) => component !== 0) ?? false)
        ? Uint16Array.from(grabDefinition.closure.safeVisibleLeafIndices)
        : new Uint16Array(0);
      playback.applySurfaceFrame(sourceFrame, true);
      playback.forceVisible(safeVisibleLeaves);
      const publications = [];
      if (grabIndex !== null) {
        publications.push(publish(
          grabIndex,
          movement?.index === grabIndex ? movement.offset : vector(0, 0, 0),
        ));
      }
      publications.push(...publishEyes(eyeControl));
      control = grab.control;
      const displayControl = mirrorControl(control, packet.input);
      const selectedId = active?.selected ? packet.controls[active.index].id : null;
      const selectedMatrix = grabIndex === null
        ? null
        : movement?.index === grabIndex ? movement.matrix : initialMatrix(packet, grabIndex);
      publishCursor(displayControl, binding, mounted, options, bound);
      ticks += 1;
      return Object.freeze({
        sourceFrame,
        control: displayControl,
        selectedId,
        selectedMatrix,
        publications: Object.freeze(publications),
        safeVisibleLeaves,
      });
    },
    destroy() { destroyed = true; },
  });
}
