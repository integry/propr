/* eslint-disable max-lines -- aggregation, deduplication, and output sanitization form one privacy boundary */
import type { Job, Queue } from 'bullmq';
import type { Knex } from 'knex';
import type { NotificationService } from '@propr/core';
import {
  normalizeISO8601Timestamp,
  VOICE_BRIEFING_MAX_ITEMS,
  voiceBriefingResponseSchema,
  type Notification,
  type NotificationListResponse,
  type ISO8601Timestamp,
  type VoiceBriefingAction,
  type VoiceBriefingItem,
  type VoiceBriefingItemKind,
  type VoiceBriefingResponse,
  type VoiceBriefingScope,
} from '@propr/shared';

export const VOICE_BRIEFING_DETAIL_LIMIT = VOICE_BRIEFING_MAX_ITEMS;
const NOTIFICATION_PAGE_SIZE = 100;
const INCLUDED_PLAN_STATUSES = [
  'generating',
  'refining',
  'executing',
  'review',
  'approved',
] as const;

export type VoiceBriefingQueueState = 'active' | 'waiting' | 'delayed';

/** The deliberately small portion of a BullMQ job that the briefing may inspect. */
export type VoiceBriefingQueueJob = Pick<
  Job,
  'id' | 'name' | 'data' | 'timestamp' | 'processedOn'
>;

export interface VoiceBriefingQueueSnapshot {
  active: readonly VoiceBriefingQueueJob[];
  waiting: readonly VoiceBriefingQueueJob[];
  delayed: readonly VoiceBriefingQueueJob[];
}

export interface VoiceBriefingPlanRow {
  draft_id: unknown;
  repository: unknown;
  status: unknown;
  updated_at: unknown;
}

export interface VoiceBriefingDataLoaders {
  loadQueueJobs(userId: string): Promise<VoiceBriefingQueueSnapshot>;
  loadPlans(userId: string): Promise<readonly VoiceBriefingPlanRow[]>;
  loadNotifications(userId: string): Promise<readonly Notification[]>;
}

type BriefingQueue = Pick<Queue, 'getJobs'>;
type NotificationReader = Pick<NotificationService, 'listNotifications'>;

export interface VoiceBriefingLoaderDependencies {
  database: Knex;
  taskQueue: BriefingQueue;
  notificationService: NotificationReader;
}

interface InjectedVoiceBriefingServiceOptions {
  /** Supplying loaders keeps snapshot construction isolated from Redis and SQLite in tests. */
  loaders: VoiceBriefingDataLoaders;
  now?: () => string | number | Date;
}

export type VoiceBriefingServiceOptions = InjectedVoiceBriefingServiceOptions
  | (VoiceBriefingLoaderDependencies & { now?: () => string | number | Date });

type WorkClass = 'attention' | 'running' | 'queued';

interface CandidateItem extends Omit<VoiceBriefingItem, 'reference' | 'position'> {
  identities: readonly string[];
  priority: number;
  workClass: WorkClass;
}

type CandidateComponent = readonly CandidateItem[];

interface NormalizedQueueEntry {
  job: VoiceBriefingQueueJob;
  state: VoiceBriefingQueueState;
  stableId: string;
}

/**
 * Construct production data loaders. Only explicitly allowlisted columns and fields
 * cross the data-loading boundary; draft prompts and notification metadata are never
 * selected for use by the briefing.
 */
export function createVoiceBriefingDataLoaders(
  dependencies: VoiceBriefingLoaderDependencies,
): VoiceBriefingDataLoaders {
  return {
    async loadQueueJobs(userId) {
      const [active, waiting, delayed] = await Promise.all([
        dependencies.taskQueue.getJobs(['active']),
        dependencies.taskQueue.getJobs(['waiting']),
        dependencies.taskQueue.getJobs(['delayed']),
      ]);
      return {
        active: active.filter(job => queueJobBelongsToRecipient(job, userId)),
        waiting: waiting.filter(job => queueJobBelongsToRecipient(job, userId)),
        delayed: delayed.filter(job => queueJobBelongsToRecipient(job, userId)),
      } as VoiceBriefingQueueSnapshot;
    },

    async loadPlans(userId) {
      return dependencies.database('task_drafts')
        .select('draft_id', 'repository', 'status', 'updated_at')
        .where({ user_id: userId })
        .whereIn('status', INCLUDED_PLAN_STATUSES) as unknown as Promise<VoiceBriefingPlanRow[]>;
    },

    async loadNotifications(userId) {
      return loadAllAuthorizedNotifications(dependencies.notificationService, userId);
    },
  };
}

