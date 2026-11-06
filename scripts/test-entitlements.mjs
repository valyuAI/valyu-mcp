#!/usr/bin/env node

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { gunzipSync } from "node:zlib";

const MOCK_PORT = 4555;
const MCP_PORT = 3199;
const KEY = "val_test_entitlements_0000000000000000000000000000000000000000";
let requiredTier = "tier_3";

const CATALOG = {
  success: true,
  total_count: 6,
  categories: Object.fromEntries(
    ["research", "patents", "markets"].map((category) => [
      category,
      { name: category },
    ]),
  ),
  datasources: [
    ["valyu/valyu-arxiv", "ArXiv", "research", 1],
    ["valyu/valyu-pubmed", "PubMed", "research", 1],
    ["wiley/wiley-finance-papers", "Wiley Finance", "research", 30],
    ["valyu/valyu-patents", "US Patents", "patents", 8],
    ["valyu/valyu-patents-epo", "EPO Patents", "patents", 8],
    ["valyu/valyu-stocks", "Stocks", "markets", 6],
  ].map(([id, name, category, cpm]) => ({
    id,
    name,
    category,
    description: `${name} records.`,
    pricing: { cpm },
  })),
};
const ENTITLED = new Set(["valyu/valyu-arxiv", "valyu/valyu-pubmed"]);

// Plan-access 403s in the current API shape: the sentence no longer carries
// "(tier_N)", so the plan comes from `recovery`. `required_tier` is kept.
const BILLING = "https://platform.valyu.ai/user/account/billing?tab=plan";
const CONTACT = "https://www.valyu.ai/contact";
const DATASOURCES = "https://docs.valyu.ai/data-sources";
const PLAN_403 = {
  __tier_new__: {
    success: false,
    error: `Nothing to search: your Pay-as-you-go plan doesn't include valyu/valyu-patents-epo (Comfortably Pro, $99/mo). Upgrade: ${BILLING}`,
    code: "tier_insufficient",
    recovery: {
      current_plan: "tier_0",
      required_tier: "tier_2",
      required_plan: { id: "tier_2", name: "Comfortably Pro", price: "$99/mo" },
      upgrade_url: BILLING,
      excluded_datasets: ["valyu/valyu-patents-epo"],
      available_datasets: [...ENTITLED],
    },
  },
  __tier_mixed__: {
    success: false,
    error: `Nothing to search: your Pay-as-you-go plan doesn't include valyu/valyu-patents-epo, and wiley/wiley-finance-papers is licensed separately, not part of a self-serve plan. Comfortably Pro ($99/mo) includes it: ${BILLING}; contact us for access: ${CONTACT}`,
    code: "tier_insufficient",
    recovery: {
      current_plan: "tier_0",
      required_tier: null,
      required_plan: null,
      upgrade_url: BILLING,
      contact_url: CONTACT,
      datasources_url: DATASOURCES,
      excluded_datasets: ["valyu/valyu-patents-epo", "wiley/wiley-finance-papers"],
      available_datasets: [...ENTITLED],
    },
  },
  // An older response with no upgrade link: falls back to the pricing page.
  __tier_old_no_link__: {
    success: false,
    error:
      "Your current plan (tier_1) does not include access to: valyu/valyu-patents-epo. Upgrade your plan to access these data sources.",
    code: "tier_insufficient",
    recovery: { required_tier: "tier_2" },
  },
  __unavailable__: {
    success: false,
    error: `Nothing to search: wiley/wiley-finance-papers is licensed separately, not part of a self-serve plan, and acme/not-a-dataset is not a dataset id we recognise. Check the ids against ${DATASOURCES}; contact us for access: ${CONTACT}`,
    code: "dataset_unavailable",
    recovery: {
      current_plan: "tier_0",
      contact_url: CONTACT,
      datasources_url: DATASOURCES,
      excluded_datasets: ["wiley/wiley-finance-papers", "acme/not-a-dataset"],
      available_datasets: [...ENTITLED],
    },
  },
  // The bare minimum: the code with no recovery block at all.
  __unavailable_bare__: {
    success: false,
    error: "Nothing to search.",
    code: "dataset_unavailable",
  },
};

const searchCalls = [];
const researchCalls = [];
const TASK_ID = "11111111-1111-4111-8111-111111111111";
let researchState = "running";
let accountUnavailable = false;
let accountCalls = 0;

