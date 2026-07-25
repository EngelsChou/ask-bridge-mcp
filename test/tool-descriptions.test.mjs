import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { M365_MODEL_PRESETS } from "../dist/model-presets.js";

const serverEntry = fileURLToPath(new URL("../dist/index.js", import.meta.url));

async function listTools() {
  const child = spawn(process.execPath, [serverEntry], { stdio: ["pipe", "pipe", "ignore"] });
  let buffer = "";
  const pending = new Map();
  let id = 0;
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      try {
        const message = JSON.parse(line);
        if (message.id && pending.has(message.id)) {
          pending.get(message.id)(message);
          pending.delete(message.id);
        }
      } catch {
        /* ignore non-JSON diagnostics */
      }
    }
  });
  const rpc = (method, params) =>
    new Promise((resolve, reject) => {
      const messageId = ++id;
      pending.set(messageId, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: messageId, method, params }) + "\n");
      setTimeout(() => {
        if (pending.has(messageId)) {
          pending.delete(messageId);
          reject(new Error(`timeout ${method}`));
        }
      }, 20000);
    });

  try {
    await rpc("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "description-test", version: "1.0.0" },
    });
    child.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\n",
    );
    const result = await rpc("tools/list", {});
    return result.result.tools;
  } finally {
    child.kill();
  }
}

test("every query tool tells the host agent that an explicit #mention must be called", async () => {
  const tools = await listTools();
  const queryToolNames = ["ask_m365_copilot", ...M365_MODEL_PRESETS.map((preset) => preset.toolName)];

  for (const name of queryToolNames) {
    const tool = tools.find((candidate) => candidate.name === name);
    assert.ok(tool, `missing tool ${name}`);
    assert.match(tool.description, /MUST call it and return its answer/, name);
    assert.match(tool.description, /simple, trivial, or answerable offline/, name);
  }
});

test("fixed-model tools still name their exact downstream model", async () => {
  const tools = await listTools();
  for (const preset of M365_MODEL_PRESETS) {
    const tool = tools.find((candidate) => candidate.name === preset.toolName);
    assert.ok(tool, `missing tool ${preset.toolName}`);
    assert.ok(
      tool.description.includes(`'${preset.model}'`),
      `${preset.toolName} should pin ${preset.model}`,
    );
  }
});
