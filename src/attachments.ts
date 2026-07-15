import { spawn } from "node:child_process";
import { lstat, mkdtemp, open, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export const MAX_ATTACHMENTS = 10;
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const MAX_TOTAL_ATTACHMENT_BYTES = 50 * 1024 * 1024;

const MAX_BASE64_CHARACTERS = Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4 + 16;
const CLIPBOARD_TIMEOUT_MS = 15_000;

const SENSITIVE_PATH_SEGMENTS = new Set([
  ".git",
  ".ssh",
  ".gnupg",
  ".aws",
  ".azure",
  ".kube",
  ".docker",
]);
const SENSITIVE_FILENAMES = new Set([
  ".envrc",
  ".npmrc",
  ".pypirc",
  ".netrc",
  "_netrc",
  ".git-credentials",
  "credentials",
  "credentials.json",
  "credentials.db",
  "credentials.sqlite",
  "secrets.json",
  "secrets.yaml",
  "secrets.yml",
  "client_secret.json",
  "client-secrets.json",
  "service-account.json",
  "service_account.json",
  "application_default_credentials.json",
  "azureprofile.json",
  "accesstokens.json",
  "known_hosts",
  "authorized_keys",
]);
const SENSITIVE_EXTENSIONS = new Set([
  ".pem",
  ".key",
  ".pfx",
  ".p12",
  ".jks",
  ".keystore",
  ".ppk",
  ".kdbx",
]);

const IMAGE_MIME_EXTENSIONS: Readonly<Record<string, string>> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/bmp": ".bmp",
  "image/tiff": ".tiff",
};

export interface InlineImageInput {
  /** Raw base64 or a data:image/...;base64,... URI. */
  data: string;
  /** Display filename used by Microsoft 365 Copilot. */
  name?: string;
  /** Required for raw base64 when it is not a PNG. */
  mimeType?: string;
}

export interface AttachmentInputs {
  imagePaths?: string[];
  filePaths?: string[];
  inlineImages?: InlineImageInput[];
  includeClipboardImage?: boolean;
  /** Explicit user consent to transmit the requested attachments to Microsoft 365. */
  attachmentConsent?: boolean;
}

export interface PreparedAttachments {
  imagePaths: string[];
  filePaths: string[];
  cleanup(): Promise<void>;
}

export interface AttachmentDependencies {
  captureClipboardImage?: (outputPath: string, signal?: AbortSignal) => Promise<void>;
  removeTemporaryDirectory?: (directory: string) => Promise<void>;
}

interface DecodedInlineImage {
  bytes: Buffer;
  mimeType: string;
  name: string;
}

interface CanonicalAllowedRoot {
  comparisonPath: string;
}

