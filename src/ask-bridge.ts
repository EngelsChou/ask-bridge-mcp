import { spawn } from "node:child_process";

export interface AskOptions {
  prompt: string;
  timeoutSeconds: number;
  newConversation: boolean;
  signal?: AbortSignal;
}

export interface AskBridgeInvocation {
  kind: "query" | "close" | "login";
  args: string[];
  stdin: string;
  windowsHide: boolean;
}

export interface AskBridgeResult {
  stdout: string;
  stderr: string;
}

export type AskBridgeRunner = (
  invocation: AskBridgeInvocation,
  signal?: AbortSignal,
) => Promise<AskBridgeResult>;

function executable(): string {
  return process.env.ASK_BRIDGE_PATH?.trim() || "ask-bridge";
}

export function buildCopilotQueryInvocation(options: AskOptions): AskBridgeInvocation {
  const args = ["--provider", "copilot", "--timeout", String(options.timeoutSeconds)];
  if (options.newConversation) args.push("--new");

  return {
    kind: "query",
    args,
    // Prompts can contain a complete source file. Passing them as a Windows
    // command-line argument fails around the 32K command-line limit, so stream
    // the prompt through stdin and close the pipe explicitly.
    stdin: options.prompt,
    windowsHide: true,
  };
}

function buildCloseInvocation(): AskBridgeInvocation {
  return {
    kind: "close",
    args: ["--provider", "copilot", "close"],
    stdin: "",
    windowsHide: true,
  };
}

function buildLoginInvocation(timeoutSeconds: number): AskBridgeInvocation {
  return {
    kind: "login",
    args: ["--provider", "copilot", "--timeout", String(timeoutSeconds), "login"],
    stdin: "",
    // The login subcommand launches headful Chrome. Do not ask Windows to hide
    // the process tree that owns that first interactive login.
    windowsHide: false,
  };
}

function abortError(): Error {
  const error = new Error("Microsoft 365 Copilot request was canceled");
  error.name = "AbortError";
  return error;
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
    const child = spawn(command, invocation.args, {
      windowsHide: invocation.windowsHide,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let stdinError: Error | undefined;
    let settled = false;

    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onAbort = () => {
      child.kill();
      fail(abortError());
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
      fail(new Error(`Unable to start ask-bridge at '${command}': ${error.message}`));
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      cleanup();

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
): Promise<string> {
  const query = () => runner(buildCopilotQueryInvocation(options), options.signal).then(answerFrom);

  try {
    return await query();
  } catch (error) {
    if (!requiresInteractiveLogin(error)) throw error;
  }

  // A normal query intentionally starts ask-bridge in background mode. If that
  // fresh profile is logged out, stop only the managed instance and relaunch
  // the dedicated login command so Chrome is visible to the user. Once login
  // completes, retry the original prompt automatically.
  await runner(buildCloseInvocation(), options.signal);
  await runner(buildLoginInvocation(options.timeoutSeconds), options.signal);

  try {
    return await query();
  } catch (error) {
    if (requiresInteractiveLogin(error)) {
      throw new Error(
        "Microsoft 365 Copilot sign-in was not completed. Finish signing in in the ask-bridge Chrome window, then retry the tool call.",
        { cause: error },
      );
    }
    throw error;
  }
}

export function askM365Copilot(options: AskOptions): Promise<string> {
  return askM365CopilotWithRunner(options, runAskBridge);
}
