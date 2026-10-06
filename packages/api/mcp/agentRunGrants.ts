import type { Knex } from 'knex';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import { db } from '@propr/core';
import type { GitHubUser } from '../authTypes.js';
import { resolveInstanceAuthorization } from '../authorization.js';
import { githubUserGrantService, type GitHubUserGrantService } from '../githubUserGrantService.js';
import { McpError, type McpConfig, type McpScope } from './config.js';
import { getMcpScopeCeilingSync, resolveMcpConfig } from './configResolver.js';
import { McpOAuthProvider } from './oauth.js';
import { McpStore } from './store.js';

/**
 * Run-scoped ProPR MCP grants for agent containers.
 *
 * An agent run acts as its owner through a delegated grant limited to the
 * definition's repositories and to the scopes of one phase. The grant is an
 * ordinary MCP grant, so `McpPolicy.authenticate` re-checks membership and
 * GitHub access on every call (the grant records the owner's membership source,
 * as browser consent does, so losing an explicit membership ends it), it is listed on the Connected apps page and its
 * calls are recorded in the MCP access log. Expiry is only a backstop: the
 * worker revokes the grant when the phase ends.
 */

export const AGENT_RUN_MCP_CLIENT_ID = 'propr-agent-runs';
export const AGENT_RUN_GRANT_TTL_MS = 2 * 60 * 60 * 1000;
/** `mcp_records` kind locating the grant of one run phase (`<runId>:<phase>`), for revocation and the daemon sweep. */
export const AGENT_RUN_GRANT_RECORD_KIND = 'agent_run_grant';

export type AgentRunGrantPhase = 'report' | 'action';
export const AGENT_RUN_GRANT_PHASES: readonly AgentRunGrantPhase[] = ['report', 'action'];

/** Report reads context only; acting never merges, deploys, manages or reviews. */
export const AGENT_RUN_PHASE_SCOPES: Readonly<Record<AgentRunGrantPhase, readonly McpScope[]>> = {
  report: ['read'],
  action: ['read', 'plan', 'execute'],
};

/**
 * Internal public client. With no redirect URIs and no grant types it can never
 * complete interactive OAuth; it only labels the grants issued here.
 */
export const AGENT_RUN_MCP_CLIENT: OAuthClientInformationFull = {
  client_id: AGENT_RUN_MCP_CLIENT_ID,
  client_name: 'ProPR Agent',
  redirect_uris: [],
  grant_types: [],
  response_types: [],
  token_endpoint_auth_method: 'none',
};

export interface AgentRunGrantRecord {
  runId: string;
  phase: AgentRunGrantPhase;
  grantId: string;
  ownerId: string;
  expiresAt: number;
}

export interface IssuedAgentRunGrant {
  grantId: string;
  accessToken: string;
  expiresAt: number;
}

export interface AgentRunGrantDependencies {
  database?: Knex;
  resolveConfig?: (database: Knex) => Promise<McpConfig | null>;
  userGrants?: Pick<GitHubUserGrantService, 'resolve'>;
}

export function agentRunGrantRecordId(runId: string, phase: AgentRunGrantPhase): string {
  return `${runId}:${phase}`;
}

async function provider({ database = db, resolveConfig = resolveMcpConfig }: AgentRunGrantDependencies): Promise<McpOAuthProvider> {
  const config = await resolveConfig(database).catch(() => null);
  if (!config) throw new McpError('MCP_DISABLED', 'The ProPR MCP server is not enabled on this instance.', 503);
  return new McpOAuthProvider(new McpStore(database, config.encryptionKey), config, () => getMcpScopeCeilingSync() ?? config.scopeCeiling);
}

/** The owner's GitHub credential for the MCP principal, from the stored user grant. */
async function ownerCredential(ownerId: string, database: Knex, userGrants: Pick<GitHubUserGrantService, 'resolve'>): Promise<GitHubUser> {
  const resolution = await userGrants.resolve(ownerId);
  if (resolution.status === 'temporarily_unavailable') {
    throw new McpError('GITHUB_UNAVAILABLE', 'GitHub authorization refresh is temporarily unavailable.', 503, { retryable: true });
  }
  if (resolution.status !== 'active') {
    throw new McpError('GITHUB_AUTHORIZATION_REQUIRED', 'The agent owner must sign in to ProPR to authorize GitHub access.', 409);
  }
  const row = await database('github_user_grants').where({ github_user_id: ownerId }).first('github_username').catch(() => undefined);
  const login = typeof row?.github_username === 'string' && row.github_username ? row.github_username : ownerId;
  return {
    id: ownerId, login, username: login, displayName: login, email: null, avatarUrl: null,
    accessToken: resolution.accessToken, refreshToken: resolution.refreshToken,
    tokenExpiresAt: resolution.tokenExpiresAt, refreshTokenExpiresAt: resolution.refreshTokenExpiresAt,
  };
}

