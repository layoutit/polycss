import test from "node:test";
import assert from "node:assert/strict";
import { createLifecycle } from "../src/lifecycle.js";
import { errorCode } from "./helpers.js";

test("lifecycle is strictly ordered and exposes read-only idempotent teardown", () => {
  const observed = [];
  const lifecycle = createLifecycle((phase) => observed.push(phase));
  assert.equal(lifecycle.phase, null);
  assert.deepEqual(lifecycle.history, []);
  assert.deepEqual(Object.keys(lifecycle.view), ["phase", "history"]);
  assert.throws(() => lifecycle.advance("construct"), errorCode("LIFECYCLE_ORDER"));

  for (const phase of ["validate", "construct", "bind", "initialize", "publish"]) lifecycle.advance(phase);
  lifecycle.assertPublished();
  assert.equal(lifecycle.view.phase, "publish");
  assert.deepEqual(lifecycle.view.history, observed);
  assert.equal(lifecycle.destroy(), true);
  assert.equal(lifecycle.destroy(), false);
  assert.deepEqual(observed, ["validate", "construct", "bind", "initialize", "publish", "destroy"]);
  assert.equal(lifecycle.view.phase, "destroy");
  assert.throws(() => lifecycle.assertPublished(), errorCode("LIFECYCLE_PRECONDITION"));
  assert.throws(() => lifecycle.advance("publish"), errorCode("LIFECYCLE_ORDER"));
});
