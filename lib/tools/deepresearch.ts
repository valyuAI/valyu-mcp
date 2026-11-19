import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { DEEPRESEARCH_POLL_INTERVAL_S } from "@/lib/constants";
import { ValyuApiError, ValyuClient } from "@/lib/valyu/client";
import {
  recordToolFailure,
  renderApiError,
  toolError,
  type ToolError,
} from "@/lib/mcp/errors";
import { renderWarnings } from "@/lib/mcp/format";
import { validateSourceBiases } from "@/lib/valyu/sources";
import type { ToolDeps } from "./search";
import type {
  DeepResearchEditParams,
  DeepResearchEditRecord,
  DeepResearchInteraction,
  DeepResearchListItem,
  DeepResearchStatusResponse,
  DeepResearchVersionList,
} from "@/lib/valyu/types";

/** Research creation and status retrieval use separate tool permissions. */
const MAX_WAIT_SECONDS = 30;
const REQUEST_BUDGET_MS = 45_000;
/** The edit endpoint waits inline for at most this long; the rest is polled. */
const EDIT_INLINE_WAIT_SECONDS = 20;

/** DeepResearch is billed in credits; the API reports costs in USD. */
const CREDITS_PER_USD = 160;

/** The per-mode price in credits: the one place it is written down. */
const MODES = {
  instant: {
    credits: 8,
    summary: "fastest, lightest mode for quick factual questions",
  },
  fast: { credits: 25, summary: "focused research" },
  standard: { credits: 100, summary: "broader research" },
  heavy: { credits: 500, summary: "deeper investigation" },
  max: { credits: 2_500, summary: "most extensive investigation" },
} as const;
type Mode = keyof typeof MODES;
const MODE_NAMES = Object.keys(MODES) as [Mode, ...Mode[]];

/** Per successful use, on top of the mode price. */
const TOOL_CREDITS = { screenshot: 8, codeExecution: 16, browserUse: 48 };

function credits(n: number): string {
  return `${n.toLocaleString("en-US", { maximumFractionDigits: 2 })} credits`;
}

const MODE_GUIDE = `${MODE_NAMES.map(
  (m) => `- "${m}": ${MODES[m].summary}, ${credits(MODES[m].credits)}.`,
).join("\n")}
Completion time varies by scope, source availability and service load. Optional tools and deliverables may add credits.`;

