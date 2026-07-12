import { spawn } from "node:child_process";

export interface AskOptions {
  prompt: string;
  timeoutSeconds: number;
  newConversation: boolean;
}

function executable(): string {
  return process.env.ASK_BRIDGE_PATH?.trim() || "ask-bridge";
}

export function askM365Copilot(options: AskOptions): Promise<string> {
  const args = ["--provider", "copilot", "--timeout", String(options.timeoutSeconds)];
  if (options.newConversation) args.push("--new");
  args.push(options.prompt);

  return new Promise((resolve, reject) => {
    const child = spawn(executable(), args, {
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    child.on("error", (error) => {
      reject(new Error(`Unable to start ask-bridge at '${executable()}': ${error.message}`));
    });
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || stdout.trim() || `ask-bridge exited with code ${code}`));
        return;
      }
      const answer = stdout.trim();
      if (!answer) {
        reject(new Error(stderr.trim() || "ask-bridge returned an empty response"));
        return;
      }
      resolve(answer);
    });
  });
}