const mock = createServer((req, res) => {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    const bytes = Buffer.concat(chunks);
    const body = (
      req.headers["content-encoding"] === "gzip" ? gunzipSync(bytes) : bytes
    ).toString();
    const send = (code, obj) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    if (req.url.startsWith("/v1/datasources/search")) {
      return send(200, {
        results: [
          { id: "valyu/valyu-patents", relevance_score: 0.99 },
          { id: "valyu/valyu-patents-epo", relevance_score: 0.98 },
        ],
      });
    }
    if (req.url.startsWith("/v1/datasources")) return send(200, CATALOG);
    if (req.url.startsWith("/v1/account/me")) {
      accountCalls++;
      if (accountUnavailable)
        return send(503, { error: "Account service unavailable" });
      return send(200, {
        org_id: "00000000-0000-0000-0000-000000000000",
        name: "TestOrg",
        tier: "tier_1",
        allowed_datasets: [...ENTITLED].sort(),
        key: {
          id: "k1",
          name: "test",
          scopes: [],
          credit_cap_usd: null,
          credit_spent_usd: 0,
        },
      });
    }
    if (req.url === "/v1/contents") {
      const input = JSON.parse(body || "{}");
      if (input.urls.includes("https://example.com/empty")) {
        return send(200, { success: true, results: [], urls_processed: 0 });
      }
      for (const [path, summary] of [
        ["empty-array", []],
        ["empty-object", {}],
        ["structured-summary", { tools: ["valyu_search", "valyu_contents"] }],
      ]) {
        if (input.urls.includes(`https://example.com/${path}`)) {
          return send(200, {
            success: true,
            results: [
              { url: `https://example.com/${path}`, content: "", summary },
            ],
          });
        }
      }
      if (input.urls.includes("https://example.com/unavailable")) {
        return send(200, {
          success: false,
          error: "Extraction failed",
          results: [],
        });
      }
      return send(200, {
        success: true,
        results: [{ content: "Page content" }],
      });
    }
    if (req.url === "/v1/deepresearch/tasks") {
      researchCalls.push(JSON.parse(body || "{}"));
      return send(200, { success: true, task_id: TASK_ID, status: "running" });
    }
    if (req.url === `/v1/deepresearch/tasks/${TASK_ID}/status`) {
      return send(200, {
        status: researchState,
        output:
          researchState === "completed"
            ? "# GLP-1 obesity market\nMariTide is developed by Amgen. [1]"
            : undefined,
        sources: [
          {
            title: "Amgen trial announcement",
            url: "https://www.amgen.com/newsroom",
          },
        ],
      });
    }
    if (req.url === `/v1/deepresearch/tasks/${TASK_ID}/cancel`) {
      researchState = "cancelled";
      return send(200, { status: researchState });
    }
    if (req.url.startsWith("/v1/deepresearch/list")) {
      return send(200, [
        {
          deepresearch_id: TASK_ID,
          query: "GLP-1 obesity market",
          status: researchState,
          created_at: "2026-09-30T10:00:00Z",
        },
      ]);
    }
    if (req.url.startsWith("/v1/search")) {
      const p = JSON.parse(body || "{}");
      searchCalls.push(p);
      if (p.query === "__no_results__") {
        return send(200, {
          success: true,
          error: "No results found for query",
          query: p.query,
          results: [],
        });
      }
      if (p.query === "__out_of_credits__") {
        return send(402, {
          success: false,
          error: "Insufficient credits. Please top up your account.",
        });
      }
      if (p.query === "__backend_down__") {
        return send(200, {
          success: true,
          error:
            "finance search failed: Finance search temporarily unavailable. Please retry.",
          query: p.query,
          results: [],
        });
      }
      if (PLAN_403[p.query]) return send(403, PLAN_403[p.query]);
      if (
        p.included_sources?.length === 1 &&
        p.included_sources[0] === "valyu/valyu-patents"
      ) {
        return send(403, {
          success: false,
          error:
            "Your current plan (tier_1) does not include access to: valyu/valyu-patents. Upgrade your plan to access these data sources.",
          code: "tier_insufficient",
          recovery: {
            required_tier: requiredTier,
            upgrade_url: "https://platform.valyu.ai/account/billing",
            available_datasets: [...ENTITLED],
          },
        });
      }
      return send(200, {
        success: true,
        error: "",
        query: p.query,
        results: [
          {
            title: "Result",
            url: "https://example.com/a",
            content: "Body text.",
            source:
              p.included_sources?.find((source) => ENTITLED.has(source)) ||
              "web",
            publication_date: "2026-08-01",
          },
        ],
        total_deduction_dollars: 0.001,
      });
    }
    send(404, { error: "not found" });
  });
});

