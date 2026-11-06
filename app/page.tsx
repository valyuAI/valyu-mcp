import { headers } from "next/headers";

import { describeTools } from "@/lib/mcp/introspect";

export const dynamic = "force-dynamic";

/** The first sentence of a tool description, for a one-line summary. */
function firstSentence(text: string): string {
  const match = /^([\s\S]+?[.!?])(\s|$)/.exec(text.trim());
  return (match ? match[1] : text).replace(/\s+/g, " ");
}

export default async function Home() {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const endpoint = `${proto}://${host}/mcp`;
  const tools = await describeTools();

  return (
    <main>
      <style>{`
        :root { color-scheme: light dark; --ink: #16151a; --muted: #5f5d66; --line: #e4e3e8; --accent: #4a6a00; --bg: #fff; }
        @media (prefers-color-scheme: dark) { :root { --ink: #ededf0; --muted: #a3a1aa; --line: #2c2b31; --accent: #c7e04a; --bg: #111014; } }
        body { margin: 0; background: var(--bg); color: var(--ink); font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; }
        main { max-width: 680px; margin: 0 auto; padding: 72px 24px 96px; }
        h1 { font-size: 28px; line-height: 1.25; margin: 0 0 12px; letter-spacing: -0.01em; }
        h2 { font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); margin: 48px 0 12px; }
        p { margin: 0 0 16px; color: var(--muted); }
        code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 14px; }
        pre { margin: 0; padding: 14px 16px; border: 1px solid var(--line); border-radius: 6px; overflow-x: auto; color: var(--ink); }
        ul { list-style: none; margin: 0; padding: 0; }
        li { padding: 12px 0; border-top: 1px solid var(--line); }
        li code { color: var(--ink); font-weight: 600; }
        li span { display: block; color: var(--muted); font-size: 15px; }
        a { color: var(--accent); }
      `}</style>

      <h1>Valyu MCP server</h1>
      <p>
        This server is running. Point any Streamable HTTP MCP client at the endpoint below and send a
        Valyu API key as <code>Authorization: Bearer &lt;VALYU_API_KEY&gt;</code>. Keys are created at{" "}
        <a href="https://platform.valyu.ai">platform.valyu.ai</a>.
      </p>

      <h2>Endpoint</h2>
      <pre>{endpoint}</pre>

      <h2>Tools</h2>
      <ul>
        {tools.map((tool) => (
          <li key={tool.name}>
            <code>{tool.name}</code>
            <span>{firstSentence(tool.description)}</span>
          </li>
        ))}
      </ul>

      <h2>Hosted</h2>
      <p>
        Valyu also runs this server at <code>https://mcp.valyu.ai/mcp</code>, with Sign in with Valyu.
        Source and docs: <a href="https://github.com/valyuAI/valyu-mcp">github.com/valyuAI/valyu-mcp</a>.
      </p>
    </main>
  );
}
