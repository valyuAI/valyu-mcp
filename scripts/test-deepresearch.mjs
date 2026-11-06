import assert from "node:assert/strict";
import { test } from "node:test";
import { toolHarness, textOf } from "./test-support.mjs";

const { ValyuApiError } = await import("../lib/valyu/client.ts");
const { renderApiError } = await import("../lib/mcp/errors.ts");
const { registerDeepResearchTools } =
  await import("../lib/tools/deepresearch.ts");

const harness = (t, responses) =>
  toolHarness(t, [registerDeepResearchTools], responses);

test("a 429 with full detail surfaces the server's own message, not the machine code", async () => {
  const body = {
    error: "rate_limited",
    message:
      "Search rate limit reached: your Pay-as-you-go plan allows 7 requests per second. Retry after 2 seconds. Upgrade to Ridiculously Cheap for 70 requests per second: https://platform.valyu.ai/user/account/billing?tab=plan",
    retry_after: 2,
    plan: "Pay-as-you-go",
    limit: { endpoint: "search", requests_per_second: 7 },
    upgrade_url: "https://platform.valyu.ai/user/account/billing?tab=plan",
  };
  const res = new Response(JSON.stringify(body), { status: 429 });
  const err = await ValyuApiError.fromResponse(res);
  assert.equal(err.body, body.message);
  assert.notEqual(err.body, "rate_limited");
  assert.equal(err.retryAfter, 2);
  assert.equal(err.plan, "Pay-as-you-go");
  assert.deepEqual(err.limit, { endpoint: "search", requests_per_second: 7 });
  assert.equal(err.upgradeUrl, body.upgrade_url);
  assert.equal(err.contactUrl, undefined);
});

test("a 429 with a contact_url offers contact, not upgrade", async () => {
  const body = {
    error: "rate_limited",
    message: "Search rate limit reached: your Enterprise plan allows 700 requests per second. Retry after 1 second. Contact us: https://www.valyu.ai/contact",
    retry_after: 1,
    plan: "Enterprise",
    limit: { endpoint: "search", requests_per_second: 700 },
    contact_url: "https://www.valyu.ai/contact",
  };
  const res = new Response(JSON.stringify(body), { status: 429 });
  const err = await ValyuApiError.fromResponse(res);
  assert.equal(err.contactUrl, body.contact_url);
  assert.equal(err.upgradeUrl, undefined);
});

test("a generic old-server 429 (no structured detail) still parses without crashing", async () => {
  const res = new Response(
    JSON.stringify({ error: "Too many requests; retry after 2 seconds" }),
    { status: 429 },
  );
  const err = await ValyuApiError.fromResponse(res);
  assert.equal(err.body, "Too many requests; retry after 2 seconds");
  assert.equal(err.retryAfter, undefined);
  assert.equal(err.upgradeUrl, undefined);
  assert.equal(err.contactUrl, undefined);
});

test("a 429 with no retry_after field falls back to the Retry-After header", async () => {
  const res = new Response(JSON.stringify({ error: "rate_limited", message: "Slow down." }), {
    status: 429,
    headers: { "Retry-After": "7" },
  });
  const err = await ValyuApiError.fromResponse(res);
  assert.equal(err.retryAfter, 7);
});

test("the rendered 429 tool error names the plan's own message, labels the link and never mentions billing or credit", async (t) => {
  const h = harness(t, [
    () => {
      throw new ValyuApiError(
        429,
        "Search rate limit reached: your Pay-as-you-go plan allows 7 requests per second. Retry after 2 seconds.",
        "http_429",
        undefined,
        undefined,
        undefined,
        2,
        "Pay-as-you-go",
        { endpoint: "search", requests_per_second: 7 },
        "https://platform.valyu.ai/user/account/billing?tab=plan",
        undefined,
      );
    },
  ]);
  const result = await h.call("valyu_deepresearch", { query: "Trial outcomes" });
  const text = textOf(result);
  assert.equal(result.isError, true);
  assert.match(text, /HTTP 429/);
  assert.match(text, /Upgrade: https:\/\/platform\.valyu\.ai/);
  assert.doesNotMatch(text, /Contact:/);
  // The upgrade URL itself legitimately contains "billing" in its path; check
  // only the explanatory sentence, not the link, never calls this a
  // billing/credit problem.
  const explanation = text.split("\n\n")[1];
  assert.doesNotMatch(explanation, /billing|credit/i);
});

