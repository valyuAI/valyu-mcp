/** Render source content without additional content limits. */

import type {
  ContentsResponse,
  SearchResponse,
  SearchResult,
} from "@/lib/valyu/types";

function asText(content: unknown): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(asText).join("\n");
  if (typeof content === "object") {
    // Preserve structured payloads as JSON.
    return JSON.stringify(content);
  }
  return String(content);
}

/**
 * Figures, where a corpus extracts them. Papers carry one or more real
 * figures (a methodology diagram, a results plot) as presigned URLs a client
 * can fetch directly; web results carry whatever the page linked, which
 * includes furniture like licence badges. Opt-in, because each URL is long
 * and only some clients can render an image.
 *
 * The links are presigned and expire about an hour after the search, so they
 * are for use now, not for storing.
 */
const MAX_IMAGES_PER_RESULT = 4;

/**
 * A presigned link can arrive already past its hour-long window. Handing a
 * model a link that 403s is worse than telling it the link is stale, so say
 * which it is.
 */
function isExpiredPresigned(url: string): boolean {
  const at = /[?&]X-Amz-Date=(\d{8}T\d{6}Z)/.exec(url)?.[1];
  const ttl = /[?&]X-Amz-Expires=(\d+)/.exec(url)?.[1];
  if (!at || !ttl) return false;
  const iso = `${at.slice(0, 4)}-${at.slice(4, 6)}-${at.slice(6, 11)}:${at.slice(11, 13)}:${at.slice(13, 15)}Z`;
  const signed = Date.parse(iso);
  if (Number.isNaN(signed)) return false;
  return Date.now() > signed + Number(ttl) * 1000;
}

