import { spawn } from "node:child_process";
import {
  prepareAttachments,
  type AttachmentDependencies,
  type AttachmentInputs,
} from "./attachments.js";
import {
  createRequestId,
  emitDiagnostic,
  type DiagnosticReporter,
} from "./diagnostics.js";

export interface AskOptions extends AttachmentInputs {
  prompt: string;
  /** Optional visible Microsoft 365 Copilot response mode or model name. */
  model?: string;
  timeoutSeconds: number;
  newConversation: boolean;
  /** Correlates MCP and ask-bridge diagnostics; never derived from prompt text. */
  requestId?: string;
  signal?: AbortSignal;
}

export interface AskBridgeInvocation {
  kind: "version" | "query" | "close" | "login";
  args: string[];
  stdin: string;
  windowsHide: boolean;
  requestId?: string;
}

export interface AskBridgeResult {
  stdout: string;
  stderr: string;
}

export type AskBridgeRunner = (
  invocation: AskBridgeInvocation,
  signal?: AbortSignal,
) => Promise<AskBridgeResult>;

export interface AttachmentCleanupFailure {
  error: unknown;
  attempts: number;
  recovered: boolean;
}

export interface AskBridgeExecutionDependencies {
  /** Test/lifecycle injection; production uses the normal attachment preparer. */
  prepareAttachments?: typeof prepareAttachments;
  /** Receives cleanup failures without changing the tool call's result. */
  onCleanupError?: (failure: AttachmentCleanupFailure) => void | Promise<void>;
  cleanupRetryDelayMs?: number;
  /** Test/lifecycle injection; production writes structured stderr and JSONL diagnostics. */
  onDiagnostic?: DiagnosticReporter;
}

type ReleaseLock = () => void;

interface LockWaiter {
  signal?: AbortSignal;
  resolve: (release: ReleaseLock) => void;
  reject: (error: Error) => void;
  onAbort: () => void;
}

class FifoAsyncMutex {
  private locked = false;
  private readonly waiters: LockWaiter[] = [];

  acquire(signal?: AbortSignal): Promise<ReleaseLock> {
    if (signal?.aborted) return Promise.reject(abortError());

    return new Promise((resolve, reject) => {
      let waiter: LockWaiter;
      const onAbort = () => {
        const index = this.waiters.indexOf(waiter);
        if (index < 0) return;
        this.waiters.splice(index, 1);
        signal?.removeEventListener("abort", onAbort);
        reject(abortError());
        this.dispatch();
      };
      waiter = { signal, resolve, reject, onAbort };
      this.waiters.push(waiter);
      signal?.addEventListener("abort", onAbort, { once: true });

      // AbortSignal does not replay an abort that happened immediately before
      // addEventListener, so close that small race explicitly.
      if (signal?.aborted) onAbort();
      else this.dispatch();
    });
  }

  private dispatch(): void {
    if (this.locked) return;

    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      if (!waiter) return;
      waiter.signal?.removeEventListener("abort", waiter.onAbort);
      if (waiter.signal?.aborted) {
        waiter.reject(abortError());
        continue;
      }

      this.locked = true;
      let released = false;
      waiter.resolve(() => {
        if (released) return;
        released = true;
        this.locked = false;
        this.dispatch();
      });
      return;
    }
  }
}

const copilotRequestMutex = new FifoAsyncMutex();
const verifiedAskBridgeVersions = new WeakMap<AskBridgeRunner, Map<string, string>>();
const MINIMUM_ASK_BRIDGE_VERSION = [0, 3, 10] as const;
const CLEANUP_ATTEMPTS = 3;
const DEFAULT_CLEANUP_RETRY_DELAY_MS = 50;
const PROCESS_CLOSE_GRACE_MS = 1_000;

function executable(): string {
  return process.env.ASK_BRIDGE_PATH?.trim() || "ask-bridge";
}

export function buildCopilotQueryInvocation(options: AskOptions): AskBridgeInvocation {
  const args = ["--provider", "copilot", "--timeout", String(options.timeoutSeconds)];
  if (options.newConversation) args.push("--new");
  if (options.model?.trim()) args.push("--model", options.model.trim());
  for (const imagePath of options.imagePaths ?? []) args.push("--image", imagePath);
  for (const filePath of options.filePaths ?? []) args.push("--file", filePath);

  return {
    kind: "query",
    args,
    // Prompts can contain a complete source file. Passing them as a Windows
    // command-line argument fails around the 32K command-line limit, so stream
    // the prompt through stdin and close the pipe explicitly.
    stdin: options.prompt,
    windowsHide: true,
    requestId: options.requestId,
  };
}