test("creation requires a brief and omits account plumbing from its public schema", (t) => {
  const h = harness(t, []);
  const shape = h.tools.get("valyu_deepresearch").schema.shape;
  for (const field of [
    "mcp_servers",
    "webhook_url",
    "alert_email",
    "metadata",
    "workflow_id",
    "workflow_params",
    "workflow_version",
  ]) {
    assert.equal(field in shape, false, field);
  }
  assert.throws(() => h.call("valyu_deepresearch", {}));
  assert.throws(() => h.call("valyu_deepresearch", { query: "   " }));
  for (const name of ["valyu_deepresearch", "valyu_deepresearch_status"]) {
    assert.throws(() => h.call(name, { query: "test", wait_seconds: 31 }));
    assert.throws(() => h.call(name, { query: "test", wait_seconds: -1 }));
  }
  assert.equal(h.requests.length, 0);
});

test("creation returns a resumable id without polling and forwards purposeful scope and output", async (t) => {
  const h = harness(t, [{ deepresearch_id: "task-123" }]);
  const result = await h.call("valyu_deepresearch", {
    query: "  Research GLP-1 obesity treatments  ",
    report_format: "At most 500 words with citations",
    included_sources: ["clinicaltrials.gov"],
    start_date: "2025-01-01",
    urls: ["https://example.com/study"],
    deliverables: [{ type: "docx", description: "Report with a source table" }],
    files: [
      {
        data: "data:text/plain;base64,dGVzdA==",
        filename: "brief.txt",
        mediaType: "text/plain",
      },
    ],
    metadata: { unnecessary: "ignored" },
  });
  assert.match(textOf(result), /task-123/);
  assert.doesNotMatch(textOf(result), /8-12|10-20|typically finishes/);
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].body.query, "Research GLP-1 obesity treatments");
  assert.equal(
    h.requests[0].body.report_format,
    "At most 500 words with citations",
  );
  assert.deepEqual(h.requests[0].body.search, {
    included_sources: ["clinicaltrials.gov"],
    start_date: "2025-01-01",
  });
  assert.equal(h.requests[0].body.deliverables[0].type, "docx");
  assert.equal(h.requests[0].body.files[0].filename, "brief.txt");
  assert.equal("metadata" in h.requests[0].body, false);
});

test("deepresearch prices are stated in credits, never dollars", async (t) => {
  const h = harness(t, [
    { deepresearch_id: "task-123" },
    {
      status: "completed",
      output: "# Report",
      cost: 0.30625,
      cost_breakdown: {
        task: 0.15625,
        screenshots: 0.05,
        code_execution: 0.1,
      },
    },
  ]);
  const tool = h.tools.get("valyu_deepresearch");
  const surface = JSON.stringify([
    tool.description,
    tool.schema.shape.mode.description,
    tool.schema.shape.tools.unwrap().shape,
  ]);
  assert.doesNotMatch(surface, /\$\d/);
  assert.match(tool.description, /"fast": focused research, 25 credits/);
  assert.match(
    tool.description,
    /"max": most extensive investigation, 2,500 credits/,
  );
  assert.match(surface, /8 credits per capture/);

  const started = await h.call("valyu_deepresearch", { query: "Research" });
  assert.match(
    textOf(started),
    /mode: fast \(25 credits; tools like screenshots or code execution may add credits\)/,
  );
  const done = await h.call("valyu_deepresearch_status", {
    task_id: "task-123",
  });
  assert.match(
    textOf(done),
    /Cost: 49 credits \(incl\. screenshots 8 credits, code execution 16 credits\)/,
  );
});

