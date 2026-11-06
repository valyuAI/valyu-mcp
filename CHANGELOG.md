# Changelog

## 2.0.0 - 2026-11-06

A rewrite. The server now matches the hosted endpoint at `https://mcp.valyu.ai/mcp`: the same
six tools, with the same input schemas and descriptions, runnable locally or on your own host.

### Added

- **Six tools**: `valyu_search`, `valyu_datasources`, `valyu_contents`, `valyu_deepresearch`,
  `valyu_deepresearch_status` and `valyu_deepresearch_control`.
- **Three ways to run it**: a stdio process (`pnpm stdio`), a Docker image (stdio), and a
  stateless Streamable HTTP server at `/mcp` (Next.js, deployable to Vercel or any Node host).
- **Scoping that matches the search API**: `included_sources` takes dataset ids, domains, URL
  prefixes, presets, saved collections and `web`, validated against the live catalogue with
  suggestions for unknown ids. `source_biases` reweights sources without excluding any.
- **Plan-aware results**: dataset coverage from the account API, actionable errors for plan
  restrictions, exhausted credits and rate limits, and the API's own warnings when a request
  is served only in part.
- **DeepResearch**: asynchronous tasks with optional bounded inline waits, progress
  notifications, checkpoints, steering, sharing, cancellation and deletion. Mode prices are
  stated in the tool and echoed on launch.
- `valyu_contents` with per-URL length, summaries, high-effort JavaScript rendering and
  optional screenshots.
- An offline test suite (`pnpm test`) that runs the HTTP server against a mock upstream, and a
  live protocol suite (`pnpm test:protocol`).

### Changed

- API key authentication only: `Authorization: Bearer`, `X-API-Key`, or `?valyuApiKey=`. The
  stdio entry point reads `VALYU_API_KEY`.
- Request bodies over 4 MiB are refused before they are parsed.
- Built on Node.js 26 LTS (22.18 or later supported), Next.js 16, TypeScript 6 and pnpm 12.

### Security

- A supply-chain policy for installs (`pnpm-workspace.yaml`): no version younger than 7 days, no
  drop in trust evidence, no dependency install scripts, no git or tarball sub-dependencies.
- CI pins actions to commit SHAs with no default token permissions, verifies the pnpm tarball
  against the lockfile, lints workflows with zizmor and audits at every severity.
- The Docker base image is pinned by digest. Dependabot runs with a 7-day cooldown. See
  `SECURITY.md`.

### Removed

- The Python server and its `valyu_context` tool, which called an SDK method that no longer
  exists. Use `valyu_search`. The last Python version is tagged `legacy-python`.
