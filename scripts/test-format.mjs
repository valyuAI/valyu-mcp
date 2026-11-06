import assert from "node:assert/strict";
import test from "node:test";
import { renderContents, renderSearch } from "../lib/mcp/format.ts";

const search = (...results) =>
  renderSearch({ success: true, results }, { query: "record" });

test("metadata retains provided fields without inventing missing values", () => {
  for (const ticker of ["TSLA", "", undefined]) {
    const result = search({
      source: "valyu/valyu-sec-filings",
      title: "Tesla filing",
      content: "Risk factors",
      metadata: {
        ...(ticker !== undefined ? { ticker } : {}),
        form_type: "10-K",
        filing_date: "2026-01-29",
      },
    });
    if (ticker !== undefined) assert.ok(result.includes(`ticker: ${ticker}`));
    else assert.doesNotMatch(result, /ticker:/);
    assert.match(result, /form_type: 10-K/);
    assert.match(result, /filing_date: 2026-01-29/);
  }
});

test("metadata and author lists are preserved without field-specific handling or caps", () => {
  const authors = Array.from({ length: 12 }, (_, index) => `Author ${index}`);
  const details = { definition: "Complete definition ".repeat(1000) };
  const result = search({
    title: "Record",
    content: "Source content",
    authors,
    metadata: {
      timestamp: "2026-09-30T00:00:00Z",
      details,
      tags: ["one", "two"],
      count: 0,
      active: false,
    },
  });
  assert.ok(result.includes(`authors: ${authors.join(", ")}`));
  assert.ok(result.includes(`details: ${JSON.stringify(details)}`));
  assert.doesNotMatch(result, /timestamp:/);
  assert.match(result, /tags: one\ntwo/);
  assert.match(result, /count: 0/);
  assert.match(result, /active: false/);
  assert.doesNotMatch(result, /et al\.|…/);
});

test("empty extraction preserves the upstream error", () => {
  const result = renderContents(
    { success: false, error: "Extraction backend unavailable", results: [] },
    {},
  );
  assert.match(result, /No content could be extracted/);
  assert.match(result, /Extraction error: Extraction backend unavailable/);
});

test("partial extraction preserves the global error and distinguishes returned successful and failed pages", () => {
  const result = renderContents(
    {
      success: false,
      error: "One page failed",
      urls_processed: 1,
      urls_failed: 1,
      results: [
        {
          title: "Successful page",
          url: "https://example.com/success",
          content: "Extracted page content",
        },
        {
          title: "Failed page",
          url: "https://example.com/failure",
          error: "Crawler blocked",
          content: "Discard this failed page body",
        },
      ],
    },
    {},
  );
  assert.match(result, /Extraction error: One page failed/);
  assert.match(result, /Extracted page content/);
  assert.match(result, /Extraction failed: Crawler blocked/);
  assert.doesNotMatch(result, /Discard this failed page body/);
  assert.equal((result.match(/^### /gm) ?? []).length, 2);
  assert.equal((result.match(/Extraction failed:/g) ?? []).length, 1);
});

test("diagnostic wrapper metadata is excluded without filtering source content", () => {
  const content = JSON.stringify({
    timestamp: "source observation date",
    request_id: "source record field",
  });
  const result = search({
    content,
    metadata: {
      request_id: "internal-request",
      traceId: "internal-trace",
      session_id: "internal-session",
      transaction_id: "internal-transaction",
      tx_id: "internal-tx",
      timestamp: "log-time",
      created_at: "source-created",
      updated_at: "source-updated",
      telemetry: { secret: "diagnostic" },
      publication_date: "2026-09-10",
      filing_date: "2026-01-29",
      chunk_index: 3,
    },
  });
  assert.ok(result.endsWith(content));
  assert.doesNotMatch(result, /internal-|log-time|diagnostic/);
  assert.match(result, /publication_date: 2026-09-10/);
  assert.match(result, /filing_date: 2026-01-29/);
  assert.match(result, /chunk_index: 3/);
  assert.match(result, /created_at: source-created/);
  assert.match(result, /updated_at: source-updated/);
});

test("API warnings reach the model as their own messages, in object or legacy string form", () => {
  const notInPlan =
    "Your Pay-as-you-go plan doesn't include valyu/valyu-biorxiv, so it was skipped. Upgrade: https://platform.valyu.ai/user/account/billing?tab=plan";
  const warnings = [
    { type: "datasets_not_in_plan", message: notInPlan, detail: { upgrade_url: "https://platform.valyu.ai/user/account/billing?tab=plan" } },
    "Collection 'nope' not found",
    { type: "no_message" },
    null,
  ];
  const found = renderSearch(
    { success: true, results: [{ title: "Paper", content: "Body" }], warnings },
    { query: "record" },
  );
  assert.ok(
    found.startsWith(
      `Found 1 result for "record".\nWarnings:\n- ${notInPlan}\n- Collection 'nope' not found\n\n### 1. Paper`,
    ),
  );
  assert.doesNotMatch(found, /no_message|datasets_not_in_plan|upgrade_url/);

  const empty = renderSearch({ success: true, results: [], warnings }, { query: "record" });
  assert.match(empty, /^No results for "record"/);
  assert.match(empty, /\n\nWarnings:\n- Your Pay-as-you-go plan/);

  const noData = renderSearch(
    { success: true, results: [{ title: "Row" }], warnings: ["max_num_results\n  was capped at 20."] },
    { query: "record" },
  );
  assert.match(noData, /NO data rows[\s\S]*\n\nWarnings:\n- max_num_results was capped at 20\.$/);

  for (const none of [undefined, [], "not a list", [{ type: "x" }]]) {
    assert.doesNotMatch(
      renderSearch({ success: true, results: [{ title: "P", content: "B" }], warnings: none }, { query: "q" }),
      /Warnings:/,
    );
  }
});
