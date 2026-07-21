#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { askM365Copilot } from "./ask-bridge.js";
import { MAX_ATTACHMENTS } from "./attachments.js";
import { createRequestId, emitDiagnostic } from "./diagnostics.js";

const server = new McpServer({ name: "ask-bridge-m365-copilot", version: "0.2.1" });

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

server.registerTool(
  "ask_m365_copilot",
  {
    title: "Ask Microsoft 365 Copilot",
    description:
      "Delegate a software-development question or task to Microsoft 365 Copilot through the user's local ask-bridge Chrome session. The prompt itself leaves the local machine: never put workspace file contents or secrets discovered by the agent into prompt unless the user explicitly requested that exact content be sent to M365. Attachments also cross this external-data boundary: include only files or images the user explicitly identified or explicitly asked to send to M365, and set attachmentConsent=true only for that request. Never discover or select 'relevant' attachment paths on the user's behalf. Local paths must be inside ASK_BRIDGE_ALLOWED_ROOTS and sensitive files are always blocked. Images merely attached to the host chat are not automatically forwarded. When the user has just pasted a screenshot and explicitly wants that original image sent to M365, set includeClipboardImage=true and attachmentConsent=true before any clipboard-changing action.",
    inputSchema: {
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
    },
  },
  async (
    {
      prompt,
      imagePaths,
      filePaths,
      inlineImages,
      includeClipboardImage,
      attachmentConsent,
      newConversation,
      timeoutSeconds,
    },
    { signal },
  ) => {
    const requestId = createRequestId();
    try {
      const answer = await askM365Copilot({
        requestId,
        prompt,
        imagePaths,
        filePaths,
        inlineImages,
        includeClipboardImage,
        attachmentConsent,
        newConversation,
        timeoutSeconds,
        signal,
      });
      emitDiagnostic(requestId, "tool_result_returned", {
        is_error: false,
        response_character_count: Array.from(answer).length,
      });
      return { content: [{ type: "text", text: answer }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      emitDiagnostic(requestId, "tool_result_returned", {
        is_error: true,
        error_name: error instanceof Error ? error.name : "UnknownError",
      });
      return {
        isError: true,
        content: [{ type: "text", text: `Microsoft 365 Copilot request failed: ${message}` }],
      };
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
