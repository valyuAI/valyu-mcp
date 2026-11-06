# Valyu MCP Server

A [Model Context Protocol](https://modelcontextprotocol.io) server for [Valyu](https://valyu.ai):
search the web and specialised indexes built for knowledge work, read pages as clean markdown,
and run DeepResearch, from Claude, ChatGPT, Cursor, Codex or any MCP client.

This repository is the self-hostable server. It exposes the same six tools, with the same
schemas, as the hosted endpoint.

## Hosted or self-hosted

**Most people should use the hosted endpoint.** Nothing to run, sign-in included:

```
https://mcp.valyu.ai/mcp
```

```bash
claude mcp add --transport http valyu https://mcp.valyu.ai/mcp
```

Docs: [docs.valyu.ai/integrations/mcp-server](https://docs.valyu.ai/integrations/mcp-server).

**Self-host** when you want a local stdio process, your own deployment, or to read and change
the code. A self-hosted server authenticates with a Valyu API key only. Keys are created at
[platform.valyu.ai](https://platform.valyu.ai), and usage is billed to the key's organisation.

## Tools

| Tool                         | What it does                                                                                  |
| ---------------------------- | --------------------------------------------------------------------------------------------- |
| `valyu_search`               | Search the web and specialised indexes in one call, or scope to a dataset, domain or preset   |
| `valyu_datasources`          | The live dataset catalogue, searchable in plain language; returns the ids that scope a search |
| `valyu_contents`             | Read one or more URLs as clean markdown, or summarise them                                    |
| `valyu_deepresearch`         | Start a long-running DeepResearch task that writes a cited report                             |
| `valyu_deepresearch_status`  | Check a task, collect the finished report, or list recent tasks                               |
| `valyu_deepresearch_control` | Steer, answer a checkpoint, share, cancel or delete a task                                    |

Indexes include academic publications, SEC filings, financial and market data, clinical trials,
biomedical databases, economic indicators, patents and legal sources. `valyu_datasources` lists
what is available to your key. DeepResearch tasks are charged per task; the price of each mode is
stated in the tool description and echoed when a task starts.

## Run it

Requires Node.js 22.18 or later (26 LTS recommended) and pnpm 12. Install pnpm with
`npm install --global pnpm@12.17.0`, or through corepack 0.36 or later; the corepack bundled with
Node 22 cannot launch pnpm 12.

```bash
git clone https://github.com/valyuAI/valyu-mcp.git
cd valyu-mcp
pnpm install
```

### Local stdio server

For clients that launch a local process. The key is read from the environment.

```bash
VALYU_API_KEY=your-key pnpm stdio
```

Claude Desktop (`claude_desktop_config.json`), Cursor (`.cursor/mcp.json`) and most other clients:

```json
{
  "mcpServers": {
    "valyu": {
      "command": "pnpm",
      "args": ["--silent", "--dir", "/absolute/path/to/valyu-mcp", "stdio"],
      "env": { "VALYU_API_KEY": "your-key" }
    }
  }
}
```

Claude Code:

```bash
claude mcp add valyu --env VALYU_API_KEY=your-key -- pnpm --silent --dir /absolute/path/to/valyu-mcp stdio
```

`--silent` keeps pnpm's own messages off stdout, which the client reads as protocol (older pnpm
versions print a script banner there). Desktop apps launch with a minimal `PATH`, so if the client reports
`spawn pnpm ENOENT`, set `command` to the absolute path from `which pnpm`.

### Docker (stdio)

```bash
docker build -t valyu-mcp .
docker run --rm -i -e VALYU_API_KEY valyu-mcp
```

`-e VALYU_API_KEY` passes the variable from your shell, so the key never appears in the command
or the image. Without a key the server still starts and lists its tools, so a client or registry
can inspect it; tool calls then return a credential error.

### HTTP server

A Next.js app serving Streamable HTTP at `/mcp`, stateless, so any instance can serve any request.

```bash
pnpm build && pnpm start          # http://localhost:3000/mcp
pnpm dev                          # the same, with reload
```

It deploys to Vercel or any Node host as-is. Each request carries its own key, as
`Authorization: Bearer <VALYU_API_KEY>` (preferred), `X-API-Key: <VALYU_API_KEY>`, or
`?valyuApiKey=<VALYU_API_KEY>` for clients that cannot set headers. Prefer a header: URLs end up in
logs. There is deliberately no server-side key fallback, because anyone who can reach the URL
would spend it.

```json
{
  "mcpServers": {
    "valyu": {
      "type": "http",
      "url": "https://your-host.example/mcp",
      "headers": { "Authorization": "Bearer your-key" }
    }
  }
}
```

`/` shows the endpoint and the live tool list. Request bodies over 4 MiB are refused.

## How the tools are meant to be used

Use `valyu_search` when a request needs external sources. A query-only call uses the API's
automatic routing across the sources available to the key. Set filters only when the request
calls for that scope, and preserve explicit source and date restrictions.

`included_sources` takes everything the search API takes: dataset ids (`valyu/valyu-arxiv`,
matched exactly), domains and URL prefixes (`arxiv.org`, `https://openai.com/index`), presets
(`academic`, `finance`, `legal`, ...), saved collections (`collection:NAME`) and `web`. Site
restrictions belong there rather than as a `site:` operator in the query. Values are validated
against the live catalogue first, because an unrecognised dataset id fails the whole search
upstream; unknown ids come back with suggestions. Presets are expanded for `included_sources`
only, so a preset in `excluded_sources` is refused locally with the reason.

`source_biases` is the soft counterpart: a map of domain or URL prefix to an integer from -5 to
+5 that reorders results without removing anything. It is available on `valyu_search` and
`valyu_deepresearch`.

`response_length` is optional and forwarded unchanged: omit it for the API default (`short`,
25,000 characters per result), or use `medium`, `large`, `max` or a positive integer. Every
returned chunk is kept, including several chunks of one long document.

`valyu_deepresearch` runs asynchronously. It returns a task id once the task is accepted;
`valyu_deepresearch_status` returns the current state or the finished report without waiting.
Task options include dataset, date and country filters, supplied URLs and files, earlier
reports, report formatting, PDF or structured output, deliverables and review checkpoints.

## Development

```bash
pnpm typecheck
pnpm build
pnpm test                         # offline: formatting, lengths, research, entitlements, stdio

# live checks against the real API, with a server running on :3000
VALYU_API_KEY=... pnpm test:protocol -- --url http://localhost:3000
```

`pnpm test` needs no key and makes no network calls beyond localhost: the entitlement suite runs
the HTTP server against a mock upstream. `VALYU_BASE_URL` points the server at a different API
host.

```
app/[transport]/route.ts   the HTTP endpoint
app/page.tsx               index page with the live tool list
stdio.ts                   the stdio entry point
lib/mcp/server.ts          server identity, instructions and tool registration (shared)
lib/mcp/auth.ts            API key extraction and the 401 response
lib/mcp/serve.ts           stateless Streamable HTTP
lib/mcp/format.ts          result rendering
lib/mcp/errors.ts          actionable errors
lib/tools/                 the six tools
lib/valyu/                 API client, dataset catalogue, plan awareness
scripts/                   tests
```

## Security

Installs are restricted by a supply-chain policy in `pnpm-workspace.yaml`: no version younger
than 7 days, no drop in a package's trust evidence, no dependency install scripts, and no git or
tarball sub-dependencies. CI pins every action to a commit SHA. See [SECURITY.md](SECURITY.md),
which also covers reporting a vulnerability.

## Earlier versions

Before 2.0 this repository held a single-tool Python server (`valyu_context`). It calls an SDK
method that no longer exists, so it no longer installs cleanly. Its last version is tagged
[`legacy-python`](https://github.com/valyuAI/valyu-mcp/tree/legacy-python). The tool it offered
is covered by `valyu_search`.

## License

[MIT](LICENSE)
