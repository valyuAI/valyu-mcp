import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Do not write agent instruction files into the project during `next dev`.
  agentRules: false,

  // Lets the entitlement test run a second dev server against a mock upstream
  // without sharing `.next` with a running `pnpm dev`.
  ...(process.env.NEXT_DIST_DIR ? { distDir: process.env.NEXT_DIST_DIR } : {}),

  // Browser-hosted MCP clients (the MCP Inspector, web connector surfaces)
  // preflight the endpoint. Auth is a per-request header, never a cookie, so
  // a wildcard origin is safe; the session and protocol headers must be
  // exposed or a browser client cannot read them off the response.
  async headers() {
    const cors = [
      { key: "Access-Control-Allow-Origin", value: "*" },
      { key: "Access-Control-Allow-Methods", value: "GET, POST, DELETE, OPTIONS" },
      {
        key: "Access-Control-Allow-Headers",
        value: "Content-Type, Authorization, X-API-Key, Accept, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID",
      },
      {
        key: "Access-Control-Expose-Headers",
        value: "Mcp-Session-Id, MCP-Protocol-Version, WWW-Authenticate",
      },
      { key: "Access-Control-Max-Age", value: "86400" },
    ];
    return [{ source: "/mcp", headers: cors }];
  },
};

export default nextConfig;
