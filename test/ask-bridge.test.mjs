import assert from "node:assert/strict";
import { access, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  askM365CopilotWithRunner,
  buildCopilotListenerInvocation,
  buildCopilotQueryInvocation,
  listenM365CopilotWithRunner,
  resolveAskBridgeExecutable,
  requiresInteractiveLogin,
} from "../dist/ask-bridge.js";
import {
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS,
  prepareAttachments,
} from "../dist/attachments.js";

const onePixelPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nWQAAAAASUVORK5CYII=",
  "base64",
);
const minimalTiffHeader = Buffer.from("49492a0008000000", "hex");

async function temporaryDirectory(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ask-bridge-mcp-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function assertPathMissing(value) {
  await assert.rejects(access(value));
}

function allowAttachmentRoot(t, directory) {
  const previous = process.env.ASK_BRIDGE_ALLOWED_ROOTS;
  process.env.ASK_BRIDGE_ALLOWED_ROOTS = directory;
  t.after(() => {
    if (previous === undefined) delete process.env.ASK_BRIDGE_ALLOWED_ROOTS;
    else process.env.ASK_BRIDGE_ALLOWED_ROOTS = previous;
  });
}

const options = {
  prompt: "請摘要檔案",
  timeoutSeconds: 300,
  newConversation: true,
};

test("prefers an explicitly configured ask-bridge executable", () => {
  const configured = String.raw`C:\custom\ask-bridge.exe`;
  assert.equal(
    resolveAskBridgeExecutable({ ASK_BRIDGE_PATH: `  ${configured}  ` }, "ignored", () => false),
    configured,
  );
});

test("auto-discovers the ask-bridge bundled beside the packaged Node runtime", () => {
  const nodeExecutable = path.join("C:\\Program Files", "ask-bridge-mcp", "runtime", "node.exe");
  const expected = path.resolve(path.dirname(nodeExecutable), "..", "bridge", "ask-bridge.exe");
  assert.equal(resolveAskBridgeExecutable({}, nodeExecutable, (value) => value === expected), expected);
});

test("falls back to PATH for development and custom installations", () => {
  assert.equal(resolveAskBridgeExecutable({}, process.execPath, () => false), "ask-bridge");
});

function withSupportedVersion(runner) {
  return (invocation, signal) =>
    invocation.kind === "version"
      ? Promise.resolve({ stdout: "ask-bridge 0.3.13\n", stderr: "" })
      : runner(invocation, signal);
}

test("streams large prompts through stdin instead of the Windows command line", () => {
  const largePrompt = "檔案內容\n" + "x".repeat(100_000);
  const invocation = buildCopilotQueryInvocation({ ...options, prompt: largePrompt });

  assert.equal(invocation.stdin, largePrompt);
  assert.ok(!invocation.args.includes(largePrompt));
  assert.deepEqual(invocation.args, ["--provider", "copilot", "--timeout", "300", "--new"]);
});

test("passes the current Microsoft 365 GPT submenu model separately from the VS Code host model", () => {
  const invocation = buildCopilotQueryInvocation({
    ...options,
    model: "  GPT 5.5 快速回應  ",
  });

  assert.deepEqual(invocation.args, [
    "--provider",
    "copilot",
    "--timeout",
    "300",
    "--new",
    "--model",
    "GPT 5.5 快速回應",
  ]);
});

test("builds a visible listener command without a prompt or automated attachments", () => {
  const invocation = buildCopilotListenerInvocation({
    timeoutSeconds: 1800,
    newConversation: false,
  });

  assert.deepEqual(invocation.args, [
    "--provider",
    "copilot",
    "--timeout",
    "1800",
    "listen",
  ]);
  assert.equal(invocation.kind, "listener");
  assert.equal(invocation.stdin, "");
  assert.equal(invocation.windowsHide, false);

  const fresh = buildCopilotListenerInvocation({
    timeoutSeconds: 7200,
    newConversation: true,
  });
  assert.deepEqual(fresh.args, [
    "--provider",
    "copilot",
    "--timeout",
    "7200",
    "--new",
    "listen",
  ]);
});

test("returns the listener response only after ask-bridge completes", async () => {
  const invocations = [];
  const runner = withSupportedVersion(async (invocation) => {
    invocations.push(invocation);
    assert.equal(invocation.kind, "listener");
    return { stdout: "M365 interactive analysis\n", stderr: "" };
  });

  const answer = await listenM365CopilotWithRunner(
    { timeoutSeconds: 1800, newConversation: false },
    runner,
  );

  assert.equal(answer, "M365 interactive analysis");
  assert.deepEqual(invocations.map(({ kind }) => kind), ["listener"]);
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
  const runner = withSupportedVersion(async (invocation) => {
    invocations.push(invocation);
    if (invocation.kind === "query" && queryCount++ === 0) {
      throw new Error(
        "You are not logged in to Microsoft 365 Copilot. Run ask-bridge --provider copilot login.",
      );
    }
    if (invocation.kind === "query") return { stdout: "Copilot answer\n", stderr: "" };
    return { stdout: "ok\n", stderr: "" };
  });

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
  const runner = withSupportedVersion(async (invocation) => {
    invocations.push(invocation);
    throw new Error("Port 9223 belongs to another browser");
  });

  await assert.rejects(askM365CopilotWithRunner(options, runner), /Port 9223/);
  assert.deepEqual(
    invocations.map(({ kind }) => kind),
    ["query"],
  );
});

test("adds repeated image and file arguments without moving the prompt onto argv", () => {
  const invocation = buildCopilotQueryInvocation({
    ...options,
    prompt: "review these artifacts",
    imagePaths: [String.raw`C:\screenshots\order header.png`, String.raw`C:\screenshots\details.png`],
    filePaths: [String.raw`C:\work\OrderHeader.cs`, String.raw`C:\work\specification.pdf`],
  });

  assert.deepEqual(invocation.args, [
    "--provider",
    "copilot",
    "--timeout",
    "300",
    "--new",
    "--image",
    String.raw`C:\screenshots\order header.png`,
    "--image",
    String.raw`C:\screenshots\details.png`,
    "--file",
    String.raw`C:\work\OrderHeader.cs`,
    "--file",
    String.raw`C:\work\specification.pdf`,
  ]);
  assert.equal(invocation.stdin, "review these artifacts");
});

test("validates absolute regular local attachment paths", async (t) => {
  const directory = await temporaryDirectory(t);
  allowAttachmentRoot(t, directory);
  const image = path.join(directory, "screen shot.png");
  const source = path.join(directory, "OrderHeader.cs");
  await writeFile(image, onePixelPng);
  await writeFile(source, "class OrderHeader {}\n");

  const prepared = await prepareAttachments({
    imagePaths: [image],
    filePaths: [source],
    attachmentConsent: true,
  });
  try {
    assert.deepEqual(prepared.imagePaths, [image]);
    assert.deepEqual(prepared.filePaths, [source]);
  } finally {
    await prepared.cleanup();
  }

  await assert.rejects(
    prepareAttachments({ filePaths: ["relative-file.cs"], attachmentConsent: true }),
    /must be an absolute local path/,
  );
  await assert.rejects(
    prepareAttachments({ filePaths: [directory], attachmentConsent: true }),
    /must point to a regular file/,
  );
});

test("materializes strict inline data URI images and removes the temporary directory", async () => {
  let materializedPath;
  const answer = await askM365CopilotWithRunner(
    {
      ...options,
      inlineImages: [
        {
          data: `data:image/png;base64,${onePixelPng.toString("base64")}`,
          name: "order-header.png",
        },
      ],
      attachmentConsent: true,
    },
    withSupportedVersion(async (invocation) => {
      assert.equal(invocation.kind, "query");
      const imageIndex = invocation.args.indexOf("--image");
      assert.notEqual(imageIndex, -1);
      materializedPath = invocation.args[imageIndex + 1];
      assert.deepEqual(await readFile(materializedPath), onePixelPng);
      return { stdout: "inline image received\n", stderr: "" };
    }),
  );

  assert.equal(answer, "inline image received");
  assert.ok(materializedPath);
  await assertPathMissing(path.dirname(materializedPath));
});

test("accepts raw base64 images with an explicit MIME type", async () => {
  const prepared = await prepareAttachments({
    inlineImages: [
      {
        data: onePixelPng.toString("base64"),
        mimeType: "image/png",
        name: "inline-wrong-extension.jpg",
      },
    ],
    attachmentConsent: true,
  });
  try {
    assert.equal(prepared.imagePaths.length, 1);
    assert.match(prepared.imagePaths[0], /inline-wrong-extension\.png$/);
    assert.deepEqual(await readFile(prepared.imagePaths[0]), onePixelPng);
  } finally {
    const directory = path.dirname(prepared.imagePaths[0]);
    await prepared.cleanup();
    await assertPathMissing(directory);
  }
});

test("accepts Microsoft 365 Copilot TIFF inline images", async () => {
  const prepared = await prepareAttachments({
    inlineImages: [
      {
        data: minimalTiffHeader.toString("base64"),
        mimeType: "image/tiff",
        name: "scan.tif",
      },
    ],
    attachmentConsent: true,
  });
  try {
    assert.match(prepared.imagePaths[0], /scan\.tif$/);
    assert.deepEqual(await readFile(prepared.imagePaths[0]), minimalTiffHeader);
  } finally {
    await prepared.cleanup();
  }
});

test("rejects malformed base64, MIME mismatches, and unsupported inline formats", async () => {
  await assert.rejects(
    prepareAttachments({
      inlineImages: [{ data: "this-is-not-base64" }],
      attachmentConsent: true,
    }),
    /not valid base64/,
  );
  await assert.rejects(
    prepareAttachments({
      inlineImages: [{ data: onePixelPng.toString("base64"), mimeType: "image/jpeg" }],
      attachmentConsent: true,
    }),
    /does not match MIME type/,
  );
  await assert.rejects(
    prepareAttachments({
      inlineImages: [{ data: onePixelPng.toString("base64"), mimeType: "image/svg+xml" }],
      attachmentConsent: true,
    }),
    /Unsupported inline image MIME type/,
  );
  await assert.rejects(
    prepareAttachments({
      inlineImages: [{ data: onePixelPng.toString("base64"), mimeType: "image/webp" }],
      attachmentConsent: true,
    }),
    /Unsupported inline image MIME type/,
  );
  await assert.rejects(
    prepareAttachments({
      inlineImages: [
        {
          data: `data:image/png;base64,${onePixelPng.toString("base64")}`,
          mimeType: "image/jpeg",
        },
      ],
      attachmentConsent: true,
    }),
    /MIME type mismatch/,
  );
});

test("enforces attachment count, per-file size, and aggregate size limits", async (t) => {
  await assert.rejects(
    prepareAttachments({ imagePaths: Array(MAX_ATTACHMENTS + 1).fill(String.raw`C:\unused.png`) }),
    /Too many attachments/,
  );

  const directory = await temporaryDirectory(t);
  allowAttachmentRoot(t, directory);
  const oversized = path.join(directory, "oversized.bin");
  const oversizedHandle = await open(oversized, "w");
  await oversizedHandle.truncate(MAX_ATTACHMENT_BYTES + 1);
  await oversizedHandle.close();
  await assert.rejects(
    prepareAttachments({ filePaths: [oversized], attachmentConsent: true }),
    /per-file limit/,
  );

  const aggregateFiles = [];
  for (let index = 0; index < 3; index += 1) {
    const value = path.join(directory, `aggregate-${index}.bin`);
    const handle = await open(value, "w");
    await handle.truncate(18 * 1024 * 1024);
    await handle.close();
    aggregateFiles.push(value);
  }
  await assert.rejects(
    prepareAttachments({ filePaths: aggregateFiles, attachmentConsent: true }),
    /attachment total exceed/,
  );
});

test("captures an injected clipboard image as PNG and cleans it after the query", async () => {
  let capturedOutputPath;
  let queryImagePath;
  const answer = await askM365CopilotWithRunner(
    { ...options, includeClipboardImage: true, attachmentConsent: true },
    withSupportedVersion(async (invocation) => {
      assert.equal(invocation.kind, "query");
      queryImagePath = invocation.args[invocation.args.indexOf("--image") + 1];
      assert.equal(queryImagePath, capturedOutputPath);
      assert.deepEqual(await readFile(queryImagePath), onePixelPng);
      return { stdout: "clipboard image received\n", stderr: "" };
    }),
    {
      captureClipboardImage: async (outputPath) => {
        capturedOutputPath = outputPath;
        await writeFile(outputPath, onePixelPng);
      },
    },
  );

  assert.equal(answer, "clipboard image received");
  assert.ok(queryImagePath);
  await assertPathMissing(path.dirname(queryImagePath));
});

test("cleans clipboard temporary files when capture fails", async () => {
  let outputPath;
  await assert.rejects(
    askM365CopilotWithRunner(
      { ...options, includeClipboardImage: true, attachmentConsent: true },
      withSupportedVersion(async () =>
        assert.fail("runner must not start after clipboard capture failure"),
      ),
      {
        captureClipboardImage: async (value) => {
          outputPath = value;
          throw new Error("clipboard is empty");
        },
      },
    ),
    /clipboard is empty/,
  );
  assert.ok(outputPath);
  await assertPathMissing(path.dirname(outputPath));
});

test("keeps materialized attachments for login retry, then cleans them", async () => {
  const queryPaths = [];
  let queryCount = 0;
  const answer = await askM365CopilotWithRunner(
    {
      ...options,
      inlineImages: [{ data: onePixelPng.toString("base64"), mimeType: "image/png" }],
      attachmentConsent: true,
    },
    withSupportedVersion(async (invocation) => {
      if (invocation.kind === "query") {
        queryCount += 1;
        const value = invocation.args[invocation.args.indexOf("--image") + 1];
        queryPaths.push(value);
        await access(value);
        if (queryCount === 1) {
          throw new Error(
            "You are not logged in to Microsoft 365 Copilot. Run ask-bridge --provider copilot login.",
          );
        }
        return { stdout: "retried with attachment\n", stderr: "" };
      }
      return { stdout: "ok\n", stderr: "" };
    }),
  );

  assert.equal(answer, "retried with attachment");
  assert.equal(queryPaths.length, 2);
  assert.equal(queryPaths[0], queryPaths[1]);
  await assertPathMissing(path.dirname(queryPaths[0]));
});

test("cleans materialized inline images after an unrelated runner failure", async () => {
  let materializedPath;
  await assert.rejects(
    askM365CopilotWithRunner(
      {
        ...options,
        inlineImages: [{ data: onePixelPng.toString("base64"), mimeType: "image/png" }],
        attachmentConsent: true,
      },
      withSupportedVersion(async (invocation) => {
        materializedPath = invocation.args[invocation.args.indexOf("--image") + 1];
        throw new Error("provider upload failed");
      }),
    ),
    /provider upload failed/,
  );
  assert.ok(materializedPath);
  await assertPathMissing(path.dirname(materializedPath));
});

test("cleans materialized inline images after cancellation", async () => {
  const controller = new AbortController();
  let startedResolve;
  const started = new Promise((resolve) => {
    startedResolve = resolve;
  });
  let materializedPath;

  const request = askM365CopilotWithRunner(
    {
      ...options,
      signal: controller.signal,
      inlineImages: [{ data: onePixelPng.toString("base64"), mimeType: "image/png" }],
      attachmentConsent: true,
    },
    withSupportedVersion((invocation, signal) =>
      new Promise((resolve, reject) => {
        materializedPath = invocation.args[invocation.args.indexOf("--image") + 1];
        startedResolve();
        signal?.addEventListener("abort", () => reject(new Error("runner canceled")), { once: true });
      })),
  );

  await started;
  controller.abort();
  await assert.rejects(request, /runner canceled/);
  assert.ok(materializedPath);
  await assertPathMissing(path.dirname(materializedPath));
});
