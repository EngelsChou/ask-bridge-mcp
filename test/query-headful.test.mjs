import assert from "node:assert/strict";
import test from "node:test";

import { buildCopilotQueryInvocation, resolveQueryHeadful } from "../dist/ask-bridge.js";

const baseOptions = {
  prompt: "hello",
  imagePaths: [],
  filePaths: [],
  inlineImages: [],
  includeClipboardImage: false,
  attachmentConsent: false,
  newConversation: false,
  timeoutSeconds: 300,
};

test("shows the Chrome window by default", () => {
  assert.equal(resolveQueryHeadful({}), true);
  assert.equal(resolveQueryHeadful({ ASK_BRIDGE_QUERY_HEADFUL: "" }), true);
  assert.equal(resolveQueryHeadful({ ASK_BRIDGE_QUERY_HEADFUL: "true" }), true);
  assert.equal(resolveQueryHeadful({ ASK_BRIDGE_QUERY_HEADFUL: "1" }), true);
});

test("keeps queries in the background window when explicitly disabled", () => {
  for (const value of ["false", "FALSE", "0", "no", "off", " Off "]) {
    assert.equal(resolveQueryHeadful({ ASK_BRIDGE_QUERY_HEADFUL: value }), false, value);
  }
});

test("passes the resolved visibility to ask-bridge and keeps the process unhidden", () => {
  const visible = buildCopilotQueryInvocation(baseOptions, true);
  assert.ok(visible.args.includes("--headless=false"));
  assert.ok(!visible.args.includes("--headless=true"));
  assert.equal(visible.windowsHide, false);

  const background = buildCopilotQueryInvocation(baseOptions, false);
  assert.ok(background.args.includes("--headless=true"));
  assert.equal(background.windowsHide, true);
});

test("still forwards prompt via stdin and preserves the other query options", () => {
  const invocation = buildCopilotQueryInvocation(
    { ...baseOptions, newConversation: true, model: "GPT 5.5 快速回應" },
    true,
  );
  assert.equal(invocation.stdin, "hello");
  assert.equal(invocation.kind, "query");
  assert.ok(invocation.args.includes("--new"));
  assert.deepEqual(invocation.args.slice(-2), ["--model", "GPT 5.5 快速回應"]);
});