/**
 * Locks the phase record for the rest of `tx`, so issuance and revocation of
 * one run phase are serialized. The row is created first when missing (the
 * placeholder holds no grant and never commits on its own), since a lock on a
 * missing row would not stop two first issuances from both seeing no
 * predecessor. A concurrent revocation may delete the row between the insert
 * and the lock; inserting again then wins the row. SQLite ignores FOR UPDATE
 * and serializes writes.
 */
async function lockPhaseRecord(store: McpStore, tx: Knex.Transaction, recordId: string): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    await tx('mcp_records').insert({ kind: AGENT_RUN_GRANT_RECORD_KIND, id: recordId, value: store.seal(null), owner_id: null, expires_at: null })
      .onConflict(['kind', 'id']).ignore();
    if (await tx('mcp_records').where({ kind: AGENT_RUN_GRANT_RECORD_KIND, id: recordId }).forUpdate().first('id')) return;
  }
  throw new Error(`Could not lock the agent run grant record ${recordId}`);
}

export async function issueAgentRunGrant(
  input: { ownerId: string; definitionName: string; runId: string; phase: AgentRunGrantPhase; repositories: readonly string[] },
  deps: AgentRunGrantDependencies = {},
): Promise<IssuedAgentRunGrant> {
  const database = deps.database ?? db;
  const oauth = await provider(deps);
  const credential = await ownerCredential(input.ownerId, database, deps.userGrants ?? githubUserGrantService);
  // Record the owner's own membership source, as browser consent does, so
  // `McpPolicy.authenticate` ends the grant when an explicit membership is removed.
  const authorization = await resolveInstanceAuthorization(credential, database);
  if (authorization.source === 'demo') throw new McpError('ACCESS_REVOKED', 'Current instance access denied.', 403);
  await oauth.store.put('client', AGENT_RUN_MCP_CLIENT_ID, AGENT_RUN_MCP_CLIENT);
  const recordId = agentRunGrantRecordId(input.runId, input.phase);
  // One transaction per run phase: revoking the predecessor, storing the new
  // grant and token, and replacing the record commit together, so overlapping
  // issuances cannot leave a valid grant that the record no longer names.
  const { grant, accessToken } = await database.transaction(async tx => {
    await lockPhaseRecord(oauth.store, tx, recordId);
    // A retried phase replaces its grant; the earlier token must not outlive it.
    const previous = await oauth.store.get<AgentRunGrantRecord | null>(AGENT_RUN_GRANT_RECORD_KIND, recordId, tx);
    if (previous) await oauth.revokeGrant(previous.grantId, undefined, tx);
    const issued = await oauth.issueDelegatedGrant({
      credential,
      clientId: AGENT_RUN_MCP_CLIENT_ID,
      clientName: `ProPR Agent: ${input.definitionName}`,
      scopes: [...AGENT_RUN_PHASE_SCOPES[input.phase]],
      repositories: [...new Set(input.repositories)],
      membershipSource: authorization.source,
      ttlMs: AGENT_RUN_GRANT_TTL_MS,
      database: tx,
    });
    const record: AgentRunGrantRecord = { runId: input.runId, phase: input.phase, grantId: issued.grant.id, ownerId: issued.grant.ownerId, expiresAt: issued.grant.expiresAt };
    await oauth.store.put(AGENT_RUN_GRANT_RECORD_KIND, recordId, record, { expiresAt: issued.grant.expiresAt, database: tx });
    return issued;
  });
  return { grantId: grant.id, accessToken, expiresAt: grant.expiresAt };
}

/** Same revocation as the Connected apps "Revoke" button. */
export async function revokeAgentRunGrant(grantId: string, deps: AgentRunGrantDependencies = {}): Promise<void> {
  await (await provider(deps)).revokeGrant(grantId);
}

/**
 * Revokes the grant recorded for one run phase and forgets it. Returns the
 * revoked grant id, or null when that phase holds no grant. With `grantId`,
 * only that grant is revoked: a newer grant recorded by a retried phase is
 * left alone (the older one was revoked when it was replaced).
 */
export async function revokeAgentRunPhaseGrant(
  runId: string, phase: AgentRunGrantPhase, deps: AgentRunGrantDependencies & { grantId?: string } = {},
): Promise<string | null> {
  const oauth = await provider(deps);
  const recordId = agentRunGrantRecordId(runId, phase);
  // Serialized with issuance (see lockPhaseRecord): the record read here is the
  // one deleted, never a replacement recorded meanwhile.
  return oauth.store.db.transaction(async tx => {
    if (!await tx('mcp_records').where({ kind: AGENT_RUN_GRANT_RECORD_KIND, id: recordId }).forUpdate().first('id')) return null;
    const record = await oauth.store.get<AgentRunGrantRecord | null>(AGENT_RUN_GRANT_RECORD_KIND, recordId, tx);
    if (!record || (deps.grantId !== undefined && record.grantId !== deps.grantId)) return null;
    await oauth.revokeGrant(record.grantId, undefined, tx);
    await tx('mcp_records').where({ kind: AGENT_RUN_GRANT_RECORD_KIND, id: recordId }).delete();
    return record.grantId;
  });
}
