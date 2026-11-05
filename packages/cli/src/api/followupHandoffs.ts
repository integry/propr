/**
 * PR Follow-up Publication Handoff API
 *
 * Typed wrappers over the admin-only follow-up handoff recovery endpoints
 * (`/api/admin/followup-handoffs`). Every call requires an instance
 * administrator with the `instance.manage_runtime` permission.
 */

import { createApiClient } from "./client.js";

/** One handoff as the admin API reports it. */
export interface FollowupHandoffStatus {
  repository: string;
  pullRequest: number;
  taskId: string;
  predecessorTaskIds: string[];
  successorTaskId: string | null;
  phase: string;
  status: string;
  statusReason: string | null;
  /** Durable owner of the claimed comments once the attempt settled without publishing. */
  settlement: string | null;
  operatorAuthorized: boolean;
  liveness: string;
  branchName: string;
  commitHash: string | null;
  completionCommentUrl: string | null;
  nextAction: string;
  retainedWorktreePath: string;
  updatedAt: number;
}

/** Counters from one keyed recovery pass. */
export interface FollowupHandoffRecoverySummary {
  inspected: number;
  published: number;
  noChanges: number;
  settled: number;
  cleanupPending: number;
  skippedLiveAgent: number;
  failedClosed: number;
  awaitingOperator: number;
  lockedByOtherWriter: number;
  errors: number;
}

export interface FollowupHandoffListResponse {
  handoffs: FollowupHandoffStatus[];
}

export interface FollowupHandoffResumeResponse {
  summary: FollowupHandoffRecoverySummary;
  /** The re-inspected record; null when the recovery pass finalized it. */
  status: FollowupHandoffStatus | null;
}

export interface FollowupHandoffReleaseResponse {
  released: boolean;
  reason?: string;
}

/** Builds the admin endpoint path for one handoff target, with encoded segments. */
export function followupHandoffPath(owner: string, repo: string, pullRequest: number, action?: string): string {
  const base = `/api/admin/followup-handoffs/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${pullRequest}`;
  return action ? `${base}/${action}` : base;
}

export async function listFollowupHandoffs(): Promise<FollowupHandoffListResponse> {
  const client = await createApiClient();
  return (await client.get<FollowupHandoffListResponse>("/api/admin/followup-handoffs")).data;
}

export async function getFollowupHandoff(owner: string, repo: string, pullRequest: number): Promise<{ status: FollowupHandoffStatus }> {
  const client = await createApiClient();
  return (await client.get<{ status: FollowupHandoffStatus }>(followupHandoffPath(owner, repo, pullRequest))).data;
}

export async function resumeFollowupHandoff(
  owner: string,
  repo: string,
  pullRequest: number,
  options: { authorizeCancelled?: boolean } = {}
): Promise<FollowupHandoffResumeResponse> {
  const client = await createApiClient();
  return (await client.post<FollowupHandoffResumeResponse>(
    followupHandoffPath(owner, repo, pullRequest, "resume"),
    { body: { authorizeCancelled: options.authorizeCancelled === true } }
  )).data;
}

export async function releaseFollowupHandoff(
  owner: string,
  repo: string,
  pullRequest: number,
  options: { force?: boolean } = {}
): Promise<FollowupHandoffReleaseResponse> {
  const client = await createApiClient();
  return (await client.post<FollowupHandoffReleaseResponse>(
    followupHandoffPath(owner, repo, pullRequest, "release"),
    { body: { force: options.force === true } }
  )).data;
}
