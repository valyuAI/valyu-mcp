/** Request/response shapes for the Valyu API surface the MCP server uses. */

export type SearchType = "all" | "web" | "proprietary";
export type ResponseLength = "short" | "medium" | "large" | "max" | number;

export interface SearchParams {
  query: string;
  max_num_results?: number;
  search_type?: SearchType;
  included_sources?: string[];
  excluded_sources?: string[];
  source_biases?: Record<string, number>;
  relevance_threshold?: number;
  start_date?: string;
  end_date?: string;
  category?: string;
  country_code?: string;
  response_length?: ResponseLength;
}

export interface SearchResult {
  id?: string;
  title?: string;
  url?: string;
  content?: unknown;
  source?: string;
  description?: string;
  publication_date?: string;
  authors?: string[];
  doi?: string;
  citation?: string;
  pmid?: string;
  pmcid?: string;
  /** Map of filename to a presigned URL, on corpora that extract figures. */
  image_url?: Record<string, string> | string[] | string;
  citation_count?: number;
  abstract?: string;
  relevance_score?: number;
  metadata?: Record<string, unknown>;
  [k: string]: unknown;
}

/** Something the API skipped or adjusted. Older responses send plain strings. */
export type ApiWarning =
  | string
  | { type: string; message: string; detail?: Record<string, unknown> };

export interface SearchResponse {
  success: boolean;
  error?: string;
  tx_id?: string;
  query?: string;
  results?: SearchResult[];
  results_by_source?: Record<string, number>;
  total_deduction_dollars?: number;
  total_characters?: number;
  warnings?: ApiWarning[];
  /** Some deployments nest results under `data`. Tolerated by the reader. */
  data?: { results?: SearchResult[] };
}

export interface ContentsParams {
  urls: string[];
  response_length?: ResponseLength;
  extract_effort?: "normal" | "high" | "auto";
  summary?: boolean | string | Record<string, unknown>;
  screenshot?: boolean;
  max_price_dollars?: number;
}

export interface ContentsResult {
  url?: string;
  title?: string;
  content?: unknown;
  summary?: unknown;
  length?: number;
  source?: string;
  error?: string;
  /** Presigned page render, present only when `screenshot: true` was sent. */
  screenshot_url?: string;
  [k: string]: unknown;
}

export interface ContentsResponse {
  success: boolean;
  error?: string;
  tx_id?: string;
  results?: ContentsResult[];
  urls_requested?: number;
  urls_processed?: number;
  urls_failed?: number;
  total_deduction_dollars?: number;
}

export interface Datasource {
  id: string;
  name?: string;
  description?: string;
  category?: string;
  type?: string;
  modality?: string;
  topics?: string[];
  languages?: string[];
  source?: string;
  example_queries?: string[];
  pricing?: { cpm?: number; [k: string]: unknown };
  update_frequency?: string;
  size?: string;
  coverage?: string;
  /**
   * Which products can reach this dataset. Some datasets are DeepResearch-only
   * and 403 the whole search request if included - this field is how we avoid
   * that.
   */
  access_modes?: string[];
  [k: string]: unknown;
}

export interface DatasourceCategory {
  name?: string;
  description?: string;
  count?: number;
  [k: string]: unknown;
}

export interface DatasourcesResponse {
  success: boolean;
  datasources?: Datasource[];
  total_count?: number;
  categories?: Record<string, DatasourceCategory>;
}

export type ResearchMode = "instant" | "fast" | "standard" | "heavy" | "max";

/** POST /v1/deepresearch/tasks body (DeepResearchCreateRequest). */
export interface DeepResearchCreateParams {
  query?: string;
  workflow_id?: string;
  workflow_params?: Record<string, unknown>;
  workflow_version?: number;
  mode?: ResearchMode;
  research_strategy?: string;
  report_format?: string;
  search?: {
    search_type?: "all" | "web" | "proprietary";
    source_biases?: Record<string, number>;
    included_sources?: string[];
    excluded_sources?: string[];
    country_code?: string;
    start_date?: string;
    end_date?: string;
  };
  urls?: string[];
  files?: { data: string; filename: string; mediaType: string; context?: string }[];
  output_formats?: (string | Record<string, unknown>)[];
  deliverables?: (string | Record<string, unknown>)[];
  tools?: Record<string, boolean | { enabled?: boolean; max_calls?: number }>;
  hitl?: Record<string, boolean>;
  mcp_servers?: Record<string, unknown>[];
  previous_reports?: string[];
  webhook_url?: string;
  alert_email?: string | { email: string; custom_url?: string };
  metadata?: Record<string, string | number | boolean>;
}

export type ResearchStatus =
  | "queued"
  | "running"
  | "awaiting_input"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";

export interface DeepResearchCreateResponse {
  success?: boolean;
  task_id?: string;
  id?: string;
  status?: ResearchStatus;
  /** Set when the task is queued behind the org's concurrency cap. */
  message?: string;
  warnings?: ApiWarning[];
  [k: string]: unknown;
}

export interface DeepResearchSource {
  title?: string;
  url?: string;
  fragment?: string;
  [k: string]: unknown;
}

/** GET /v1/deepresearch/list item. */
export interface DeepResearchListItem {
  deepresearch_id: string;
  query?: string;
  title?: string;
  status: ResearchStatus;
  created_at: string;
  public?: boolean;
  mode?: string;
  [k: string]: unknown;
}

/** Current HITL checkpoint; present when status is awaiting_input or paused. */
export interface DeepResearchInteraction {
  interaction_id: string;
  type: "planning_questions" | "plan_review" | "source_review" | "outline_review" | string;
  data?: unknown;
  [k: string]: unknown;
}

export interface DeepResearchStatusResponse {
  success?: boolean;
  task_id?: string;
  id?: string;
  status?: ResearchStatus;
  progress?: unknown;
  current_step?: number;
  total_steps?: number;
  output?: unknown;
  sources?: DeepResearchSource[];
  error?: string;
  cost?: number;
  cost_breakdown?: Record<string, number>;
  output_type?: "markdown" | "json" | "toon" | string;
  pdf_url?: string;
  deliverables?: { title?: string; type?: string; status?: string; url?: string; description?: string }[];
  images?: { title?: string; image_type?: string; image_url?: string; description?: string }[];
  total_deduction_dollars?: number;
  hitl?: unknown;
  interaction?: DeepResearchInteraction;
  warnings?: ApiWarning[];
  [k: string]: unknown;
}

/**
 * GET /v1/account/me - the caller's plan and the datasets it covers. Accepts
 * the same API keys as every other endpoint and requires no extra scope.
 */
export interface AccountResponse {
  org_id?: string;
  name?: string;
  tier?: string;
  allowed_datasets?: string[];
  key?: {
    id?: string;
    name?: string;
    scopes?: string[];
    credit_cap_usd?: number | null;
    credit_spent_usd?: number | null;
  };
}
