import { invariant } from "./errors.js";

export const LIFECYCLE_PHASES = Object.freeze([
  "validate",
  "construct",
  "bind",
  "initialize",
  "publish",
  "destroy",
]);

export function createLifecycle(onPhase) {
  invariant(onPhase === undefined || typeof onPhase === "function", "INVALID_LIFECYCLE_OBSERVER", "onLifecyclePhase must be a function.");
  let phase = null;
  const history = [];
  const view = Object.freeze({
    get phase() { return phase; },
    get history() { return Object.freeze([...history]); },
  });

  const notify = (next) => {
    history.push(next);
    phase = next;
    onPhase?.(next);
  };

  return Object.freeze({
    view,
    get phase() { return phase; },
    get history() { return Object.freeze([...history]); },
    advance(next) {
      invariant(next !== "destroy" && LIFECYCLE_PHASES.includes(next), "INVALID_LIFECYCLE_PHASE", `Unknown lifecycle phase ${String(next)}.`);
      const expected = phase === null ? "validate" : LIFECYCLE_PHASES[LIFECYCLE_PHASES.indexOf(phase) + 1];
      invariant(next === expected, "LIFECYCLE_ORDER", `Lifecycle cannot advance from ${phase ?? "start"} to ${next}; expected ${expected}.`);
      notify(next);
      return next;
    },
    destroy() {
      if (phase === "destroy") return false;
      history.push("destroy");
      phase = "destroy";
      try { onPhase?.("destroy"); } catch {}
      return true;
    },
    assertPublished() {
      invariant(phase === "publish", "LIFECYCLE_PRECONDITION", `Operation requires publish phase; current phase is ${phase ?? "start"}.`);
    },
  });
}
