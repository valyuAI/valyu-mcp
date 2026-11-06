import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { RequestContext } from "./auth";
import { registerTools } from "./server";

export interface ToolParam {
  name: string;
  type: string;
  required: boolean;
  description: string;
}

export interface ToolDoc {
  name: string;
  title: string;
  description: string;
  params: ToolParam[];
}

type JsonSchema = {
  type?: string | string[];
  enum?: unknown[];
  items?: JsonSchema;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  description?: string;
  anyOf?: JsonSchema[];
  default?: unknown;
};

function typeOf(s: JsonSchema): string {
  if (s.enum) return s.enum.map((v) => JSON.stringify(v)).join(" | ");
  if (s.anyOf) return s.anyOf.map(typeOf).join(" | ");
  const t = Array.isArray(s.type) ? s.type.join(" | ") : s.type ?? "any";
  if (t === "array") return `${s.items ? typeOf(s.items) : "any"}[]`;
  return t;
}

/**
 * The current tool surface, read from the same registrations the endpoint
 * serves, so the index page never drifts from what a client sees. Built at
 * render time with an inert context; nothing is called.
 */
export async function describeTools(): Promise<ToolDoc[]> {
  const server = new McpServer({ name: "introspect", version: "0" });
  const ctx: RequestContext = { apiKey: "", credentialSource: "authorization" };
  registerTools(server, ctx);

  type ListResult = {
    tools: { name: string; title?: string; description?: string; inputSchema?: JsonSchema; annotations?: { title?: string } }[];
  };
  type Handler = (req: unknown, extra: unknown) => Promise<ListResult>;
  const handlers = (server.server as unknown as { _requestHandlers: Map<string, Handler> })._requestHandlers;
  const list = handlers.get("tools/list");
  if (!list) return [];
  const { tools } = await list({ method: "tools/list", params: {} }, {});

  return tools.map((t) => {
    const props = t.inputSchema?.properties ?? {};
    const required = new Set(t.inputSchema?.required ?? []);
    return {
      name: t.name,
      title: t.annotations?.title ?? t.title ?? t.name,
      description: t.description ?? "",
      params: Object.entries(props).map(([name, s]) => ({
        name,
        type: typeOf(s) + (s.default !== undefined ? ` = ${JSON.stringify(s.default)}` : ""),
        required: required.has(name),
        description: s.description ?? "",
      })),
    };
  });
}
