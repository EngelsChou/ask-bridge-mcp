import assert from "node:assert/strict";
import test from "node:test";
import {
  fixedM365ModelForTool,
  M365_MODEL_PRESETS,
} from "../dist/model-presets.js";

const expectedMappings = {
  ask_m365_copilot_auto: "Auto",
  ask_m365_copilot_gpt_5_5_think_deeper: "GPT 5.5 Think deeper",
  ask_m365_copilot_gpt_5_5_quick_response: "GPT 5.5 快速回應",
  ask_m365_copilot_gpt_5_6_think_deeper: "GPT 5.6 Think deeper",
};

test("maps every fixed MCP tool to its exact Microsoft 365 model label", () => {
  assert.deepEqual(
    Object.fromEntries(M365_MODEL_PRESETS.map(({ toolName, model }) => [toolName, model])),
    expectedMappings,
  );
  for (const [toolName, model] of Object.entries(expectedMappings)) {
    assert.equal(fixedM365ModelForTool(toolName), model);
    assert.match(toolName, /^[a-z0-9_]+$/);
  }
});

test("does not assign a fixed model to the generic MCP tool", () => {
  assert.equal(fixedM365ModelForTool("ask_m365_copilot"), undefined);
});
