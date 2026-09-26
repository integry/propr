import type { Knex } from 'knex';
import type { getAuthenticatedOctokit, loadMonitoredReposRaw, GoalArtifact } from '@propr/core';
import { isNotificationPreviewEligible, trustedPreviewMedia, type Notification, type PublishedVisualPreview } from '@propr/shared';

/**
 * `commentBody` scopes a follow-up run to the completion comment it published;
 * such sources never inherit the PR description shared by earlier runs.
 */
export interface PreviewSource { repository: string; prNumbers: number[]; commentBody?: string; commentId?: number; isFollowUp?: boolean }
export interface PreviewProjection { previews: PublishedVisualPreview[]; unavailable?: boolean }
type PreviewAssociation = { kind: 'pull' | 'comment'; repository: string; number: number };
interface Dependencies {
  loadRepos?: typeof loadMonitoredReposRaw;
  getOctokit?: typeof getAuthenticatedOctokit;
}

/** Bounded cache of parsed published bodies only. Policy is re-read before every projection. */
export function createPreviewMediaReader(deps: Dependencies = {}) {
  const cache = new Map<string, { expires: number; value: Promise<PreviewProjection> }>();
  // The core barrel initializes the global database. Resolve production services
  // only when needed so importing list helpers or projecting rows without PRs is inert.
  const loadRepos = deps.loadRepos ?? (async () => (await import('@propr/core')).loadMonitoredReposRaw());
  const getOctokit = deps.getOctokit ?? (async () => (await import('@propr/core')).getAuthenticatedOctokit());

  async function enabledRepositories(repositories: string[]): Promise<Set<string>> {
    if (!repositories.length) return new Set();
    try {
      const repos = await loadRepos();
      const { resolveRepositoryVisualPreviewSettings } = await import('@propr/core');
      return new Set(repositories.map(name => name.trim().toLowerCase())
        .filter(name => resolveRepositoryVisualPreviewSettings(repos, name).enabled));
    } catch { return new Set(); } // Fail closed, including legacy/unconfigured repositories.
  }

  async function readPr(repository: string, prNumber: number): Promise<PreviewProjection> {
    const key = `${repository}#${prNumber}`;
    const previous = cache.get(key);
    if (previous && previous.expires > Date.now()) return previous.value;
    const entry = { expires: Date.now() + 60_000, value: Promise.resolve<PreviewProjection>({ previews: [] }) };
    entry.value = (async () => {
      try {
        const [owner, repo] = repository.split('/');
        const octokit = await getOctokit();
        const response = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
          owner, repo, pull_number: prNumber, request: { signal: AbortSignal.timeout(4000) },
        });
        const { parsePublishedVisualPreviews } = await import('@propr/core');
        return { previews: parsePublishedVisualPreviews(response.data.body) };
      } catch {
        entry.expires = Date.now() + 10_000;
        return { previews: [], unavailable: true };
      }
    })();
    cache.delete(key);
    cache.set(key, entry);
    while (cache.size > 512) cache.delete(cache.keys().next().value!);
    return entry.value;
  }

  async function project(
    sources: readonly PreviewSource[], limit = 3, mode: 'list' | 'gallery' = 'list',
  ): Promise<PreviewProjection[]> {
    const results = new Map<string, PreviewProjection>();
    const associations = new Map<string, PreviewAssociation>();
    let keys: string[][] | undefined;
    let expired = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // The deadline covers policy loading as well as GitHub reads. Started reads
    // may fill the cache, but no more work is scheduled after the list returns.
    const deadline = mode === 'list' ? new Promise<void>(resolve => {
      timer = setTimeout(() => { expired = true; resolve(); }, 1500);
    }) : undefined;
    const batch = (async () => {
      const enabled = await enabledRepositories(sources.filter(source => source.prNumbers.length || source.commentBody).map(source => source.repository));
      if (expired) return;
      const parseComment = sources.some(source => source.commentBody && enabled.has(source.repository.trim().toLowerCase()))
        ? (await import('@propr/core')).parsePublishedVisualPreviews : undefined;
      if (expired) return;
      const reads = new Map<string, { repository: string; number: number }>();
      keys = sources.map((source, index) => {
        const repository = source.repository.trim().toLowerCase();
        if (!enabled.has(repository) || !/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(repository) || repository.split('/').some(part => part === '.' || part === '..')) return [];
        if (source.commentBody) {
          // Run-scoped media is already stored with the task; no GitHub read is needed.
          const key = `comment:${index}`;
          results.set(key, { previews: parseComment?.(source.commentBody) ?? [] });
          if (source.commentId) associations.set(key, { kind: 'comment', repository, number: source.commentId });
          return [key];
        }
        if (source.isFollowUp) return [];
        return [...new Set(source.prNumbers)].filter(number => Number.isSafeInteger(number) && number > 0).map(number => {
          const key = `${repository}#${number}`;
          reads.set(key, { repository, number });
          associations.set(key, { kind: 'pull', repository, number });
          return key;
        });
      });
      const cached: Promise<void>[] = [];
      const entries: Array<[string, { repository: string; number: number }]> = [];
      for (const [key, source] of reads) {
        const previous = cache.get(key);
        if (previous && previous.expires > Date.now()) {
          cached.push(previous.value.then(value => { results.set(key, value); }));
        } else if (mode === 'gallery' || entries.length < 6) {
          entries.push([key, source]);
        }
      }
      let next = 0;
      // Only the explicit gallery can read all identities. List pages share a
      // six-read allowance regardless of their row or goal-artifact count.
      await Promise.all([...cached, ...Array.from({ length: Math.min(6, entries.length) }, async () => {
        while (!expired && next < entries.length) {
          const [key, source] = entries[next++];
          results.set(key, await readPr(source.repository, source.number));
        }
      })]);
    })();
    try {
      await (deadline ? Promise.race([batch, deadline]) : batch);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    if (!keys) return sources.map(source => ({
      previews: [], ...(source.prNumbers.length || source.commentBody ? { unavailable: true } : {}),
    }));
    return keys.map(sourceKeys => ({
      previews: trustedPreviewMedia(sourceKeys.flatMap(key => projectApplicationMedia(
        results.get(key)?.previews ?? [], associations.get(key),
      )), limit),
      ...(sourceKeys.some(key => !results.has(key) || results.get(key)?.unavailable) ? { unavailable: true } : {}),
    }));
  }

  return { project, enabledRepositories };
}