test("instant mode is offered at 8 credits without checkpoints or deliverables", async (t) => {
  const h = harness(t, [{ deepresearch_id: "task-instant" }]);
  assert.match(
    h.tools.get("valyu_deepresearch").description,
    /"instant": fastest, lightest mode for quick factual questions, 8 credits/,
  );
  for (const extra of [
    { hitl: { plan_review: true } },
    { deliverables: ["an Excel sheet"] },
  ]) {
    const refused = await h.call("valyu_deepresearch", {
      query: "Boiling point of ethanol",
      mode: "instant",
      ...extra,
    });
    assert.equal(refused.isError, true);
    assert.match(textOf(refused), /Instant mode does not support/);
  }
  assert.equal(h.requests.length, 0);

  const started = await h.call("valyu_deepresearch", {
    query: "Boiling point of ethanol",
    mode: "instant",
    hitl: { plan_review: false },
  });
  assert.equal(h.requests[0].body.mode, "instant");
  assert.match(textOf(started), /mode: instant \(8 credits;/);
});

test("listing tolerates a task with neither title nor query", async (t) => {
  const h = harness(t, [
    [
      {
        deepresearch_id: "task-1",
        status: "completed",
        created_at: "2026-10-20T10:24:59.052Z",
      },
    ],
  ]);
  const result = await h.call("valyu_deepresearch_status", {});
  assert.equal(result.isError, undefined);
  assert.match(textOf(result), /task-1.*\n  \(untitled\)/);
});

test("structured output and PDF conflict fails before any paid task starts", async (t) => {
  const h = harness(t, []);
  const result = await h.call("valyu_deepresearch", {
    query: "Research",
    output_schema: { type: "object" },
    pdf: true,
  });
  assert.equal(result.isError, true);
  assert.equal(h.requests.length, 0);
});

test("completed status retains the entire report, citations and deliverable links", async (t) => {
  const report = "# Report\n" + "Evidence with a citation. ".repeat(25_000);
  const h = harness(t, [
    {
      status: "completed",
      output: report,
      sources: [{ title: "Study", url: "https://example.com/study" }],
      deliverables: [
        {
          type: "docx",
          title: "Report",
          status: "completed",
          url: "https://example.com/report.docx",
        },
      ],
    },
  ]);
  const result = await h.call("valyu_deepresearch_status", {
    task_id: "task-123",
  });
  assert.ok(textOf(result).includes(report));
  assert.match(textOf(result), /https:\/\/example.com\/study/);
  assert.match(textOf(result), /https:\/\/example.com\/report.docx/);
  assert.equal(h.requests.length, 1);
});

test("a missing completed report and a failed task are errors rather than successful reports", async (t) => {
  const missingOutputs = [undefined, null, "", " \n "];
  const h = harness(t, [
    ...missingOutputs.map((output) => ({ status: "completed", output })),
    { status: "failed", error: "source retrieval failed" },
  ]);
  for (const output of missingOutputs) {
    const missing = await h.call("valyu_deepresearch_status", {
      task_id: "task-123",
    });
    assert.equal(missing.isError, true, `Missing output: ${String(output)}`);
    assert.match(textOf(missing), /do not start a duplicate/);
  }
  const failed = await h.call("valyu_deepresearch_status", {
    task_id: "task-123",
  });
  assert.equal(failed.isError, true);
  assert.match(textOf(failed), /source retrieval failed/);
});

test("structured empty reports are returned without semantic filtering", async (t) => {
  for (const output of [{}, []]) {
    const h = harness(t, [{ status: "completed", output }]);
    const result = await h.call("valyu_deepresearch_status", {
      task_id: "task-123",
    });
    assert.notEqual(result.isError, true);
    assert.ok(textOf(result).includes(JSON.stringify(output)));
  }
});

test("a human checkpoint returns immediately even when a wait was requested", async (t) => {
  const plan =
    "Review clinical trials. ".repeat(500) + "Final checkpoint question";
  const h = harness(t, [
    {
      status: "awaiting_input",
      interaction: {
        interaction_id: "review-1",
        type: "plan_review",
        data: { plan },
      },
    },
  ]);
  const result = await h.call("valyu_deepresearch_status", {
    task_id: "task-123",
    wait_seconds: 30,
  });
  assert.match(textOf(result), /review-1/);
  assert.match(textOf(result), /plan_review/);
  assert.ok(textOf(result).includes(plan));
  assert.equal(h.requests.length, 1);
});

test("inline creation waits report checkpoints and cancellation accurately", async (t) => {
  for (const status of ["awaiting_input", "paused", "cancelled"]) {
    const h = harness(t, [
      { deepresearch_id: "task-123" },
      {
        status,
        interaction: {
          interaction_id: "review-1",
          type: "plan_review",
          data: { plan: "Review trials" },
        },
      },
    ]);
    const result = await h.call("valyu_deepresearch", {
      query: "Research trials",
      wait_seconds: 1,
    });
    assert.match(textOf(result), /task-123/);
    assert.ok(textOf(result).includes(status));
    assert.doesNotMatch(textOf(result), /Tell the user it is running/);
    if (status !== "cancelled") {
      assert.match(textOf(result), /review-1/);
      assert.match(textOf(result), /Review trials/);
    }
    assert.equal(h.requests.length, 2);
  }
});

test("caller cancellation interrupts a pending status wait and propagates to upstream", async (t) => {
  const h = harness(t, [
    (init) => {
      setTimeout(() => h.controller.abort(new Error("caller cancelled")), 5);
      return Response.json({ status: "running" });
    },
  ]);
  const result = await h.call("valyu_deepresearch_status", {
    task_id: "task-123",
    wait_seconds: 30,
  });
  assert.equal(result.isError, true);
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].signal.aborted, true);
});

