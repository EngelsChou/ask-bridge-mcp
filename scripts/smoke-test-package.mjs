import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const stageDir = path.join(repoRoot, "release", "stage");
const nodeExe = process.argv[2] ?? path.join(stageDir, "runtime", "node.exe");
const entry = process.argv[3] ?? path.join(stageDir, "app", "dist", "index.js");
const advisorExample = path.join(stageDir, "examples", "m365-advisor.agent.md");
const coordinatorExample = path.join(stageDir, "examples", "m365-coordinator.agent.md");
const vscodeMcpConfig = path.join(stageDir, "vscode-mcp.json");

await access(nodeExe);
await access(entry);
await access(advisorExample);
await access(coordinatorExample);
await access(vscodeMcpConfig);

const mcpConfig = JSON.parse(await readFile(vscodeMcpConfig, "utf8"));
assert.equal(
  mcpConfig?.servers?.m365Copilot?.env?.ASK_BRIDGE_ALLOWED_ROOTS,
  "${workspaceFolder}",
  "Packaged vscode-mcp.json must preserve ${workspaceFolder} as the default attachment root",
);

const transport = new StdioClientTransport({
  command: nodeExe,
  args: [entry],
  stderr: "pipe",
});
const client = new Client({ name: "ask-bridge-mcp-package-test", version: "1.0.0" });

try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  assert.ok(
    tools.some((tool) => tool.name === "ask_m365_copilot"),
    "Packaged MCP server did not expose ask_m365_copilot",
  );
  const tool = tools.find((candidate) => candidate.name === "ask_m365_copilot");
  for (const property of [
    "prompt",
    "model",
    "imagePaths",
    "filePaths",
    "inlineImages",
    "includeClipboardImage",
    "attachmentConsent",
  ]) {
    assert.ok(
      tool?.inputSchema?.properties?.[property],
      `Packaged ask_m365_copilot schema is missing ${property}`,
    );
  }
  console.log("Packaged MCP server smoke test passed.");
} finally {
  await client.close();
}