function buildVersionInvocation(requestId?: string): AskBridgeInvocation {
  return {
    kind: "version",
    args: ["--version"],
    stdin: "",
    windowsHide: true,
    requestId,
  };
}

function buildCloseInvocation(requestId?: string): AskBridgeInvocation {
  return {
    kind: "close",
    args: ["--provider", "copilot", "close"],
    stdin: "",
    windowsHide: true,
    requestId,
  };
}

function buildLoginInvocation(timeoutSeconds: number, requestId?: string): AskBridgeInvocation {
  return {
    kind: "login",
    args: ["--provider", "copilot", "--timeout", String(timeoutSeconds), "login"],
    stdin: "",
    // The login subcommand launches headful Chrome. Do not ask Windows to hide
    // the process tree that owns that first interactive login.
    windowsHide: false,
    requestId,
  };
}

function abortError(): Error {
  const error = new Error("Microsoft 365 Copilot request was canceled");
  error.name = "AbortError";
  return error;
}

function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true || (error instanceof Error && error.name === "AbortError");
}

interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease?: string;
  text: string;
}

function parseVersion(value: string): ParsedVersion | undefined {
  const match =
    /\bv?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?\b/.exec(
      value,
    );
  if (!match) return undefined;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4],
    text: match[0],
  };
}

function isSupportedVersion(version: ParsedVersion): boolean {
  const actual = [version.major, version.minor, version.patch];
  for (let index = 0; index < MINIMUM_ASK_BRIDGE_VERSION.length; index += 1) {
    if (actual[index] !== MINIMUM_ASK_BRIDGE_VERSION[index]) {
      return actual[index] > MINIMUM_ASK_BRIDGE_VERSION[index];
    }
  }
  return version.prerelease === undefined;
}

function versionUpgradeGuidance(detail: string): string {
  return `${detail} Upgrade ask-bridge to version 0.3.10 or later, then fully restart VS Code so the MCP server reloads the installed executable.`;
}

async function ensureSupportedAskBridgeVersion(
  runner: AskBridgeRunner,
  requestId?: string,
  signal?: AbortSignal,
): Promise<string> {
  const command = executable();
  const cachedByCommand = verifiedAskBridgeVersions.get(runner);
  const cachedVersion = cachedByCommand?.get(command);
  if (cachedVersion) return cachedVersion;

  let result: AskBridgeResult;
  try {
    result = await runner(buildVersionInvocation(requestId), signal);
  } catch (error) {
    if (isAbortError(error, signal)) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      versionUpgradeGuidance(`Unable to verify the installed ask-bridge version: ${detail}.`),
      { cause: error },
    );
  }

  const output = `${result.stdout}\n${result.stderr}`.trim();
  const version = parseVersion(output);
  if (!version) {
    throw new Error(
      versionUpgradeGuidance(
        `Unable to read a semantic version from 'ask-bridge --version' output${output ? ` (${output})` : ""}.`,
      ),
    );
  }
  if (!isSupportedVersion(version)) {
    throw new Error(
      versionUpgradeGuidance(
        `Installed ask-bridge ${version.text} is too old; ask-bridge-mcp requires ask-bridge 0.3.10 or later.`,
      ),
    );
  }

  const versions = cachedByCommand ?? new Map<string, string>();
  versions.set(command, version.text);
  if (!cachedByCommand) verifiedAskBridgeVersions.set(runner, versions);
  return version.text;
}

function defaultCleanupReporter(failure: AttachmentCleanupFailure): void {
  const detail = failure.error instanceof Error ? failure.error.message : String(failure.error);
  const status = failure.recovered
    ? "initially failed; a later cleanup attempt returned successfully"
    : "failed after all retries";
  process.stderr.write(
    `[ask-bridge-mcp] Attachment cleanup ${status} (${failure.attempts} attempt(s)): ${detail}\n`,
  );
}

async function cleanupAttachmentsBestEffort(
  cleanup: () => Promise<void>,
  dependencies: AskBridgeExecutionDependencies,
): Promise<void> {
  let firstError: unknown;
  let failed = false;
  let recovered = false;
  let attempts = 0;

  for (let attempt = 1; attempt <= CLEANUP_ATTEMPTS; attempt += 1) {
    attempts = attempt;
    try {
      await cleanup();
      recovered = failed;
      break;
    } catch (error) {
      if (!failed) firstError = error;
      failed = true;
      if (attempt < CLEANUP_ATTEMPTS) {
        const delayMs =
          dependencies.cleanupRetryDelayMs ?? DEFAULT_CLEANUP_RETRY_DELAY_MS;
        if (delayMs > 0) {
          await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
        }
      }
    }
  }

  if (!failed) return;
  try {
    const reporter = dependencies.onCleanupError ?? defaultCleanupReporter;
    await reporter({ error: firstError, attempts, recovered });
  } catch {
    // Reporting is also best-effort: it must never replace a successful answer
    // or the original query failure.
  }
}

