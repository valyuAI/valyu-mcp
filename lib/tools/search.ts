import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { ValyuApiError, ValyuClient } from "@/lib/valyu/client";
import { getEntitlements } from "@/lib/valyu/entitlements";
import {
  getCatalog,
  rankSources,
  renderCatalog,
  resolveSources,
  validateSourceBiases,
} from "@/lib/valyu/sources";
import { renderSearch } from "@/lib/mcp/format";
import {
  excludedSourcesError,
  renderApiError,
  toolError,
  unresolvedSourcesError,
} from "@/lib/mcp/errors";
import type { RequestContext } from "@/lib/mcp/auth";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Search external sources with optional source and publication-date filters. */
const SEARCH_DESCRIPTION = `Search the web and specialised indexes for source-backed research, current information, or a specific document or data record. Indexes include academic publications, SEC filings, financial data, clinical trials, biomedical databases, economic indicators, patents and legal sources. valyu_datasources lists current datasets and access information.

Returns ranked source excerpts with links, relevance scores and available metadata. response_length is optional: omit it to use the API default, or choose a preset or character limit per result. Content is returned as supplied by the API.

Use a focused natural-language query. Omit filters for automatic routing. When the user names a source, preserve that scope: included_sources accepts dataset ids, domains, URL prefixes and supported presets. Use valyu_datasources to resolve dataset ids rather than guessing them. Preserve explicit source and date restrictions; broaden them only when the user requests it.

Use date filters for an explicit publication window. A forecast year in the query is not a publication date. For the latest available value, ask for "latest" without inferring a narrow date window; periodic data can be dated at the start of its reporting period.

Do not use for general knowledge that needs no lookup, writing or coding that needs no external information, or personalised buy/sell decisions. valyu_contents reads a known URL; valyu_deepresearch starts a requested multi-step research report.`;

const searchInputSchema = {
  query: z
    .string()
    .min(1)
    .describe(
      "Focused natural-language search query. Preserve subject names, identifiers and years relevant to the request.",
    ),
  included_sources: z
    .array(z.string())
    .optional()
    .describe(
      "Hard source filter: dataset ids from valyu_datasources, domains, URL prefixes, supported presets (academic, finance, legal), or web. Preserve a source restriction the user requested. Unknown dataset ids are rejected.",
    ),
  source_biases: z
    .record(z.string(), z.coerce.number().int().min(-5).max(5))
    .optional()
    .describe(
      "Requested source preferences: map domains or URL prefixes to integers from -5 to 5; 0 is neutral. Reweights results without excluding other sources.",
    ),
  excluded_sources: z
    .array(z.string())
    .optional()
    .describe(
      "Sources the user asked to exclude, as dataset ids, domains or URL prefixes.",
    ),
  max_num_results: z.coerce
    .number()
    .int()
    .min(1)
    .max(100)
    .default(10)
    .describe(
      "Maximum number of results or document chunks (1-100, default 10). Account permissions may restrict larger requests.",
    ),
  response_length: z
    .union([
      z.enum(["short", "medium", "large", "max"]),
      z.number().int().positive(),
    ])
    .optional()
    .describe(
      "Optional API response length per result: short (25000 characters, API default), medium (50000), large (100000), max (all available content), or a positive integer character limit. Structured search records may be returned whole. Omit to use the API default.",
    ),
  start_date: z
    .string()
    .optional()
    .describe(
      "Include results published on or after this date (YYYY-MM-DD). Use only for the requested publication window. Periodic data can be dated at the start of its reporting period.",
    ),
  end_date: z
    .string()
    .optional()
    .describe(
      "Include results published on or before this date (YYYY-MM-DD). Use only for the requested publication window.",
    ),
  include_images: z
    .boolean()
    .default(false)
    .describe(
      "Include available figure links with results. Some links expire and may require repeating the search; web images can include page decoration.",
    ),
  country_code: z
    .string()
    .length(2)
    .optional()
    .describe(
      "Country preference requested by the user, as an ISO 3166-1 alpha-2 code such as GB or US.",
    ),
};

export interface ToolDeps {
  ctx: RequestContext;
  signal?: AbortSignal;
}