function imageUrlsOf(raw: unknown): string[] {
  if (!raw) return [];
  const vals =
    typeof raw === "string"
      ? [raw]
      : Array.isArray(raw)
        ? raw
        : typeof raw === "object"
          ? Object.values(raw as Record<string, unknown>)
          : [];
  return vals
    .filter((v): v is string => typeof v === "string" && /^https?:\/\//.test(v))
    .slice(0, MAX_IMAGES_PER_RESULT);
}

const DIAGNOSTIC_METADATA = new Set([
  "requestid",
  "traceid",
  "sessionid",
  "transactionid",
  "txid",
  "timestamp",
  "telemetry",
  "logging",
]);

function renderMetadata(meta: unknown): string | undefined {
  if (!meta || typeof meta !== "object" || Array.isArray(meta))
    return undefined;
  return (
    Object.entries(meta)
      .filter(
        ([key]) =>
          !DIAGNOSTIC_METADATA.has(
            key.replace(/[^a-z0-9]/gi, "").toLowerCase(),
          ),
      )
      .map(([key, value]) => `${key}: ${asText(value)}`)
      .join(" · ") || undefined
  );
}

/**
 * The response's `warnings` (a dataset outside the plan was skipped, a limit
 * was capped, a collection was not found) as a short section of their own
 * messages, or "" when there are none. Items are `{type, message, detail?}`;
 * older responses send plain strings. Anything else is ignored.
 */
export function renderWarnings(warnings: unknown): string {
  if (!Array.isArray(warnings)) return "";
  const lines = warnings.flatMap((w) => {
    const m = typeof w === "string" ? w : w?.message;
    const text = typeof m === "string" ? m.replace(/\s+/g, " ").trim() : "";
    return text ? [`- ${text}`] : [];
  });
  return lines.length ? `Warnings:\n${lines.join("\n")}` : "";
}

function resultsOf(res: SearchResponse): SearchResult[] {
  return res.results ?? res.data?.results ?? [];
}

/** Separate API errors from its benign "no results" message. */
function upstreamFailure(res: SearchResponse): string | undefined {
  const raw = typeof res.error === "string" ? res.error.trim() : "";
  if (!raw) return undefined;
  if (/^no results found/i.test(raw)) return undefined;
  return raw;
}

/** Render API results without applying additional content limits. */
export function renderSearch(
  res: SearchResponse,
  opts: {
    query: string;
    sourcesUsed?: string[];
    /** Render extracted figure URLs (valyu_search `include_images`). */
    includeImages?: boolean;
  },
): string {
  // Keep every API result, including multiple chunks sharing a URL.
  const results = resultsOf(res);
  const header: string[] = [];
  const upstream = upstreamFailure(res);
  const warnings = renderWarnings(res.warnings);

  if (results.length === 0) {
    const scope = opts.sourcesUsed?.length
      ? ` in ${opts.sourcesUsed.join(", ")}`
      : "";
    // A backend that fell over is not the same as a query that matched
    // nothing. Both can arrive as HTTP 200 with zero results, and only the
    // `error` string distinguishes them. Telling a model to "try broader
    // keywords" when a source is unavailable sends it into a rewording loop
    // that cannot succeed.
    const text = upstream
      ? `Search could not complete: ${upstream}\n\n` +
        `This is an upstream availability problem, not a problem with the ` +
        `query - rewording will not help. Retry in a few seconds. If it ` +
        `persists, search a different source or tell the user this source is ` +
        `currently unavailable - do not fill the gap from memory.`
      : `No results for "${opts.query}"${scope}.\n\n` +
        `If consistent with the user’s request, revise the query or filters. ` +
        `Preserve explicit source and date restrictions. ` +
        `Call valyu_datasources to see what is available.`;
    return [text, warnings].filter(Boolean).join("\n\n");
  }

  // A "Found N results" card whose results carry no data invites a model to
  // invent the numbers, most often on structured datasets with a date filter
  // that emptied the set. An error stops a model; an empty success does not.
  // Say what happened instead.
  const withData = results.filter(
    (r) =>
      (asText(r.content) || asText(r.abstract) || asText(r.description)).trim()
        .length > 0,
  );
  if (withData.length === 0) {
    const named = results
      .slice(0, 5)
      .map(
        (r) =>
          `- ${(r.title ?? "Untitled").replace(/\s+/g, " ").trim()}${r.source ? ` (${r.source})` : ""}`,
      )
      .join("\n");
    const text =
      `${results.length} result${results.length === 1 ? "" : "s"} matched "${opts.query}" but ` +
      `returned NO data rows:\n${named}\n\n` +
      `The empty data may reflect query phrasing, filters or source coverage. ` +
      `Preserve the user's source and date restrictions; adjust filters only when consistent with the request. ` +
      `valyu_datasources(query) provides the dataset's example queries.\n` +
      `Do not infer values from the titles above - there are none.`;
    return [text, warnings].filter(Boolean).join("\n\n");
  }

  header.push(
    `Found ${results.length} result${results.length === 1 ? "" : "s"} for "${opts.query}".`,
  );
  if (opts.sourcesUsed?.length) {
    header.push(`Sources searched: ${opts.sourcesUsed.join(", ")}.`);
  }
  if (upstream) {
    header.push(
      `Partial: one or more backends failed (${upstream}) - these results are ` +
        `incomplete. Retry for full coverage.`,
    );
  }
  if (warnings) header.push(warnings);
  header.push("");

  const headerText = header.join("\n");

  // Render provenance separately from the unchanged result bodies.
  const fixed = results.map((r, i) => {
    const lines: string[] = [];
    const title = (r.title ?? "Untitled").replace(/\s+/g, " ").trim();
    lines.push(`### ${i + 1}. ${title}`);

    const meta: string[] = [];
    if (r.url) meta.push(r.url);
    if (typeof r.relevance_score === "number") {
      meta.push(`relevance: ${r.relevance_score.toFixed(2)}`);
    }
    if (r.source) meta.push(`source: ${r.source}`);
    if (r.publication_date) meta.push(`published: ${r.publication_date}`);
    if (Array.isArray(r.authors) && r.authors.length) {
      meta.push(`authors: ${r.authors.join(", ")}`);
    }
    if (r.doi) meta.push(`doi: ${r.doi}`);
    if (typeof r.citation_count === "number") {
      meta.push(`cited by: ${r.citation_count}`);
    }
    // Identifiers a reader looks the document up by, where the corpus has them.
    if (r.pmid) meta.push(`pmid: ${r.pmid}`);
    if (r.pmcid) meta.push(`pmcid: ${r.pmcid}`);
    if (meta.length) lines.push(meta.join(" · "));

    const extra = renderMetadata(r.metadata);
    if (extra) lines.push(extra);
    if (typeof r.citation === "string" && r.citation.trim()) {
      lines.push(`cite: ${r.citation.replace(/\s+/g, " ").trim()}`);
    }
    if (opts.includeImages) {
      for (const u of imageUrlsOf(r.image_url)) {
        lines.push(
          isExpiredPresigned(u)
            ? `image (link expired - re-run the search for a fresh one): ${u}`
            : `image: ${u}`,
        );
      }
    }
    return lines.join("\n");
  });

  const blocks = results.map((r, i) => {
    const body =
      asText(r.content) || asText(r.abstract) || asText(r.description);
    return body ? `${fixed[i]}\n\n${body}` : fixed[i];
  });

  return [headerText, blocks.join("\n\n")].filter(Boolean).join("\n");
}

export function renderContents(
  res: ContentsResponse,
  opts: { includeScreenshots?: boolean },
): string {
  const results = res.results ?? [];
  if (results.length === 0) {
    const text =
      `No content could be extracted.\n\n` +
      (res.error ? `Extraction error: ${res.error}\n\n` : "") +
      `The page may be paywalled, JS-rendered, or blocking crawlers. ` +
      `Retry with \`extract_effort: "high"\`, or search for the content instead.`;
    return text;
  }

  const blocks = results.map((r, i) => {
    const lines: string[] = [];
    lines.push(`### ${i + 1}. ${r.title ?? r.url ?? "Untitled"}`);
    if (r.url) lines.push(r.url);
    if (r.error) {
      lines.push(`\n> Extraction failed: ${r.error}`);
      return lines.join("\n");
    }
    if (
      opts.includeScreenshots &&
      typeof r.screenshot_url === "string" &&
      r.screenshot_url
    ) {
      lines.push(
        isExpiredPresigned(r.screenshot_url)
          ? `screenshot (link expired - call again for a fresh one): ${r.screenshot_url}`
          : `screenshot: ${r.screenshot_url}`,
      );
    }
    const summary = asText(r.summary);
    if (summary) lines.push("", `**Summary:** ${summary}`);
    const body = asText(r.content);
    if (body) lines.push("", body);
    return lines.join("\n");
  });

  return [
    res.error ? `Extraction error: ${res.error}` : "",
    blocks.join("\n\n"),
  ]
    .filter(Boolean)
    .join("\n");
}
