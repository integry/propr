/**
 * Free-plan preflight for `propr deploy fly`. Fly rejects a volume over 5 GB
 * on the Free plan ("size_gb must be between 1GB and 5GB. Volumes larger than
 * 5GB aren't included in the Free plan"), which used to surface partway
 * through a deploy, at `volumes create` or `volumes extend`. The org's plan
 * is read from Fly's GraphQL API (`organization.paidPlan`) before anything is
 * created, and an oversized `--volume-size` is refused there instead.
 *
 * The probe never blocks a deploy on its own failure: an unreadable plan is
 * "unknown" and the deploy goes on, as it did before the preflight existed.
 */

import type { FlyDeployPlan } from "./flyMachineConfig.js";

export const FLY_GRAPHQL_URL = "https://api.fly.io/graphql";
/** Largest volume Fly accepts on the Free plan. */
export const FLY_FREE_PLAN_MAX_VOLUME_GB = 5;

export type FlyOrgPlan = "free" | "paid" | "unknown";

const ORG_PLAN_QUERY = "query($slug: String!) { organization(slug: $slug) { slug paidPlan } }";

/**
 * The org's plan, or "unknown" when Fly cannot be asked or does not say.
 * `authorization` is a full Authorization header value (see
 * flyAuthorizationHeader); it is never logged.
 */
export async function fetchFlyOrgPlan(
  authorization: string,
  org: string,
  fetchImpl: typeof fetch = fetch,
  url: string = FLY_GRAPHQL_URL,
): Promise<FlyOrgPlan> {
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { Authorization: authorization, Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ query: ORG_PLAN_QUERY, variables: { slug: org } }),
    });
    if (!response.ok) return "unknown";
    const body = await response.json() as { data?: { organization?: { paidPlan?: unknown } | null } };
    const paidPlan = body?.data?.organization?.paidPlan;
    if (paidPlan === false) return "free";
    if (paidPlan === true) return "paid";
    return "unknown";
  } catch {
    return "unknown";
  }
}

/** Whether the plan's volume is larger than the Free plan allows (and so worth a plan lookup). */
export function exceedsFreePlanVolumeCap(plan: Pick<FlyDeployPlan, "volumeSizeGb">): boolean {
  return plan.volumeSizeGb > FLY_FREE_PLAN_MAX_VOLUME_GB;
}

/** Refuse, before anything is created, a volume Fly would reject for a Free-plan org. */
export function assertVolumeFitsFlyPlan(plan: Pick<FlyDeployPlan, "org" | "volumeSizeGb">, orgPlan: FlyOrgPlan): void {
  if (orgPlan !== "free" || !exceedsFreePlanVolumeCap(plan)) return;
  throw new Error(
    `org ${plan.org} is on the Fly Free plan, which caps volumes at ${FLY_FREE_PLAN_MAX_VOLUME_GB} GB, but --volume-size is ${plan.volumeSizeGb} GB. `
      + "Nothing was created. Rerun without --volume-size (default: 1 GB, enough for SQLite and Redis); "
      + "--legacy-docker keeps Docker images on the Machine's persistent root filesystem (--rootfs-size), not on the volume.",
  );
}
