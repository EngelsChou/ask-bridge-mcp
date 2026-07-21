import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const MAX_LOG_BYTES = 2 * 1024 * 1024;

export type DiagnosticDetails = Record<string, unknown>;
export type DiagnosticReporter = (event: string, details: DiagnosticDetails) => void;

export function createRequestId(): string {
  return `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
}

export function diagnosticRecord(
  requestId: string,
  event: string,
  details: DiagnosticDetails,
  timestampUnixMs = Date.now(),
  processId = process.pid,
): Record<string, unknown> {
  return {
    timestamp_unix_ms: timestampUnixMs,
    process_id: processId,
    request_id: requestId,
    event,
    details,
  };
}

function diagnosticPath(): string | undefined {
  const configured = process.env.ASK_BRIDGE_MCP_DIAGNOSTICS_PATH?.trim();
  if (configured?.toLowerCase() === "off") return undefined;
  if (configured) return path.resolve(configured);
  return path.join(homedir(), ".config", "ask-bridge", "mcp-diagnostics.jsonl");
}

function appendDiagnosticFile(line: string): void {
  const filePath = diagnosticPath();
  if (!filePath) return;

  try {
    const directory = path.dirname(filePath);
    mkdirSync(directory, { recursive: true });
    if (existsSync(filePath) && statSync(filePath).size >= MAX_LOG_BYTES) {
      const previousPath = `${filePath}.previous`;
      rmSync(previousPath, { force: true });
      renameSync(filePath, previousPath);
    }
    appendFileSync(filePath, `${line}\n`, "utf8");
  } catch {
    // Diagnostic I/O must never replace the M365 result or failure.
  }
}

export function emitDiagnostic(
  requestId: string,
  event: string,
  details: DiagnosticDetails,
): void {
  const line = JSON.stringify(diagnosticRecord(requestId, event, details));
  process.stderr.write(`[ask-bridge-mcp] ${line}\n`);
  appendDiagnosticFile(line);
}
