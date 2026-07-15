import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { prepareAttachments } from "../dist/attachments.js";

const onePixelPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nWQAAAAASUVORK5CYII=",
  "base64",
);

async function temporaryDirectory(t, prefix = "ask-bridge-mcp-security-") {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function setAllowedRoots(t, value) {
  const previous = process.env.ASK_BRIDGE_ALLOWED_ROOTS;
  process.env.ASK_BRIDGE_ALLOWED_ROOTS = value;
  t.after(() => {
    if (previous === undefined) delete process.env.ASK_BRIDGE_ALLOWED_ROOTS;
    else process.env.ASK_BRIDGE_ALLOWED_ROOTS = previous;
  });
}

function clearAllowedRoots(t) {
  const previous = process.env.ASK_BRIDGE_ALLOWED_ROOTS;
  delete process.env.ASK_BRIDGE_ALLOWED_ROOTS;
  t.after(() => {
    if (previous === undefined) delete process.env.ASK_BRIDGE_ALLOWED_ROOTS;
    else process.env.ASK_BRIDGE_ALLOWED_ROOTS = previous;
  });
}

async function captureRejection(promise) {
  let error;
  try {
    await promise;
  } catch (caught) {
    error = caught;
  }
  assert.ok(error instanceof Error, "Expected the operation to reject with an Error");
  return error;
}

test("requires explicit consent for every attachment source", async (t) => {
  const directory = await temporaryDirectory(t);
  const file = path.join(directory, "review.txt");
  await writeFile(file, "review me");
  setAllowedRoots(t, directory);

  for (const inputs of [
    { filePaths: [file] },
    { imagePaths: [file] },
    { inlineImages: [{ data: onePixelPng.toString("base64"), mimeType: "image/png" }] },
    { includeClipboardImage: true },
  ]) {
    await assert.rejects(prepareAttachments(inputs), /attachmentConsent=true is required/);
  }
});

test("fails closed for path attachments when no allowed roots are configured", async (t) => {
  const directory = await temporaryDirectory(t);
  const file = path.join(directory, "review.txt");
  await writeFile(file, "review me");
  clearAllowedRoots(t);

  await assert.rejects(
    prepareAttachments({ filePaths: [file], attachmentConsent: true }),
    /ASK_BRIDGE_ALLOWED_ROOTS is not configured/,
  );
});

test("accepts canonical files inside any configured root", async (t) => {
  const directory = await temporaryDirectory(t);
  const firstRoot = path.join(directory, "first");
  const secondRoot = path.join(directory, "second");
  await mkdir(firstRoot);
  await mkdir(secondRoot);
  const file = path.join(secondRoot, "review.txt");
  await writeFile(file, "review me");
  setAllowedRoots(t, `${firstRoot}${path.delimiter}${secondRoot}`);

  const prepared = await prepareAttachments({ filePaths: [file], attachmentConsent: true });
  try {
    assert.deepEqual(prepared.filePaths, [await realpath(file)]);
  } finally {
    await prepared.cleanup();
  }
});

test("rejects sibling-prefix traversal without leaking a path or file content", async (t) => {
  const directory = await temporaryDirectory(t);
  const root = path.join(directory, "allowed");
  const sibling = path.join(directory, "allowed-sibling");
  await mkdir(root);
  await mkdir(sibling);
  const file = path.join(sibling, "ordinary.txt");
  const secretContent = "DO_NOT_ECHO_THIS_CONTENT_7c54";
  await writeFile(file, secretContent);
  setAllowedRoots(t, root);

  const error = await captureRejection(
    prepareAttachments({ filePaths: [file], attachmentConsent: true }),
  );
  assert.match(error.message, /outside ASK_BRIDGE_ALLOWED_ROOTS/);
  assert.ok(!error.message.includes(file));
  assert.ok(!error.message.includes(secretContent));
});

test("rejects sensitive directories, filenames, and private-key extensions", async (t) => {
  const root = await temporaryDirectory(t);
  setAllowedRoots(t, root);
  const blockedPaths = [
    path.join(root, ".git", "config"),
    path.join(root, ".ssh", "config"),
    path.join(root, ".gnupg", "pubring.kbx"),
    path.join(root, ".aws", "config"),
    path.join(root, ".azure", "azureProfile.json"),
    path.join(root, ".env"),
    path.join(root, ".env.production"),
    path.join(root, "id_rsa"),
    path.join(root, "id_ed25519.pub"),
    path.join(root, "credentials"),
    path.join(root, "service-account.json"),
    path.join(root, "private.pem"),
    path.join(root, "certificate.pfx"),
    path.join(root, "signing.keystore"),
  ];

  for (const file of blockedPaths) {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "sensitive value");
    const error = await captureRejection(
      prepareAttachments({ filePaths: [file], attachmentConsent: true }),
    );
    assert.match(error.message, /sensitive-file policy/);
    assert.ok(!error.message.includes(file));
    assert.ok(!error.message.includes("sensitive value"));
  }
});

