import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const stageDir = path.join(repoRoot, "release", "stage");
const nodeExe = process.argv[2] ?? path.join(stageDir, "runtime", "node.exe");
const entry = process.argv[3] ?? path.join(stageDir, "app", "dist", "index.js");

await access(nodeExe);
await access(entry);

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
  console.log("Packaged MCP server smoke test passed.");
} finally {
  await client.close();
}
