#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { askM365Copilot, listenM365Copilot } from "./ask-bridge.js";
import { MAX_ATTACHMENTS, type InlineImageInput } from "./attachments.js";
import { createRequestId, emitDiagnostic } from "./diagnostics.js";
import { M365_MODEL_PRESETS } from "./model-presets.js";

const server = new McpServer({ name: "ask-bridge-m365-copilot", version: "0.2.18" });

const inlineImageSchema = z.object({
  data: z
    .string()
    .min(1)
    .describe("Raw base64 image bytes or a data:image/...;base64,... URI"),
  name: z
    .string()
    .min(1)
    .max(255)
    .optional()
    .describe("Optional display filename such as order-header.png"),
  mimeType: z
    .string()
    .min(1)
    .max(100)
    .optional()
    .describe("Image MIME type for raw base64, for example image/png"),
});

const commonInputSchema = {
  prompt: z
    .string()
    .min(1)
    .describe(
      "The complete prompt that will leave the local machine and be sent to Microsoft 365 Copilot; do not include agent-discovered workspace contents or secrets unless the user explicitly asked to transmit that exact content",
    ),
  imagePaths: z
    .array(z.string().min(1))
    .max(MAX_ATTACHMENTS)
    .default([])
    .describe(
      "Absolute local image paths explicitly identified or approved by the user; every canonical path must be inside ASK_BRIDGE_ALLOWED_ROOTS",
    ),
  filePaths: z
    .array(z.string().min(1))
    .max(MAX_ATTACHMENTS)
    .default([])
    .describe(
      "Absolute local source/document paths explicitly identified or approved by the user; active editor context is not added automatically and every canonical path must be inside ASK_BRIDGE_ALLOWED_ROOTS",
    ),
  inlineImages: z
    .array(inlineImageSchema)
    .max(MAX_ATTACHMENTS)
    .default([])
    .describe(
      "Inline images supplied as strict base64 or data URIs only when the user explicitly asked to send them to M365",
    ),
  includeClipboardImage: z
    .boolean()
    .default(false)
    .describe(
      "On Windows, capture and upload the current clipboard image only when the user explicitly asked to send that clipboard image to M365",
    ),
  attachmentConsent: z
    .boolean()
    .default(false)
    .describe(
      "Set true only when the user explicitly requested that every attachment in this tool call be transmitted to Microsoft 365 Copilot; required whenever any path, inline image, or clipboard image is included",
    ),
  newConversation: z
    .boolean()
    .default(true)
    .describe("Start a new Copilot conversation; defaults to true to avoid unrelated context"),
  timeoutSeconds: z
    .number()
    .int()
    .min(30)
    .max(1800)
    .default(300)
    .describe("Maximum ask-bridge response wait in seconds"),
};

const modelSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .optional()
  .describe(
    "Optional Microsoft 365 Copilot mode or visible model name, such as Auto, Quick response, Think deeper, GPT 5.5 Think deeper, GPT 5.5 快速回應, or Claude; availability depends on the signed-in tenant and differs from the VS Code Chat model picker",
  );

const externalDataBoundary =
  "The prompt leaves the local machine. Never include workspace contents or secrets discovered by the agent unless the user explicitly requested that exact content be sent to M365. Attachments also cross this boundary: include only files or images explicitly identified or requested by the user, set attachmentConsent=true, never discover attachment paths on the user's behalf, and keep paths inside ASK_BRIDGE_ALLOWED_ROOTS. Host-chat attachments are not forwarded automatically.";

interface ToolArguments {
  prompt: string;
  model?: string;
  imagePaths: string[];
  filePaths: string[];
  inlineImages: InlineImageInput[];
  includeClipboardImage: boolean;
  attachmentConsent: boolean;
  newConversation: boolean;
  timeoutSeconds: number;
}

