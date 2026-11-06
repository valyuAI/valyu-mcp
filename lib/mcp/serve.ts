/**
 * Stateless Streamable HTTP, using the SDK's Web-standard transport directly.
 *
 * Its `handleRequest` takes a `Request` and returns a `Response` - exactly the
 * shape of an App Router route handler - so no adapter is needed. One server
 * and one transport per request, nothing shared between them, so any instance
 * can serve any call.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { type ServerCapabilities } from "@modelcontextprotocol/sdk/types.js";

export interface ServeOptions {
  name: string;
  version: string;
  /**
   * Display name, website and icons for the connector. `name` is a slug, so a
   * client with nothing else to go on labels the connection "valyu-mcp"
   * and draws no icon; these are the fields ChatGPT's connector panel and
   * Claude's connector list actually render.
   */
  title?: string;
  websiteUrl?: string;
  icons?: {
    src: string;
    mimeType?: string;
    sizes?: string[];
    theme?: "light" | "dark";
  }[];
  instructions: string;
  capabilities?: ServerCapabilities;
  /** Registers this request's tools onto a freshly built server. */
  register: (server: McpServer) => void;
}

/**
 * `/mcp` is POST-only. GET would open a standalone notification stream and
 * DELETE would terminate a session; we run stateless, so neither applies.
 * Answering 405 rather than 404 tells a client the endpoint exists but the
 * method does not.
 */
function methodNotAllowed(): Response {
  return jsonRpcError(405, -32000, "Method not allowed.", { Allow: "POST" });
}

function jsonRpcError(
  status: number,
  code: number,
  message: string,
  headers: Record<string, string> = {},
): Response {
  return new Response(
    JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }),
    { status, headers: { "Content-Type": "application/json", ...headers } },
  );
}

/** Unmatched transport segment. */
export function notFound(): Response {
  return new Response("Not found", { status: 404 });
}

export async function serveMcp(
  request: Request,
  opts: ServeOptions,
): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed();

  const server = new McpServer(
    {
      name: opts.name,
      version: opts.version,
      ...(opts.title ? { title: opts.title } : {}),
      ...(opts.websiteUrl ? { websiteUrl: opts.websiteUrl } : {}),
      ...(opts.icons?.length ? { icons: opts.icons } : {}),
    },
    {
      instructions: opts.instructions,
      capabilities: opts.capabilities ?? { tools: { listChanged: true } },
    },
  );
  opts.register(server);

  // The body is read here before the SDK transport sees it, so its size bound
  // has to be applied here too.
  const bounded = await boundBody(request);
  if (bounded instanceof Response) return bounded;
  request = bounded;

  // Small models sometimes double-encode `arguments` as a JSON string. The SDK
  // rejects that with a raw validation dump the model then retries unchanged.
  // Decode it here so the call reaches the tool like any other.
  request = await coerceStringArguments(request);

  // Omitting `sessionIdGenerator` selects the SDK's stateless mode: no
  // Mcp-Session-Id is issued, none is validated, and no per-session state
  // outlives the request. DeepResearch keeps SSE enabled because its progress
  // notifications must reach the client before the final result.
  const transport = new WebStandardStreamableHTTPServerTransport({
    enableJsonResponse: !(await callsStreamingTool(request)),
  });
  await server.connect(transport);

  return transport.handleRequest(request);
}

/** The SDK transport's own default bound on a request body (4 MiB). */
const MAX_BODY_BYTES = 4 * 1024 * 1024;

function payloadTooLarge(): Response {
  return jsonRpcError(
    413,
    -32600,
    `Payload Too Large: request body must not exceed ${MAX_BODY_BYTES} bytes.`,
  );
}

/**
 * Read the body once, refusing anything over MAX_BODY_BYTES whether or not a
 * Content-Length was sent, and hand back an equivalent buffered request.
 */
async function boundBody(request: Request): Promise<Request | Response> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return payloadTooLarge();
  if (!request.body) return request;

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      return payloadTooLarge();
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new Request(request.url, { method: request.method, headers: request.headers, body });
}

/** Tool calls that emit progress before their final result must use SSE. */
async function callsStreamingTool(request: Request): Promise<boolean> {
  try {
    const body: unknown = await request.clone().json();
    const messages = Array.isArray(body) ? body : [body];
    return messages.some((message) => {
      if (!message || typeof message !== "object") return false;
      const value = message as {
        method?: unknown;
        params?: { name?: unknown };
      };
      return (
        value.method === "tools/call" &&
        value.params?.name === "valyu_deepresearch"
      );
    });
  } catch {
    return false;
  }
}

/**
 * Rewrite a tools/call whose `params.arguments` arrived as a JSON string into
 * the object it encodes. Any body that is not that exact shape passes through
 * untouched, including batches and anything unparsable.
 */
async function coerceStringArguments(request: Request): Promise<Request> {
  let raw: string;
  try {
    raw = await request.clone().text();
  } catch {
    return request;
  }
  if (!raw.includes('"arguments"')) return request;
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return request;
  }
  const fix = (msg: unknown): boolean => {
    if (!msg || typeof msg !== "object") return false;
    const m = msg as { method?: unknown; params?: { arguments?: unknown } };
    if (m.method !== "tools/call" || !m.params) return false;
    const a = m.params.arguments;
    if (typeof a !== "string") return false;
    try {
      const parsed = JSON.parse(a);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        m.params.arguments = parsed;
        return true;
      }
    } catch {
      /* leave it; the SDK's validation error is the right answer */
    }
    return false;
  };
  const changed = Array.isArray(body) ? body.map(fix).some(Boolean) : fix(body);
  if (!changed) return request;
  return new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body: JSON.stringify(body),
  });
}
