# Security

## Reporting a vulnerability

Please report vulnerabilities privately through
[GitHub's private vulnerability reporting](https://github.com/valyuAI/valyu-mcp/security/advisories/new)
or to contact@valyu.ai. Do not open a public issue.

## Credentials

The server never stores keys. Over HTTP every request carries its own Valyu API key, and there
is no server-side fallback key. Over stdio the key comes from `VALYU_API_KEY`. Logs carry only
the tool name, failure kind and HTTP status, never a key, query or response body.

## Supply chain

Dependencies are the most likely way for malicious code to reach this server, so installs are
restricted by policy in [`pnpm-workspace.yaml`](pnpm-workspace.yaml) and checked in CI:

| Control | Where | What it stops |
| --- | --- | --- |
| `minimumReleaseAge: 10080` | pnpm | Any version, direct or transitive, published less than 7 days ago. Compromised releases are usually detected and pulled within that window. |
| `trustPolicy: no-downgrade` | pnpm | A release with weaker trust evidence than earlier ones, e.g. a hijacked account publishing without the usual provenance. |
| `strictDepBuilds` with an explicit `allowBuilds` list | pnpm | Install scripts. No dependency runs code at install time; an unreviewed script fails the install. |
| `blockExoticSubdeps` | pnpm | Transitive dependencies from git repositories or tarball URLs. |
| Exact versions, committed lockfile, `--frozen-lockfile` | pnpm, CI, Docker | Silent drift between what was reviewed and what is installed. |
| `packageManager` pin with hash | pnpm | A substituted pnpm binary. |
| Actions pinned to full commit SHAs, `permissions: {}` by default, no persisted checkout credentials, no dependency cache | CI | Moved tags, token theft, cache poisoning. |
| zizmor | CI | Unsafe workflow patterns (template injection, excessive permissions, unpinned actions). |
| `pnpm audit` at every severity | CI | Known vulnerabilities. Ignores are listed with their reasoning in `pnpm-workspace.yaml`. |
| Base image pinned by digest, non-root user | Docker | A re-pushed image tag. |
| Dependabot with a 7-day cooldown | GitHub | Stale dependencies, without opening PRs for versions pnpm would refuse. |

### Urgent fixes

A security patch younger than 7 days is refused by `minimumReleaseAge`. To take one
deliberately, add the package to `minimumReleaseAgeExclude` in `pnpm-workspace.yaml` in the same
pull request as the upgrade, and remove it once the version is a week old.
