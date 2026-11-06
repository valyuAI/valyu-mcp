/**
 * stdio entry point: the same server and tools as the HTTP endpoint, for MCP
 * clients that launch a local process (Claude Desktop, Cursor, Glama, ...).
 *
 *   VALYU_API_KEY=... pnpm stdio
 *
 * The key is read once from the environment. Without one the server still
 * starts and lists its tools, so a client or registry can inspect it; tool
 * calls then return the API's credential error.
 *
 * stdout carries the protocol, so nothing here may write to it.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { registerTools, SERVER_INFO, SERVER_INSTRUCTIONS } from "@/lib/mcp/server";

const apiKey = process.env.VALYU_API_KEY?.trim() ?? "";
if (!apiKey) {
  console.error(
    "valyu-mcp: VALYU_API_KEY is not set. Tools are listed, but calls will fail until a key " +
      "from https://platform.valyu.ai is provided.",
  );
}

const server = new McpServer(
  { ...SERVER_INFO, icons: [{ src: "https://mcp.valyu.ai/icon.svg", mimeType: "image/svg+xml", sizes: ["any"] }] },
  { instructions: SERVER_INSTRUCTIONS, capabilities: { tools: { listChanged: true } } },
);
registerTools(server, { apiKey, credentialSource: "environment" });

server.connect(new StdioServerTransport()).catch((err: unknown) => {
  console.error("valyu-mcp: failed to start:", err instanceof Error ? err.message : err);
  process.exit(1);
});