mock.on("error", (e) => {
  console.error(`mock upstream could not bind :${MOCK_PORT}: ${e.message}`);
  process.exit(1);
});
await new Promise((r) => mock.listen(MOCK_PORT, r));
try {
  await fetch(`http://localhost:${MCP_PORT}/mcp`, {
    signal: AbortSignal.timeout(800),
  });
  console.error(
    `something is already listening on :${MCP_PORT}; stop it first`,
  );
  mock.close();
  process.exit(1);
} catch {
  /* nothing there: good */
}
// Kill the process group during cleanup so a stale Next child cannot serve later tests.
const dev = spawn(
  process.execPath,
  ["node_modules/next/dist/bin/next", "dev", "--port", String(MCP_PORT)],
  {
    env: {
      ...process.env,
      VALYU_BASE_URL: `http://localhost:${MOCK_PORT}`,
      NEXT_DIST_DIR: ".next-test",
    },
    stdio: "ignore",
    detached: true,
  },
);

let cleanedUp = false;
const cleanup = () => {
  if (cleanedUp) return;
  cleanedUp = true;
  try {
    process.kill(-dev.pid, "SIGKILL");
  } catch {
    /* already gone */
  }
  mock.close();
};
process.on("exit", cleanup);
process.on("SIGINT", () => {
  cleanup();
  process.exit(1);
});
let ready = false;
for (let i = 0; i < 60; i++) {
  try {
    await fetch(`http://localhost:${MCP_PORT}/mcp`, {
      signal: AbortSignal.timeout(1500),
    });
    ready = true;
    break;
  } catch {
    await new Promise((r) => setTimeout(r, 500));
  }
}
if (!ready) {
  console.error("dev server did not start");
  cleanup();
  process.exit(1);
}

async function rpc(method, params = {}, path = "/mcp") {
  const res = await fetch(`http://localhost:${MCP_PORT}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${KEY}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params,
    }),
  });
  const raw = await res.text();
  let p = null;
  for (const l of raw.split("\n")) {
    if (l.startsWith("data: ")) {
      try {
        p = JSON.parse(l.slice(6));
      } catch {}
    }
  }
  if (!p) {
    try {
      p = JSON.parse(raw);
    } catch {
      p = { raw };
    }
  }
  const text = (p?.result?.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("");
  return { text, isError: p?.result?.isError === true, payload: p };
}

const callTool = (name, args) => rpc("tools/call", { name, arguments: args });

let pass = 0,
  fail = 0;
const out = [];
async function test(name, fn) {
  try {
    await fn();
    pass++;
    out.push(`  PASS  ${name}`);
  } catch (e) {
    fail++;
    out.push(`  FAIL  ${name}\n          ${String(e.message).slice(0, 300)}`);
  }
}

await test("valyu_datasources refreshes account coverage without inferring absent access", async () => {
  const before = accountCalls;
  const r = await callTool("valyu_datasources", {});
  assert.match(r.text, /UNKNOWN/);
  assert.match(r.text, /valyu\/valyu-patents`?\s*\*\*\[UNKNOWN/);
  assert.equal(accountCalls, before + 1);
  ENTITLED.add("valyu/valyu-patents");
  try {
    const updated = await callTool("valyu_datasources", {});
    assert.match(updated.text, /valyu\/valyu-patents`?\s*\*\*\[COVERED/);
    assert.equal(accountCalls, before + 2);
  } finally {
    ENTITLED.delete("valyu/valyu-patents");
  }
});

await test("entitled datasets are NOT marked locked", async () => {
  const r = await callTool("valyu_datasources", { category: "research" });
  const arxivLine = r.text.split("\n").find((l) => l.includes("valyu-arxiv"));
  assert.ok(arxivLine, "arxiv missing from listing");
  assert.ok(
    !arxivLine.includes("LOCKED"),
    `arxiv wrongly locked: ${arxivLine}`,
  );
  assert.match(arxivLine, /COVERED/);
});

await test("tool discovery lists exactly the six public tools with no internal-only inputs", async () => {
  const { payload } = await rpc("tools/list");
  const names = payload.result.tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, [
    "valyu_contents",
    "valyu_datasources",
    "valyu_deepresearch",
    "valyu_deepresearch_control",
    "valyu_deepresearch_status",
    "valyu_search",
  ]);
  for (const tool of payload.result.tools) {
    for (const field of ["context", "llm_model", "conversation_id"]) {
      assert.ok(
        !Object.hasOwn(tool.inputSchema.properties, field),
        `${tool.name} exposes ${field}`,
      );
    }
    assert.doesNotMatch(
      tool.description,
      /No other search MCP|better than a plain fetch|Reach for this first/i,
    );
  }
});

await test("failed and empty extraction envelopes are MCP errors", async () => {
  for (const path of ["unavailable", "empty", "empty-array", "empty-object"]) {
    const r = await callTool("valyu_contents", {
      urls: [`https://example.com/${path}`],
    });
    assert.equal(r.isError, true, path);
    if (path === "unavailable") assert.match(r.text, /Extraction failed/);
  }
});