test("recent task listing and control validation preserve their separate permissions", async (t) => {
  const h = harness(t, [
    [
      {
        deepresearch_id: "old-task",
        status: "completed",
        query: "Trial landscape",
        created_at: "2026-09-10T11:00:00Z",
      },
    ],
  ]);
  const listed = await h.call("valyu_deepresearch_status", { limit: 5 });
  assert.match(textOf(listed), /old-task/);
  assert.match(h.requests[0].url, /limit=5/);
  assert.equal(
    h.tools.get("valyu_deepresearch_status").annotations.readOnlyHint,
    true,
  );
  assert.equal(
    h.tools.get("valyu_deepresearch_control").annotations.destructiveHint,
    true,
  );
  const invalid = await h.call("valyu_deepresearch_control", {
    task_id: "old-task",
    action: "share",
  });
  assert.equal(invalid.isError, true);
  assert.equal(h.requests.length, 1);
});

test("uncertain creation outcomes require checking recent tasks before retrying", async (t) => {
  for (const error of [
    new DOMException("The operation timed out", "TimeoutError"),
    new DOMException("The operation was aborted", "AbortError"),
    new TypeError("fetch failed"),
    new ValyuApiError(500, "Server error"),
    new ValyuApiError(502, "Bad gateway"),
    new ValyuApiError(504, "Gateway timeout"),
  ]) {
    const h = harness(t, [
      () => {
        throw error;
      },
    ]);
    const result = await h.call("valyu_deepresearch", {
      query: "Trial outcomes",
      wait_seconds: 0,
    });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /may have been accepted/);
    assert.match(
      textOf(result),
      /Check recent tasks with valyu_deepresearch_status before retrying/,
    );
    assert.doesNotMatch(textOf(result), /Retry once/);
    assert.equal(h.requests.length, 1);
  }
});

test("a queued creation shows the plan's cap message and status instead of running", async (t) => {
  const h = harness(t, [
    {
      deepresearch_id: "task-queued",
      status: "queued",
      message:
        "Queued: your Pay-as-you-go plan runs 3 DeepResearch tasks at once, so this one starts when one of yours finishes. Upgrade to Ridiculously Cheap to run 30 at once: https://platform.valyu.ai/user/account/billing?tab=plan",
    },
  ]);
  const result = await h.call("valyu_deepresearch", {
    query: "Trial outcomes",
    wait_seconds: 0,
  });
  assert.equal(result.isError, undefined);
  const text = textOf(result);
  assert.match(text, /task-queued/);
  assert.match(text, /status: queued/);
  assert.match(text, /Queued: your Pay-as-you-go plan runs 3 DeepResearch tasks/);
  assert.equal(h.requests.length, 1);
});

test("definite creation rejections do not suggest the task may have started", async (t) => {
  for (const status of [400, 402, 403, 429]) {
    const h = harness(t, [
      () => {
        throw new ValyuApiError(status, "Request rejected");
      },
    ]);
    const result = await h.call("valyu_deepresearch", {
      query: "Trial outcomes",
    });
    assert.equal(result.isError, true);
    assert.doesNotMatch(
      textOf(result),
      /may have been accepted|Check recent tasks/,
    );
    assert.equal(h.requests.length, 1);
  }
});

test("request warnings are shown on start and with the finished report", async (t) => {
  const warning = {
    type: "datasets_not_in_plan",
    message: "Your Pay-as-you-go plan doesn't include valyu/valyu-biorxiv, so it was skipped.",
  };
  const h = harness(t, [
    { deepresearch_id: "task-123", status: "queued", warnings: [warning] },
    { status: "completed", output: "# Report", warnings: ["Collection 'nope' not found"] },
  ]);
  const started = textOf(await h.call("valyu_deepresearch", { query: "Research" }));
  assert.match(started, /\nWarnings:\n- Your Pay-as-you-go plan doesn't include valyu\/valyu-biorxiv, so it was skipped\.\n/);

  const done = textOf(await h.call("valyu_deepresearch_status", { task_id: "task-123" }));
  assert.match(done, /# Report\n\nWarnings:\n- Collection 'nope' not found/);
});

test("a fetch timeout is reported as a timeout, not an unexpected error", () => {
  // AbortSignal.timeout rejects fetch with a TimeoutError DOMException.
  const timeout = new DOMException("The operation was aborted due to timeout", "TimeoutError");
  const abort = new DOMException("This operation was aborted", "AbortError");
  for (const err of [timeout, abort]) {
    const text = textOf(renderApiError(err, "valyu_search"));
    assert.match(text, /valyu_search timed out\./, err.name);
    assert.doesNotMatch(text, /aborted due to timeout/, err.name);
  }
});
