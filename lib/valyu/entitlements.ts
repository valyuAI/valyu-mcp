/** Account-listed access is confirmed; absent datasets remain unknown. */

import { ValyuClient } from "./client";

/**
 * Plan labels as published on https://www.valyu.ai/pricing. Names only, no
 * prices: the account API supplies the tier, not current pricing.
 */
const PLAN_NAMES: Record<string, string> = {
  tier_0: "Pay As You Go",
  tier_1: "Ridiculously Cheap",
  tier_2: "Comfortably Pro",
  tier_3: "Serious Business",
};

/**
 * Map the API's plan id to its published plan name. Returns undefined for
 * anything unrecognised rather than echoing a raw id into tool output;
 * callers fall back to "the current plan".
 */
export function planLabel(tier: string | undefined): string | undefined {
  if (!tier) return undefined;
  return PLAN_NAMES[tier];
}

export interface Entitlements {
  /** False when we have not been able to establish anything. */
  known: boolean;
  /** True when every supplied catalog id appears in the account's list. */
  fullAccess: boolean;
  /** Dataset ids the plan covers. */
  allowed: Set<string>;
  currentTier?: string;
}

const UNKNOWN: Entitlements = {
  known: false,
  fullAccess: false,
  allowed: new Set(),
};

/**
 * Resolve entitlements from the account API. Never throws: subscription
 * awareness is an enhancement, and a failure here must not take down
 * valyu_datasources.
 */
export async function getEntitlements(
  client: ValyuClient,
  catalogIds: string[],
): Promise<Entitlements> {
  try {
    const acct = await client.account();
    const allowed = new Set(acct.allowed_datasets ?? []);
    if (!acct.tier && allowed.size === 0) return UNKNOWN;

    return {
      known: true,
      fullAccess: catalogIds.every((id) => allowed.has(id)),
      allowed,
      currentTier: acct.tier,
    };
  } catch {
    // 401 on a dead key, or the endpoint being unavailable. Either way we know
    // nothing about the plan, and saying nothing beats guessing.
    return UNKNOWN;
  }
}

/** True when this dataset is covered by the caller's plan. */
export function canAccess(e: Entitlements, id: string): true | undefined {
  return e.known && e.allowed.has(id) ? true : undefined;
}