await test("meaningful structured extraction summaries remain usable", async () => {
  const r = await callTool("valyu_contents", {
    urls: ["https://example.com/structured-summary"],
  });
  assert.equal(r.isError, false);
  assert.match(r.text, /valyu_search/);
  assert.match(r.text, /valyu_contents/);
});

await test("patent discovery returns exact IDs and explicit access status", async () => {
  const r = await callTool("valyu_datasources", { query: "patents" });
  assert.equal(r.isError, false);
  assert.match(r.text, /valyu\/valyu-patents/);
  assert.match(r.text, /valyu\/valyu-patents-epo/);
  assert.match(r.text, /UNKNOWN/);
  assert.doesNotMatch(r.text, /LOCKED|outside plan/i);
  assert.doesNotMatch(r.text, /Do both/);
});

await test("failed access lookup labels datasets unknown instead of covered", async () => {
  accountUnavailable = true;
  try {
    const r = await callTool("valyu_datasources", { category: "patents" });
    assert.match(r.text, /UNKNOWN/);
    assert.doesNotMatch(r.text, /COVERED/);
  } finally {
    accountUnavailable = false;
  }
});

await test("research returns a task immediately and status retrieves its report and sources", async () => {
  researchState = "running";
  const created = await callTool("valyu_deepresearch", {
    query:
      "Run deep research on the GLP-1 obesity market and write a cited report",
  });
  assert.equal(created.isError, false);
  assert.ok(created.text.includes(TASK_ID));
  assert.equal(researchCalls.length, 1);
  assert.match(researchCalls[0].query, /GLP-1 obesity/);
  const running = await callTool("valyu_deepresearch_status", {
    task_id: TASK_ID,
  });
  assert.match(running.text, /running/);
  assert.ok(!running.text.includes("MariTide"));
  researchState = "completed";
  const done = await callTool("valyu_deepresearch_status", {
    task_id: TASK_ID,
  });
  assert.equal(done.isError, false);
  assert.match(done.text, /MariTide is developed by Amgen/);
  assert.match(done.text, /https:\/\/www\.amgen\.com/);
});

await test("research cancellation needs only the task id and action", async () => {
  researchState = "running";
  const r = await callTool("valyu_deepresearch_control", {
    task_id: TASK_ID,
    action: "cancel",
  });
  assert.equal(r.isError, false);
  assert.equal(researchState, "cancelled");
});

await test("valyu_datasources explains access without purchase or upgrade links", async () => {
  const r = await callTool("valyu_datasources", {});
  assert.match(r.text, /Ridiculously Cheap/);
  assert.doesNotMatch(r.text, /valyu\.ai\/pricing|Plans are described/);
  assert.doesNotMatch(r.text, /account\/billing/);
});

await test("entitlements come from /v1/account/me, not from a search probe", async () => {
  assert.ok(accountCalls > 0, "never called the account API");
  const probes = searchCalls.filter((c) =>
    String(c.query || "").includes("nonexistent sentinel"),
  );
  assert.equal(
    probes.length,
    0,
    `still issuing search probes: ${JSON.stringify(probes.map((p) => p.included_sources))}`,
  );
});

