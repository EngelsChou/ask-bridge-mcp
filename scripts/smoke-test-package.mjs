import assert from "node:assert/strict";
import { exec, execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const stageDir = path.join(repoRoot, "release", "stage");
const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);
const nodeExe = process.argv[2] ?? path.join(stageDir, "runtime", "node.exe");
const entry = process.argv[3] ?? path.join(stageDir, "app", "dist", "index.js");
const askBridgeExe = path.join(stageDir, "bridge", "ask-bridge.exe");
const askBridgeUpdaterExe = path.join(stageDir, "bridge", "ask-bridge-update.exe");
const askBridgeCommand = path.join(stageDir, "bin", "ask-bridge.cmd");
const askCommand = path.join(stageDir, "bin", "ask.cmd");
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
await access(askBridgeCommand);
await access(askCommand);
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
assert.equal(components.askBridge.version, "0.3.13");
assert.equal(components.chromeDevtoolsMcp.version, "1.5.0");
assert.equal(chromeDevtoolsPackage.version, components.chromeDevtoolsMcp.version);
const { stdout: askBridgeVersionOutput } = await execFileAsync(askBridgeExe, ["--version"], {
  windowsHide: true,
});
const expectedVersionRegex = new RegExp(`\\b${components.askBridge.version.replaceAll('.', '\\.')}\\b`);
assert.match(askBridgeVersionOutput, expectedVersionRegex);
for (const command of [askBridgeCommand, askCommand]) {
  const { stdout } = await execAsync(`"${command.replaceAll('"', '""')}" --version`, {
    windowsHide: true,
  });
  assert.match(stdout, expectedVersionRegex);
}

const packagedModule = await import(pathToFileURL(path.join(stageDir, "app", "dist", "ask-bridge.js")));
assert.equal(
  packagedModule.resolveAskBridgeExecutable({}, nodeExe),
  askBridgeExe,
  "Packaged MCP server must auto-discover its bundled ask-bridge executable",
);
const packagedPresets = await import(
  pathToFileURL(path.join(stageDir, "app", "dist", "model-presets.js"))
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
  for (const preset of packagedPresets.M365_MODEL_PRESETS) {
    const fixedTool = tools.find((candidate) => candidate.name === preset.toolName);
    assert.ok(fixedTool, `Packaged MCP server did not expose ${preset.toolName}`);
    assert.ok(
      fixedTool.inputSchema?.properties?.prompt,
      `Packaged fixed-model tool ${preset.toolName} is missing prompt`,
    );
    assert.equal(
      fixedTool.inputSchema?.properties?.model,
      undefined,
      `Packaged fixed-model tool ${preset.toolName} must not allow model overrides`,
    );
    assert.match(
      fixedTool.description ?? "",
      new RegExp(preset.model.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"),
      `Packaged fixed-model tool ${preset.toolName} must describe ${preset.model}`,
    );
  }
  const listener = tools.find(
    (candidate) => candidate.name === "ask_m365_copilot_listener",
  );
  assert.ok(listener, "Packaged MCP server did not expose ask_m365_copilot_listener");
  assert.ok(
    listener.inputSchema?.properties?.newConversation,
    "Packaged listener schema is missing newConversation",
  );
  assert.ok(
    listener.inputSchema?.properties?.timeoutSeconds,
    "Packaged listener schema is missing timeoutSeconds",
  );
  for (const forbidden of ["prompt", "model", "imagePaths", "filePaths"]) {
    assert.equal(
      listener.inputSchema?.properties?.[forbidden],
      undefined,
      `Packaged listener must not expose ${forbidden}`,
    );
  }
  assert.match(
    listener.description ?? "",
    /Return VS Code/i,
    "Packaged listener must describe its interactive handoff button",
  );
  console.log("Packaged MCP server smoke test passed.");
} finally {
  await client.close();
}
