/** Render actionable errors while preserving the caller's requested scope. */

import { ValyuApiError } from "@/lib/valyu/client";
import { planLabel } from "@/lib/valyu/entitlements";
import type { UnresolvedSource } from "@/lib/valyu/sources";

/** First-line markers on 402 and 429 results, kept stable for log filtering. */
const CREDITS_EXHAUSTED_MARK = "HTTP 402";
const RATE_LIMITED_MARK = "HTTP 429";

export interface ToolError {
  // The SDK's CallToolResult carries an index signature; mirror it so these
  // helpers are assignable to a tool callback's return type.
  [x: string]: unknown;
  content: { type: "text"; text: string }[];
  isError: true;
}

export function toolError(text: string): ToolError {
  return { content: [{ type: "text", text }], isError: true };
}

const PRESERVE_SCOPE =
  `Preserve any source restriction the user requested and explain the access limitation. ` +
  `If alternative sources are acceptable, omit \`included_sources\` to search available sources automatically.`;

/** "the requested dataset is" / "the requested datasets (a, b) are". */
function requestedDatasets(ids: string[]): string {
  if (!ids.length) return "the requested dataset is";
  return ids.length === 1
    ? `the requested dataset (${ids[0]}) is`
    : `the requested datasets (${ids.join(", ")}) are`;
}

/** AbortSignal.timeout rejects with TimeoutError; a manual abort with AbortError. */
function isTimeout(err: unknown): boolean {
  return err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
}

const EXPECTED_API_STATUSES = new Set([400, 401, 402, 403, 404, 409, 422, 429]);

function recordToolFailure(err: unknown, context: string): void {
  const status = err instanceof ValyuApiError ? err.status : undefined;
  const expected = status !== undefined && EXPECTED_API_STATUSES.has(status);
  const kind =
    err instanceof ValyuApiError
      ? err.status >= 500
        ? "upstream_5xx"
        : `upstream_${err.status}`
      : isTimeout(err)
        ? "timeout"
        : "unexpected";

  // Structural only: no request, credential, query, API response body or
  // task id is logged. stderr, so it never corrupts a stdio transport.
  const log = JSON.stringify({
    event: "mcp_tool_failure",
    context,
    kind,
    ...(status === undefined ? {} : { status }),
  });
  if (expected) console.warn(log);
  else console.error(log);
}

