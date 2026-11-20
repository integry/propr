import { PLUGIN_REPOSITORY_PATTERN, pluginHttpsUrlHost, type PluginContext, type PluginJsonValue, type RepositoryEvent } from '@propr/shared';
import { eventName, readEventSelection, type EventSelection } from '../_shared/eventSelection.js';

/**
 * The outbound webhook envelope and the configured targets. The envelope is
 * built from an allowlist of identifiers, links, states and scores: never
 * code, logs, prompt text, tool output, free text or credentials. The docs
 * page `docs/docs/plugins/webhooks.md` is its reference.
 */

/** The envelope format; it changes only by adding fields, and a breaking change gets a new version. */
export const WEBHOOK_ENVELOPE_VERSION = 1;
/** Target slots in the settings: `target<n>Url`, `target<n>Events`, `target<n>Repositories` and the `target-<n>-secret` connection. */
export const WEBHOOK_TARGET_SLOTS = 3;
export const WEBHOOK_HEADERS = {
  event: 'x-propr-event', delivery: 'x-propr-delivery', timestamp: 'x-propr-timestamp', signature: 'x-propr-signature', version: 'x-propr-envelope-version',
} as const;
export const WEBHOOK_SIGNATURE_PREFIX = 'sha256=';

export interface WebhookTarget extends EventSelection {
  /** `target-<n>`. */
  name: string;
  url: string;
  host: string;
  /** The `signing_secret` connection that signs its deliveries. */
  connection: string;
}

/** The configured targets: each slot with an acceptable URL. */
export function webhookTargets(settings: PluginContext['settings']): WebhookTarget[] {
  const targets: WebhookTarget[] = [];
  for (let slot = 1; slot <= WEBHOOK_TARGET_SLOTS; slot++) {
    const url = settings[`target${slot}Url`];
    const host = pluginHttpsUrlHost(url);
    if (typeof url !== 'string' || !host) continue;
    targets.push({ name: `target-${slot}`, url, host, connection: `target-${slot}-secret`, ...readEventSelection(settings, `target${slot}Events`, `target${slot}Repositories`) });
  }
  return targets;
}

/** A coded value (a state, a kind, a model or branch name): short, without spaces. Anything else, prose included, is left out. */
const CODE = /^[A-Za-z0-9._:/@+-]{1,100}$/;
const code = (value: unknown): string | null => (typeof value === 'string' && CODE.test(value) ? value : null);
const integer = (value: unknown): number | null => (typeof value === 'number' && Number.isSafeInteger(value) ? value : null);
const number = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const flag = (value: unknown): boolean | null => (typeof value === 'boolean' ? value : null);
const sha = (value: unknown): string | null => (typeof value === 'string' && /^[0-9a-f]{7,64}$/i.test(value) ? value : null);

const repositoryUrl = (repository: string) => (PLUGIN_REPOSITORY_PATTERN.test(repository) ? `https://github.com/${repository}` : null);

export type Json = { [key: string]: PluginJsonValue };
export interface WebhookEnvelope extends Json {
  version: number;
  /** The delivery id: the same for every attempt of this event to this target. */
  id: string;
  event: string;
  occurredAt: string;
  /** The event's journal sequence number; it grows with every event of the ProPR instance. */
  sequence: number;
  repository: { fullName: string; url: string | null };
  pullRequest: Json | null;
  issue: Json | null;
  task: Json | null;
  review: Json | null;
  ultrafix: Json | null;
  epicQueue: Json | null;
}

const PULL_REQUEST_STATES: Record<string, string> = { opened: 'open', merged: 'merged', closed: 'closed' };

function pullRequestPart(event: RepositoryEvent, base: string | null): Json | null {
  const number = integer(event.prNumber) ?? (event.domain === 'task' ? integer(event.payload.prNumber) : null);
  if (number === null) return null;
  const part: Json = { number, url: base ? `${base}/pull/${number}` : null, headSha: sha(event.headSha) };
  if (event.domain === 'pull_request') {
    part.state = PULL_REQUEST_STATES[event.type] ?? null;
    if (event.type === 'opened') { part.draft = flag(event.payload.draft); part.baseRef = code(event.payload.baseRef); }
  }
  return part;
}

function issuePart(event: RepositoryEvent, base: string | null): Json | null {
  const number = integer(event.issueNumber) ?? (event.domain === 'task' ? integer(event.payload.issueNumber) : null);
  return number === null ? null : { number, url: base ? `${base}/issues/${number}` : null };
}

function taskPart(event: RepositoryEvent): Json | null {
  if (event.domain !== 'task') return null;
  const p = event.payload;
  const part: Json = {
    id: code(event.entityId) ?? code(p.taskId), kind: code(p.kind), state: event.type,
    agent: code(p.agent), model: code(p.model), attempts: integer(p.attempts),
  };
  if (event.type === 'completed' || event.type === 'failed' || event.type === 'cancelled') {
    Object.assign(part, { terminalReason: code(p.terminalReason), failureCategory: code(p.failureCategory), durationMs: integer(p.durationMs), pullRequestOutcome: code(p.pullRequest) });
  }
  return part;
}

function reviewPart(event: RepositoryEvent): Json | null {
  if (event.domain !== 'pull_request' || event.type !== 'review_scored') return null;
  const p = event.payload;
  return { score: number(p.score), goal: number(p.goal), goalReached: flag(p.goalReached), source: code(p.source), cycle: integer(p.cycle), reviewerModel: code(p.reviewerModel) };
}

function ultrafixPart(event: RepositoryEvent): Json | null {
  if (event.domain !== 'pull_request' || event.type !== 'ultrafix_ended') return null;
  // `reason` is the loop's own wording: free text, so it is not sent.
  return { outcome: code(event.payload.outcome), finalScore: number(event.payload.finalScore), workEpoch: integer(event.payload.workEpoch) };
}

function epicQueuePart(event: RepositoryEvent): Json | null {
  if (event.domain !== 'epic_queue') return null;
  const p = event.payload;
  // `blockedReason` is free text, so it is not sent; the blocked head issue is.
  const part: Json = { id: code(event.entityId), planId: code(event.planId), state: event.type };
  if (event.type === 'blocked') part.headIssue = integer(p.headIssue);
  if (event.type === 'completed') { part.fromIssue = integer(p.fromIssue); part.cursor = integer(p.cursor); }
  return part;
}

/** The envelope of one event to one target: identifiers, links, states and scores, from an allowlist of fields. */
export function webhookEnvelope(event: RepositoryEvent, id: string): WebhookEnvelope {
  const base = repositoryUrl(event.repository);
  return {
    version: WEBHOOK_ENVELOPE_VERSION, id, event: eventName(event), occurredAt: String(event.occurredAt), sequence: event.seq,
    repository: { fullName: event.repository, url: base },
    pullRequest: pullRequestPart(event, base), issue: issuePart(event, base),
    task: taskPart(event), review: reviewPart(event), ultrafix: ultrafixPart(event), epicQueue: epicQueuePart(event),
  };
}

/** The delivery id of one event to one target, stable across attempts. */
export const webhookDeliveryId = (deliveryId: string, target: Pick<WebhookTarget, 'name'>) => `${deliveryId}.${target.name}`;
