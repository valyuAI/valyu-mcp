export const SDK_NAME = "valyu-mcp";
export const SDK_VERSION = "2.0.0";

/** Display name for the connector. `SDK_NAME` is a slug and reads as one. */
export const SERVER_TITLE = "Valyu";
export const SERVER_WEBSITE_URL = "https://valyu.ai";

export const VALYU_BASE_URL =
  process.env.VALYU_BASE_URL ?? "https://api.valyu.ai";

/** Emitted in progress notifications; also the client-side poll hint. */
export const DEEPRESEARCH_POLL_INTERVAL_S = 15;
