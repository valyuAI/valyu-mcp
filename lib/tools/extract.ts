import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { ValyuClient } from "@/lib/valyu/client";
import { renderContents } from "@/lib/mcp/format";
import { renderApiError } from "@/lib/mcp/errors";
import type { ToolDeps } from "./search";

function hasContent(value: unknown): boolean {
  if (value == null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.some(hasContent);
  if (typeof value === "object") return Object.values(value).some(hasContent);
  return true;
}

/** Extract URL content or summaries with optional API response limits. */
export function registerExtractTool(server: McpServer, deps: ToolDeps): void {
  server.tool(
    "valyu_contents",
    `Fetch one or more URLs and return readable markdown with navigation, ads and boilerplate removed. response_length is optional: omit it to use the API default, or choose a preset or character limit per URL. Content is returned as supplied by the API.

Use this when you already have a URL and need its actual content: a page found via valyu_search, a link the user pasted, or a document you need to quote accurately.
Use valyu_search to find URLs.

Some paywalls and access controls prevent extraction. For JavaScript-rendered pages set \`extract_effort: "high"\`.

Set \`summary: true\` (or pass a string instruction) to request a summary instead of page text.

Examples:
- {"urls": ["https://example.com/paper"]}
- {"urls": ["https://a.com", "https://b.com"], "summary": "key financial figures only"}`,
    {
      urls: z
        .array(
          z
            .string()
            .url()
            .refine(
              (url) => /^https?:\/\//i.test(url),
              "URL must use http or https",
            ),
        )
        .min(1)
        .max(10)
        .describe("1-10 absolute http(s) URLs to fetch."),
      summary: z
        .union([z.boolean(), z.string().max(500)])
        .optional()
        .describe(
          'true for a general summary, or a string instruction describing what to extract, e.g. "only the methodology and results".',
        ),
      extract_effort: z
        .enum(["normal", "high", "auto"])
        .default("auto")
        .describe(
          '"normal" requests standard extraction; "high" requests JavaScript rendering; "auto" selects per URL. Access controls can still prevent extraction.',
        ),
      screenshot: z
        .boolean()
        .default(false)
        .describe(
          "Request a page screenshot link when the user's request depends on visual content, such as a chart or layout. Returned links can expire.",
        ),
      response_length: z
        .union([
          z.enum(["short", "medium", "large", "max"]),
          z.number().int().positive(),
        ])
        .optional()
        .describe(
          "Optional API response length per URL: short (25000 characters, API default), medium (50000), large (100000), max (all available content), or a positive integer character limit. Omit to use the API default.",
        ),
    },
    {
      title: "Extract page content",
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true,
    },
    async ({ urls, summary, extract_effort, screenshot, response_length }) => {
      const client = new ValyuClient(
        deps.ctx.apiKey,
        deps.signal,
        "valyu_contents",
      );
      try {
        const res = await client.contents({
          urls,
          summary,
          extract_effort,
          screenshot,
          response_length,
        });
        const rendered = renderContents(res, {
          includeScreenshots: screenshot,
        });
        const usable = res.results?.some(
          (result) =>
            !result.error &&
            (hasContent(result.content) || hasContent(result.summary)),
        );
        return {
          content: [{ type: "text" as const, text: rendered }],
          ...(!res.success || !usable ? { isError: true } : {}),
        };
      } catch (err) {
        return renderApiError(err, "Content extraction");
      }
    },
  );
}
