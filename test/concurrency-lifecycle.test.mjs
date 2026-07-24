import assert from "node:assert/strict";
import test from "node:test";
import {
  askM365CopilotWithRunner,
  listenM365CopilotWithRunner,
} from "../dist/ask-bridge.js";

const baseOptions = {
  prompt: "request",
  timeoutSeconds: 300,
  newConversation: false,
};

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitFor(predicate, message) {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function supportedVersion() {
  return { stdout: "ask-bridge 0.3.15\n", stderr: "" };
}

test("runs concurrent tool calls one at a time in FIFO order", async (t) => {
  const gates = new Map([
    ["A", deferred()],
    ["B", deferred()],
    ["C", deferred()],
  ]);
  t.after(() => {
    for (const gate of gates.values()) gate.resolve();
  });

  const events = [];
  const runner = async (invocation) => {
    if (invocation.kind === "version") return supportedVersion();
    assert.equal(invocation.kind, "query");
    const id = invocation.stdin;
    events.push(`start:${id}`);
    await gates.get(id).promise;
    events.push(`end:${id}`);
    return { stdout: `answer:${id}\n`, stderr: "" };
  };

  const first = askM365CopilotWithRunner({ ...baseOptions, prompt: "A" }, runner);
  await waitFor(() => events.includes("start:A"), "first request did not start");
  const second = askM365CopilotWithRunner({ ...baseOptions, prompt: "B" }, runner);
  const third = askM365CopilotWithRunner({ ...baseOptions, prompt: "C" }, runner);

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(events, ["start:A"]);

  gates.get("A").resolve();
  await waitFor(() => events.includes("start:B"), "second FIFO request did not start");
  assert.deepEqual(events, ["start:A", "end:A", "start:B"]);

  gates.get("B").resolve();
  await waitFor(() => events.includes("start:C"), "third FIFO request did not start");
  assert.deepEqual(events, ["start:A", "end:A", "start:B", "end:B", "start:C"]);

  gates.get("C").resolve();
  assert.deepEqual(await Promise.all([first, second, third]), ["answer:A", "answer:B", "answer:C"]);
  assert.deepEqual(events, [
    "start:A",
    "end:A",
    "start:B",
    "end:B",
    "start:C",
    "end:C",
  ]);
});

test("listener holds the same Chrome lock until Return VS Code completes", async (t) => {
  const listenerGate = deferred();
  t.after(() => listenerGate.resolve());
  const events = [];
  const runner = async (invocation) => {
    if (invocation.kind === "version") return supportedVersion();
    events.push(`start:${invocation.kind}`);
    if (invocation.kind === "listener") await listenerGate.promise;
    events.push(`end:${invocation.kind}`);
    return {
      stdout: invocation.kind === "listener" ? "interactive result\n" : "query result\n",
      stderr: "",
    };
  };

  const listener = listenM365CopilotWithRunner(
    { timeoutSeconds: 1800, newConversation: false },
    runner,
  );
  await waitFor(
    () => events.includes("start:listener"),
    "listener did not acquire the Chrome lock",
  );
  const query = askM365CopilotWithRunner(baseOptions, runner);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(events, ["start:listener"]);

  listenerGate.resolve();
  assert.equal(await listener, "interactive result");
  assert.equal(await query, "query result");
  assert.deepEqual(events, [
    "start:listener",
    "end:listener",
    "start:query",
    "end:query",
  ]);
});

test("aborting a queued request rejects immediately and does not block later requests", async (t) => {
  const firstGate = deferred();
  t.after(() => firstGate.resolve());
  const started = [];
  const runner = async (invocation) => {
    if (invocation.kind === "version") return supportedVersion();
    assert.equal(invocation.kind, "query");
    started.push(invocation.stdin);
    if (invocation.stdin === "A") await firstGate.promise;
    return { stdout: `${invocation.stdin} done\n`, stderr: "" };
  };

  const first = askM365CopilotWithRunner({ ...baseOptions, prompt: "A" }, runner);
  await waitFor(() => started.includes("A"), "first request did not acquire the lock");

  const controller = new AbortController();
  const canceled = askM365CopilotWithRunner(
    { ...baseOptions, prompt: "B", signal: controller.signal },
    runner,
  );
  const third = askM365CopilotWithRunner({ ...baseOptions, prompt: "C" }, runner);
  controller.abort();

  const cancellationResult = await Promise.race([
    canceled.then(
      () => "resolved",
      (error) => error.name,
    ),
    new Promise((resolve) => setTimeout(() => resolve("timed-out"), 250)),
  ]);
  assert.equal(cancellationResult, "AbortError");
  assert.deepEqual(started, ["A"]);

  firstGate.resolve();
  assert.equal(await first, "A done");
  assert.equal(await third, "C done");
  assert.deepEqual(started, ["A", "C"]);
});

test("holds the lock across login retry and attachment cleanup", async (t) => {
  const loginGate = deferred();
  const cleanupGate = deferred();
  t.after(() => {
    loginGate.resolve();
    cleanupGate.resolve();
  });
  const loginStarted = deferred();
  const cleanupStarted = deferred();
  const events = [];
  let firstQueryCount = 0;

  const runner = async (invocation) => {
    if (invocation.kind === "version") return supportedVersion();
    if (invocation.kind === "query") {
      events.push(`query:${invocation.stdin}`);
      if (invocation.stdin === "A" && firstQueryCount++ === 0) {
        throw new Error(
          "You are not logged in to Microsoft 365 Copilot. Run ask-bridge --provider copilot login.",
        );
      }
      return { stdout: `answer:${invocation.stdin}\n`, stderr: "" };
    }
    events.push(invocation.kind);
    if (invocation.kind === "login") {
      loginStarted.resolve();
      await loginGate.promise;
    }
    return { stdout: "ok\n", stderr: "" };
  };

  const first = askM365CopilotWithRunner(
    { ...baseOptions, prompt: "A" },
    runner,
    {},
    {
      prepareAttachments: async () => {
        events.push("prepare:A");
        return {
          imagePaths: [],
          filePaths: [],
          cleanup: async () => {
            events.push("cleanup:A");
            cleanupStarted.resolve();
            await cleanupGate.promise;
          },
        };
      },
    },
  );
  await loginStarted.promise;
  const second = askM365CopilotWithRunner(
    { ...baseOptions, prompt: "B" },
    runner,
    {},
    {
      prepareAttachments: async () => {
        events.push("prepare:B");
        return { imagePaths: [], filePaths: [], cleanup: async () => {} };
      },
    },
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(events, ["prepare:A", "query:A", "close", "login"]);

  loginGate.resolve();
  await cleanupStarted.promise;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(events, [
    "prepare:A",
    "query:A",
    "close",
    "login",
    "query:A",
    "cleanup:A",
  ]);

  cleanupGate.resolve();
  assert.equal(await first, "answer:A");
  assert.equal(await second, "answer:B");
  assert.deepEqual(events, [
    "prepare:A",
    "query:A",
    "close",
    "login",
    "query:A",
    "cleanup:A",
    "prepare:B",
    "query:B",
  ]);
});

test("cleanup failures never replace a successful answer or the original query error", async () => {
  const cleanupFailure = new Error("temporary directory is busy");
  const cleanupEvents = [];
  let cleanupAttempts = 0;
  const failingPreparation = async () => ({
    imagePaths: [],
    filePaths: [],
    cleanup: async () => {
      cleanupAttempts += 1;
      throw cleanupFailure;
    },
  });

  const successRunner = async (invocation) =>
    invocation.kind === "version"
      ? supportedVersion()
      : { stdout: "successful answer\n", stderr: "" };
  const answer = await askM365CopilotWithRunner(
    baseOptions,
    successRunner,
    {},
    {
      prepareAttachments: failingPreparation,
      cleanupRetryDelayMs: 0,
      onCleanupError: (failure) => cleanupEvents.push(failure),
    },
  );
  assert.equal(answer, "successful answer");
  assert.equal(cleanupAttempts, 3);
  assert.equal(cleanupEvents.length, 1);
  assert.equal(cleanupEvents[0].error, cleanupFailure);
  assert.equal(cleanupEvents[0].attempts, 3);
  assert.equal(cleanupEvents[0].recovered, false);

  const originalError = new Error("original provider error");
  const errorRunner = async (invocation) => {
    if (invocation.kind === "version") return supportedVersion();
    throw originalError;
  };
  await assert.rejects(
    askM365CopilotWithRunner(baseOptions, errorRunner, {}, {
      prepareAttachments: failingPreparation,
      cleanupRetryDelayMs: 0,
      onCleanupError: () => {
        throw new Error("reporter also failed");
      },
    }),
    (error) => error === originalError,
  );
});

test("rejects ask-bridge older than 0.3.15 before querying with upgrade guidance", async () => {
  const kinds = [];
  const runner = async (invocation) => {
    kinds.push(invocation.kind);
    if (invocation.kind === "version") {
      return { stdout: "ask-bridge 0.3.10\n", stderr: "" };
    }
    assert.fail("an unsupported ask-bridge must not receive a query");
  };

  await assert.rejects(
    askM365CopilotWithRunner(baseOptions, runner),
    (error) =>
      /requires ask-bridge 0\.3\.15 or later/i.test(error.message) &&
      /upgrade ask-bridge/i.test(error.message) &&
      /restart VS Code/i.test(error.message),
  );
  assert.deepEqual(kinds, ["version"]);
});

test("caches a successful version check for repeated calls using the same runner", async () => {
  let versionChecks = 0;
  let queries = 0;
  const runner = async (invocation) => {
    if (invocation.kind === "version") {
      versionChecks += 1;
      return { stdout: "ask-bridge v0.3.15\n", stderr: "" };
    }
    queries += 1;
    return { stdout: `answer ${queries}\n`, stderr: "" };
  };

  assert.equal(await askM365CopilotWithRunner(baseOptions, runner), "answer 1");
  assert.equal(await askM365CopilotWithRunner(baseOptions, runner), "answer 2");
  assert.equal(versionChecks, 1);
  assert.equal(queries, 2);
});
