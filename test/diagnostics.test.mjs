import assert from "node:assert/strict";
import test from "node:test";
import { askM365CopilotWithRunner } from "../dist/ask-bridge.js";
import { diagnosticRecord } from "../dist/diagnostics.js";

test("diagnostic records correlate requests without prompt or response content", () => {
  const record = diagnosticRecord(
    "request-123",
    "request_succeeded",
    { prompt_character_count: 12, response_character_count: 34 },
    1000,
    2000,
  );

  assert.equal(record.request_id, "request-123");
  assert.equal(record.timestamp_unix_ms, 1000);
  assert.equal(record.process_id, 2000);
  assert.equal(record.event, "request_succeeded");
  assert.equal(record.details.prompt_character_count, 12);
  assert.equal(record.prompt, undefined);
  assert.equal(record.response, undefined);
});

test("request lifecycle logs reach the final MCP result boundary", async () => {
  const events = [];
  const answer = await askM365CopilotWithRunner(
    {
      requestId: "request-456",
      prompt: "第一行\n第二行",
      timeoutSeconds: 300,
      newConversation: true,
    },
    async (invocation) =>
      invocation.kind === "version"
        ? { stdout: "ask-bridge 0.3.15\n", stderr: "" }
        : { stdout: "完整回答\n", stderr: "" },
    {},
    { onDiagnostic: (event, details) => events.push({ event, details }) },
  );

  assert.equal(answer, "完整回答");
  assert.deepEqual(
    events.map(({ event }) => event),
    [
      "request_queued",
      "request_started",
      "version_verified",
      "attachments_prepared",
      "request_succeeded",
      "request_finished",
    ],
  );
  assert.equal(events[0].details.prompt_character_count, 7);
  assert.equal(events[0].details.prompt_line_break_count, 1);
  assert.equal(events[4].details.response_character_count, 4);
  assert.ok(!JSON.stringify(events).includes("第一行"));
  assert.ok(!JSON.stringify(events).includes("完整回答"));
});
