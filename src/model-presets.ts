export interface M365ModelPreset {
  toolName: string;
  title: string;
  model: string;
}

export const M365_MODEL_PRESETS = [
  {
    toolName: "ask_m365_copilot_auto",
    title: "Ask M365 — Auto",
    model: "Auto",
  },
  {
    toolName: "ask_m365_copilot_gpt_5_5_think_deeper",
    title: "Ask M365 — GPT 5.5 Think deeper",
    model: "GPT 5.5 Think deeper",
  },
  {
    toolName: "ask_m365_copilot_gpt_5_5_quick_response",
    title: "Ask M365 — GPT 5.5 快速回應",
    model: "GPT 5.5 快速回應",
  },
  {
    toolName: "ask_m365_copilot_gpt_5_6_think_deeper",
    title: "Ask M365 — GPT 5.6 Think deeper",
    model: "GPT 5.6 Think deeper",
  },
] as const satisfies readonly M365ModelPreset[];

export function fixedM365ModelForTool(toolName: string): string | undefined {
  return M365_MODEL_PRESETS.find((preset) => preset.toolName === toolName)?.model;
}
