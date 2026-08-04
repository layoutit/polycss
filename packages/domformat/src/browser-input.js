import { invariant } from "./errors.js";

export function createInteractionInput(host, presentation) {
  const win = host.ownerDocument.defaultView;
  const keys = new Set();
  let enabled = false;
  let pointerId = null;
  let pointerHeld = false;
  let pendingPointer = null;
  let destroyed = false;
  const keyMap = new Map([
    ["ArrowLeft", "left"], ["KeyA", "left"],
    ["ArrowRight", "right"], ["KeyD", "right"],
    ["ArrowUp", "up"], ["KeyW", "up"],
    ["ArrowDown", "down"], ["KeyS", "down"],
    ["Space", "grab"], ["KeyR", "hold"],
  ]);
  const editable = (target) => target instanceof win.HTMLInputElement
    || target instanceof win.HTMLTextAreaElement
    || target instanceof win.HTMLSelectElement
    || (target instanceof win.Element && target.closest("[contenteditable='true']") !== null);
  const mapPointer = (event) => {
    const bounds = host.getBoundingClientRect();
    if (!(bounds.width > 0) || !(bounds.height > 0)) return;
    const scale = Math.min(bounds.width / presentation.fitWidth, bounds.height / presentation.fitHeight);
    const offsetX = (bounds.width - presentation.sourceWidth * scale) / 2;
    const offsetY = (bounds.height - presentation.sourceHeight * scale) / 2;
    pendingPointer = Object.freeze({
      x: (event.clientX - bounds.left - offsetX) / scale,
      y: (event.clientY - bounds.top - offsetY) / scale,
    });
  };
  const keydown = (event) => {
    const key = keyMap.get(event.code);
    if (!enabled || !key || editable(event.target)) return;
    event.preventDefault();
    keys.add(key);
  };
  const keyup = (event) => {
    const key = keyMap.get(event.code);
    if (!enabled || !key) return;
    if (keys.delete(key) && !editable(event.target)) event.preventDefault();
  };
  const pointermove = (event) => {
    if (enabled && event.isPrimary !== false) mapPointer(event);
  };
  const pointerdown = (event) => {
    if (!enabled || event.isPrimary === false || event.button !== 0) return;
    event.preventDefault();
    mapPointer(event);
    pointerHeld = true;
    pointerId = event.pointerId;
    host.focus?.({ preventScroll: true });
    host.setPointerCapture?.(event.pointerId);
  };
  const release = () => {
    if (pointerId !== null && host.hasPointerCapture?.(pointerId)) host.releasePointerCapture?.(pointerId);
  };
  const pointerup = (event) => {
    if (pointerId === null || event.pointerId !== pointerId) return;
    mapPointer(event);
    pointerHeld = false;
    release();
    pointerId = null;
  };
  const blur = () => {
    keys.clear();
    pointerHeld = false;
    pendingPointer = null;
    release();
    pointerId = null;
  };
  const registrations = [
    [host, "keydown", keydown],
    [host, "keyup", keyup],
    [host, "blur", blur],
    [win, "blur", blur],
    [host, "pointermove", pointermove],
    [host, "pointerdown", pointerdown],
    [host, "pointerup", pointerup],
    [host, "pointercancel", pointerup],
    [host, "lostpointercapture", pointerup],
  ];
  const attached = [];
  try {
    for (const registration of registrations) {
      registration[0].addEventListener(registration[1], registration[2]);
      attached.push(registration);
    }
  } catch (error) {
    for (const [target, name, listener] of attached.reverse()) {
      try { target.removeEventListener(name, listener); } catch {}
    }
    throw error;
  }
  return Object.freeze({
    setEnabled(next) {
      invariant(!destroyed, "INPUT_DESTROYED", "The mounted input adapter is destroyed.");
      enabled = next;
      if (!enabled) blur();
    },
    sample() {
      invariant(!destroyed, "INPUT_DESTROYED", "The mounted input adapter is destroyed.");
      const x = Number(keys.has("right")) - Number(keys.has("left"));
      const y = Number(keys.has("up")) - Number(keys.has("down"));
      const pointer = pendingPointer;
      pendingPointer = null;
      return Object.freeze({
        stickX: pointer ? 0 : x < 0 ? -128 : x > 0 ? 127 : 0,
        stickY: pointer ? 0 : y < 0 ? -128 : y > 0 ? 127 : 0,
        pressed: keys.has("grab") || pointerHeld,
        hold: keys.has("hold"),
        pointer,
      });
    },
    destroy() {
      if (destroyed) return false;
      destroyed = true;
      try { release(); } catch {}
      for (const [target, name, listener] of registrations) {
        try { target.removeEventListener(name, listener); } catch {}
      }
      return true;
    },
  });
}
