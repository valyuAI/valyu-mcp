/**
 * Credential extraction for the HTTP server. Every request carries its own
 * Valyu API key; nothing is stored between requests.
 *
 * Order of preference:
 *   1. `Authorization: Bearer <key>`  - works on every major MCP surface.
 *   2. `X-API-Key: <key>`             - documented alias.
 *   3. `?valyuApiKey=<key>`           - for clients that cannot set headers.
 *      Prefer a header where you can: URLs end up in proxy and access logs,
 *      and MCP 2025-11-25 says tokens MUST NOT travel in the query string.
 *
 * There is deliberately no fallback to a server-side key: anyone who can reach
 * the URL would spend it. The stdio entry point reads VALYU_API_KEY instead.
 */

/** The credential a request's tool calls run with. */
export interface RequestContext {
  apiKey: string;
  credentialSource: "authorization" | "x-api-key" | "query" | "environment";
}

/** The request's credential, or null when it carries none. */
export function buildContext(req: Request): RequestContext | null {
  const auth = req.headers.get("authorization");
  if (auth) {
    const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (m?.[1]) return { apiKey: m[1].trim(), credentialSource: "authorization" };
  }

  const xKey = req.headers.get("x-api-key");
  if (xKey?.trim()) return { apiKey: xKey.trim(), credentialSource: "x-api-key" };

  try {
    const q = new URL(req.url).searchParams.get("valyuApiKey");
    if (q?.trim()) return { apiKey: q.trim(), credentialSource: "query" };
  } catch {
    /* malformed URL - fall through */
  }

  return null;
}

/** A real HTTP 401, so clients surface the problem instead of an empty tool list. */
export function unauthorizedResponse(): Response {
  const message =
    "Send a Valyu API key as `Authorization: Bearer <VALYU_API_KEY>` (preferred) or " +
    "`X-API-Key: <VALYU_API_KEY>`. Get a key at https://platform.valyu.ai.";
  return new Response(
    JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message }, id: null }),
    {
      status: 401,
      headers: {
        "Content-Type": "application/json",
        "WWW-Authenticate": `Bearer error="invalid_token", error_description="Valyu API key required"`,
      },
    },
  );
}