export const previewMediaReader = createPreviewMediaReader();

/** Returns the newest history metadata carrying a completion comment, independent of the current lifecycle row. */
export function latestCommentMetadata(historyRecords: ReadonlyArray<Record<string, unknown>>): unknown {
  for (let index = historyRecords.length - 1; index >= 0; index--) {
    if (record(historyRecords[index].metadata).githubComment) return historyRecords[index].metadata;
  }
  return undefined;
}

/** Visual previews are optional evidence; failures or stalls must never hide the task history. */
export async function projectTaskPreviewMedia(
  task: Record<string, unknown>,
  historyRecords: Array<Record<string, unknown>>,
  reader: Pick<typeof previewMediaReader, 'project'> = previewMediaReader,
  deadlineMs = 5000,
): Promise<PublishedVisualPreview[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Gallery reads have no internal deadline, so bound the whole enrichment here.
    const expired = new Promise<PreviewProjection[]>(resolve => { timer = setTimeout(() => resolve([]), deadlineMs); });
    const [projection] = await Promise.race([
      reader.project([taskPreviewSource({ ...task, latest_metadata: latestCommentMetadata(historyRecords) })], 8, 'gallery'),
      expired,
    ]);
    return projection?.previews ?? [];
  } catch {
    return [];
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// Mirrors the core renderer's marker; kept local so identity parsing stays independent of core services.
const VISUAL_PREVIEW_MARKER = '<!-- propr-visual-preview -->';

function record(value: unknown): Record<string, unknown> {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
}

/**
 * Follow-up runs share their PR with the run that created it, but not its published description.
 * Job data identifies a follow-up the same way the task history API does, including the nested issue reference.
 */
function isFollowUpTask(row: Record<string, unknown>, initial: Record<string, unknown>): boolean {
  return row.task_type === 'pr-comment' || row.task_type === 'review'
    || (typeof row.task_id === 'string' && row.task_id.startsWith('pr-comments-batch-'))
    || !!initial.pullRequestNumber || !!record(initial.issueRef).pullRequestNumber;
}

function commentIdFromUrl(value: unknown, repository: string): number | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const url = new URL(value);
    const match = /^#issuecomment-([1-9][0-9]*)$/.exec(url.hash);
    const number = match ? Number(match[1]) : NaN;
    const path = /^\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/[1-9][0-9]*$/.exec(url.pathname);
    if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port || url.username || url.password
      || path?.[1].toLowerCase() !== repository.toLowerCase()
      || !Number.isSafeInteger(number)) return undefined;
    return number;
  } catch { return undefined; }
}