export function renderApiError(err: unknown, context: string): ToolError {
  recordToolFailure(err, context);
  if (err instanceof ValyuApiError) {
    switch (err.status) {
      case 401:
      case 403: {
        if (err.restrictedSources?.length) {
          return toolError(
            `${context} failed: these datasets are not reachable from search - ` +
              `${err.restrictedSources.join(", ")}.\n\n` +
              `Remove them from \`included_sources\` only if alternative sources fit the user's request. Call valyu_datasources ` +
              `to see every dataset you can search.`,
          );
        }
        if (err.code === "tier_insufficient") {
          const rec = err.recovery;
          const plan = planLabel(err.currentTier);
          const required = rec?.requiredPlan;
          const neededName =
            required?.name ?? planLabel(required?.id ?? rec?.requiredTier);
          const needed =
            neededName && required?.price
              ? `${neededName} (${required.price})`
              : neededName;
          const datasets = rec?.excludedDatasets ?? [];
          const several = datasets.length > 1;

          const lines = [
            `${context} failed: ${requestedDatasets(datasets)} not included in ` +
              `${plan ? `the current plan (${plan})` : "the current plan"}.`,
            "",
            PRESERVE_SCOPE,
            "",
          ];
          if (needed) {
            lines.push(
              `To reach ${several ? "these datasets" : "this dataset"} specifically, ` +
                `${several ? "they are" : "it is"} included from the ${needed} plan upward.`,
            );
          } else if (rec?.contactUrl && err.body) {
            // No one plan covers a mix of plan and licensed datasets; the
            // API's own sentence says which plan adds which dataset.
            lines.push(`Details from Valyu: ${err.body}`);
          }
          lines.push(
            rec?.upgradeUrl
              ? `Upgrade: ${rec.upgradeUrl}`
              : `Plan information: https://www.valyu.ai/pricing.`,
          );
          // A request mixing plan datasets with licensed or unknown ids: the
          // upgrade covers only the former, so say where the rest come from.
          if (rec?.contactUrl) {
            lines.push(
              "",
              `Some of the requested datasets are licensed separately or are not ` +
                `valid dataset ids, so no plan includes them. For access to those, ` +
                `contact Valyu: ${rec.contactUrl}`,
            );
          }
          lines.push(
            "",
            `Call valyu_datasources to see exactly which datasets are ` +
              `listed for the account and where access remains unconfirmed.`,
          );
          return toolError(lines.join("\n"));
        }
        // Every named dataset is licensed separately or is not a dataset id,
        // so no plan change unlocks any of them. Never present it as an upgrade.
        if (err.code === "dataset_unavailable") {
          const rec = err.recovery;
          const datasets = rec?.excludedDatasets ?? [];
          const several = datasets.length > 1;
          return toolError(
            [
              `${context} failed: ${requestedDatasets(datasets)} licensed separately ` +
                `or ${several ? "not valid dataset ids" : "not a valid dataset id"}, so ` +
                `switching plans does not unlock ${several ? "them" : "it"}.`,
              "",
              PRESERVE_SCOPE,
              "",
              `For access to a separately licensed dataset, contact Valyu: ` +
                `${rec?.contactUrl ?? "https://www.valyu.ai/contact"}`,
              "",
              `Call valyu_datasources to check the ids and see which datasets ` +
                `the account can search.`,
            ].join("\n"),
          );
        }
        // Not every 403 is a bad key. The API also uses it for limits a key
        // has not been granted - "Must be between 1 and 20. Contact Valyu for
        // higher limits." - and its own wording says what to do far better
        // than a generic credential message, which sent callers off to check
        // a key that was working fine.
        const said = err.body?.replace(/\s+/g, " ").trim();
        if (
          said &&
          !/credential|api[_ -]?key|unauthor|invalid token/i.test(said)
        ) {
          return toolError(
            `${context} failed (HTTP ${err.status}): ${said}\n\n` +
              `This is a limit on the account rather than a problem with the ` +
              `request. Adjust the request to fit, or ask Valyu to raise it.`,
          );
        }
        return toolError(
          `${context} failed: the Valyu API rejected the credential ` +
            `(HTTP ${err.status}). Check the key sent as \`Authorization: Bearer ` +
            `<VALYU_API_KEY>\` is valid and active at https://platform.valyu.ai.`,
        );
      }
      case 402:
        // Not a fault in the request or the tool: the account has run out of
        // credits (or hit its spending cap). A retry will not help, so say
        // what unblocks it instead. Keep `CREDITS_EXHAUSTED_MARK` in the first
        // line.
        return toolError(
          `${context} failed (${CREDITS_EXHAUSTED_MARK}): the account has insufficient available credits or has reached its spending limit.\n\n` +
            `This is the state of the Valyu account, not a problem with the request. ` +
            `Do not retry while the account has insufficient available credits. ` +
            `Explain the account limitation and continue only with information already available.`,
        );
      case 429: {
        // Temporary, not an account problem: the server's own message already
        // states the plan, the limit and how long to wait - don't re-derive or
        // re-summarise those numbers here. Keep `RATE_LIMITED_MARK` in the
        // first line.
        const retryLine =
          err.retryAfter != null
            ? `Wait at least ${err.retryAfter}s, then retry.`
            : `Wait a few seconds, then retry.`;
        const linkLine = err.upgradeUrl
          ? `Upgrade: ${err.upgradeUrl}`
          : err.contactUrl
            ? `Contact: ${err.contactUrl}`
            : undefined;
        return toolError(
          [
            `${context} failed (${RATE_LIMITED_MARK}): ${err.body}`,
            "",
            `This is temporary traffic shaping, not a rejected request. ${retryLine}`,
            ...(linkLine ? ["", linkLine] : []),
          ].join("\n"),
        );
      }
      case 400:
        return toolError(
          `${context} failed: the request was rejected as invalid - ${err.body}\n\n` +
            `Check date formats are YYYY-MM-DD and that \`included_sources\` values come ` +
            `from valyu_datasources.`,
        );
      case 404:
        return toolError(
          `${context} failed: not found - ${err.body}\n\n` +
            `Check the id is correct and has not expired.`,
        );
      case 422:
        // Not transient: the scope genuinely has no matching data.
        return toolError(
          `${context} returned no usable data - ${err.body}\n\n` +
            `No usable matches were returned for this query and scope. Preserve the user's ` +
            `source and date restrictions. Rephrase the query, or broaden filters only if ` +
            `that is consistent with the request.`,
        );
      default:
        return toolError(
          `${context} failed with HTTP ${err.status}: ${err.body}\n\n` +
            `This is usually transient - retry once. If it persists, simplify ` +
            `the query or reduce \`max_num_results\`.`,
        );
    }
  }

  if (isTimeout(err)) {
    return toolError(
      `${context} timed out. Retry with a narrower query, a shorter ` +
        `\`response_length\`, or fewer \`max_num_results\`.`,
    );
  }

  const msg = err instanceof Error ? err.message : String(err);
  return toolError(
    `${context} failed: ${msg}\n\nRetry once; if it persists, simplify the request.`,
  );
}

/**
 * One bullet per rejected token. The suggestions are the load-bearing part:
 * the model cannot see the catalogue, so a bare "unknown value" leaves it
 * guessing. `noMatchNote` is appended when there is nothing to suggest.
 */
function suggestionLines(
  unresolved: UnresolvedSource[],
  noMatchNote = "",
): string {
  return unresolved
    .map((u) =>
      u.didYouMean.length
        ? `  - "${u.token}" - did you mean: ${u.didYouMean.map((d) => `\`${d}\``).join(", ")}?`
        : `  - "${u.token}"${noMatchNote}`,
    )
    .join("\n");
}

/**
 * `excluded_sources` is not expanded upstream: presets and collections are
 * read there as dataset ids and fail the request, so they are caught here.
 */
export function excludedSourcesError(
  unresolved: UnresolvedSource[],
): ToolError {
  return toolError(
    `Unusable value(s) in \`excluded_sources\`:\n${suggestionLines(unresolved)}\n\n` +
      `It takes domains, URL prefixes and dataset ids only. Presets and ` +
      `collections work in \`included_sources\` but are not expanded here, so ` +
      `naming one loses the whole search.\n` +
      `Example: excluded_sources: ["reddit.com", "valyu/valyu-arxiv"]`,
  );
}

/** Build the "you passed unknown sources" message with suggestions. */
export function unresolvedSourcesError(
  unresolved: UnresolvedSource[],
): ToolError {
  return toolError(
    `Unknown value(s) in \`included_sources\`:\n` +
      `${suggestionLines(unresolved, " - no close match")}\n\n` +
      `A dataset id must come from valyu_datasources(query); a domain or URL ` +
      `prefix (e.g. "arxiv.org") is passed straight through. If alternative sources fit the user's request, omit ` +
      `\`included_sources\` to search sources available to the account.\n` +
      `Example: included_sources: ["valyu/valyu-arxiv"]`,
  );
}
