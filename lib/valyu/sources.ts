/**
 * Live source registry.
 *
 * Dataset ids are never hardcoded: a hardcoded list goes stale as datasets
 * are added and retired, and a single unreachable id fails the WHOLE search
 * request. So ids are resolved and validated against the live
 * /v1/datasources registry before calling search, and an unknown id comes
 * back as an actionable error instead of a 403.
 *
 * Presence in the registry is the signal used; `access_modes` is not relied
 * on for this check.
 */

import type { Datasource, DatasourceCategory } from "./types";
import { ValyuClient } from "./client";
import { canAccess, planLabel, type Entitlements } from "./entitlements";

export interface SourceCatalog {
  sources: Datasource[];
  byId: Map<string, Datasource>;
  categories: Record<string, DatasourceCategory>;
}

/**
 * The catalogue is read fresh on every call. It is the list of datasets a
 * caller can search and whether their plan covers them, and a cached copy
 * means a newly launched dataset is invisible until the entry ages out.
 */
export async function getCatalog(client: ValyuClient): Promise<SourceCatalog> {
  const res = await client.datasources();
  const sources = res.datasources ?? [];
  return {
    sources,
    byId: new Map(sources.map((s) => [s.id, s])),
    categories: res.categories ?? {},
  };
}

/** A token we could not resolve, with the closest catalogue entries to it. */
export interface UnresolvedSource {
  token: string;
  didYouMean: string[];
}

export interface ResolvedSources {
  /** Scoping values to send upstream: dataset ids, domains, URLs, presets. */
  ids: string[];
  unresolved: UnresolvedSource[];
}

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

const TOKEN_RE = /[a-z0-9]+/g;
function tokensOf(text: string): Set<string> {
  return new Set(text.toLowerCase().match(TOKEN_RE) ?? []);
}

function sourceText(s: Datasource, catalog: SourceCatalog): string {
  const cat = s.category ? catalog.categories[s.category] : undefined;
  return [
    s.id,
    s.name,
    s.description,
    s.category,
    cat?.name,
    cat?.description,
    ...(s.topics ?? []),
    ...(s.example_queries ?? []),
  ]
    .filter(Boolean)
    .join("\n");
}

/** Discovery reports available sources without starting a content search. */
const WEB_NOTE =
  `\n\nFor a requested content search, pass the selected dataset id in included_sources. ` +
  `An unscoped search also includes the web; keep any source restriction the user requested.`;

/**
 * Local lexical ranking over the catalogue: token overlap in both directions
 * plus a bonus for the id/name themselves. Fails open - always returns the
 * closest datasets rather than nothing - because an empty answer from a
 * discovery tool reads as "this does not exist" to a model. Used when the
 * semantic endpoint is unavailable and for did-you-mean suggestions.
 */