/** Build one bounded, non-streaming digest from a point-in-time set of data loads. */
export class VoiceBriefingService {
  private readonly loaders: VoiceBriefingDataLoaders;
  private readonly now: () => string | number | Date;

  constructor(options: VoiceBriefingServiceOptions) {
    this.loaders = 'loaders' in options
      ? options.loaders
      : createVoiceBriefingDataLoaders(options);
    this.now = options.now ?? (() => new Date());
  }

  async getBriefing(
    userId: string,
    scope: VoiceBriefingScope = 'all',
  ): Promise<VoiceBriefingResponse> {
    const generatedAt = normalizeISO8601Timestamp(this.now());
    const [queueSnapshot, plans, notifications] = await Promise.all([
      this.loaders.loadQueueJobs(userId),
      this.loaders.loadPlans(userId),
      this.loaders.loadNotifications(userId),
    ]);

    const queueEntries = normalizeQueueEntries(queueSnapshot);
    const queueCandidates = queueEntries.map(entry => queueCandidate(entry, generatedAt));
    const planCandidates = plans.flatMap(plan => planCandidate(plan, generatedAt));
    const notificationCandidates = notifications.flatMap(notificationCandidate);
    const rawCandidates = [
      ...notificationCandidates,
      ...planCandidates,
      ...queueCandidates,
    ];
    const components = buildCandidateComponents(rawCandidates);
    const queueCandidateSet = new Set(queueCandidates);
    const allCandidates = selectComponentRepresentatives(components);
    const runningCandidates = selectComponentRepresentatives(
      components,
      candidate => queueCandidateSet.has(candidate) && candidate.workClass === 'running',
    );
    const queuedCandidates = selectComponentRepresentatives(
      components,
      candidate => queueCandidateSet.has(candidate) && candidate.workClass === 'queued',
    );
    const attentionCandidates = selectComponentRepresentatives(
      components,
      candidate => candidate.requiresAttention,
    );
    const scopedCandidates = (scope === 'all'
      ? allCandidates
      : selectComponentRepresentatives(
        components,
        candidate => candidate.workClass === scope,
      )).slice(0, VOICE_BRIEFING_DETAIL_LIMIT);
    const items = assignReferences(scopedCandidates);
    const counts = {
      running: runningCandidates.length,
      queued: queuedCandidates.length,
      attention: attentionCandidates.length,
      plans: planCandidates.length,
      total: allCandidates.length,
    };
    const headline = buildHeadline(scope, counts);
    const speechText = [
      headline,
      ...items.map(item => `${capitalize(item.reference)}: ${item.summary}`),
    ].join(' ');

    // This is the final privacy and shape boundary. In addition to catching
    // implementation drift, it rejects unsafe navigation paths and extra fields.
    return voiceBriefingResponseSchema.parse({
      generatedAt,
      scope,
      headline,
      speechText,
      counts,
      items,
    });
  }
}

export function createVoiceBriefingService(
  dependencies: VoiceBriefingLoaderDependencies,
  options: { now?: () => string | number | Date } = {},
): VoiceBriefingService {
  return new VoiceBriefingService({
    loaders: createVoiceBriefingDataLoaders(dependencies),
    ...options,
  });
}

