import assert from "node:assert/strict";
import test from "node:test";
import {
  askM365CopilotWithRunner,
  buildCopilotQueryInvocation,
  requiresInteractiveLogin,
} from "../dist/ask-bridge.js";

const options = {
  prompt: "請摘要檔案",
  timeoutSeconds: 300,
  newConversation: true,
};

test("streams large prompts through stdin instead of the Windows command line", () => {
  const largePrompt = "檔案內容\n" + "x".repeat(100_000);
  const invocation = buildCopilotQueryInvocation({ ...options, prompt: largePrompt });

  assert.equal(invocation.stdin, largePrompt);
  assert.ok(!invocation.args.includes(largePrompt));
  assert.deepEqual(invocation.args, ["--provider", "copilot", "--timeout", "300", "--new"]);
});

test("recognizes ask-bridge logged-out diagnostics", () => {
  assert.equal(
    requiresInteractiveLogin(
      new Error(
        "You are not logged in to Microsoft 365 Copilot. Please run `ask-bridge --provider copilot login`.",
      ),
    ),
    true,
  );
  assert.equal(requiresInteractiveLogin(new Error("Chrome failed to start")), false);
});

test("relaunches visible login and retries the original stdin prompt", async () => {
  const invocations = [];
  let queryCount = 0;
  const runner = async (invocation) => {
    invocations.push(invocation);
    if (invocation.kind === "query" && queryCount++ === 0) {
      throw new Error(
        "You are not logged in to Microsoft 365 Copilot. Run ask-bridge --provider copilot login.",
      );
    }
    if (invocation.kind === "query") return { stdout: "Copilot answer\n", stderr: "" };
    return { stdout: "ok\n", stderr: "" };
  };

  const answer = await askM365CopilotWithRunner(options, runner);

  assert.equal(answer, "Copilot answer");
  assert.deepEqual(
    invocations.map(({ kind }) => kind),
    ["query", "close", "login", "query"],
  );
  assert.equal(invocations[0].stdin, options.prompt);
  assert.equal(invocations[2].windowsHide, false);
  assert.equal(invocations[3].stdin, options.prompt);
});

test("does not turn unrelated ask-bridge failures into a login flow", async () => {
  const invocations = [];
  const runner = async (invocation) => {
    invocations.push(invocation);
    throw new Error("Port 9223 belongs to another browser");
  };

  await assert.rejects(askM365CopilotWithRunner(options, runner), /Port 9223/);
  assert.deepEqual(
    invocations.map(({ kind }) => kind),
    ["query"],
  );
});