await test("check_access:false skips the annotation entirely", async () => {
  const before = accountCalls;
  for (const query of [undefined, "patents"]) {
    const r = await callTool("valyu_datasources", {
      check_access: false,
      query,
    });
    assert.doesNotMatch(r.text, /COVERED|UNKNOWN|^Plan: /m);
  }
  assert.equal(accountCalls, before, "opt-out still queried account access");
});

await test("a scoped search above the plan returns an actionable upsell", async () => {
  const r = await callTool("valyu_search", {
    query: "battery patents",
    included_sources: ["valyu/valyu-patents"],
  });
  assert.equal(r.isError, true);
  assert.match(
    r.text,
    /not included in the current plan \(Ridiculously Cheap\)/,
  );
  assert.match(r.text, /Preserve any source restriction the user requested/);
  assert.match(
    r.text,
    /If alternative sources are acceptable, omit `included_sources`/,
  );
  assert.match(r.text, /Serious Business/);
  // The older shape: plan from the "(tier_1)" sentence, the needed plan from
  // `required_tier`, and the API's own upgrade link.
  assert.match(r.text, /Upgrade: https:\/\/platform.valyu.ai\/account\/billing/);
  assert.doesNotMatch(r.text, /Plan information|Details from Valyu|contact Valyu/);
});

const planError = (query, included_sources = ["valyu/valyu-patents-epo"]) =>
  callTool("valyu_search", { query, included_sources });

await test("a plan error in the current API shape names both plans from recovery", async () => {
  const r = await planError("__tier_new__");
  assert.equal(r.isError, true);
  assert.match(
    r.text,
    /the requested dataset \(valyu\/valyu-patents-epo\) is not included in the current plan \(Pay As You Go\)/,
  );
  assert.match(r.text, /Preserve any source restriction the user requested/);
  assert.match(r.text, /included from the Comfortably Pro \(\$99\/mo\) plan upward/);
  assert.match(r.text, /Upgrade: https:\/\/platform.valyu.ai\/user\/account\/billing\?tab=plan/);
  assert.doesNotMatch(r.text, /Plan information|contact Valyu|tier_\d/);
});

await test("a plan error with licensed datasets mixed in points to contact for those", async () => {
  const r = await planError("__tier_mixed__", [
    "valyu/valyu-patents-epo",
    "wiley/wiley-finance-papers",
  ]);
  assert.equal(r.isError, true);
  assert.match(
    r.text,
    /the requested datasets \(valyu\/valyu-patents-epo, wiley\/wiley-finance-papers\) are not included in the current plan \(Pay As You Go\)/,
  );
  assert.doesNotMatch(r.text, /plan upward/);
  assert.match(r.text, /Details from Valyu: Nothing to search: your Pay-as-you-go plan/);
  assert.match(r.text, /Upgrade: https:\/\/platform.valyu.ai/);
  assert.match(
    r.text,
    /licensed separately or are not valid dataset ids, so no plan includes them\. For access to those, contact Valyu: https:\/\/www.valyu.ai\/contact/,
  );
});

await test("an older plan error without an upgrade link falls back to the pricing page", async () => {
  const r = await planError("__tier_old_no_link__");
  assert.equal(r.isError, true);
  assert.match(r.text, /not included in the current plan \(Ridiculously Cheap\)/);
  assert.match(r.text, /included from the Comfortably Pro plan upward/);
  assert.match(r.text, /Plan information: https:\/\/www.valyu.ai\/pricing/);
  assert.doesNotMatch(r.text, /Upgrade:/);
});

await test("datasets no plan includes are a contact error, never an upgrade", async () => {
  const r = await planError("__unavailable__", ["wiley/wiley-finance-papers"]);
  assert.equal(r.isError, true);
  assert.match(
    r.text,
    /the requested datasets \(wiley\/wiley-finance-papers, acme\/not-a-dataset\) are licensed separately or not valid dataset ids, so switching plans does not unlock them/,
  );
  assert.match(r.text, /Preserve any source restriction the user requested/);
  assert.match(r.text, /contact Valyu: https:\/\/www.valyu.ai\/contact/);
  assert.match(r.text, /Call valyu_datasources to check the ids/);
  assert.doesNotMatch(r.text, /upgrade|pricing|billing|plan upward|HTTP 403|credential/i);
});