async function loadAllAuthorizedNotifications(
  service: NotificationReader,
  userId: string,
): Promise<Notification[]> {
  const notifications: Notification[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | null = null;

  do {
    const response: NotificationListResponse = await service.listNotifications(userId, {
      cursor,
      limit: NOTIFICATION_PAGE_SIZE,
    });
    notifications.push(...response.notifications.filter(notification =>
      notification.severity === 'warning' || notification.severity === 'error',
    ));
    cursor = response.nextCursor;
    if (cursor !== null) {
      if (seenCursors.has(cursor)) {
        throw new Error('Notification pagination returned a repeated cursor');
      }
      seenCursors.add(cursor);
    }
  } while (cursor !== null);

  return notifications;
}

function queueJobBelongsToRecipient(
  job: VoiceBriefingQueueJob,
  userId: string,
): boolean {
  const data = recordValue(job.data);
  return nonEmptyString(data.userId) === userId;
}

function normalizeQueueEntries(snapshot: VoiceBriefingQueueSnapshot): NormalizedQueueEntry[] {
  const entries: NormalizedQueueEntry[] = [];
  const seenIds = new Set<string>();
  const states: VoiceBriefingQueueState[] = ['active', 'waiting', 'delayed'];

  for (const state of states) {
    snapshot[state].forEach((job, index) => {
      const rawId = nonEmptyString(job.id);
      const stableId = rawId ?? `unidentified-${state}-${index + 1}`;
      if (seenIds.has(stableId)) return;
      seenIds.add(stableId);
      entries.push({ job, state, stableId });
    });
  }
  return entries;
}

function queueCandidate(
  entry: NormalizedQueueEntry,
  fallbackTimestamp: ISO8601Timestamp,
): CandidateItem {
  const data = recordValue(entry.job.data);
  const repository = repositoryFromJobData(data);
  const taskId = taskIdFromJob(entry.job, data);
  const outputId = safeIdentifier(taskId ?? entry.stableId, `queue-${entry.stableId}`);
  const title = safeTitle(
    nonEmptyString(data.title)
      ?? nonEmptyString(recordValue(data.issuePayload).title)
      ?? 'Task',
  );
  const status = entry.state === 'active' ? 'running' : entry.state;
  const updatedAt = safeTimestamp(
    entry.state === 'active' ? entry.job.processedOn ?? entry.job.timestamp : entry.job.timestamp,
    fallbackTimestamp,
  );
  const identities = queueIdentities(entry, data, repository, taskId);
  const isRunning = entry.state === 'active';

  return {
    kind: 'task',
    id: outputId,
    title,
    repository,
    status,
    summary: safeSummary(title, repository, statusSummary(status)),
    href: taskId ? `/tasks/${safePathSegment(taskId)}` : '/tasks',
    requiresAttention: false,
    actions: isRunning && taskId ? ['open', 'stop'] : ['open'],
    updatedAt,
    identities,
    priority: isRunning ? 30 : entry.state === 'waiting' ? 40 : 50,
    workClass: isRunning ? 'running' : 'queued',
  };
}

function planCandidate(
  row: VoiceBriefingPlanRow,
  fallbackTimestamp: ISO8601Timestamp,
): CandidateItem[] {
  const status = typeof row.status === 'string' ? row.status : '';
  if (!(INCLUDED_PLAN_STATUSES as readonly string[]).includes(status)) return [];
  const draftId = nonEmptyString(row.draft_id);
  if (!draftId) return [];

  const id = safeIdentifier(draftId, 'plan');
  const repository = safeRepository(row.repository);
  const title = safeTitle(repository ? `Plan for ${repository}` : 'Plan');
  const requiresAttention = status === 'review';
  const running = status === 'generating' || status === 'refining' || status === 'executing';
  const canStopDraftOperation = status === 'generating' || status === 'refining';
  const actions: VoiceBriefingAction[] = requiresAttention
    ? ['open', 'follow_up']
    : canStopDraftOperation ? ['open', 'stop'] : ['open'];

  return [{
    kind: 'plan',
    id,
    title,
    repository,
    status,
    summary: safeSummary(title, null, planStatusSummary(status)),
    href: `/studio/${safePathSegment(draftId)}`,
    requiresAttention,
    actions,
    updatedAt: safeTimestamp(row.updated_at, fallbackTimestamp),
    identities: [`plan:${draftId}`],
    priority: requiresAttention ? 20 : running ? 30 : 40,
    workClass: requiresAttention ? 'attention' : running ? 'running' : 'queued',
  }];
}

function notificationCandidate(notification: Notification): CandidateItem[] {
  if (notification.severity !== 'warning' && notification.severity !== 'error') return [];

  const target = notification.target;
  const kind = notificationItemKind(notification);
  const identity = notificationIdentity(notification);
  const idValue = target.type === 'plan'
    ? target.draftId
    : (target.type === 'task' || target.type === 'review') && target.taskId
      ? target.taskId
      : notification.id;
  const id = safeIdentifier(idValue, 'notification');
  const title = safeTitle(notification.title);
  const repository = target.type === 'system_failure'
    ? null
    : safeRepository(target.repository);
  const hasMutationTarget = target.type === 'plan'
    || target.type === 'task'
    || (target.type === 'review' && Boolean(target.taskId));
  const actions: VoiceBriefingAction[] = [
    ...(kind === 'system' ? [] : ['open' as const]),
    ...(hasMutationTarget && kind !== 'plan' && notification.actions.includes('stop')
      ? ['stop' as const]
      : []),
    ...(hasMutationTarget && notification.actions.includes('follow_up')
      ? ['follow_up' as const]
      : []),
  ];

  return [{
    kind,
    id,
    title,
    repository,
    status: notification.severity,
    summary: safeSummary(title, repository, `needs ${notification.severity} attention`),
    href: notificationPath(notification),
    requiresAttention: true,
    actions,
    updatedAt: notification.occurredAt,
    identities: identity,
    priority: notification.severity === 'error' ? 0 : 10,
    workClass: 'attention',
  }];
}

function notificationItemKind(notification: Notification): VoiceBriefingItemKind {
  switch (notification.target.type) {
    case 'plan': return 'plan';
    case 'system_failure':
    case 'indexing': return 'system';
    case 'task':
    case 'review':
    case 'pull_request': return 'task';
  }
}

function notificationIdentity(notification: Notification): string[] {
  const target = notification.target;
  switch (target.type) {
    case 'plan': return [`plan:${target.draftId}`];
    case 'task': return [
      `task:${target.taskId}`,
      ...resourceIdentities(target.repository, target.issueNumber, target.prNumber),
    ];
    case 'review': return [
      ...(target.taskId ? [`task:${target.taskId}`] : []),
      `pr:${target.repository}:${target.prNumber}`,
    ];
    case 'pull_request': return [`pr:${target.repository}:${target.prNumber}`];
    case 'indexing': return [`index:${target.repository}:${target.branch ?? ''}`];
    case 'system_failure': return [`system:${target.component}`];
  }
}

function notificationPath(notification: Notification): string {
  const target = notification.target;
  switch (target.type) {
    case 'plan': return `/studio/${safePathSegment(target.draftId)}`;
    case 'task': return `/tasks/${safePathSegment(target.taskId)}`;
    case 'review': return target.taskId
      ? `/tasks/${safePathSegment(target.taskId)}`
      : '/tasks';
    case 'pull_request': return '/repositories';
    case 'indexing': {
      const repository = safeRepository(target.repository);
      if (!repository) return '/repositories';
      const [owner, name] = repository.split('/');
      const path = `/summaries/${safePathSegment(owner)}/${safePathSegment(name)}`;
      return target.branch
        ? `${path}?branch=${safePathSegment(target.branch)}`
        : path;
    }
    case 'system_failure': return '/';
  }
}

function queueIdentities(
  entry: NormalizedQueueEntry,
  data: Record<string, unknown>,
  repository: string | null,
  taskId: string | undefined,
): string[] {
  const values = new Set<string>([`task:${entry.stableId}`]);
  const explicitTaskId = nonEmptyString(data.taskId);
  if (explicitTaskId) values.add(`task:${explicitTaskId}`);
  if (taskId) values.add(`task:${taskId}`);
  if (repository) {
    for (const key of resourceIdentities(
      repository,
      positiveInteger(data.number) ?? positiveInteger(data.issueNumber),
      positiveInteger(data.pullRequestNumber) ?? positiveInteger(data.prNumber),
    )) values.add(key);
  }
  return [...values];
}

function resourceIdentities(
  repository: string,
  issueNumber?: number,
  prNumber?: number,
): string[] {
  return [
    ...(issueNumber === undefined ? [] : [`issue:${repository}:${issueNumber}`]),
    ...(prNumber === undefined ? [] : [`pr:${repository}:${prNumber}`]),
  ];
}

function taskIdFromJob(
  job: VoiceBriefingQueueJob,
  data: Record<string, unknown>,
): string | undefined {
  const explicitTaskId = nonEmptyString(data.taskId);
  if (explicitTaskId) return explicitTaskId;
  const jobId = nonEmptyString(job.id);
  if (!jobId) return undefined;

  if (job.name === 'processPullRequestComment' || job.name === 'processMergeConflict') {
    return jobId;
  }
  if (job.name !== 'processGitHubIssue' || data.isChildJob !== true) return undefined;

  const owner = nonEmptyString(data.repoOwner);
  const repository = nonEmptyString(data.repoName);
  const number = positiveInteger(data.number);
  const agent = nonEmptyString(data.agentAlias);
  const model = nonEmptyString(data.modelName);
  const correlationId = nonEmptyString(data.correlationId);
  return owner && repository && number && agent && model && correlationId
    ? `${owner}-${repository}-${number}-${agent}-${model}-${correlationId}`
    : undefined;
}

function repositoryFromJobData(data: Record<string, unknown>): string | null {
  const explicit = safeRepository(data.repository);
  if (explicit) return explicit;
  const owner = nonEmptyString(data.repoOwner) ?? nonEmptyString(data.owner);
  const name = nonEmptyString(data.repoName);
  return owner && name ? safeRepository(`${owner}/${name}`) : null;
}

function buildCandidateComponents(candidates: CandidateItem[]): CandidateComponent[] {
  const sorted = [...candidates].sort(compareCandidates);
  const parents = sorted.map((_, index) => index);
  const identityOwners = new Map<string, number>();

  const find = (index: number): number => {
    let root = index;
    while (parents[root] !== root) root = parents[root];
    while (parents[index] !== index) {
      const parent = parents[index];
      parents[index] = root;
      index = parent;
    }
    return root;
  };
  const union = (left: number, right: number): void => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parents[rightRoot] = leftRoot;
  };

  sorted.forEach((candidate, index) => {
    candidate.identities.forEach(identity => {
      const owner = identityOwners.get(identity);
      if (owner === undefined) identityOwners.set(identity, index);
      else union(index, owner);
    });
  });

  const components = new Map<number, CandidateItem[]>();
  sorted.forEach((candidate, index) => {
    const root = find(index);
    const component = components.get(root);
    if (component) component.push(candidate);
    else components.set(root, [candidate]);
  });
  return [...components.values()];
}