function requestSignal(...signals: (AbortSignal | undefined)[]): AbortSignal {
  return AbortSignal.any([
    ...signals.filter((signal): signal is AbortSignal => signal !== undefined),
    AbortSignal.timeout(REQUEST_BUDGET_MS),
  ]);
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function idOf(r: Record<string, unknown>): string | undefined {
  return (
    (typeof r.deepresearch_id === "string" && r.deepresearch_id) ||
    (typeof r.task_id === "string" && r.task_id) ||
    (typeof r.id === "string" && r.id) ||
    undefined
  );
}

function progressOf(s: DeepResearchStatusResponse): {
  step?: number;
  total?: number;
} {
  const p = s.progress as
    { current_step?: number; total_steps?: number } | undefined;
  return { step: p?.current_step, total: p?.total_steps };
}

const TERMINAL = new Set(["completed", "failed", "cancelled"]);
const WAITING_FOR_USER = new Set(["awaiting_input", "paused"]);

function renderTaskList(tasks: DeepResearchListItem[]): string {
  if (!tasks.length) return "No deepresearch tasks yet for this organisation.";
  const lines = tasks.map((t) => {
    const when = Number.isFinite(Date.parse(t.created_at))
      ? new Date(t.created_at).toISOString().replace("T", " ").slice(0, 16) +
        " UTC"
      : t.created_at;
    const title = (t.title || t.query || "(untitled)")
      .replace(/\s+/g, " ")
      .slice(0, 140);
    return `- \`${t.deepresearch_id}\` · ${t.status}${t.public ? " · public" : ""} · ${when}\n  ${title}`;
  });
  return (
    `${tasks.length} recent deepresearch task${tasks.length === 1 ? "" : "s"} (newest first):\n\n` +
    lines.join("\n") +
    `\n\nGet a report with valyu_deepresearch_status(task_id).`
  );
}

/**
 * A human-in-the-loop checkpoint. The model relays it to the user and answers
 * via valyu_deepresearch_control "respond"; the response shape depends on
 * the checkpoint type, so the shape is spelled out here rather than left to
 * be guessed.
 */
const RESPONSE_SHAPES: Record<string, string> = {
  planning_questions:
    '{"answers": [{"question": "<question text>", "answer": "<answer>"}, …]}',
  plan_review:
    '{"approved": true} or {"approved": false, "modifications": "<what to change>"}',
  source_review:
    '{"included_domains": ["…"], "excluded_domains": ["…"]} (both may be [] to accept the recommendations)',
  outline_review:
    '{"approved": true} or {"approved": false, "modifications": "<what to change>"}',
};

function renderInteraction(
  taskId: string,
  interaction: DeepResearchInteraction | undefined,
): string {
  if (!interaction) {
    return "Paused at a human-in-the-loop checkpoint, but no checkpoint details were returned; check again shortly.";
  }
  const data = JSON.stringify(interaction.data ?? {}, null, 1);
  const shape =
    RESPONSE_SHAPES[interaction.type] ?? "(see the checkpoint data)";
  return (
    `Paused at a human-in-the-loop checkpoint (${interaction.type}). Put this to the user, then answer with ` +
    `valyu_deepresearch_control {"action": "respond", "task_id": "${taskId}", "interaction_id": "${interaction.interaction_id}", "response": ${shape}}.\n\n` +
    `Checkpoint data:\n${data}`
  );
}

/** Render a completed task's report in full - it is the deliverable. */
function renderReport(
  s: DeepResearchStatusResponse,
  opts: { includeSources: boolean },
): string {
  const body =
    typeof s.output === "string"
      ? s.output
      : "```json\n" + JSON.stringify(s.output ?? null, null, 2) + "\n```";

  const parts: string[] = [];
  // An earlier version must never be mistaken for the current report.
  if (s.is_latest === false && typeof s.version === "number") {
    parts.push(
      `(Version ${s.version} of this report, not the current version. Omit \`version\` to read the current one.)`,
      "",
    );
  }
  // The report body usually opens with its own H1; only add the task title
  // when it does not, otherwise the heading appears twice.
  if (
    typeof s.title === "string" &&
    s.title &&
    !body.trimStart().startsWith("#")
  ) {
    parts.push(`# ${s.title}`, "");
  }
  parts.push(body);

  if (opts.includeSources && Array.isArray(s.sources) && s.sources.length) {
    parts.push("", `## Sources (${s.sources.length})`);
    s.sources.forEach((src, i) => {
      const url = src.fragment ? `${src.url}${src.fragment}` : src.url;
      parts.push(`${i + 1}. [${src.title ?? url ?? "source"}](${url ?? ""})`);
    });
  }

  const files: string[] = [];
  if (typeof s.pdf_url === "string" && s.pdf_url)
    files.push(`- PDF: ${s.pdf_url}`);
  for (const d of s.deliverables ?? []) {
    // The id is what valyu_deepresearch_edit takes as `deliverable_id`.
    const label = `${d.type ?? "file"} ${d.title ?? ""}${d.id ? ` (id ${d.id})` : ""}`;
    if (d.url)
      files.push(
        `- ${label}: ${d.url}${d.status && d.status !== "completed" ? ` (${d.status})` : ""}`,
      );
    else if (d.status === "failed") files.push(`- ${label}: generation failed`);
  }
  for (const img of s.images ?? []) {
    if (img.image_url)
      files.push(
        `- ${img.image_type ?? "image"} ${img.title ?? ""}: ${img.image_url}`,
      );
  }
  if (files.length) parts.push("", "## Files", ...files);

  const warnings = renderWarnings(s.warnings);
  if (warnings) parts.push("", warnings);

  const versionLines: string[] = [];
  if (s.is_latest !== false && typeof s.version === "number" && s.version > 1) {
    versionLines.push(
      `Version ${s.version}${s.revised_at ? `, last revised ${s.revised_at}` : ""}. List earlier versions with valyu_deepresearch_versions.`,
    );
  }
  if (s.active_edit?.edit_id) {
    versionLines.push(
      `An edit is running on this report (edit_id \`${s.active_edit.edit_id}\`); this text is from before it. Check it with valyu_deepresearch_edit and that edit_id.`,
    );
  } else if (s.editable && s.is_latest !== false) {
    versionLines.push(
      "This report can be refined with valyu_deepresearch_edit instead of new research.",
    );
  }
  if (versionLines.length) parts.push("", ...versionLines);

  const cost = typeof s.cost === "number" ? s.cost : undefined;
  if (cost !== undefined) {
    const extras = Object.entries(s.cost_breakdown ?? {})
      .filter(([k, v]) => k !== "task" && typeof v === "number" && v > 0)
      .map(
        ([k, v]) =>
          `${k.replace(/_/g, " ")} ${credits((v as number) * CREDITS_PER_USD)}`,
      );
    parts.push(
      "",
      `Cost: ${credits(cost * CREDITS_PER_USD)}${extras.length ? ` (incl. ${extras.join(", ")})` : ""}`,
    );
  }

  return parts.join("\n");
}

export function registerDeepResearchTools(
  server: McpServer,
  deps: ToolDeps,
): void {
  registerStartTool(server, deps);
  registerStatusTool(server, deps);
  registerControlTool(server, deps);
  registerEditTool(server, deps);
  registerVersionsTool(server, deps);
}

/** Start a task, with an optional bounded inline wait for it to finish. */
function registerStartTool(server: McpServer, deps: ToolDeps): void {
  server.tool(
    "valyu_deepresearch",
    `Start an asynchronous research task that searches sources and produces a cited report. Use when the user requests deep research or an extensive investigation and accepts background execution and its cost. For a short factual lookup, use search.

The default call returns a task id after the task is accepted. Use valyu_deepresearch_status to check progress and retrieve the completed report and requested files. Completion time varies; a task can take many minutes or longer. Each call starts a new task and incurs charges. If the creation response is lost, check recent tasks before retrying to avoid duplicate charges.

Provide a research brief and select a mode. Optional inputs can restrict source scope, provide relevant URLs or files, define report structure, request structured output or generated documents, and enable review checkpoints. Supply only inputs needed for the user's requested research. Source and date filters restrict available evidence, so preserve the user's intended scope.

Modes:
${MODE_GUIDE}`,
    {
      query: z
        .string()
        .trim()
        .min(1)
        .max(25_000)
        .describe(
          "The research question, scope, timeframe and requested output. Include only information relevant to this research task.",
        ),
      mode: z
        .enum(MODE_NAMES)
        .default("fast")
        .describe(`Depth/cost tier.\n${MODE_GUIDE}`),
      wait_seconds: z.coerce
        .number()
        .int()
        .min(0)
        .max(MAX_WAIT_SECONDS)
        .default(0)
        .describe(
          "Seconds to wait for completion, from 0 to 30. Default 0 returns a task id after acceptance. Use the status tool later to retrieve the report.",
        ),
      report_format: z
        .string()
        .max(1000)
        .optional()
        .describe(
          'Natural-language guidance for the report structure, e.g. "a one-page memo with a risks table" or "bullet points, no preamble".',
        ),
      research_strategy: z
        .string()
        .max(1000)
        .optional()
        .describe(
          'Natural-language guidance for how to run the research, e.g. "prioritise primary sources and SEC filings over news".',
        ),
      included_sources: z
        .array(z.string())
        .max(20)
        .optional()
        .describe(
          'Restrict research to dataset ids, domains or URL prefixes, or "web". Use for an explicit source restriction; omit for unrestricted research.',
        ),
      excluded_sources: z
        .array(z.string())
        .max(20)
        .optional()
        .describe(
          "Dataset ids, domains or URL prefixes to exclude when requested by the user.",
        ),
      source_biases: z
        .record(z.string(), z.coerce.number().int().min(-5).max(5))
        .optional()
        .describe(
          "Adjust source ranking without excluding sources. Map a domain or URL prefix to an integer from -5 to +5. Use only for a requested source preference.",
        ),
      search_type: z
        .enum(["all", "web", "proprietary"])
        .optional()
        .describe(
          "Search all sources (default), web only, or proprietary datasets only. Use a restricted value when the user requests that scope.",
        ),
      country_code: z
        .string()
        .length(2)
        .optional()
        .describe(
          "Two-letter country code to geo-target web results when relevant to the requested geographic scope, e.g. GB.",
        ),
      start_date: z
        .string()
        .optional()
        .describe(
          "Include sources published on or after this date (YYYY-MM-DD). Use for an explicit publication-date restriction.",
        ),
      end_date: z
        .string()
        .optional()
        .describe(
          "Include sources published on or before this date (YYYY-MM-DD). Use for an explicit publication-date restriction.",
        ),
      urls: z
        .array(z.string().url())
        .max(10)
        .optional()
        .describe(
          "Up to 10 URLs the agent must read and use as context (e.g. a filing, a trial page, a competitor's site).",
        ),
      previous_reports: z
        .array(z.string())
        .max(3)
        .optional()
        .describe(
          "Up to 3 earlier task ids whose reports become context for this one - for follow-ups and updates.",
        ),
      files: z
        .array(
          z.object({
            data: z
              .string()
              .describe(
                "data:<mediaType>;base64,<base64> URL of the file content.",
              ),
            filename: z.string(),
            mediaType: z
              .string()
              .describe("MIME type, e.g. application/pdf or text/csv."),
            context: z
              .string()
              .max(10_000)
              .optional()
              .describe("What the file is and how to use it."),
          }),
        )
        .max(10)
        .optional()
        .describe(
          "Up to 10 files (as base64 data URLs) for the agent to analyse. Keep them small; large uploads belong in the platform UI.",
        ),
      pdf: z
        .boolean()
        .default(false)
        .describe(
          "Also produce a PDF of the report (a download link is returned with the report).",
        ),
      output_schema: z
        .record(z.string(), z.unknown())
        .optional()
        .describe(
          "JSON Schema for structured JSON output instead of a markdown report. Cannot be combined with `pdf`.",
        ),
      deliverables: z
        .array(
          z.union([
            z.string().max(500),
            z.object({
              type: z.enum(["csv", "xlsx", "pptx", "docx", "pdf"]),
              description: z.string().max(500),
              columns: z.array(z.string()).optional(),
            }),
          ]),
        )
        .max(10)
        .optional()
        .describe(
          'Up to 10 files to generate from the report, e.g. "an Excel sheet of every trial with phase and sponsor" or {"type": "pptx", "description": "10-slide summary"}. Download links come back with the report. Not available in instant mode.',
        ),
      tools: z
        .object({
          code_execution: z
            .boolean()
            .optional()
            .describe(
              `Sandboxed Python for analysis and tables (${credits(TOOL_CREDITS.codeExecution)} per successful run).`,
            ),
          screenshots: z
            .boolean()
            .optional()
            .describe(
              `Capture screenshots of web pages (${credits(TOOL_CREDITS.screenshot)} per capture).`,
            ),
          browser_use: z
            .boolean()
            .optional()
            .describe(
              `Autonomous browser sessions for interactive sites (${credits(TOOL_CREDITS.browserUse)} per session). Not available in instant mode.`,
            ),
          charts: z
            .boolean()
            .optional()
            .describe("Embed generated charts in the report (free)."),
        })
        .optional()
        .describe(
          "Enable or disable analysis and document tools needed for the requested research. Some tools add credits.",
        ),
      hitl: z
        .object({
          planning_questions: z
            .boolean()
            .optional()
            .describe(
              "Pause before starting to ask the user clarifying questions.",
            ),
          plan_review: z
            .boolean()
            .optional()
            .describe(
              "Pause after planning so the user can approve or amend the plan.",
            ),
          source_review: z
            .boolean()
            .optional()
            .describe(
              "Pause after the sweep so the user can include/exclude source domains.",
            ),
          outline_review: z
            .boolean()
            .optional()
            .describe(
              "Pause before writing so the user can approve the outline.",
            ),
        })
        .optional()
        .describe(
          'Human-in-the-loop checkpoints. A paused task shows up in valyu_deepresearch_status with the question to relay; answer via valyu_deepresearch_control action "respond". Use when the user wants to steer the work at key points. Not available in instant mode.',
        ),
    },
    {
      title: "DeepResearch",
      // Not read-only on purpose: this creates a long-running task and spends
      // credits (see MODES). Hosts should be free to confirm it.
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
    },
    async (args, extra) => {
      const signal = requestSignal(deps.signal, extra.signal);
      const client = new ValyuClient(
        deps.ctx.apiKey,
        signal,
        "valyu_deepresearch",
      );
      let taskId: string | undefined;
      let createdMessage: string | undefined;
      let createdStatus: string | undefined;
      let createdWarnings = "";

      if (args.source_biases) {
        const problem = validateSourceBiases(args.source_biases);
        if (problem) return toolError(problem);
      }
      // Instant produces no deliverables and offers no review checkpoints;
      // refuse both here so the model gets one clear message before any task
      // starts.
      if (
        args.mode === "instant" &&
        (Object.values(args.hitl ?? {}).some(Boolean) ||
          args.deliverables?.length)
      ) {
        return toolError(
          "Instant mode does not support review checkpoints (`hitl`) or `deliverables`. Remove them, or use fast mode or above.",
        );
      }
      if (args.output_schema && args.pdf) {
        return toolError(
          "`output_schema` (structured JSON) cannot be combined with `pdf`; choose one.",
        );
      }

      const search = {
        search_type: args.search_type,
        included_sources: args.included_sources,
        excluded_sources: args.excluded_sources,
        source_biases: args.source_biases,
        country_code: args.country_code,
        start_date: args.start_date,
        end_date: args.end_date,
      };
      const output_formats = args.output_schema
        ? [args.output_schema]
        : args.pdf
          ? ["markdown", "pdf"]
          : undefined;

      try {
        const created = await client.createResearch({
          query: args.query,
          mode: args.mode,
          report_format: args.report_format,
          research_strategy: args.research_strategy,
          // The API scopes search under a `search` object; top-level
          // included_sources / dates are silently ignored.
          search: Object.values(search).some((v) => v !== undefined)
            ? search
            : undefined,
          urls: args.urls,
          previous_reports: args.previous_reports,
          files: args.files,
          output_formats,
          deliverables: args.deliverables,
          tools: args.tools,
          hitl: args.hitl,
        });
        taskId = idOf(created as Record<string, unknown>);
        createdMessage = typeof created.message === "string" ? created.message : undefined;
        createdStatus = typeof created.status === "string" ? created.status : undefined;
        createdWarnings = renderWarnings(created.warnings);
      } catch (err) {
        if (!(err instanceof ValyuApiError) || err.status >= 500) {
          return toolError(
            "Research creation could not be confirmed. The task may have been " +
              "accepted. Check recent tasks with valyu_deepresearch_status before " +
              "retrying to avoid duplicate charges.",
          );
        }
        return renderApiError(err, "Starting deepresearch");
      }

      if (!taskId) {
        return toolError(
          "Research creation returned no task id. Check recent tasks " +
            "with valyu_deepresearch_status before retrying to avoid duplicate charges.",
        );
      }

      const started = Date.now();
      const deadline = started + args.wait_seconds * 1000;
      let last: DeepResearchStatusResponse | undefined;

      while (
        args.wait_seconds > 0 &&
        Date.now() < deadline &&
        !signal.aborted
      ) {
        const remaining = deadline - Date.now();
        try {
          await pause(
            Math.min(DEEPRESEARCH_POLL_INTERVAL_S * 1000, remaining),
            signal,
          );
          last = await client.researchStatus(taskId);
        } catch {
          break; // fall through to returning the handle
        }
        const { step, total } = progressOf(last);

        // Report progress while a caller explicitly waits for completion.
        if (extra?.sendNotification && typeof step === "number") {
          await extra
            .sendNotification({
              method: "notifications/progress",
              params: {
                progressToken: extra.requestId ?? taskId,
                progress: step,
                total: total ?? undefined,
                message: `Researching - step ${step}${total ? `/${total}` : ""}`,
              },
            })
            .catch(() => undefined);
        }
        if (
          last.status &&
          (TERMINAL.has(last.status) || WAITING_FOR_USER.has(last.status))
        )
          break;
      }

      const elapsed = Math.round((Date.now() - started) / 1000);

      if (last?.status === "completed") {
        return {
          content: [
            {
              type: "text" as const,
              text:
                `Research complete (${elapsed}s). Task id: \`${taskId}\`\n\n` +
                `Call valyu_deepresearch_status with this id to read the report.`,
            },
          ],
        };
      }
      if (last?.status === "failed") {
        return toolError(
          `Deepresearch failed: ${last.error ?? "unknown error"}\n\n` +
            `Retry with a simpler query, or use valyu_search instead.`,
        );
      }
      if (
        last?.status === "cancelled" ||
        (last?.status && WAITING_FOR_USER.has(last.status))
      ) {
        return {
          content: [
            {
              type: "text" as const,
              text:
                `Task id: \`${taskId}\`\nStatus: ${last.status}\n\n` +
                (last.status === "cancelled"
                  ? "The task was cancelled."
                  : renderInteraction(taskId, last.interaction)) +
                (createdWarnings ? `\n\n${createdWarnings}` : ""),
            },
          ],
        };
      }

      const { step, total } = progressOf(last ?? {});
      const progressLine =
        typeof step === "number"
          ? ` Currently at step ${step}${total ? `/${total}` : ""}.`
          : "";

      return {
        content: [
          {
            type: "text" as const,
            text:
              `Deepresearch started.\n\n` +
              `task_id: \`${taskId}\`\n` +
              `mode: ${args.mode} (${credits(MODES[args.mode].credits)}; tools like screenshots or code execution may add credits)\n` +
              `status: ${last?.status ?? createdStatus ?? "running"}\n` +
              (createdMessage ? `\n${createdMessage}\n` : "") +
              (createdWarnings ? `\n${createdWarnings}\n` : "") +
              `elapsed: ${elapsed}s${progressLine}\n\n` +
              `Tell the user it is running and give them the task_id so the report ` +
              `is never lost, then carry on. Check on it with valyu_deepresearch_status ` +
              `(instant by default) whenever the user asks or you come back to it; ` +
              `it returns the report itself once finished. Do not poll in a loop.`,
          },
        ],
      };
    },
  );
}

/** Poll, collect the finished report, or list recent tasks. */
function registerStatusTool(server: McpServer, deps: ToolDeps): void {
  server.tool(
    "valyu_deepresearch_status",
    `Retrieve a research task's status or completed report. Without task_id, list recent tasks for the account.

Running tasks return a compact status and progress summary. Completed tasks return the full report, citations and generated-file links. Paused tasks return the review checkpoint to relay to the user. Failed and cancelled tasks retain their terminal status.

The default returns the current state without waiting. An optional wait of up to 30 seconds checks for completion within that interval. If the task is still running, retain its id and check again later. Avoid repeated immediate checks.`,
    {
      task_id: z
        .string()
        .min(1)
        .optional()
        .describe(
          "The task id returned by valyu_deepresearch. Omit to list recent tasks instead.",
        ),
      limit: z.coerce
        .number()
        .int()
        .min(1)
        .max(50)
        .default(20)
        .describe(
          "Listing only: how many recent tasks to return (default 20).",
        ),
      wait_seconds: z.coerce
        .number()
        .int()
        .min(0)
        .max(MAX_WAIT_SECONDS)
        .default(0)
        .describe(
          "Seconds to wait for completion, from 0 to 30. Default 0 retrieves the current state without waiting.",
        ),
      include_sources: z
        .boolean()
        .default(true)
        .describe(
          "Include the citation list with deep links into each source (completed tasks only).",
        ),
      version: z.coerce
        .number()
        .int()
        .min(1)
        .optional()
        .describe(
          "Read an earlier version of an edited report (see valyu_deepresearch_versions). Omit for the current version.",
        ),
    },
    {
      title: "Research status, report & list",
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
    async ({ task_id, limit, wait_seconds, include_sources, version }, extra) => {
      const signal = requestSignal(deps.signal, extra.signal);
      const client = new ValyuClient(
        deps.ctx.apiKey,
        signal,
        "valyu_deepresearch_status",
      );
      try {
        if (!task_id) {
          const tasks = await client.listResearch(limit);
          return {
            content: [{ type: "text" as const, text: renderTaskList(tasks) }],
          };
        }
        const deadline = Date.now() + wait_seconds * 1000;
        let s = await client.researchStatus(task_id, version);

        while (
          !(
            s.status &&
            (TERMINAL.has(s.status) || WAITING_FOR_USER.has(s.status))
          ) &&
          Date.now() + DEEPRESEARCH_POLL_INTERVAL_S * 1000 < deadline &&
          !signal.aborted
        ) {
          await pause(DEEPRESEARCH_POLL_INTERVAL_S * 1000, signal);
          s = await client.researchStatus(task_id, version);
        }

        if (s.status === "completed") {
          if (
            s.output === undefined ||
            s.output === null ||
            (typeof s.output === "string" && !s.output.trim())
          ) {
            return toolError(
              `Task \`${task_id}\` is marked completed, but its report was not returned. Check the task again; do not start a duplicate research task.`,
            );
          }
          return {
            content: [
              {
                type: "text" as const,
                text: renderReport(s, { includeSources: include_sources }),
              },
            ],
            _meta: { "anthropic/maxResultSizeChars": 500_000 },
          };
        }

        const { step, total } = progressOf(s);
        const createdAt =
          typeof (s as { created_at?: unknown }).created_at === "string"
            ? Date.parse((s as { created_at: string }).created_at)
            : NaN;
        const elapsedLine = Number.isFinite(createdAt)
          ? ` (${Math.max(0, Math.round((Date.now() - createdAt) / 60000))} min elapsed)`
          : "";
        const lines = [
          `status: ${s.status ?? "unknown"}`,
          typeof step === "number"
            ? `progress: step ${step}${total ? `/${total}` : ""}`
            : null,
          s.status === "failed"
            ? `Failed: ${s.error ?? "unknown error"}`
            : s.status === "awaiting_input" || s.status === "paused"
              ? renderInteraction(task_id, s.interaction)
              : s.status && TERMINAL.has(s.status)
                ? null
                : `Still running${elapsedLine}. Report this to the user (task_id \`${task_id}\`) and check again later - an immediate re-check returns this same line.`,
        ].filter(Boolean);
        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
          ...(s.status === "failed" ? { isError: true } : {}),
        };
      } catch (err) {
        return renderApiError(err, "Checking deepresearch status");
      }
    },
  );
}

/** Steer, cancel, answer a checkpoint, share or delete a task. */
function registerControlTool(server: McpServer, deps: ToolDeps): void {
  server.tool(
    "valyu_deepresearch_control",
    `Manage a deepresearch task. Only act on the user's explicit request; these change or remove their work.

action "steer": send a follow-up instruction to redirect or narrow a running task - e.g. "focus on European regulation" or "ignore pre-2024 sources".
action "cancel": stop a queued, running or paused task. Cancellation does not imply a refund of charges already incurred.
action "respond": answer a human-in-the-loop checkpoint (status awaiting_input / paused). valyu_deepresearch_status shows the checkpoint, its interaction_id and the exact response shape.
action "share": turn the public share link on or off (\`public\` true/false).
action "delete": permanently delete a finished (completed, failed or cancelled) task and its report. Irreversible - confirm with the user first.
action "restore": make an earlier \`version\` of an edited report current again (see valyu_deepresearch_versions). It adds a new version; nothing is lost.`,
    {
      task_id: z
        .string()
        .min(1)
        .describe(
          "The task id returned by valyu_deepresearch (or listed by valyu_deepresearch_status).",
        ),
      action: z
        .enum(["steer", "cancel", "respond", "share", "delete", "restore"])
        .describe(
          '"steer", "cancel", "respond", "share", "delete" or "restore" - see the tool description.',
        ),
      instruction: z
        .string()
        .min(1)
        .max(2000)
        .optional()
        .describe(
          'The steering instruction, in plain language. Required when action is "steer".',
        ),
      interaction_id: z
        .string()
        .min(1)
        .optional()
        .describe(
          'The checkpoint id shown by valyu_deepresearch_status. Required when action is "respond".',
        ),
      response: z
        .record(z.string(), z.unknown())
        .optional()
        .describe(
          'The checkpoint answer, in the shape valyu_deepresearch_status specified for that checkpoint type. Required when action is "respond".',
        ),
      public: z
        .boolean()
        .optional()
        .describe(
          'Required when action is "share": true publishes a share link, false removes it.',
        ),
      version: z.coerce
        .number()
        .int()
        .min(1)
        .optional()
        .describe(
          'Required when action is "restore": the version number to make current.',
        ),
    },
    {
      title: "Steer, cancel, respond, share, delete or restore deepresearch",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      // action "share" publishes a public link to the report, which changes
      // publicly visible state outside the user's account. That makes this
      // open-world even though every other action stays inside the account.
      openWorldHint: true,
    },
    async (
      {
        task_id,
        action,
        instruction,
        interaction_id,
        response,
        public: isPublic,
        version,
      },
      extra,
    ) => {
      const client = new ValyuClient(
        deps.ctx.apiKey,
        requestSignal(deps.signal, extra.signal),
        "valyu_deepresearch_control",
      );
      const ok = (text: string) => ({
        content: [{ type: "text" as const, text }],
      });
      try {
        switch (action) {
          case "steer": {
            if (!instruction) {
              return toolError(
                'action "steer" needs an `instruction`, e.g. {"action": "steer", "task_id": "…", "instruction": "focus on primary sources"}.',
              );
            }
            await client.updateResearch(task_id, instruction);
            return ok(
              `Instruction sent to task \`${task_id}\`. It will be applied to the remaining deepresearch steps.`,
            );
          }
          case "cancel":
            await client.cancelResearch(task_id);
            return ok(`Task \`${task_id}\` cancelled.`);
          case "respond": {
            if (!interaction_id || !response) {
              return toolError(
                'action "respond" needs `interaction_id` and `response`; call valyu_deepresearch_status(task_id) to see the checkpoint and the response shape it expects.',
              );
            }
            const r = (await client.respondResearch(
              task_id,
              interaction_id,
              response,
            )) as {
              status?: string;
            };
            return ok(
              `Checkpoint answered; task \`${task_id}\` is ${r?.status ?? "resuming"}. Check on it later with valyu_deepresearch_status.`,
            );
          }
          case "share": {
            if (typeof isPublic !== "boolean") {
              return toolError('action "share" needs `public`: true or false.');
            }
            const r = (await client.setResearchPublic(task_id, isPublic)) as {
              public?: boolean;
              share_url?: string;
              url?: string;
            };
            const link = r?.share_url ?? r?.url;
            return ok(
              (r?.public ?? isPublic)
                ? `Task \`${task_id}\` is now public${link ? `: ${link}` : "."}`
                : `Task \`${task_id}\` is private again.`,
            );
          }
          case "delete":
            await client.deleteResearch(task_id);
            return ok(`Task \`${task_id}\` and its report have been deleted.`);
          case "restore": {
            if (version === undefined) {
              return toolError(
                'action "restore" needs `version`; call valyu_deepresearch_versions(task_id) to see the versions.',
              );
            }
            const r = await client.restoreResearchVersion(task_id, version);
            return ok(
              `Version ${r.restored_from ?? version} of task \`${task_id}\` is current again, as version ${r.version}. Read it with valyu_deepresearch_status.`,
            );
          }
        }
      } catch (err) {
        if (action === "restore") {
          return renderEditApiError(err, "Restoring the report version");
        }
        return renderApiError(err, `Research task action "${action}"`);
      }
    },
  );
}

/** Shared by the report-edit tools. */
const EDIT_DESCRIPTION =
  "Make small, targeted edits to a finished DeepResearch report or deliverable with a plain-language instruction. Untouched text stays exactly as it was, citations stay consistent, and every edit creates a new version you can restore. " +
  "Use it to refine a report you already have (fix a figure, tighten a section, change tone, add a cited point from the sources the task gathered) instead of running new research. Large rewrites are declined; start a new task for those.";

/** What to do after each decline, in addition to the API's own suggestion. */
const DECLINE_NEXT: Record<string, string> = {
  "edit.rewrite_requested":
    "The change is too large for an edit. Split it into smaller targeted edits, or, if the user wants a rewrite, start a new task with valyu_deepresearch.",
  "edit.out_of_evidence":
    "The sources this task gathered do not cover it. Tell the user; a new task with valyu_deepresearch is needed to research it.",
  "edit.contradictory":
    "Clarify the instruction with the user, then edit again.",
  "edit.unsafe_instruction": "Revise the instruction before trying again.",
  "edit.not_applicable":
    "Check the target and focus (`deliverable_id`, `section`, `text`) match what the user meant, then edit again.",
  "edit.no_change": "The report already does what was asked; nothing to do.",
};

/** HTTP-level edit rejections, by the API's `code`. Nothing was run. */
const EDIT_ERRORS: Record<string, string> = {
  "edit.invalid_request": "the request was rejected as invalid",
  "edit.task_not_completed":
    "the task has not completed. Only a completed report can be edited; check it with valyu_deepresearch_status",
  "edit.in_progress":
    "another edit is already running on this task. Wait for it to finish (valyu_deepresearch_status shows it), then retry",
  "edit.revision_conflict":
    "the report has changed since the `base_version` given. Read the current version with valyu_deepresearch_status, then retry against it (or omit `base_version`)",
  "edit.unsupported_task":
    "this task's output cannot be edited. Only markdown reports can; start a new task for a different output",
  "focus.not_found":
    "the `text` or `section` was not found in the report. Copy the passage exactly from the current report (valyu_deepresearch_status), or give the section heading instead",
  "edit.busy": "the editor is busy right now. Wait a short while, then retry",
};

function renderEditApiError(err: unknown, context: string): ToolError {
  if (!(err instanceof ValyuApiError)) return renderApiError(err, context);
  const code = err.code;
  if (code === "focus.ambiguous") {
    recordToolFailure(err, context);
    const options = (err.candidates ?? []).slice(0, 10).map((c) => {
      const str = (v: unknown) => (typeof v === "string" ? v : "");
      return `- section "${str(c.section) || "(none)"}": ...${str(c.prefix)}[passage]${str(c.suffix)}...`;
    });
    return toolError(
      `${context} failed (focus.ambiguous): the \`text\` matches more than one place in the report, so nothing was changed.\n` +
        (options.length ? `\nMatches:\n${options.join("\n")}\n` : "") +
        `\nAdd the \`section\` it is in, or include more of the surrounding words in \`text\`, then retry.`,
    );
  }
  if (code && EDIT_ERRORS[code]) {
    recordToolFailure(err, context);
    return toolError(
      `${context} failed (${code}): ${EDIT_ERRORS[code]}.` +
        (err.body ? `\n\nDetails: ${err.body}` : ""),
    );
  }
  if (err.status === 404) {
    recordToolFailure(err, context);
    return toolError(
      `${context} failed: not found - ${err.body}\n\n` +
        `Check the task id (and edit id or version). Editing is available only for completed reports on accounts where it is enabled.`,
    );
  }
  if (err.status === 403 && !/credential|api[_ -]?key|unauthor|invalid token/i.test(err.body)) {
    recordToolFailure(err, context);
    return toolError(
      `${context} failed (HTTP 403): ${err.body}\n\n` +
        `Only the account that ran the task can edit it, read its earlier versions or restore them.`,
    );
  }
  return renderApiError(err, context);
}

function renderEditRecord(
  taskId: string,
  r: DeepResearchEditRecord,
  waitedSeconds: number,
): { content: { type: "text"; text: string }[]; isError?: true } {
  const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
  const what =
    r.target?.kind === "deliverable"
      ? `deliverable ${r.target.deliverable_id}`
      : "report";

  if (r.status === "applied") {
    const lines = [
      `Edit applied to the ${what} of task \`${taskId}\`: now version ${r.version ?? "?"}` +
        (r.base_version ? ` (edited from version ${r.base_version}).` : "."),
    ];
    if (r.summary) lines.push("", `Summary: ${r.summary}`);
    const changes = (r.changes ?? [])
      .map((c) =>
        [c.section, c.description].filter((v) => typeof v === "string" && v).join(": "),
      )
      .filter(Boolean);
    if (changes.length) lines.push("", "Changes:", ...changes.map((c) => `- ${c}`));
    const unapplied = (r.unapplied ?? []).map((u) =>
      typeof u === "string" ? u : JSON.stringify(u),
    );
    if (unapplied.length)
      lines.push("", "Not applied:", ...unapplied.map((u) => `- ${u}`));
    const warnings = renderWarnings(r.warnings);
    if (warnings) lines.push("", warnings);
    if (r.pdf_url) lines.push("", `PDF: ${r.pdf_url}`);
    lines.push(
      "",
      `Read the updated ${what === "report" ? "report" : "task"} with valyu_deepresearch_status(task_id). ` +
        `The previous version stays available (valyu_deepresearch_versions) and can be restored.`,
    );
    return text(lines.join("\n"));
  }

  if (r.status === "declined") {
    const code = r.decline?.code ?? "declined";
    const lines = [
      `Edit declined (${code}): ${r.decline?.message ?? r.summary ?? "no reason given"}`,
    ];
    if (r.decline?.suggestion) lines.push(`Suggestion: ${r.decline.suggestion}`);
    lines.push(
      "",
      `No new version was created; the ${what} is unchanged.`,
    );
    if (DECLINE_NEXT[code]) lines.push(DECLINE_NEXT[code]);
    return text(lines.join("\n"));
  }

  if (r.status === "failed") {
    const e = r.error;
    return toolError(
      `Edit failed${e?.code ? ` (${e.code})` : ""}: ${e?.message ?? "unknown error"}\n\n` +
        (e?.retryable
          ? "Nothing was changed. Submit the edit again."
          : "Nothing was changed. Tell the user; retrying the same edit is unlikely to help."),
    );
  }

  return text(
    `Edit still running after ${waitedSeconds}s (edit_id \`${r.edit_id}\`). ` +
      `Check it later with valyu_deepresearch_edit {"task_id": "${taskId}", "edit_id": "${r.edit_id}"}; ` +
      `do not submit the instruction again.`,
  );
}

/** Edit a completed report, waiting for the result within the call's limits. */
function registerEditTool(server: McpServer, deps: ToolDeps): void {
  server.tool(
    "valyu_deepresearch_edit",
    `${EDIT_DESCRIPTION}

The task must be completed. Write the instruction as the user would, e.g. "cut the executive summary to 3 bullets" or "correct the 2025 revenue figure to $4.2B". To focus the edit, pass the \`section\` heading or the exact \`text\` to change; to edit a generated file instead of the report, pass its \`deliverable_id\` (listed with the report by valyu_deepresearch_status).

The call waits up to \`wait_seconds\` (default 30) and returns the summary, the changes and the new version, or why the edit was declined. If it is still running, check it later by passing its \`edit_id\` instead of an instruction. Each call with an instruction is a new edit; do not resend one that is still running.`,
    {
      task_id: z
        .string()
        .min(1)
        .describe("The id of the completed research task."),
      instruction: z
        .string()
        .trim()
        .min(1)
        .max(4000)
        .optional()
        .describe(
          "What to change, in plain language. Required unless `edit_id` is given.",
        ),
      section: z
        .string()
        .trim()
        .min(1)
        .max(300)
        .optional()
        .describe(
          'Heading of the section to edit, e.g. "Executive Summary". Report edits only.',
        ),
      text: z
        .string()
        .min(1)
        .max(20_000)
        .optional()
        .describe(
          "The exact passage to edit, copied from the report (a highlighted passage). Report edits only.",
        ),
      deliverable_id: z
        .string()
        .min(1)
        .optional()
        .describe(
          'Edit this generated file (e.g. "f_01") instead of the report.',
        ),
      base_version: z.coerce
        .number()
        .int()
        .min(1)
        .optional()
        .describe(
          "The version you read. If the report has changed since, the edit is refused instead of applied to newer text.",
        ),
      edit_id: z
        .string()
        .min(1)
        .optional()
        .describe(
          "Check on an edit that was still running, instead of starting a new one.",
        ),
      wait_seconds: z.coerce
        .number()
        .int()
        .min(0)
        .max(MAX_WAIT_SECONDS)
        .default(MAX_WAIT_SECONDS)
        .describe(
          "Seconds to wait for the result, from 0 to 30 (default 30).",
        ),
    },
    {
      title: "Edit a deepresearch report",
      // Creates a new version; earlier versions stay restorable.
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    async (args, extra) => {
      const signal = requestSignal(deps.signal, extra.signal);
      const client = new ValyuClient(
        deps.ctx.apiKey,
        signal,
        "valyu_deepresearch_edit",
      );
      const context = "Editing the report";
      if (!args.edit_id && !args.instruction) {
        return toolError(
          "Pass an `instruction` to start an edit, or the `edit_id` of an edit that was still running.",
        );
      }
      if (args.edit_id && args.instruction) {
        return toolError(
          "Pass either `instruction` (a new edit) or `edit_id` (check an earlier one), not both.",
        );
      }
      if (args.deliverable_id && (args.section || args.text)) {
        return toolError(
          "`section` and `text` focus a report edit; leave them out when editing a deliverable.",
        );
      }

      const started = Date.now();
      const deadline = started + args.wait_seconds * 1000;
      let record: DeepResearchEditRecord;

      if (args.edit_id) {
        try {
          record = await client.researchEdit(args.task_id, args.edit_id);
        } catch (err) {
          return renderEditApiError(err, context);
        }
      } else {
        const focus =
          args.section || args.text
            ? { section: args.section, text: args.text }
            : undefined;
        const params: DeepResearchEditParams = {
          instruction: args.instruction!,
          target: args.deliverable_id
            ? { kind: "deliverable", deliverable_id: args.deliverable_id }
            : undefined,
          focus: focus && (Object.fromEntries(
            Object.entries(focus).filter(([, v]) => v !== undefined),
          ) as DeepResearchEditParams["focus"]),
          base_version: args.base_version,
          wait_seconds: Math.min(EDIT_INLINE_WAIT_SECONDS, args.wait_seconds),
        };
        try {
          record = await client.editResearch(args.task_id, params);
        } catch (err) {
          if (!(err instanceof ValyuApiError) || err.status >= 500) {
            recordToolFailure(err, context);
            return toolError(
              `${context} could not be confirmed; the edit may have started. ` +
                `Check valyu_deepresearch_status(task_id) for an edit in progress, or valyu_deepresearch_versions, before retrying so the change is not applied twice.`,
            );
          }
          return renderEditApiError(err, context);
        }
      }

      while (record.status === "running" && record.edit_id) {
        const interval =
          Math.min(Math.max(record.retry_after_seconds ?? 3, 1), 10) * 1000;
        if (Date.now() + interval >= deadline || signal.aborted) break;
        try {
          await pause(interval, signal);
          record = await client.researchEdit(args.task_id, record.edit_id);
        } catch {
          break; // return what we have; the edit_id lets the caller resume
        }
      }

      return renderEditRecord(
        args.task_id,
        record,
        Math.round((Date.now() - started) / 1000),
      );
    },
  );
}

function renderVersions(taskId: string, v: DeepResearchVersionList): string {
  const versions = [...(v.versions ?? [])].sort((a, b) => b.version - a.version);
  if (!versions.length) return `Task \`${taskId}\` has no versions to list.`;
  const lines = versions.map((x) => {
    const target =
      x.target?.kind === "deliverable"
        ? ` · deliverable ${x.target.deliverable_id}`
        : "";
    const head = [
      `- version ${x.version}${x.is_head ? " (current)" : ""}`,
      x.kind,
      x.created_at,
    ]
      .filter(Boolean)
      .join(" · ");
    const detail = [
      x.instruction ? `  Instruction: ${x.instruction}` : null,
      x.summary ? `  Summary: ${x.summary}` : null,
      x.pdf_url ? `  PDF: ${x.pdf_url}` : null,
    ].filter(Boolean);
    return [head + target, ...detail].join("\n");
  });
  return (
    `Task \`${taskId}\`: ${versions.length} version${versions.length === 1 ? "" : "s"}, current version ${v.head ?? "?"} (newest first).\n\n` +
    lines.join("\n") +
    `\n\nRead a version with valyu_deepresearch_status(task_id, version). Restore one with valyu_deepresearch_control action "restore" only when the user asks.`
  );
}

/** List the versions an edited report has been through. */
function registerVersionsTool(server: McpServer, deps: ToolDeps): void {
  server.tool(
    "valyu_deepresearch_versions",
    `List the versions of a deepresearch report: the original, each edit made with valyu_deepresearch_edit (with its instruction and summary) and each restore, newest first, marking the current one. Use it to find an earlier version to read with valyu_deepresearch_status, or to restore when the user asks.`,
    {
      task_id: z
        .string()
        .min(1)
        .describe("The id of the research task."),
    },
    {
      title: "Deepresearch report versions",
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
    async ({ task_id }, extra) => {
      const client = new ValyuClient(
        deps.ctx.apiKey,
        requestSignal(deps.signal, extra.signal),
        "valyu_deepresearch_versions",
      );
      try {
        const v = await client.researchVersions(task_id);
        return {
          content: [{ type: "text" as const, text: renderVersions(task_id, v) }],
        };
      } catch (err) {
        return renderEditApiError(err, "Listing report versions");
      }
    },
  );
}