class AskBridgeProcessError extends Error {
  constructor(
    message: string,
    readonly stdout: string,
    readonly stderr: string,
    readonly exitCode: number | null,
  ) {
    super(message);
    this.name = "AskBridgeProcessError";
  }
}

async function runAskBridge(
  invocation: AskBridgeInvocation,
  signal?: AbortSignal,
): Promise<AskBridgeResult> {
  if (signal?.aborted) throw abortError();

  return new Promise((resolve, reject) => {
    const command = executable();
    const requestId = invocation.requestId ?? createRequestId();
    const startedAt = Date.now();
    emitDiagnostic(requestId, "process_started", {
      kind: invocation.kind,
      argument_count: invocation.args.length,
      stdin_character_count: Array.from(invocation.stdin).length,
      stdin_line_break_count: (invocation.stdin.match(/\r\n|\r|\n/g) ?? []).length,
    });
    const child = spawn(command, invocation.args, {
      windowsHide: invocation.windowsHide,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ASK_BRIDGE_REQUEST_ID: requestId },
    });

    let stdout = "";
    let stderr = "";
    let stdinError: Error | undefined;
    let settled = false;
    let canceled = false;
    let exitCode: number | null | undefined;
    let closeGraceTimer: NodeJS.Timeout | undefined;

    const cleanup = () => {
      signal?.removeEventListener("abort", onAbort);
      if (closeGraceTimer) clearTimeout(closeGraceTimer);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onAbort = () => {
      canceled = true;
      child.kill();
    };

    signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    child.stdin.on("error", (error: Error) => {
      // A failed child often closes stdin before it exits. Preserve that error
      // only when the process would otherwise look successful.
      stdinError = error;
    });
    child.once("error", (error) => {
      emitDiagnostic(requestId, "process_start_failed", {
        kind: invocation.kind,
        duration_ms: Date.now() - startedAt,
        error_name: error.name,
      });
      fail(
        canceled || signal?.aborted
          ? abortError()
          : new Error(`Unable to start ask-bridge at '${command}': ${error.message}`),
      );
    });
    const complete = (code: number | null, completionSignal: "close" | "exit_grace_timeout") => {
      if (settled) return;
      settled = true;
      cleanup();

      emitDiagnostic(requestId, "process_exited", {
        kind: invocation.kind,
        duration_ms: Date.now() - startedAt,
        exit_code: code,
        canceled: canceled || signal?.aborted === true,
        stdout_character_count: Array.from(stdout).length,
        stderr_character_count: Array.from(stderr).length,
        completion_signal: completionSignal,
      });

      if (canceled || signal?.aborted) {
        reject(abortError());
        return;
      }
      if (code !== 0) {
        const message = stderr.trim() || stdout.trim() || `ask-bridge exited with code ${code}`;
        reject(new AskBridgeProcessError(message, stdout, stderr, code));
        return;
      }
      if (stdinError) {
        reject(
          new AskBridgeProcessError(
            `Failed to stream the prompt to ask-bridge: ${stdinError.message}`,
            stdout,
            stderr,
            code,
          ),
        );
        return;
      }
      resolve({ stdout, stderr });
    };

    child.once("exit", (code) => {
      exitCode = code;
      // A detached browser may outlive ask-bridge and accidentally retain one
      // of its inherited stdio handles. Prefer the normal `close` event so all
      // output is drained, but never let that descendant block VS Code forever
      // after the actual CLI process has already exited.
      closeGraceTimer = setTimeout(
        () => complete(code, "exit_grace_timeout"),
        PROCESS_CLOSE_GRACE_MS,
      );
      closeGraceTimer.unref();
    });
    child.once("close", (code) => {
      complete(code ?? exitCode ?? null, "close");
    });

    child.stdin.end(invocation.stdin, "utf8");
  });
}

export function requiresInteractiveLogin(error: unknown): boolean {
  const text =
    error instanceof AskBridgeProcessError
      ? `${error.stderr}\n${error.stdout}\n${error.message}`
      : error instanceof Error
        ? error.message
        : String(error);

  return (
    /You are not logged in to Microsoft 365 Copilot/i.test(text) ||
    /ask-bridge\s+--provider\s+copilot\s+login/i.test(text)
  );
}