await test("a bare dataset_unavailable still renders the contact error", async () => {
  const r = await planError("__unavailable_bare__", ["wiley/wiley-finance-papers"]);
  assert.equal(r.isError, true);
  assert.match(
    r.text,
    /the requested dataset is licensed separately or not a valid dataset id, so switching plans does not unlock it/,
  );
  assert.match(r.text, /contact Valyu: https:\/\/www.valyu.ai\/contact/);
  assert.doesNotMatch(r.text, /upgrade|pricing|billing|HTTP 403|credential/i);
});

await test("plan errors do not invent access arrangements when the API omits a recognised tier", async () => {
  try {
    for (requiredTier of [undefined, "tier_99"]) {
      const r = await callTool("valyu_search", {
        query: "battery patents",
        included_sources: ["valyu/valyu-patents"],
      });
      assert.equal(r.isError, true);
      assert.match(r.text, /not included in the current plan/);
      assert.doesNotMatch(r.text, /provisioned per organisation|plan upward/);
    }
  } finally {
    requiredTier = "tier_3";
  }
});

await test("search forwards permitted scopes without inferring dropped datasets or reading plan state", async () => {
  for (const included_sources of [
    undefined,
    ["valyu/valyu-patents", "valyu/valyu-arxiv"],
    ["valyu/valyu-arxiv", "valyu/valyu-pubmed"],
    ["wiley/wiley-finance-papers", "valyu/valyu-arxiv"],
    ["arxiv.org"],
  ]) {
    const before = accountCalls;
    const r = await callTool("valyu_search", {
      query: "battery research",
      included_sources,
    });
    assert.equal(r.isError, false);
    assert.match(r.text, /Found 1 result/);
    assert.doesNotMatch(r.text, /outside the current plan|likely skipped/);
    assert.equal(
      accountCalls,
      before,
      "search inferred outcomes from account metadata",
    );
    assert.deepEqual(searchCalls.at(-1).included_sources, included_sources);
  }
});

await test("source bias passes through without becoming an included or excluded filter", async () => {
  const r = await callTool("valyu_search", {
    query: "climate projections",
    source_biases: { "nasa.gov": 5 },
  });
  assert.equal(r.isError, false);
  const input = searchCalls.at(-1);
  assert.deepEqual(input.source_biases, { "nasa.gov": 5 });
  assert.equal(input.included_sources, undefined);
  assert.equal(input.excluded_sources, undefined);
});

await test("a dead backend is reported as an outage, not as no-results", async () => {
  const r = await callTool("valyu_search", { query: "__backend_down__" });
  assert.match(r.text, /could not complete/i);
  assert.match(r.text, /Finance search temporarily unavailable/);
  assert.match(r.text, /rewording will not help/i);
  assert.ok(
    !/broader keywords/i.test(r.text),
    "told the model to reword the query during an upstream outage",
  );
});

await test("an empty account is named as such and the model is told not to retry", async () => {
  const before = searchCalls.length;
  const r = await callTool("valyu_search", { query: "__out_of_credits__" });
  assert.equal(r.isError, true);
  assert.match(r.text, /HTTP 402/);
  assert.match(r.text, /insufficient available credits/);
  assert.match(r.text, /Do not retry/);
  assert.match(r.text, /account limitation/);
  assert.doesNotMatch(
    r.text,
    /add more|credits are added|top up|buy|purchase|https:\/\/platform.valyu.ai/i,
  );
  assert.doesNotMatch(r.text, /transient/);
  assert.doesNotMatch(r.text, /account\/billing/);
  assert.equal(
    searchCalls.length - before,
    1,
    "the server itself retried the call",
  );
});

await test("empty search recovery preserves explicitly requested scope", async () => {
  const r = await callTool("valyu_search", { query: "__no_results__" });
  assert.match(r.text, /No results/i);
  assert.match(
    r.text,
    /If consistent with the user’s request, revise the query or filters/,
  );
  assert.match(r.text, /Preserve explicit source and date restrictions/);
});

console.log(`\nbehaviour tests (mock upstream on :${MOCK_PORT})\n`);
console.log(out.join("\n"));
console.log(`\n${pass} passed, ${fail} failed\n`);
cleanup();
process.exit(fail > 0 ? 1 : 0);
