import assert from "node:assert/strict";
import test from "node:test";

import { clearM365CopilotWithRunner } from "../dist/ask-bridge.js";

function recordingRunner(result = { stdout: "Closed ask-bridge Chrome browser instance.\n", stderr: "" }) {
  const invocations = [];
  const runner = async (invocation) => {
    invocations.push(invocation);
    if (result instanceof Error) throw result;
    return result;
  };
  return { runner, invocations };
}

test("runs exactly `ask-bridge --provider copilot close` with no prompt on stdin", async () => {
  const { runner, invocations } = recordingRunner();
  await clearM365CopilotWithRunner({ requestId: "test" }, runner, { onDiagnostic: () => {} });

  assert.equal(invocations.length, 1);
  const [invocation] = invocations;
  assert.equal(invocation.kind, "close");
  assert.deepEqual(invocation.args, ["--provider", "copilot", "close"]);
  assert.equal(invocation.stdin, "");
});

test("returns the ask-bridge output, or a default message when it prints nothing", async () => {
  const { runner } = recordingRunner();
  const message = await clearM365CopilotWithRunner({}, runner, { onDiagnostic: () => {} });
  assert.match(message, /Closed ask-bridge Chrome browser instance/);

  const quiet = recordingRunner({ stdout: "", stderr: "" });
  const fallback = await clearM365CopilotWithRunner({}, quiet.runner, { onDiagnostic: () => {} });
  assert.match(fallback, /Closed the managed Microsoft 365 Copilot Chrome instance/);
});

test("never returns mojibake from console-codepage helper output", async () => {
  // taskkill prints a localized message in the OEM codepage; decoded as UTF-8
  // it becomes replacement characters, which must not reach the chat.
  const garbled = recordingRunner({ stdout: "���\\: �w�N�פ�H���ǰe��\n", stderr: "" });
  const message = await clearM365CopilotWithRunner({}, garbled.runner, { onDiagnostic: () => {} });
  assert.ok(!message.includes("�"), message);
  assert.match(message, /Closed the managed Microsoft 365 Copilot Chrome instance/);
});

test("does not verify the ask-bridge version: clearing must work even when it is stuck", async () => {
  const { runner, invocations } = recordingRunner();
  await clearM365CopilotWithRunner({}, runner, { onDiagnostic: () => {} });
  assert.ok(!invocations.some((invocation) => invocation.kind === "version"));
});

test("reports failures instead of pretending the browser was closed", async () => {
  const failing = recordingRunner(new Error("port 9223 is owned by another Chrome"));
  await assert.rejects(
    () => clearM365CopilotWithRunner({}, failing.runner, { onDiagnostic: () => {} }),
    /port 9223 is owned by another Chrome/,
  );
});

test("emits clear diagnostics without any prompt or response content", async () => {
  const events = [];
  const { runner } = recordingRunner();
  await clearM365CopilotWithRunner({}, runner, {
    onDiagnostic: (event, details) => events.push({ event, details }),
  });

  const names = events.map((entry) => entry.event);
  assert.deepEqual(names, ["clear_queued", "clear_started", "clear_succeeded", "clear_finished"]);
  const serialized = JSON.stringify(events);
  assert.ok(!/prompt|response_character_count/i.test(serialized));
});
