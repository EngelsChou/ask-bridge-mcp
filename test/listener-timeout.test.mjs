import assert from "node:assert/strict";
import test from "node:test";

import { resolveListenerTimeoutSeconds } from "../dist/ask-bridge.js";

test("raises short host-agent timeouts to the default 30-minute floor", () => {
  assert.equal(resolveListenerTimeoutSeconds(30, {}), 1800);
  assert.equal(resolveListenerTimeoutSeconds(299, {}), 1800);
  assert.equal(resolveListenerTimeoutSeconds(undefined, {}), 1800);
});

test("keeps requests that are longer than the floor", () => {
  assert.equal(resolveListenerTimeoutSeconds(3600, {}), 3600);
  assert.equal(resolveListenerTimeoutSeconds(7200, {}), 7200);
});

test("honours ASK_BRIDGE_LISTENER_TIMEOUT_SECONDS from the MCP config env", () => {
  const env = { ASK_BRIDGE_LISTENER_TIMEOUT_SECONDS: "3600" };
  assert.equal(resolveListenerTimeoutSeconds(30, env), 3600);
  assert.equal(resolveListenerTimeoutSeconds(5400, env), 5400);

  const shortFloor = { ASK_BRIDGE_LISTENER_TIMEOUT_SECONDS: "60" };
  assert.equal(resolveListenerTimeoutSeconds(30, shortFloor), 60);
  assert.equal(resolveListenerTimeoutSeconds(600, shortFloor), 600);
});

test("clamps configured floors into the 30..7200 range and ignores junk", () => {
  assert.equal(resolveListenerTimeoutSeconds(30, { ASK_BRIDGE_LISTENER_TIMEOUT_SECONDS: "999999" }), 7200);
  assert.equal(resolveListenerTimeoutSeconds(30, { ASK_BRIDGE_LISTENER_TIMEOUT_SECONDS: "5" }), 30);
  assert.equal(resolveListenerTimeoutSeconds(30, { ASK_BRIDGE_LISTENER_TIMEOUT_SECONDS: "abc" }), 1800);
  assert.equal(resolveListenerTimeoutSeconds(30, { ASK_BRIDGE_LISTENER_TIMEOUT_SECONDS: "" }), 1800);
});