function answerFrom(result: AskBridgeResult): string {
  const answer = result.stdout.trim();
  if (!answer) {
    throw new AskBridgeProcessError(
      result.stderr.trim() || "ask-bridge returned an empty response",
      result.stdout,
      result.stderr,
      0,
    );
  }
  return answer;
}

export async function askM365CopilotWithRunner(
  options: AskOptions,
  runner: AskBridgeRunner,
  attachmentDependencies: AttachmentDependencies = {},
  executionDependencies: AskBridgeExecutionDependencies = {},
): Promise<string> {
  const requestId = options.requestId ?? createRequestId();
  const startedAt = Date.now();
  const diagnostic =
    executionDependencies.onDiagnostic ??
    ((event: string, details: Record<string, unknown>) =>
      emitDiagnostic(requestId, event, details));
  const report = (event: string, details: Record<string, unknown>) => {
    try {
      diagnostic(event, details);
    } catch {
      // Diagnostics are deliberately best-effort.
    }
  };
  let stage = "queue";
  let release: ReleaseLock | undefined;

  report("request_queued", {
    prompt_character_count: Array.from(options.prompt).length,
    prompt_line_break_count: (options.prompt.match(/\r\n|\r|\n/g) ?? []).length,
    timeout_seconds: options.timeoutSeconds,
    new_conversation: options.newConversation,
    requested_attachment_count:
      (options.imagePaths?.length ?? 0) +
      (options.filePaths?.length ?? 0) +
      (options.inlineImages?.length ?? 0) +
      Number(options.includeClipboardImage === true),
  });

  try {
    release = await copilotRequestMutex.acquire(options.signal);
    report("request_started", { queue_duration_ms: Date.now() - startedAt });

    stage = "version_check";
    const version = await ensureSupportedAskBridgeVersion(runner, requestId, options.signal);
    report("version_verified", { ask_bridge_version: version });

    stage = "attachment_preparation";
    const prepare = executionDependencies.prepareAttachments ?? prepareAttachments;
    const attachments = await prepare(options, options.signal, attachmentDependencies);
    report("attachments_prepared", {
      image_count: attachments.imagePaths.length,
      file_count: attachments.filePaths.length,
    });

    try {
      const preparedOptions: AskOptions = {
        ...options,
        requestId,
        imagePaths: attachments.imagePaths,
        filePaths: attachments.filePaths,
        inlineImages: [],
        includeClipboardImage: false,
      };
      const query = () =>
        runner(buildCopilotQueryInvocation(preparedOptions), options.signal).then(answerFrom);

      let answer: string;
      stage = "query";
      try {
        answer = await query();
      } catch (error) {
        if (!requiresInteractiveLogin(error)) throw error;
        report("interactive_login_required", {});

        // A normal query intentionally starts ask-bridge in background mode. If that
        // fresh profile is logged out, stop only the managed instance and relaunch
        // the dedicated login command so Chrome is visible to the user. Once login
        // completes, retry the original prompt and attachments automatically.
        stage = "interactive_login";
        await runner(buildCloseInvocation(requestId), options.signal);
        await runner(buildLoginInvocation(options.timeoutSeconds, requestId), options.signal);
        report("interactive_login_completed", {});

        stage = "query_retry";
        try {
          answer = await query();
        } catch (retryError) {
          if (requiresInteractiveLogin(retryError)) {
            throw new Error(
              "Microsoft 365 Copilot sign-in was not completed. Finish signing in in the ask-bridge Chrome window, then retry the tool call.",
              { cause: retryError },
            );
          }
          throw retryError;
        }
      }

      stage = "completed";
      report("request_succeeded", {
        duration_ms: Date.now() - startedAt,
        response_character_count: Array.from(answer).length,
      });
      return answer;
    } finally {
      await cleanupAttachmentsBestEffort(attachments.cleanup, executionDependencies);
    }
  } catch (error) {
    report(options.signal?.aborted ? "request_canceled" : "request_failed", {
      stage,
      duration_ms: Date.now() - startedAt,
      error_name: error instanceof Error ? error.name : "UnknownError",
    });
    throw error;
  } finally {
    release?.();
    report("request_finished", {
      duration_ms: Date.now() - startedAt,
      lock_released: release !== undefined,
    });
  }
}

export function askM365Copilot(options: AskOptions): Promise<string> {
  return askM365CopilotWithRunner(options, runAskBridge);
}
