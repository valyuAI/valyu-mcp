/**
 * Typed Valyu API client.
 *
 * Every method takes its credential explicitly. There is deliberately no
 * module-scope mutable state: one process can serve many concurrent requests,
 * and each must run on - and be billed to - its own caller's key.
 */

import { SDK_NAME, SDK_VERSION, VALYU_BASE_URL } from "@/lib/constants";
import type {
  AccountResponse,
  ContentsParams,
  ContentsResponse,
  DatasourcesResponse,
  DeepResearchCreateParams,
  DeepResearchCreateResponse,
  DeepResearchListItem,
  DeepResearchStatusResponse,
  SearchParams,
  SearchResponse,
} from "./types";

/**
 * The `recovery` block the search endpoint attaches to a plan-access 403
 * (`tier_insufficient` or `dataset_unavailable`). It is the only place the API
 * tells a caller what its plan actually covers: `available_datasets` lists
 * every dataset the caller's plan and grants include.
 */
export interface TierRecovery {
  /** Plan id that unlocks every requested dataset. Older field, still sent. */
  requiredTier?: string;
  /** The caller's plan id, e.g. "tier_0". Absent from older responses. */
  currentPlan?: string;
  /** The plan that unlocks every requested dataset; absent when none does. */
  requiredPlan?: { id?: string; name?: string; price?: string };
  upgradeUrl?: string;
  /** Sent when some requested datasets are licensed or not datasets at all. */
  contactUrl?: string;
  /** The requested datasets the caller cannot search. */
  excludedDatasets?: string[];
  availableDatasets?: string[];
}

/**
 * Parsed out of the older error sentence, "Your current plan (tier_1) does not
 * include access to: ...". Only a fallback for `recovery.current_plan`: the
 * current sentence names the plan instead.
 */
const CURRENT_TIER = /current plan \((tier_\d)\)/i;

function str(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}

function strList(v: unknown): string[] | undefined {
  return Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : undefined;
}

