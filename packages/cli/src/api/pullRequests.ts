/**
 * Pull request API
 *
 * Read-only pull request views from the ProPR backend's `/api/pull-requests/*` endpoints.
 */

import { ApiClient, createApiClient } from "./index.js";

export type ReadinessGateStatus = "pass" | "waiting" | "fail" | "unknown" | "not_applicable";

export interface PullRequestReadinessGate {
  gate: string;
  status: ReadinessGateStatus;
  /** Stable reason code. */
  reason: string;
  detail?: string;
}

/** The read-only readiness verdict `GET /api/pull-requests/:number/readiness` returns. */
export interface PullRequestReadiness {
  repository: string;
  number: number;
  head: string;
  base: string;
  state: "open" | "merged" | "closed";
  draft: boolean;
  verdict: "ready" | "waiting" | "blocked" | "merged" | "closed" | "unknown";
  gates: PullRequestReadinessGate[];
  blockingReasons: string[];
  waitingReasons: string[];
  review: { score: number; goal: number; goalReached: boolean; reviewedHead: string | null; matchesCurrentHead: boolean } | null;
  ultrafix: { active: boolean; completionStatus: "succeeded" | "failed" | null; labelPresent: boolean } | null;
  checks: { reason: string; blockingFailed: string[]; blockingPending: string[]; nonBlockingCount: number };
  autoMerge: { eligible: "eligible" | "ineligible" | "transient"; reason: string; policy: string | null };
  evaluatedAt: string;
}

/** Evaluate one pull request's readiness; the server never writes anything for this read. */
export async function getPullRequestReadiness(repository: string, number: number, client?: ApiClient): Promise<PullRequestReadiness> {
  const apiClient = client ?? (await createApiClient());
  const params = new URLSearchParams({ repository });
  const response = await apiClient.get<PullRequestReadiness>(`/api/pull-requests/${number}/readiness?${params.toString()}`);
  return response.data;
}