test("uses case-insensitive root comparison on Windows", async (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows-specific path comparison");
    return;
  }
  const root = await temporaryDirectory(t);
  const file = path.join(root, "Review.txt");
  await writeFile(file, "review me");
  setAllowedRoots(t, root.toUpperCase());

  const prepared = await prepareAttachments({ filePaths: [file], attachmentConsent: true });
  await prepared.cleanup();
});

test("canonicalizes parent links and rejects an escape outside the allowed root", async (t) => {
  const directory = await temporaryDirectory(t);
  const root = path.join(directory, "allowed");
  const outside = path.join(directory, "outside");
  const linkedDirectory = path.join(root, "linked");
  await mkdir(root);
  await mkdir(outside);
  const outsideFile = path.join(outside, "review.txt");
  await writeFile(outsideFile, "outside data");

  try {
    await symlink(outside, linkedDirectory, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (error?.code === "EPERM" || error?.code === "EACCES") {
      t.skip("Creating a directory link is not permitted on this host");
      return;
    }
    throw error;
  }
  setAllowedRoots(t, root);

  await assert.rejects(
    prepareAttachments({
      filePaths: [path.join(linkedDirectory, "review.txt")],
      attachmentConsent: true,
    }),
    /outside ASK_BRIDGE_ALLOWED_ROOTS/,
  );
});

test("inline and clipboard images need consent but do not need an allowed root", async (t) => {
  clearAllowedRoots(t);
  const inline = await prepareAttachments({
    inlineImages: [{ data: onePixelPng.toString("base64"), mimeType: "image/png" }],
    attachmentConsent: true,
  });
  await inline.cleanup();

  const clipboard = await prepareAttachments(
    { includeClipboardImage: true, attachmentConsent: true },
    undefined,
    {
      captureClipboardImage: (outputPath) => writeFile(outputPath, onePixelPng),
    },
  );
  await clipboard.cleanup();
});

test("cleanup remains retryable after its first removal failure", async () => {
  let attempts = 0;
  const prepared = await prepareAttachments(
    {
      inlineImages: [{ data: onePixelPng.toString("base64"), mimeType: "image/png" }],
      attachmentConsent: true,
    },
    undefined,
    {
      removeTemporaryDirectory: async (directory) => {
        attempts += 1;
        if (attempts === 1) throw new Error("simulated removal failure");
        await rm(directory, { recursive: true, force: true });
      },
    },
  );
  const directory = path.dirname(prepared.imagePaths[0]);

  await assert.rejects(prepared.cleanup(), /simulated removal failure/);
  await access(directory);
  await prepared.cleanup();
  await assert.rejects(access(directory));
  await prepared.cleanup();
  assert.equal(attempts, 2);
});

test("preparation preserves its original error when temporary cleanup also fails", async (t) => {
  let temporaryDirectoryPath;
  let removalAttempts = 0;
  t.after(async () => {
    if (temporaryDirectoryPath) {
      await rm(temporaryDirectoryPath, { recursive: true, force: true });
    }
  });

  const error = await captureRejection(
    prepareAttachments(
      { includeClipboardImage: true, attachmentConsent: true },
      undefined,
      {
        captureClipboardImage: async (outputPath) => {
          temporaryDirectoryPath = path.dirname(outputPath);
          throw new Error("original clipboard capture failure");
        },
        removeTemporaryDirectory: async () => {
          removalAttempts += 1;
          throw new Error("secondary cleanup failure");
        },
      },
    ),
  );

  assert.match(error.message, /original clipboard capture failure/);
  assert.doesNotMatch(error.message, /secondary cleanup failure/);
  assert.equal(removalAttempts, 3);
});