function abortError(): Error {
  const error = new Error("Microsoft 365 Copilot request was canceled");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

function formatBytes(bytes: number): string {
  return `${Math.ceil(bytes / (1024 * 1024))} MiB`;
}

function comparisonPath(value: string): string {
  const normalized = path.normalize(value);
  const root = path.parse(normalized).root;
  const withoutTrailingSeparators =
    normalized === root ? normalized : normalized.replace(/[\\/]+$/g, "");
  return process.platform === "win32"
    ? withoutTrailingSeparators.toLocaleLowerCase("en-US")
    : withoutTrailingSeparators;
}

function isWithinRoot(candidate: string, root: CanonicalAllowedRoot): boolean {
  const relative = path.relative(root.comparisonPath, comparisonPath(candidate));
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

function isSensitivePath(value: string): boolean {
  const segments = path.resolve(value).split(/[\\/]+/).filter(Boolean);
  if (segments.some((segment) => SENSITIVE_PATH_SEGMENTS.has(segment.toLowerCase()))) {
    return true;
  }

  const filename = (segments.at(-1) ?? "").toLowerCase();
  return (
    filename === ".env" ||
    filename.startsWith(".env.") ||
    /^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?$/.test(filename) ||
    SENSITIVE_FILENAMES.has(filename) ||
    SENSITIVE_EXTENSIONS.has(path.extname(filename))
  );
}

async function resolveAllowedRoots(signal?: AbortSignal): Promise<CanonicalAllowedRoot[]> {
  const configured = process.env.ASK_BRIDGE_ALLOWED_ROOTS;
  const values = configured
    ?.split(path.delimiter)
    .map((value) => value.trim())
    .filter(Boolean);

  if (!values?.length) {
    throw new Error(
      "Path attachments are disabled because ASK_BRIDGE_ALLOWED_ROOTS is not configured.",
    );
  }

  const roots: CanonicalAllowedRoot[] = [];
  for (const value of values) {
    throwIfAborted(signal);
    if (!path.isAbsolute(value)) {
      throw new Error("ASK_BRIDGE_ALLOWED_ROOTS must contain only absolute directory paths.");
    }

    let canonicalPath: string;
    try {
      canonicalPath = await realpath(value);
      const info = await stat(canonicalPath);
      if (!info.isDirectory()) {
        throw new Error("not a directory");
      }
    } catch {
      throw new Error("ASK_BRIDGE_ALLOWED_ROOTS contains an inaccessible or invalid directory.");
    }

    const canonicalRoot = {
      comparisonPath: comparisonPath(canonicalPath),
    };
    if (!roots.some((root) => root.comparisonPath === canonicalRoot.comparisonPath)) {
      roots.push(canonicalRoot);
    }
  }
  return roots;
}

function isWindowsReservedName(value: string): boolean {
  const stem = value.split(".", 1)[0]?.toUpperCase() ?? "";
  return /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(stem);
}

function safeFilename(value: string, fallback: string): string {
  const basename = path.basename(value.trim())
    .replace(/[\u0000-\u001f<>:"/\\|?*]/g, "_")
    .replace(/[. ]+$/g, "")
    .slice(0, 180);

  if (!basename || basename === "." || basename === ".." || isWindowsReservedName(basename)) {
    return fallback;
  }
  return basename;
}

function normalizedMimeType(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (!/^image\/[a-z0-9.+-]+$/.test(normalized)) {
    throw new Error(`Unsupported inline image MIME type '${value}'.`);
  }
  if (!(normalized in IMAGE_MIME_EXTENSIONS)) {
    throw new Error(
      `Unsupported inline image MIME type '${value}'. Supported types: ${Object.keys(IMAGE_MIME_EXTENSIONS).join(", ")}.`,
    );
  }
  return normalized;
}

function strictBase64Decode(value: string, label: string): Buffer {
  const compact = value.replace(/[\t\n\r ]/g, "");
  if (!compact || compact.length > MAX_BASE64_CHARACTERS) {
    if (compact.length > MAX_BASE64_CHARACTERS) {
      throw new Error(
        `${label} exceeds the ${formatBytes(MAX_ATTACHMENT_BYTES)} decoded-size limit.`,
      );
    }
    throw new Error(`${label} is empty.`);
  }
  if (compact.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(compact)) {
    throw new Error(`${label} is not valid base64 data.`);
  }

  const padding = compact.endsWith("==") ? 2 : compact.endsWith("=") ? 1 : 0;
  const decodedSize = (compact.length / 4) * 3 - padding;
  if (decodedSize > MAX_ATTACHMENT_BYTES) {
    throw new Error(`${label} exceeds the ${formatBytes(MAX_ATTACHMENT_BYTES)} decoded-size limit.`);
  }

  const bytes = Buffer.from(compact, "base64");
  if (bytes.length !== decodedSize) {
    throw new Error(`${label} is not valid base64 data.`);
  }
  return bytes;
}

function imageSignatureMatches(bytes: Buffer, mimeType: string): boolean {
  if (mimeType === "image/png") {
    return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"));
  }
  if (mimeType === "image/jpeg") {
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  if (mimeType === "image/gif") {
    return bytes.length >= 6 && ["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"));
  }
  if (mimeType === "image/tiff") {
    return (
      bytes.length >= 4 &&
      (bytes.subarray(0, 4).equals(Buffer.from("49492a00", "hex")) ||
        bytes.subarray(0, 4).equals(Buffer.from("4d4d002a", "hex")) ||
        bytes.subarray(0, 4).equals(Buffer.from("49492b00", "hex")) ||
        bytes.subarray(0, 4).equals(Buffer.from("4d4d002b", "hex")))
    );
  }
  if (mimeType === "image/bmp") {
    return bytes.length >= 2 && bytes.subarray(0, 2).toString("ascii") === "BM";
  }
  return false;
}

function decodeInlineImage(input: InlineImageInput, index: number): DecodedInlineImage {
  const label = `inlineImages[${index}].data`;
  const dataUriMatch = /^data:([^;,]+)(?:;[^,]*)?;base64,([\s\S]*)$/i.exec(input.data.trim());
  const uriMimeType = dataUriMatch ? normalizedMimeType(dataUriMatch[1]) : undefined;
  const explicitMimeType = normalizedMimeType(input.mimeType);
  if (uriMimeType && explicitMimeType && uriMimeType !== explicitMimeType) {
    throw new Error(
      `inlineImages[${index}] MIME type mismatch: data URI is '${uriMimeType}' but mimeType is '${explicitMimeType}'.`,
    );
  }

  const mimeType = uriMimeType ?? explicitMimeType ?? "image/png";
  const base64 = dataUriMatch ? dataUriMatch[2] : input.data;
  const bytes = strictBase64Decode(base64, label);
  if (!imageSignatureMatches(bytes, mimeType)) {
    throw new Error(`inlineImages[${index}] content does not match MIME type '${mimeType}'.`);
  }

  const extension = IMAGE_MIME_EXTENSIONS[mimeType];
  const requestedName = input.name ?? `inline-image-${index + 1}${extension}`;
  let name = safeFilename(requestedName, `inline-image-${index + 1}${extension}`);
  const requestedExtension = path.extname(name).toLowerCase();
  const extensionMatches =
    requestedExtension === extension ||
    (mimeType === "image/jpeg" && requestedExtension === ".jpeg") ||
    (mimeType === "image/tiff" && requestedExtension === ".tif");
  if (!extensionMatches) {
    name = `${path.basename(name, requestedExtension) || `inline-image-${index + 1}`}${extension}`;
  }
  return { bytes, mimeType, name };
}

async function validateLocalFile(
  value: string,
  label: string,
  allowedRoots: CanonicalAllowedRoot[] | undefined,
  signal?: AbortSignal,
): Promise<{ path: string; size: number }> {
  throwIfAborted(signal);
  if (!path.isAbsolute(value)) {
    throw new Error(`${label} must be an absolute local path.`);
  }
  if (allowedRoots && isSensitivePath(value)) {
    throw new Error(`${label} is blocked by the sensitive-file policy.`);
  }

  let info;
  try {
    info = await lstat(value);
  } catch {
    throw new Error(`${label} could not be read.`);
  }
  throwIfAborted(signal);
  if (!info.isFile()) {
    throw new Error(`${label} must point to a regular file (directories and symbolic links are not allowed).`);
  }

  let canonicalPath: string;
  try {
    canonicalPath = await realpath(value);
  } catch {
    throw new Error(`${label} could not be canonicalized.`);
  }
  if (allowedRoots) {
    if (isSensitivePath(canonicalPath)) {
      throw new Error(`${label} is blocked by the sensitive-file policy.`);
    }
    if (!allowedRoots.some((root) => isWithinRoot(canonicalPath, root))) {
      throw new Error(`${label} is outside ASK_BRIDGE_ALLOWED_ROOTS.`);
    }
  }

  try {
    info = await lstat(canonicalPath);
  } catch {
    throw new Error(`${label} could not be read after canonicalization.`);
  }
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error(`${label} must point to a regular file (symbolic links are not allowed).`);
  }
  if (info.size <= 0) throw new Error(`${label} is empty.`);
  if (info.size > MAX_ATTACHMENT_BYTES) {
    throw new Error(`${label} exceeds the ${formatBytes(MAX_ATTACHMENT_BYTES)} per-file limit.`);
  }

  try {
    const handle = await open(canonicalPath, "r");
    await handle.close();
  } catch {
    throw new Error(`${label} is not readable.`);
  }
  return { path: canonicalPath, size: info.size };
}

function clipboardScript(): string {
  return `
param([Parameter(Mandatory = $true)][string]$OutputPath)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
if (-not [System.Windows.Forms.Clipboard]::ContainsImage()) {
  [Console]::Error.WriteLine('ASK_BRIDGE_CLIPBOARD_EMPTY')
  exit 4
}
$image = [System.Windows.Forms.Clipboard]::GetImage()
if ($null -eq $image) {
  [Console]::Error.WriteLine('ASK_BRIDGE_CLIPBOARD_EMPTY')
  exit 4
}
try {
  $image.Save($OutputPath, [System.Drawing.Imaging.ImageFormat]::Png)
} finally {
  $image.Dispose()
}
`;
}

export async function captureWindowsClipboardImage(
  outputPath: string,
  signal?: AbortSignal,
): Promise<void> {
  if (process.platform !== "win32") {
    throw new Error("includeClipboardImage is supported only on Windows.");
  }
  throwIfAborted(signal);

  const scriptPath = path.join(path.dirname(outputPath), "capture-clipboard.ps1");
  await writeFile(scriptPath, clipboardScript(), { encoding: "utf8", mode: 0o600, signal });

  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-STA",
        "-WindowStyle",
        "Hidden",
        "-File",
        scriptPath,
        "-OutputPath",
        outputPath,
      ],
      { windowsHide: true, shell: false, stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    let settled = false;
    let aborted = false;
    let timedOut = false;

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve();
    };
    const onAbort = () => {
      aborted = true;
      child.kill();
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, CLIPBOARD_TIMEOUT_MS);

    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < 16_384) stderr += chunk;
    });
    child.once("error", (error) => {
      finish(new Error(`Unable to start Windows PowerShell for clipboard capture: ${error.message}`));
    });
    child.once("close", (code) => {
      if (aborted || signal?.aborted) {
        finish(abortError());
        return;
      }
      if (timedOut) {
        finish(new Error("Timed out while reading the Windows clipboard image."));
        return;
      }
      if (code === 0) {
        finish();
        return;
      }
      if (code === 4 || stderr.includes("ASK_BRIDGE_CLIPBOARD_EMPTY")) {
        finish(
          new Error(
            "The Windows clipboard does not contain an image. Copy the screenshot again, then retry with includeClipboardImage=true.",
          ),
        );
        return;
      }
      finish(
        new Error(
          `Failed to capture the Windows clipboard image (PowerShell exit code ${code ?? "unknown"}).`,
        ),
      );
    });
  });
}