function projectApplicationMedia(
  previews: readonly PublishedVisualPreview[], association: PreviewAssociation | undefined,
): PublishedVisualPreview[] {
  if (!association) return [...previews];
  const [owner, repo] = association.repository.split('/');
  return previews.flatMap(preview => {
    const attachment = /^https:\/\/github\.com\/user-attachments\/assets\/([A-Za-z0-9_-]+)$/.exec(preview.url);
    return attachment ? [{ ...preview,
      url: `/api/preview-media/${association.kind === 'pull' ? 'pulls' : 'comments'}/${owner}/${repo}/${association.number}/${attachment[1]}`,
    }] : [];
  });
}

export function taskPreviewSource(row: Record<string, unknown>): PreviewSource {
  const initial = record(row.initial_job_data);
  const result = record(row.final_result);
  if (isFollowUpTask(row, initial)) {
    const comment = record(record(row.latest_metadata).githubComment);
    const commentBody = typeof comment.body === 'string' && comment.body.includes(VISUAL_PREVIEW_MARKER) ? comment.body : undefined;
    const repository = String(row.repository ?? '');
    const commentId = commentIdFromUrl(comment.url, repository);
    return { repository, prNumbers: [], isFollowUp: true, ...(commentBody ? { commentBody } : {}),
      ...(commentBody && commentId ? { commentId } : {}) };
  }
  return { repository: String(row.repository ?? ''), prNumbers: [
    row.pr_number || record(record(result.postProcessing).pr).number,
  ].filter((number): number is number => typeof number === 'number' && Number.isSafeInteger(number) && number > 0) };
}

export function goalPreviewSource(row: { repository: string; final_pr_number: number | null; artifact_refs: unknown }): PreviewSource {
  // Stored identity parsing must remain synchronous and independent of core services.
  let artifacts: GoalArtifact[] = [];
  try {
    const parsed: unknown = typeof row.artifact_refs === 'string' ? JSON.parse(row.artifact_refs) : row.artifact_refs;
    if (Array.isArray(parsed)) artifacts = parsed;
  } catch { /* Malformed stored artifacts have no preview identity. */ }
  return { repository: row.repository, prNumbers: [
    ...(row.final_pr_number ? [row.final_pr_number] : []),
    ...artifacts.filter(artifact => artifact?.type === 'pull_request'
      && artifact.url === `https://github.com/${row.repository}/pull/${artifact.number}`).map(artifact => artifact.number),
  ] };
}

export async function projectNotificationPreviews(
  notifications: readonly Notification[], reader = previewMediaReader, database?: Knex,
): Promise<Notification[]> {
  const sources = notifications.map(notification => isNotificationPreviewEligible(notification)
    && (notification.kind === 'task' || notification.kind === 'pull_request')
    ? { repository: notification.target.repository, prNumbers: notification.target.prNumber ? [notification.target.prNumber] : [] }
    : { repository: '', prNumbers: [] });
  // Older immutable completion events may predate the task's persisted PR identity.
  const missing = notifications.filter(notification => notification.kind === 'task'
    && notification.severity === 'success' && !notification.target.prNumber);
  if (missing.length) {
    const enabled = await reader.enabledRepositories(missing.map(notification => notification.target.type === 'task' ? notification.target.repository : ''));
    const taskIds = missing.flatMap(notification => notification.kind === 'task'
      && enabled.has(notification.target.repository.trim().toLowerCase()) ? [notification.target.taskId] : []);
    if (taskIds.length) {
      try {
        const db = database ?? (await import('@propr/core')).db;
        const tasks = await db('tasks').whereIn('task_id', taskIds)
          .where(function () { this.whereNull('task_type').orWhereNot('task_type', 'goal'); })
          .select('task_id', 'repository', 'pr_number', 'initial_job_data', 'final_result');
        const byId = new Map(tasks.map(row => [row.task_id, taskPreviewSource(row)]));
        notifications.forEach((notification, index) => {
          if (notification.kind !== 'task' || notification.severity !== 'success' || sources[index].prNumbers.length) return;
          const source = byId.get(notification.target.taskId);
          if (source?.repository.toLowerCase() === notification.target.repository.trim().toLowerCase()) sources[index] = source;
        });
      } catch { /* Optional media must not make the Inbox unavailable. */ }
    }
  }
  const media = await reader.project(sources, 1);
  return notifications.map((notification, index) => {
    const fields = { ...notification };
    delete fields.previewMedia;
    return { ...fields, ...(media[index].previews.length ? { previewMedia: media[index].previews } : {}) } as Notification;
  });
}
