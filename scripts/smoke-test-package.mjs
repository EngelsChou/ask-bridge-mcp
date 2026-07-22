import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const stageDir = path.join(repoRoot, "release", "stage");
const execFileAsync = promisify(execFile);
const nodeExe = process.argv[2] ?? path.join(stageDir, "runtime", "node.exe");
const entry = process.argv[3] ?? path.join(stageDir, "app", "dist", "index.js");
const askBridgeExe = path.join(stageDir, "bridge", "ask-bridge.exe");
const askBridgeUpdaterExe = path.join(stageDir, "bridge", "ask-bridge-update.exe");
const bundledNpx = path.join(stageDir, "runtime", "npx.cmd");
const chromeDevtoolsMcpPackage = path.join(
  stageDir,
  "app",
  "node_modules",
  "chrome-devtools-mcp",
  "package.json",
);
const componentsManifest = path.join(stageDir, "components.json");
const advisorExample = path.join(stageDir, "examples", "m365-advisor.agent.md");
const coordinatorExample = path.join(stageDir, "examples", "m365-coordinator.agent.md");
const vscodeMcpConfig = path.join(stageDir, "vscode-mcp.json");

await access(nodeExe);
await access(entry);
await access(askBridgeExe);
await access(askBridgeUpdaterExe);
await access(bundledNpx);
await access(chromeDevtoolsMcpPackage);
await access(componentsManifest);
await access(advisorExample);
await access(coordinatorExample);
await access(vscodeMcpConfig);

const mcpConfig = JSON.parse(await readFile(vscodeMcpConfig, "utf8"));
assert.equal(
  mcpConfig?.servers?.m365Copilot?.env?.ASK_BRIDGE_PATH,
  "${env:LOCALAPPDATA}\\Programs\\ask-bridge-mcp\\bridge\\ask-bridge.exe",
  "Packaged vscode-mcp.json must use the bundled ask-bridge executable",
);
assert.equal(
  mcpConfig?.servers?.m365Copilot?.env?.ASK_BRIDGE_ALLOWED_ROOTS,
  "${workspaceFolder}",
  "Packaged vscode-mcp.json must preserve ${workspaceFolder} as the default attachment root",
);

const components = JSON.parse(await readFile(componentsManifest, "utf8"));
const chromeDevtoolsPackage = JSON.parse(await readFile(chromeDevtoolsMcpPackage, "utf8"));
assert.equal(components.askBridge.version, "0.3.10");
assert.equal(components.chromeDevtoolsMcp.version, "1.5.0");
assert.equal(chromeDevtoolsPackage.version, components.chromeDevtoolsMcp.version);
const { stdout: askBridgeVersionOutput } = await execFileAsync(askBridgeExe, ["--version"], {
  windowsHide: true,
});
assert.match(askBridgeVersionOutput, /\b0\.3\.10\b/);

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