export function registerSearchTool(server: McpServer, deps: ToolDeps): void {
  server.tool(
    "valyu_search",
    SEARCH_DESCRIPTION,
    searchInputSchema,
    {
      title: "Valyu search",
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true,
    },
    async (args) => {
      const {
        query,
        included_sources,
        excluded_sources,
        source_biases,
        max_num_results,
        response_length,
        start_date,
        end_date,
        country_code,
        include_images,
      } = args;

      for (const [name, val] of [
        ["start_date", start_date],
        ["end_date", end_date],
      ] as const) {
        if (val && !ISO_DATE.test(val)) {
          return toolError(
            `\`${name}\` must be formatted YYYY-MM-DD (got "${val}"). ` +
              `Example: ${name}: "2026-01-15".`,
          );
        }
      }

      if (source_biases) {
        const problem = validateSourceBiases(source_biases);
        if (problem) return toolError(problem);
      }

      const client = new ValyuClient(
        deps.ctx.apiKey,
        deps.signal,
        "valyu_search",
      );

      let resolvedSources: string[] | undefined;
      let resolvedExclusions: string[] | undefined;
      let sourcesUsed: string[] | undefined;

      if (included_sources?.length || excluded_sources?.length) {
        let catalog;
        try {
          catalog = await getCatalog(client);
        } catch (err) {
          return renderApiError(err, "Loading the dataset catalog");
        }

        if (included_sources?.length) {
          const resolved = resolveSources(included_sources, catalog);
          if (resolved.unresolved.length) {
            return unresolvedSourcesError(resolved.unresolved);
          }
          if (resolved.ids.length === 0) {
            return toolError(
              `\`included_sources\` resolved to nothing. Call valyu_datasources ` +
                `to see available datasets. If alternative sources fit the user's request, omit \`included_sources\` to ` +
                `search sources available to the account.`,
            );
          }
          resolvedSources = resolved.ids;
          // Report what the caller actually scoped to - every token resolved,
          // so echo the input rather than a partial view of it.
          sourcesUsed = [...new Set(included_sources.map((s) => s.trim()))];
        }

        if (excluded_sources?.length) {
          // No preset expansion here: upstream reads a preset name in
          // `excluded_sources` as a dataset id and 403s the whole request.
          // See PRESETS in lib/valyu/sources.ts.
          const resolved = resolveSources(excluded_sources, catalog, {
            allowPresets: false,
          });
          if (resolved.unresolved.length) {
            return excludedSourcesError(resolved.unresolved);
          }
          resolvedExclusions = resolved.ids;
        }
      }

      try {
        // No `search_type`: naming sources already says what to search, and
        // forcing "proprietary" alongside them made domains and presets return
        // nothing. The API picks the right mode from `included_sources`.
        const res = await client.search({
          query,
          max_num_results,
          included_sources: resolvedSources,
          excluded_sources: resolvedExclusions,
          source_biases,
          start_date,
          end_date,
          country_code,
          response_length,
        });

        if (!res.success && res.error) {
          return toolError(
            `Search failed: ${res.error}\n\nRetry if the error is temporary. Adjust the query or filters only ` +
              `when consistent with the user’s requested source and date scope.`,
          );
        }

        const text = renderSearch(res, {
          query,
          sourcesUsed,
          includeImages: include_images,
        });
        return { content: [{ type: "text" as const, text }] };
      } catch (err) {
        return renderApiError(err, "Search");
      }
    },
  );
}

/** Discover dataset ids and their current access information. */
export function registerSourcesTool(server: McpServer, deps: ToolDeps): void {
  server.tool(
    "valyu_datasources",
    `List or find Valyu datasets and their exact ids, descriptions, example queries and current plan access. Use when the user asks what datasets exist or when a requested source needs a dataset id for valyu_search's included_sources.

Pass query for a ranked subset; omit it for the full catalogue. Access is reported as covered by the account or unconfirmed when it cannot be checked. Dataset discovery does not itself run a content search.`,
    {
      query: z
        .string()
        .optional()
        .describe(
          'Describe the data you need in plain language, e.g. "peer-reviewed medical literature", "FDA drug labels", "insider transactions", "CPI inflation". Returns possible dataset matches ranked by relevance.',
        ),
      check_access: z
        .boolean()
        .default(true)
        .describe(
          "Show account-reported dataset coverage when available; access not confirmed by the account API remains unknown. Set false to omit access annotations.",
        ),
      category: z
        .string()
        .optional()
        .describe("Only list datasets in this category ID."),
    },
    {
      title: "List Valyu datasets",
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
    async ({ query, check_access, category }) => {
      const client = new ValyuClient(
        deps.ctx.apiKey,
        deps.signal,
        "valyu_datasources",
      );
      try {
        const full = await getCatalog(client);
        const catalog = category
          ? {
              ...full,
              sources: full.sources.filter((src) => src.category === category),
            }
          : full;
        // Never let entitlement resolution break listing: it is an annotation,
        // not the point of the tool.
        const entitlements = check_access
          ? await getEntitlements(
              client,
              catalog.sources.map((s) => s.id),
            ).catch(() => undefined)
          : undefined;
        const ranked = query?.trim()
          ? {
              ...(await rankSources(client, query.trim(), catalog, 8)),
              query: query.trim(),
            }
          : undefined;
        const text = renderCatalog(catalog, { ranked, entitlements });
        return { content: [{ type: "text" as const, text }] };
      } catch (err) {
        return renderApiError(err, "Listing datasets");
      }
    },
  );
}