function selectComponentRepresentatives(
  components: readonly CandidateComponent[],
  matches: (candidate: CandidateItem) => boolean = () => true,
): CandidateItem[] {
  return components
    .flatMap(component => component.find(matches) ?? [])
    .sort(compareCandidates);
}

function compareCandidates(left: CandidateItem, right: CandidateItem): number {
  return left.priority - right.priority
    || compareText(right.updatedAt, left.updatedAt)
    || compareText(left.kind, right.kind)
    || compareText(left.title, right.title)
    || compareText(left.id, right.id);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assignReferences(candidates: CandidateItem[]): VoiceBriefingItem[] {
  const positions: Record<VoiceBriefingItemKind, number> = { task: 0, plan: 0, system: 0 };
  return candidates.map(candidate => {
    const position = ++positions[candidate.kind];
    return {
      kind: candidate.kind,
      id: candidate.id,
      title: candidate.title,
      repository: candidate.repository,
      status: candidate.status,
      summary: candidate.summary,
      href: candidate.href,
      requiresAttention: candidate.requiresAttention,
      actions: candidate.actions,
      updatedAt: candidate.updatedAt,
      position,
      reference: `${candidate.kind} ${position}`,
    };
  });
}

function buildHeadline(
  scope: VoiceBriefingScope,
  counts: VoiceBriefingResponse['counts'],
): string {
  if (scope === 'attention') {
    return `${counts.attention} ${plural(counts.attention, 'item', 'items')} need attention.`;
  }
  if (scope === 'running') {
    return `${counts.running} ${plural(counts.running, 'job is', 'jobs are')} running.`;
  }
  return `${counts.running} running, ${counts.queued} queued, ${counts.plans} ${plural(counts.plans, 'plan', 'plans')}, and ${counts.attention} needing attention.`;
}

function safeSummary(title: string, repository: string | null, status: string): string {
  return boundedText(`${title}${repository ? ` in ${repository}` : ''} ${status}.`, 320, 'Item update');
}

function statusSummary(status: string): string {
  switch (status) {
    case 'running': return 'is running';
    case 'waiting': return 'is queued';
    case 'delayed': return 'is delayed';
    default: return `is ${status}`;
  }
}

function planStatusSummary(status: string): string {
  switch (status) {
    case 'review': return 'is ready for review';
    case 'generating': return 'is generating';
    case 'refining': return 'is refining';
    case 'executing': return 'is executing';
    case 'approved': return 'is approved';
    default: return `is ${status}`;
  }
}

function safeTitle(value: string): string {
  return boundedText(value, 160, 'Untitled item');
}

function boundedText(value: string, maximum: number, fallback: string): string {
  const normalized = value
    .replace(/\p{Cc}/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return fallback;
  return normalized.length <= maximum
    ? normalized
    : `${normalized.slice(0, maximum - 1).trimEnd()}…`;
}

function safeIdentifier(value: string, fallback: string): string {
  return boundedText(value, 255, fallback);
}

function safePathSegment(value: string): string {
  return encodeURIComponent(safeIdentifier(value, 'unknown'));
}

function safeRepository(value: unknown): string | null {
  const repository = nonEmptyString(value);
  if (!repository || repository.length > 255 || !/^[^/\s]+\/[^/\s]+$/.test(repository)) {
    return null;
  }
  return repository;
}

function safeTimestamp(
  value: unknown,
  fallback: ISO8601Timestamp,
): ISO8601Timestamp {
  if (!(typeof value === 'string' || typeof value === 'number' || value instanceof Date)) {
    return fallback;
  }
  try {
    return normalizeISO8601Timestamp(value);
  } catch {
    return fallback;
  }
}

function recordValue(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

function plural(count: number, singular: string, pluralValue: string): string {
  return count === 1 ? singular : pluralValue;
}

function capitalize(value: string): string {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}
