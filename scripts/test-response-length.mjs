import assert from "node:assert/strict";
import { test } from "node:test";
import { toolHarness, textOf } from "./test-support.mjs";

const { registerSearchTool } = await import("../lib/tools/search.ts");
const { registerExtractTool } = await import("../lib/tools/extract.ts");

const harness = (t, response) =>
  toolHarness(t, [registerSearchTool, registerExtractTool], response);

const tools = [
  {
    name: "valyu_search",
    path: "/v1/search",
    input: { query: "Original publication" },
  },
  {
    name: "valyu_contents",
    path: "/v1/contents",
    input: { urls: ["https://example.com/publication"] },
  },
];
for (const tool of tools) {
  test(`${tool.name} omits response_length so the API chooses its default`, async (t) => {
    const h = harness(t, {
      success: true,
      results: [{ content: "Upstream result" }],
    });
    const registered = h.tools.get(tool.name);
    assert.equal(registered.schema.shape.response_length.isOptional(), true);
    assert.match(registered.description, /response_length is optional/i);
    assert.match(
      registered.schema.shape.response_length.description,
      /omit to use the api default/i,
    );
    await h.call(tool.name, tool.input);
    assert.equal(h.requests.length, 1);
    assert.ok(h.requests[0].url.endsWith(tool.path));
    assert.equal(Object.hasOwn(h.requests[0].body, "response_length"), false);
  });

  test(`${tool.name} forwards named and numeric response lengths unchanged`, async (t) => {
    const h = harness(t, {
      success: true,
      results: [{ content: "Upstream result" }],
    });
    for (const length of [
      "short",
      "medium",
      "large",
      "max",
      1,
      30000,
      1_000_000,
    ]) {
      await h.call(tool.name, { ...tool.input, response_length: length });
      assert.equal(h.requests.at(-1).body.response_length, length);
    }
    assert.equal(h.requests.length, 7);
  });

  test(`${tool.name} rejects invalid response lengths before contacting the API`, (t) => {
    const h = harness(t, {});
    for (const length of [
      "long",
      "30000",
      "",
      0,
      -1,
      1.5,
      null,
      true,
      {},
      [],
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ]) {
      assert.throws(
        () => h.call(tool.name, { ...tool.input, response_length: length }),
        undefined,
        String(length),
      );
    }
    assert.equal(h.requests.length, 0);
  });
}

test("search returns complete long text and structured records regardless of dataset", async (t) => {
  const body = `HEAD\n${"unchanged content\n".repeat(25000)}END`;
  const structured = {
    protocolSection: {
      arbitrarySection: { suppliedByApi: body },
      outcomesModule: {
        primaryOutcomes: [
          { measure: "Upstream endpoint", timeFrame: "Supplied timeframe" },
        ],
      },
    },
    extensionFromApi: ["retain unknown fields", { nested: body }],
  };
  const malformed =
    '{"nct_id":"NCT03575351", malformed registry ' + "x".repeat(10000);
  const h = harness(t, {
    success: true,
    results: [
      { content: malformed, source: "valyu/valyu-clinical-trials" },
      {
        title: "Clinical record",
        source: "valyu/valyu-clinical-trials",
        content: structured,
      },
      {
        source: "valyu/valyu-clinical-trials",
        content: JSON.stringify(structured),
      },
      ...Array.from({ length: 10 }, (_, index) => ({
        url: "https://example.com/filing",
        source: "valyu/valyu-sec-filings",
        content: body,
        metadata: { chunk_index: index },
      })),
      {
        title: "New dataset",
        source: "publisher/new-dataset",
        content: structured,
      },
    ],
  });
  const result = await h.call("valyu_search", {
    query: "Original records",
    response_length: 1,
  });
  assert.equal(h.requests[0].body.response_length, 1);
  const text = textOf(result);
  assert.ok(text.includes(body));
  assert.equal(text.split(JSON.stringify(structured)).length - 1, 3);
  assert.ok(text.includes(malformed));
  assert.match(text, /Found 14 results/);
  assert.match(text, /chunk_index: 9/);
  assert.equal(text.split(body).length - 1, 10);
  assert.doesNotMatch(text, /truncated|omitted endpoints|content limit/i);
});

test("contents returns complete API text and structured summaries without a second limit", async (t) => {
  const body = `HEAD\n${"unchanged extracted content\n".repeat(25000)}END`;
  const summary = { customField: body, nested: [{ retained: true }] };
  const h = harness(t, {
    success: true,
    results: [
      { url: "https://example.com/one", content: body },
      { url: "https://example.com/two", content: summary, summary },
    ],
  });
  const result = await h.call("valyu_contents", {
    urls: ["https://example.com/one", "https://example.com/two"],
    response_length: "short",
  });
  assert.equal(h.requests[0].body.response_length, "short");
  assert.equal(result.isError, undefined);
  const text = textOf(result);
  assert.ok(text.includes(body));
  assert.equal(text.split(JSON.stringify(summary)).length - 1, 2);
  assert.doesNotMatch(text, /truncated|content limit/i);
});
