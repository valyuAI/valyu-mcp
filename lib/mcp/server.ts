/**
 * The server definition shared by the HTTP endpoint and the stdio entry point:
 * identity, instructions for the model, and the six tools.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { SDK_NAME, SDK_VERSION, SERVER_TITLE, SERVER_WEBSITE_URL } from "@/lib/constants";
import type { RequestContext } from "@/lib/mcp/auth";
import { registerDeepResearchTools } from "@/lib/tools/deepresearch";
import { registerExtractTool } from "@/lib/tools/extract";
import { registerSearchTool, registerSourcesTool } from "@/lib/tools/search";

export const SERVER_INFO = {
  name: SDK_NAME,
  version: SDK_VERSION,
  title: SERVER_TITLE,
  websiteUrl: SERVER_WEBSITE_URL,
};

export const SERVER_INSTRUCTIONS = `Valyu provides source-backed search and research. Use valyu_search to find information across web pages and specialised datasets, valyu_contents to read specified URLs, and valyu_datasources to discover available datasets. Use these tools when external information is needed for the user's request. General knowledge, writing and coding requests that need no external information do not call for these tools. Do not use these tools to make personalised buy/sell decisions. Financial facts and source research are supported.

Search results include source links, metadata and excerpts. Excerpts may be shortened to the requested response length; a result is not necessarily the complete document. Check dates and source coverage before drawing conclusions, and distinguish what sources establish from inference.

Search configuration:
1. Query-only search uses automatic routing across sources available to the account. Set included_sources, excluded_sources, source_biases, country_code or date filters when the user's request calls for a particular scope. Preserve explicitly requested restrictions; do not silently broaden them.
2. Use valyu_datasources to find exact dataset IDs and their access status. Website domains can also be used as source filters. Do not guess dataset IDs.
3. Publication-date filters restrict document dates. A forecast year, trial identifier or historical year in the query is not automatically a publication-date restriction. "Latest" usually calls for checking the dates of returned sources rather than assuming a fixed date window.
4. If a search is empty or incomplete, explain the limitation. Adjust the query or scope only in a way consistent with the user's request.

DeepResearch runs asynchronously and incurs a charge. Start valyu_deepresearch when the user explicitly asks for deep research or an exhaustive investigation and accepts its cost and duration. An explicit request to run deep research already authorises starting it. For ordinary summaries or briefs, search and read the necessary sources. Check progress and retrieve the report with valyu_deepresearch_status. Use valyu_deepresearch_control only for the specific action the user requests. Reports and generated files can contain errors: verify decision-critical facts, numerical claims and citations before relying on them, and disclose unresolved discrepancies.`;

/** Register every public tool against one caller's credential. */
export function registerTools(server: McpServer, ctx: RequestContext): void {
  registerSearchTool(server, { ctx });
  registerSourcesTool(server, { ctx });
  registerExtractTool(server, { ctx });
  registerDeepResearchTools(server, { ctx });
}