export class ValyuApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    readonly code?: string,
    readonly restrictedSources?: string[],
    readonly recovery?: TierRecovery,
    readonly currentTier?: string,
    /** Seconds to wait before retrying. Only ever set on a 429. */
    readonly retryAfter?: number,
    /** The caller's plan name, as sent on a 429. */
    readonly plan?: string,
    /** Which bucket was limited and its sustained rate, as sent on a 429. */
    readonly limit?: { endpoint?: string; requests_per_second?: number },
    /** Self-serve upgrade link, as sent on a 429. */
    readonly upgradeUrl?: string,
    /** Sales contact link, sent on a 429 instead of upgradeUrl where applicable. */
    readonly contactUrl?: string,
  ) {
    super(`Valyu API ${status}: ${body.slice(0, 400)}`);
    this.name = "ValyuApiError";
  }

  /**
   * The API returns two different error envelopes:
   *   {success:false, error:"..."}         (search / contents / deepresearch)
   *   {error:"code", message:"..."}        (workflows, and now rate limits)
   * Normalise both, and pull out `restricted_sources` (datasets unreachable
   * from search at all) and the `recovery` block (datasets above the caller's
   * plan) which mean different things and need different advice.
   */
  static async fromResponse(res: Response): Promise<ValyuApiError> {
    const raw = await res.text();
    let message = raw;
    let code: string | undefined;
    let restricted: string[] | undefined;
    let recovery: TierRecovery | undefined;
    let retryAfter: number | undefined;
    let plan: string | undefined;
    let limit: { endpoint?: string; requests_per_second?: number } | undefined;
    let upgradeUrl: string | undefined;
    let contactUrl: string | undefined;
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      // On a 429 `error` is a machine code ("rate_limited"), not display text -
      // unlike the search/contents/deepresearch envelope, where `error` IS the
      // human message. Prefer `message` there; leave every other status's
      // precedence exactly as before.
      message =
        (res.status === 429 && typeof parsed.message === "string" && parsed.message) ||
        (typeof parsed.error === "string" && parsed.error) ||
        (typeof parsed.message === "string" && parsed.message) ||
        raw;
      code = typeof parsed.code === "string" ? parsed.code : undefined;
      if (Array.isArray(parsed.restricted_sources)) {
        restricted = parsed.restricted_sources.filter(
          (s): s is string => typeof s === "string",
        );
      }
      const rec = parsed.recovery;
      if (rec && typeof rec === "object") {
        const r = rec as Record<string, unknown>;
        const plan =
          r.required_plan && typeof r.required_plan === "object"
            ? (r.required_plan as Record<string, unknown>)
            : undefined;
        recovery = {
          requiredTier: str(r.required_tier),
          currentPlan: str(r.current_plan),
          requiredPlan: plan && {
            id: str(plan.id),
            name: str(plan.name),
            price: str(plan.price),
          },
          upgradeUrl: str(r.upgrade_url),
          contactUrl: str(r.contact_url),
          excludedDatasets: strList(r.excluded_datasets),
          availableDatasets: strList(r.available_datasets),
        };
      }
      if (res.status === 429) {
        retryAfter = typeof parsed.retry_after === "number" ? parsed.retry_after : undefined;
        plan = typeof parsed.plan === "string" ? parsed.plan : undefined;
        if (parsed.limit && typeof parsed.limit === "object" && !Array.isArray(parsed.limit)) {
          const l = parsed.limit as Record<string, unknown>;
          limit = {
            endpoint: typeof l.endpoint === "string" ? l.endpoint : undefined,
            requests_per_second:
              typeof l.requests_per_second === "number" ? l.requests_per_second : undefined,
          };
        }
        upgradeUrl = typeof parsed.upgrade_url === "string" ? parsed.upgrade_url : undefined;
        contactUrl = typeof parsed.contact_url === "string" ? parsed.contact_url : undefined;
      }
    } catch {
      /* non-JSON body: keep the raw text */
    }
    if (res.status === 429 && retryAfter === undefined) {
      const headerValue = res.headers.get("retry-after");
      if (headerValue !== null) {
        const header = Number(headerValue);
        if (Number.isFinite(header)) retryAfter = header;
      }
    }
    const currentTier = recovery?.currentPlan ?? CURRENT_TIER.exec(message)?.[1];
    return new ValyuApiError(
      res.status,
      message,
      code,
      restricted,
      recovery,
      currentTier,
      retryAfter,
      plan,
      limit,
      upgradeUrl,
      contactUrl,
    );
  }
}

function headers(apiKey: string, json = true, integration?: string): Record<string, string> {
  return {
    ...(json ? { "Content-Type": "application/json" } : {}),
    "x-api-key": apiKey,
    "User-Agent": `${SDK_NAME}/${SDK_VERSION}`,
    "X-Valyu-SDK": SDK_NAME,
    "X-Valyu-SDK-Version": SDK_VERSION,
    // Names the MCP tool making the call.
    ...(integration ? { "X-Valyu-Integration": integration } : {}),
  };
}

/**
 * Strip undefined/null/empty-array so we never send inert keys upstream.
 *
 * Sending only meaningful keys keeps requests minimal and makes an empty
 * value impossible to confuse with an intentional one.
 */
function compact<T extends object>(obj: T): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v) && v.length === 0) continue;
    out[k] = v;
  }
  return out;
}

async function request<T>(
  path: string,
  apiKey: string,
  init: {
    method: "GET" | "POST" | "DELETE";
    body?: unknown;
    signal?: AbortSignal;
    integration?: string;
  },
): Promise<T> {
  const res = await fetch(`${VALYU_BASE_URL}${path}`, {
    method: init.method,
    headers: headers(apiKey, init.body !== undefined, init.integration),
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    signal: init.signal,
  });

  // 206 = partial success (some sources/URLs failed). The body is still
  // usable, so treat it as success - a naive res.ok check would too, but
  // being explicit documents the intent.
  if (!res.ok && res.status !== 206) {
    throw await ValyuApiError.fromResponse(res);
  }
  return (await res.json()) as T;
}

export class ValyuClient {
  constructor(
    private readonly apiKey: string,
    private readonly signal?: AbortSignal,
    /** The MCP tool making the call; sent upstream as X-Valyu-Integration. */
    private readonly integration?: string,
  ) {}