function rankSourcesLocally(
  query: string,
  catalog: SourceCatalog,
  limit = 8,
): { id: string; score: number }[] {
  // Namespace and filler tokens match every row and only add noise.
  const STOP = new Set([
    "valyu",
    "dataset",
    "datasets",
    "data",
    "the",
    "a",
    "of",
    "for",
    "and",
  ]);
  const q = new Set([...tokensOf(query)].filter((t) => !STOP.has(t)));
  if (!q.size) return [];
  const scored = catalog.sources.map((s) => {
    const doc = tokensOf(sourceText(s, catalog));
    let hit = 0;
    for (const t of q) if (doc.has(t)) hit++;
    const idTokens = tokensOf(`${s.id} ${s.name ?? ""}`);
    let idHit = 0;
    for (const t of q) if (idTokens.has(t)) idHit++;
    // Query coverage dominates; id/name hits break ties strongly.
    const score = hit / q.size + 0.5 * (idHit / q.size);
    return { id: s.id, score };
  });
  return scored
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/**
 * Ranked dataset ids for a natural-language query. Semantic endpoint first
 * (server-side ranking); local lexical ranking when
 * that is unavailable or empty. Never returns an empty list for a query that
 * shares a single token with any dataset.
 */
export async function rankSources(
  client: ValyuClient,
  query: string,
  catalog: SourceCatalog,
  limit = 8,
): Promise<{
  ranked: { id: string; score: number }[];
  mode: "semantic" | "lexical";
}> {
  try {
    const res = await client.searchDatasources(query, limit);
    const ranked = (res.results ?? [])
      .filter((r) => catalog.byId.has(r.id))
      .map((r) => ({ id: r.id, score: r.relevance_score ?? 0 }));
    if (ranked.length) return { ranked, mode: "semantic" };
  } catch {
    // Endpoint absent (older deployments), auth, or transient - fall through.
  }
  return { ranked: rankSourcesLocally(query, catalog, limit), mode: "lexical" };
}

/** Cheap edit-distance-ish similarity for "did you mean" suggestions. */
function similarity(a: string, b: string): number {
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (y.includes(x) || x.includes(y)) return 0.85;
  let hits = 0;
  for (let i = 0; i < x.length - 1; i++) {
    if (y.includes(x.slice(i, i + 2))) hits++;
  }
  return hits / Math.max(1, x.length - 1);
}

/**
 * Preset scopes the search API expands in `included_sources`, alongside
 * dataset ids. These are the API's own groupings, NOT the catalogue's
 * categories: catalogue category ids ("research", "markets", "company",
 * "economic", "healthcare") are not presets and are rejected upstream.
 *
 * Presets are only expanded for `included_sources`; the API applies no
 * expansion to `excluded_sources`, where a preset name would be read as a
 * dataset id and fail the request. Hence the `allowPresets` flag below.
 */
const PRESETS = new Set([
  "academic",
  "automotive",
  "chemistry",
  "compliance",
  "cybersecurity",
  "earnings",
  "environment",
  "finance",
  "genomics",
  "health",
  "legal",
  "medical",
  "patent",
  "patents",
  "physics",
  "politics",
  "pulse",
  "transportation",
]);

/**
 * A domain, host, URL or URL prefix - anything that scopes web results to a
 * site. Deliberately loose: the API is the authority on what it can match,
 * and the only job here is to tell "sec.gov" apart from a mistyped dataset
 * name.
 */
function isDomainOrUrl(token: string): boolean {
  if (/^https?:\/\//i.test(token)) return true;
  if (/\s/.test(token)) return false;
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+([/?#].*)?$/i.test(token);
}

/**
 * Every scoping value the search API accepts, resolved or passed through:
 *
 *   - an exact dataset id            "valyu/valyu-arxiv"
 *   - a domain                       "arxiv.org", "www.sec.gov"
 *   - a URL or URL prefix            "https://example.com/blog"
 *   - the literal "web"              add the live web to a scoped search
 *   - a preset                       "academic", "finance", "legal", …
 *   - a saved collection             "collection:my-sources"
 *
 * Validation is not pedantry: an unrecognised token fails the WHOLE request
 * upstream (verified - `included_sources: ["bogusword"]` answers "your plan
 * does not include access to: bogusword" and returns nothing), so a typo
 * would silently cost the caller the search. Domains, URLs and collections
 * cannot be checked against anything local, so they pass through untouched;
 * a dataset id must match the catalogue exactly, and anything left over comes
 * back to the model with suggestions rather than being guessed at.
 */
export function resolveSources(
  tokens: string[],
  catalog: SourceCatalog,
  { allowPresets = true }: { allowPresets?: boolean } = {},
): ResolvedSources {
  const ids: string[] = [];
  const unresolved: UnresolvedSource[] = [];
  const seen = new Set<string>();

  const push = (id: string) => {
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  };

  for (const raw of tokens) {
    const token = raw.trim();
    if (!token) continue;

    const lower = token.toLowerCase();

    if (lower === "web") {
      push("web");
      continue;
    }

    const isCollection = lower.startsWith("collection:");
    if (isCollection || PRESETS.has(lower)) {
      if (!allowPresets) {
        unresolved.push({ token, didYouMean: [] });
        continue;
      }
      // Collection names keep the caller's casing; presets are normalised.
      push(isCollection ? token : lower);
      continue;
    }

    // Domains, URLs and URL prefixes scope results to a site. Not in the
    // catalogue and not checkable locally, so forward them as given.
    if (isDomainOrUrl(token)) {
      push(token);
      continue;
    }

    // 1. exact id
    if (catalog.byId.has(token)) {
      push(token);
      continue;
    }

    // A bare name is NOT resolved to a dataset id. Rewriting "pubmed" into
    // "valyu/valyu-pubmed" means the source searched is not the source the
    // caller named, and the caller never sees the substitution. Ids come from
    // valyu_datasources, exact; anything else comes back with suggestions.

    // 3. give up, but help the model self-correct. Token ranking first - it
    // sees names, descriptions and example queries, so "valyu/wiley" or
    // "fundamentals" land on the right datasets; the string-distance pass
    // only catches typos, and on its own is dominated by the shared
    // "valyu/valyu-" prefix.
    const tokenRanked = rankSourcesLocally(token, catalog, 4).map((x) => x.id);
    const byDistance = catalog.sources
      .map((s) => ({
        id: s.id,
        score: similarity(
          token.replace(/^valyu\/(valyu-)?/i, ""),
          (s.id.split("/").pop() ?? s.id).replace(/^valyu-/, ""),
        ),
      }))
      .filter((x) => x.score > 0.5)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)
      .map((x) => x.id);
    const suggestions = [...new Set([...tokenRanked, ...byDistance])].slice(
      0,
      4,
    );
    unresolved.push({ token, didYouMean: suggestions });
  }

  return { ids, unresolved };
}

/**
 * `source_biases` is a soft ranking nudge, unlike the hard include/exclude
 * filters: it boosts or demotes a domain while leaving the rest of the corpus
 * in play. The API takes an object of source to integer in [-5, +5] and
 * rejects the whole request on a malformed entry, so the cases it 400s on are
 * checked here instead: a blank or spaced key, a case-insensitive duplicate,
 * and an out-of-range or non-integer value (the last two via the schema).
 * Returns a message when the map is unusable, otherwise undefined.
 */
export function validateSourceBiases(
  biases: Record<string, number>,
): string | undefined {
  const seen = new Set<string>();
  for (const [source, bias] of Object.entries(biases)) {
    const key = source.trim();
    if (!key || /\s/.test(key)) {
      return (
        `\`source_biases\` key "${source}" is not a source. Use a domain or ` +
        `URL prefix with no spaces, e.g. {"nasa.gov": 5, "pinterest.com": -3}.`
      );
    }
    const lower = key.toLowerCase();
    if (seen.has(lower)) {
      return (
        `\`source_biases\` names "${key}" twice (keys are case-insensitive). ` +
        `Give each source one bias.`
      );
    }
    seen.add(lower);
  }
  return undefined;
}

/** Compact catalog rendering for the discovery tool. */
export function renderCatalog(
  catalog: SourceCatalog,
  opts: {
    /** Pre-ranked ids for a free-text query (see rankSources). */
    ranked?: {
      ranked: { id: string; score: number }[];
      mode: "semantic" | "lexical";
      query: string;
    };
    entitlements?: Entitlements;
  } = {},
): string {
  const sources = catalog.sources;

  // Query mode: a flat best-first list. Grouping by category would hide the
  // ranking, and the ranking is the whole answer.
  if (opts.ranked) {
    const { ranked, mode, query } = opts.ranked;
    const inScope = new Set(sources.map((s) => s.id));
    const hits = ranked.filter((r) => inScope.has(r.id));
    if (!hits.length) {
      return (
        `No dataset in the catalog resembles "${query}". ` +
        `If alternative sources fit the user's request, an unscoped valyu_search can search the web and other sources available to the account.`
      );
    }
    const ent = opts.entitlements;
    const lines = hits.map((r, i) => {
      const s = catalog.byId.get(r.id)!;
      const access = ent?.known ? canAccess(ent, s.id) : undefined;
      const accessLabel = access ? "COVERED" : "UNKNOWN - access not confirmed";
      const accessSuffix = ent ? ` (${accessLabel})` : "";
      const desc = (s.description ?? "").replace(/\s+/g, " ").slice(0, 150);
      const line = `${i + 1}. \`${s.id}\`${accessSuffix} - ${desc}${desc.length === 150 ? "…" : ""}`;
      // The dataset's own example queries are the highest-value field here.
      // Structured corpora (economic series, fundamentals, filings metadata)
      // answer plain-language questions and return nothing for the series
      // codes and ticker-style phrasing a model reaches for unprompted:
      // "CPI inflation data since 2020" returns the series where "CPIAUCSL
      // consumer price index all urban consumers" returns no rows. Showing
      // the phrasing that works is what makes calling this tool first pay.
      const examples = (s.example_queries ?? []).slice(0, 3);
      return examples.length
        ? `${line}\n   Phrase queries like: ${examples.map((q) => `"${q}"`).join(", ")}`
        : line;
    });
    return (
      `Closest datasets for "${query}" (${mode} match, best first). ` +
      `Ranking indicates a possible match, not confirmed coverage.\n\n` +
      lines.join("\n") +
      WEB_NOTE
    );
  }

  const ent = opts.entitlements;

  const grouped = new Map<string, Datasource[]>();
  for (const s of sources) {
    const c = s.category ?? "other";
    if (!grouped.has(c)) grouped.set(c, []);
    grouped.get(c)!.push(s);
  }

  const known = ent?.known ? ent : undefined;

  const lines: string[] = [
    `${sources.length} dataset${sources.length === 1 ? "" : "s"} in the catalog. ` +
      `Pass dataset ids as \`included_sources\` to valyu_search, or omit them to route automatically.`,
  ];

  if (known) {
    const plan = planLabel(known.currentTier);
    lines.push(
      "",
      known.fullAccess
        ? `Plan: ${plan ?? "current plan"} - every dataset shown is included.`
        : `Plan: ${plan ?? "current plan"}. Access not confirmed by the API is marked UNKNOWN.`,
    );
  }

  lines.push("");

  for (const [cat, items] of [...grouped.entries()].sort()) {
    const meta = catalog.categories[cat];
    lines.push(`## ${meta?.name ?? cat}`);
    for (const s of items) {
      const desc = (s.description ?? "").replace(/\s+/g, " ").trim();
      const access = known ? canAccess(known, s.id) : undefined;
      const accessLabel = access ? "COVERED" : "UNKNOWN - access not confirmed";
      const mark = ent ? ` **[${accessLabel}]**` : "";
      lines.push(
        `- \`${s.id}\`${mark} - ${desc.slice(0, 150)}${desc.length > 150 ? "…" : ""}`,
      );
    }
    lines.push("");
  }
  lines.push(WEB_NOTE);
  return lines.join("\n");
}