async function executeAskTool(
  args: ToolArguments,
  signal: AbortSignal,
  fixedModel?: string,
) {
  const requestId = createRequestId();
  try {
    const answer = await askM365Copilot({
      requestId,
      ...args,
      model: fixedModel ?? args.model,
      signal,
    });
    emitDiagnostic(requestId, "tool_result_returned", {
      is_error: false,
      response_character_count: Array.from(answer).length,
    });
    return { content: [{ type: "text" as const, text: answer }] };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emitDiagnostic(requestId, "tool_result_returned", {
      is_error: true,
      error_name: error instanceof Error ? error.name : "UnknownError",
    });
    return {
      isError: true,
      content: [
        { type: "text" as const, text: `Microsoft 365 Copilot request failed: ${message}` },
      ],
    };
  }
}

async function executeListenerTool(
  args: { newConversation: boolean; timeoutSeconds: number },
  signal: AbortSignal,
) {
  const requestId = createRequestId();
  try {
    const answer = await listenM365Copilot({ requestId, ...args, signal });
    emitDiagnostic(requestId, "tool_result_returned", {
      is_error: false,
      response_character_count: Array.from(answer).length,
      source: "m365_listener",
    });
    return { content: [{ type: "text" as const, text: answer }] };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emitDiagnostic(requestId, "tool_result_returned", {
      is_error: true,
      error_name: error instanceof Error ? error.name : "UnknownError",
      source: "m365_listener",
    });
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: `Microsoft 365 Copilot listener failed: ${message}`,
        },
      ],
    };
  }
}

server.registerTool(
  "ask_m365_copilot",
  {
    title: "Ask Microsoft 365 Copilot",
    description:
      `Delegate a question or task to Microsoft 365 Copilot. The VS Code Chat model picker controls only the host model; use this tool's model field to select the downstream M365 model. ${externalDataBoundary}`,
    inputSchema: { ...commonInputSchema, model: modelSchema },
  },
  async (args, { signal }) => executeAskTool(args, signal),
);

for (const preset of M365_MODEL_PRESETS) {
  server.registerTool(
    preset.toolName,
    {
      title: preset.title,
      description:
        `Delegate a question or task to Microsoft 365 Copilot and always select the exact downstream model '${preset.model}'. The model is fixed by the tool and cannot be overridden by the VS Code host agent. If that model is unavailable in the signed-in tenant, the request stops before submitting the prompt. ${externalDataBoundary}`,
      inputSchema: commonInputSchema,
    },
    async (args, { signal }) => executeAskTool(args, signal, preset.model),
  );
}

server.registerTool(
  "ask_m365_copilot_listener",
  {
    title: "Listen to M365 — Return VS Code",
    description:
      "Open the managed Microsoft 365 Copilot Chrome window and wait while the user works directly in M365 Chat. The user may manually upload files, screenshots, OneDrive content, or other work data in that page; those inputs go directly from the browser to Microsoft 365 and are not selected or transmitted by the VS Code agent. A self-cleaning 'Return VS Code' button appears beside the M365 composer and is enabled after a response is available and generation has stopped. When the user clicks it, this tool returns the latest M365 response text so the VS Code Copilot Chat agent can continue the current task. Keep this tool call running until the user clicks the button, cancels it, or timeoutSeconds expires.",
    inputSchema: {
      newConversation: z
        .boolean()
        .default(false)
        .describe(
          "Set to true ONLY if the user explicitly asked to start a brand-new chat. MUST be kept false (the default) when continuing an existing interaction or task so the open M365 conversation and uploaded files are preserved.",
        ),
      timeoutSeconds: z
        .number()
        .int()
        .min(30)
        .max(7200)
        .default(1800)
        .describe(
          "Maximum time to wait for the user to click Return VS Code, from 30 seconds to 2 hours",
        ),
    },
  },
  async (args, { signal }) => executeListenerTool(args, signal),
);

const transport = new StdioServerTransport();
await server.connect(transport);
