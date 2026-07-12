#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { askM365Copilot } from "./ask-bridge.js";

const server = new McpServer({ name: "ask-bridge-m365-copilot", version: "0.1.0" });

server.registerTool(
  "ask_m365_copilot",
  {
    title: "Ask Microsoft 365 Copilot",
    description:
      "Delegate a question or task to Microsoft 365 Copilot through the user's local ask-bridge Chrome session. Use when the user explicitly asks for Microsoft 365 Copilot or M365 Copilot.",
    inputSchema: {
      prompt: z.string().min(1).describe("The complete prompt to send to Microsoft 365 Copilot"),
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
  async ({ prompt, newConversation, timeoutSeconds }) => {
    try {
      const answer = await askM365Copilot({ prompt, newConversation, timeoutSeconds });
      return { content: [{ type: "text", text: answer }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        isError: true,
        content: [{ type: "text", text: `Microsoft 365 Copilot request failed: ${message}` }],
      };
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