async function cleanupAfterPreparationFailure(cleanup: () => Promise<void>): Promise<void> {
  const attempts = 3;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await cleanup();
      return;
    } catch {
      // Temporary files should not replace the original validation or capture
      // error. Retry transient Windows locks, then report without echoing paths.
    }
  }
  process.stderr.write(
    "[ask-bridge-mcp] Failed to remove a temporary attachment directory after preparation failed.\n",
  );
}

export async function prepareAttachments(
  inputs: AttachmentInputs,
  signal?: AbortSignal,
  dependencies: AttachmentDependencies = {},
): Promise<PreparedAttachments> {
  const imageInputs = inputs.imagePaths ?? [];
  const fileInputs = inputs.filePaths ?? [];
  const inlineInputs = inputs.inlineImages ?? [];
  const requestedCount =
    imageInputs.length + fileInputs.length + inlineInputs.length + (inputs.includeClipboardImage ? 1 : 0);

  if (requestedCount > MAX_ATTACHMENTS) {
    throw new Error(`Too many attachments (${requestedCount}); the maximum is ${MAX_ATTACHMENTS}.`);
  }
  if (requestedCount > 0 && inputs.attachmentConsent !== true) {
    throw new Error(
      "attachmentConsent=true is required because this request would transmit attachments to Microsoft 365 Copilot.",
    );
  }
  throwIfAborted(signal);

  const allowedRoots =
    imageInputs.length + fileInputs.length > 0 ? await resolveAllowedRoots(signal) : undefined;

  let tempDirectory: string | undefined;
  let totalBytes = 0;
  let cleaned = false;
  const preparedImages: string[] = [];
  const preparedFiles: string[] = [];

  const ensureTempDirectory = async (): Promise<string> => {
    if (!tempDirectory) {
      tempDirectory = await mkdtemp(path.join(tmpdir(), "ask-bridge-mcp-"));
    }
    return tempDirectory;
  };
  const addSize = (size: number, label: string) => {
    totalBytes += size;
    if (totalBytes > MAX_TOTAL_ATTACHMENT_BYTES) {
      throw new Error(
        `${label} makes the attachment total exceed ${formatBytes(MAX_TOTAL_ATTACHMENT_BYTES)}.`,
      );
    }
  };
  const cleanup = async () => {
    if (cleaned) return;
    if (tempDirectory) {
      const remove =
        dependencies.removeTemporaryDirectory ??
        ((directory: string) =>
          rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
      await remove(tempDirectory);
    }
    cleaned = true;
  };

  try {
    for (let index = 0; index < imageInputs.length; index += 1) {
      const validated = await validateLocalFile(
        imageInputs[index],
        `imagePaths[${index}]`,
        allowedRoots,
        signal,
      );
      addSize(validated.size, `imagePaths[${index}]`);
      preparedImages.push(validated.path);
    }
    for (let index = 0; index < fileInputs.length; index += 1) {
      const validated = await validateLocalFile(
        fileInputs[index],
        `filePaths[${index}]`,
        allowedRoots,
        signal,
      );
      addSize(validated.size, `filePaths[${index}]`);
      preparedFiles.push(validated.path);
    }

    for (let index = 0; index < inlineInputs.length; index += 1) {
      throwIfAborted(signal);
      const decoded = decodeInlineImage(inlineInputs[index], index);
      addSize(decoded.bytes.length, `inlineImages[${index}]`);
      const directory = await ensureTempDirectory();
      const outputPath = path.join(directory, `${String(index + 1).padStart(2, "0")}-${decoded.name}`);
      await writeFile(outputPath, decoded.bytes, { mode: 0o600, signal });
      preparedImages.push(outputPath);
    }

    if (inputs.includeClipboardImage) {
      throwIfAborted(signal);
      const directory = await ensureTempDirectory();
      const outputPath = path.join(directory, "clipboard.png");
      const capture = dependencies.captureClipboardImage ?? captureWindowsClipboardImage;
      await capture(outputPath, signal);
      const captured = await validateLocalFile(
        outputPath,
        "Windows clipboard image",
        undefined,
        signal,
      );
      addSize(captured.size, "Windows clipboard image");
      preparedImages.push(outputPath);
    }

    return { imagePaths: preparedImages, filePaths: preparedFiles, cleanup };
  } catch (error) {
    await cleanupAfterPreparationFailure(cleanup);
    throw error;
  }
}