  /** Every endpoint below carries the same credential, signal and integration tag. */
  private call<T>(
    path: string,
    init: { method: "GET" | "POST" | "DELETE"; body?: unknown },
  ): Promise<T> {
    return request<T>(path, this.apiKey, {
      ...init,
      signal: this.signal,
      integration: this.integration,
    });
  }

  /**
   * POST /v1/search - the canonical search endpoint.
   *
   * `/v1/deepsearch` was migrated to `/v1/search` per the 2025-12-19 API
   * changelog; this targets the supported endpoint.
   */
  search(params: SearchParams): Promise<SearchResponse> {
    return this.call<SearchResponse>("/v1/search", {
      method: "POST",
      body: compact(params),
    });
  }

  /**
   * GET /v1/account/me - org, subscription tier, and the datasets the plan
   * covers. It needs no extra key scope.
   */
  account(): Promise<AccountResponse> {
    return this.call<AccountResponse>("/v1/account/me", { method: "GET" });
  }

  contents(params: ContentsParams): Promise<ContentsResponse> {
    return this.call<ContentsResponse>("/v1/contents", {
      method: "POST",
      body: compact(params),
    });
  }

  datasources(category?: string): Promise<DatasourcesResponse> {
    const qs = category ? `?category=${encodeURIComponent(category)}` : "";
    return this.call<DatasourcesResponse>(`/v1/datasources${qs}`, { method: "GET" });
  }

  /** Semantic catalogue search: ranked dataset ids for a natural-language query. */
  searchDatasources(
    query: string,
    limit = 10,
  ): Promise<{ results?: { id: string; relevance_score?: number }[]; search_mode?: string }> {
    const qs = `?q=${encodeURIComponent(query)}&limit=${limit}`;
    return this.call(`/v1/datasources/search${qs}`, { method: "GET" });
  }

  createResearch(
    params: DeepResearchCreateParams,
  ): Promise<DeepResearchCreateResponse> {
    return this.call<DeepResearchCreateResponse>("/v1/deepresearch/tasks", {
      method: "POST",
      body: compact(params),
    });
  }

  researchStatus(taskId: string): Promise<DeepResearchStatusResponse> {
    return this.call<DeepResearchStatusResponse>(
      `/v1/deepresearch/tasks/${encodeURIComponent(taskId)}/status`,
      { method: "GET" },
    );
  }

  cancelResearch(taskId: string): Promise<unknown> {
    return this.call(`/v1/deepresearch/tasks/${encodeURIComponent(taskId)}/cancel`, {
      method: "POST",
    });
  }

  /** Steer a running task with a follow-up instruction. */
  updateResearch(taskId: string, instruction: string): Promise<unknown> {
    return this.call(`/v1/deepresearch/tasks/${encodeURIComponent(taskId)}/update`, {
      method: "POST",
      body: { instruction },
    });
  }

  /** Recent tasks for the organisation, newest first. */
  listResearch(limit = 20): Promise<DeepResearchListItem[]> {
    return this.call<DeepResearchListItem[]>(`/v1/deepresearch/list?limit=${limit}`, {
      method: "GET",
    });
  }

  /** Answer a human-in-the-loop checkpoint; resumes a paused/awaiting task. */
  respondResearch(
    taskId: string,
    interactionId: string,
    response: Record<string, unknown>,
  ): Promise<unknown> {
    return this.call(`/v1/deepresearch/tasks/${encodeURIComponent(taskId)}/respond`, {
      method: "POST",
      body: { interaction_id: interactionId, response },
    });
  }

  /** Permanently delete a finished (completed/failed/cancelled) task. */
  deleteResearch(taskId: string): Promise<unknown> {
    return this.call(`/v1/deepresearch/tasks/${encodeURIComponent(taskId)}/delete`, {
      method: "DELETE",
    });
  }

  /** Toggle the public share link for a task. */
  setResearchPublic(taskId: string, isPublic: boolean): Promise<unknown> {
    return this.call(`/v1/deepresearch/tasks/${encodeURIComponent(taskId)}/public`, {
      method: "POST",
      body: { public: isPublic },
    });
  }
}
