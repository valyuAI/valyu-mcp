#!/usr/bin/env node
// Live HTTP smoke checks. VALYU_API_KEY=... pnpm test:protocol -- --url http://localhost:3100
import assert from "node:assert/strict";

const urlIndex = process.argv.indexOf("--url");
const ORIGIN =
  urlIndex < 0 ? "http://localhost:3100" : process.argv[urlIndex + 1];
const KEY = process.env.VALYU_API_KEY;
if (!KEY) throw new Error("Set VALYU_API_KEY.");
const auth = { Authorization: `Bearer ${KEY}` };
const currentTools = [
  "valyu_contents",
  "valyu_datasources",
  "valyu_deepresearch",
  "valyu_deepresearch_control",
  "valyu_deepresearch_status",
  "valyu_search",
];
let failures = 0;
let checks = 0;
const safeMessage = (value) =>
  String(value)
    .split(KEY)
    .join("[redacted]")
    .replace(
      /([?&](?:X-Amz-[^=\s&]+|X-Goog-[^=\s&]+|Signature|token|api_key|valyuApiKey)=)[^\s&#)"'<>\\]*/gi,
      "$1[redacted]",
    );
async function check(name, fn) {
  checks++;
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    failures++;
    console.error(`FAIL ${name}: ${safeMessage(error.message).slice(0, 300)}`);
  }
}
async function rpc(method, params = {}, path = "/mcp", headers = auth) {
  const response = await fetch(`${ORIGIN}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const raw = await response.text();
  const data = raw
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .at(-1);
  let payload;
  try {
    payload = JSON.parse(data ? data.slice(6) : raw);
  } catch {
    payload = { raw };
  }
  const text = (payload.result?.content ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
  return {
    status: response.status,
    headers: response.headers,
    payload,
    text,
    isError: payload.result?.isError === true,
  };
}
const call = (name, input) => rpc("tools/call", { name, arguments: input });
const search = (input) => call("valyu_search", input);
const initialize = {
  protocolVersion: "2025-03-26",
  capabilities: {},
  clientInfo: { name: "test", version: "1" },
};
function successful(result) {
  assert.equal(result.isError, false, result.text.slice(0, 200));
  assert.ok(result.payload.result, "missing tool result");
}

await check(
  "unauthenticated requests return a 401 Bearer challenge",
  async () => {
    const result = await rpc("initialize", initialize, "/mcp", {});
    assert.equal(result.status, 401);
    assert.match(result.headers.get("www-authenticate") ?? "", /^Bearer /);
  },
);
for (const [name, path, headers] of [
  ["Bearer", "/mcp", auth],
  ["X-API-Key", "/mcp", { "X-API-Key": KEY }],
  ["legacy query key", `/mcp?valyuApiKey=${encodeURIComponent(KEY)}`, {}],
]) {
  await check(`${name} authentication works`, async () => {
    const result = await rpc("initialize", initialize, path, headers);
    assert.equal(result.payload.result?.serverInfo.name, "valyu-mcp");
  });
}
await check(
  "initialization includes usable instructions and fetchable branding",
  async () => {
    const { payload } = await rpc("initialize", initialize);
    assert.match(payload.result.instructions, /valyu_search/);
    assert.match(payload.result.instructions, /valyu_contents/);
    const info = payload.result.serverInfo;
    assert.equal(info.title, "Valyu");
    assert.match(info.websiteUrl, /^https:\/\//);
    assert.ok(info.icons?.length);
    for (const icon of info.icons) {
      assert.ok(icon.src.startsWith(`${ORIGIN}/`));
      const response = await fetch(icon.src);
      assert.equal(response.status, 200);
      assert.ok(
        response.headers
          .get("content-type")
          ?.includes(icon.mimeType.split("/")[1]),
      );
      assert.ok((await response.arrayBuffer()).byteLength > 500);
    }
  },
);
await check(
  "tool discovery exposes six correctly annotated tools and no internal-only fields",
  async () => {
    const { payload } = await rpc("tools/list");
    assert.deepEqual(
      payload.result.tools.map((tool) => tool.name).sort(),
      currentTools,
    );
    for (const tool of payload.result.tools) {
      assert.ok(tool.annotations?.title);
      assert.equal(
        tool.annotations.readOnlyHint,
        !["valyu_deepresearch", "valyu_deepresearch_control"].includes(
          tool.name,
        ),
      );
      for (const field of ["context", "llm_model", "conversation_id"])
        assert.ok(!Object.hasOwn(tool.inputSchema.properties, field));
      if (["valyu_search", "valyu_contents"].includes(tool.name))
        assert.ok(!tool.inputSchema.required?.includes("response_length"));
      assert.doesNotMatch(
        tool.description,
        /No other search MCP|better than a plain fetch|Reach for this first/i,
      );
    }
    assert.deepEqual(
      payload.result.tools.find((tool) => tool.name === "valyu_search")
        .inputSchema.required,
      ["query"],
    );
  },
);
for (const [name, input, expected] of [
  [
    "default unscoped search",
    { query: "quantum error correction" },
    /Found \d+ result/,
  ],
  [
    "dataset source",
    {
      query: "GLP-1 agonists cardiovascular outcomes",
      included_sources: ["valyu/valyu-clinical-trials"],
    },
    /Found \d+ result/,
  ],
  [
    "academic chunks",
    {
      query: "sparse autoencoders transformer interpretability",
      max_num_results: 8,
    },
    /source: valyu\//,
  ],
  [
    "domain source",
    {
      query: "transformer attention mechanism",
      included_sources: ["arxiv.org"],
      max_num_results: 3,
    },
    /arxiv\.org/,
  ],
  [
    "API preset",
    {
      query: "NVDA quarterly earnings",
      included_sources: ["finance"],
      max_num_results: 3,
    },
    /Found \d+ result/,
  ],
  [
    "excluded domain",
    {
      query: "noise cancelling headphones",
      excluded_sources: ["reddit.com"],
      max_num_results: 3,
    },
    /Found \d+ result/,
  ],
  [
    "source bias",
    {
      query: "climate change sea level projections",
      source_biases: { "nasa.gov": 5 },
      max_num_results: 5,
    },
    /Found \d+ result/,
  ],
  [
    "explicit numeric response length",
    {
      query: "transformer architecture",
      response_length: 30000,
      max_num_results: 3,
    },
    /Found \d+ result/,
  ],
]) {
  await check(name, async () => {
    const result = await search(input);
    successful(result);
    assert.match(result.text, expected);
    assert.equal(result.payload.result.structuredContent, undefined);
  });
}
for (const [name, input, expected] of [
  [
    "retired dataset",
    { included_sources: ["valyu/valyu-npi-registry"] },
    /Unknown value|did you mean|valyu_datasources/i,
  ],
  [
    "dataset typo",
    { included_sources: ["valyu/valyu-arxive"] },
    /valyu\/valyu-arxiv/,
  ],
  [
    "category instead of dataset",
    { included_sources: ["company"] },
    /did you mean/,
  ],
  ["excluded preset", { excluded_sources: ["finance"] }, /excluded_sources/],
  [
    "bare dataset name",
    { included_sources: ["pubmed"] },
    /valyu\/valyu-pubmed/,
  ],
  ["invalid bias domain", { source_biases: { "nasa gov": 3 } }, /not a source/],
  [
    "duplicate bias domain",
    { source_biases: { "NASA.gov": 3, "nasa.gov": -2 } },
    /twice/,
  ],
  ["malformed date", { start_date: "last week" }, /YYYY-MM-DD/],
]) {
  await check(name, async () => {
    const result = await search({ query: "research", ...input });
    assert.equal(result.isError, true);
    assert.match(result.text, expected);
  });
}
await check("filing chunks and API provenance survive formatting", async () => {
  const result = await search({
    query: "Apple 10-K risk factors",
    included_sources: ["valyu/valyu-sec-filings"],
    max_num_results: 10,
    response_length: 600,
  });
  successful(result);
  assert.match(result.text, /chunk_index: 1/);
  assert.match(result.text, /accession_number/);
  assert.match(result.text, /form_type: 10-K/);
  assert.doesNotMatch(result.text, /duplicate chunk|ticker: unavailable/i);
});
await check(
  "account result caps are reported without misclassifying credentials",
  async () => {
    const result = await search({
      query: "transformer attention",
      max_num_results: 50,
      response_length: 500,
    });
    assert.match(
      result.text,
      result.isError ? /higher limits|num_results/i : /Found \d+ result/,
    );
    assert.doesNotMatch(result.text, /rejected the credential/);
  },
);
await check(
  "datasource discovery supports access annotations and explicit opt-out",
  async () => {
    const covered = await call("valyu_datasources", {});
    successful(covered);
    assert.match(covered.text, /valyu\/valyu-arxiv/);
    assert.match(covered.text, /^Plan: /m);
    const plain = await call("valyu_datasources", { check_access: false });
    successful(plain);
    assert.doesNotMatch(plain.text, /^Plan: |LOCKED/m);
    const ranked = await call("valyu_datasources", {
      query: "US CPI inflation series",
    });
    successful(ranked);
    assert.match(ranked.text, /valyu\/valyu-fred/);
  },
);

for (const [name, tool, input, label] of [
  [
    "search images",
    "valyu_search",
    {
      query: "Attention Is All You Need transformer architecture figure",
      included_sources: ["valyu/valyu-arxiv"],
      max_num_results: 3,
      response_length: 600,
    },
    "image",
  ],
  [
    "contents screenshots",
    "valyu_contents",
    {
      urls: ["https://docs.valyu.ai/integrations/mcp-server"],
      response_length: 500,
    },
    "screenshot",
  ],
]) {
  await check(
    `${name} are opt-in and returned links are fetchable`,
    async () => {
      const off = await call(tool, input);
      successful(off);
      assert.doesNotMatch(off.text, new RegExp(`^${label}`, "m"));
      const on = await call(tool, {
        ...input,
        [label === "image" ? "include_images" : "screenshot"]: true,
      });
      successful(on);
      const link = on.text.match(
        new RegExp(
          String.raw`^${label}(?: \(link expired[^)]*\))?: (\S+)`,
          "m",
        ),
      );
      assert.ok(link, "no media URL returned");
      const response = await fetch(link[1]);
      const expired = on.text.includes(`${label} (link expired`);
      assert.equal(response.status, expired ? 403 : 200);
      if (!expired)
        assert.match(response.headers.get("content-type") ?? "", /^image\//);
    },
  );
}
await check("contents returns readable extracted text", async () => {
  const result = await call("valyu_contents", {
    urls: ["https://modelcontextprotocol.io/introduction"],
    response_length: 6000,
  });
  successful(result);
  assert.ok(result.text.length > 100);
});
await check(
  "research status lists recent tasks and reports unknown tasks cleanly",
  async () => {
    const recent = await call("valyu_deepresearch_status", { limit: 3 });
    successful(recent);
    assert.match(
      recent.text,
      /recent deepresearch task|No deepresearch tasks yet/,
    );
    const missing = await call("valyu_deepresearch_status", {
      task_id: "00000000-0000-0000-0000-000000000000",
    });
    assert.equal(missing.isError, true);
    assert.ok(missing.text.length > 20);
  },
);
await check("checkpoint responses require an interaction id", async () => {
  const result = await call("valyu_deepresearch_control", {
    task_id: "00000000-0000-0000-0000-000000000000",
    action: "respond",
  });
  assert.equal(result.isError, true);
  assert.match(result.text, /interaction_id/);
});
console.log(`${checks - failures} passed, ${failures} failed`);
process.exitCode = failures ? 1 : 0;
