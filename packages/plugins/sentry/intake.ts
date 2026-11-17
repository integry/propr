import { PluginDeliveryError, PluginSdkError, type PluginContext, type PluginJsonValue, type PluginWebhookInput } from '@propr/shared';
import { githubTriggerLabel } from '../_shared/trackerIssue.js';
import { deleteTicket, readTicket, reserveTicket, writeTicket } from '../_shared/trackerRecords.js';
import { ISSUE_ID, deliveryFailure, getIssue, getLatestEvent, issueWebUrl, recordId, sentryOrganization, sentryOrigin, type SentryEvent, type SentryIssue } from './api.js';
import { decideStart, releaseStart, startSentence, type NotStartedReason } from './autostart.js';
import { sentryIssueBody, sentryIssueTitle, type SentryErrorSummary } from './issueBody.js';
import { SENTRY_SETTINGS, autoStartSettings, mappedById, projectRepository } from './settings.js';
import { eventExceptions } from './stacktrace.js';

/**
 * Sentry, inbound: the `sentry` webhook of an internal integration
 * (https://docs.sentry.io/organization/integrations/integration-platform/webhooks/).
 * ProPR verifies `Sentry-Hook-Signature` (the hex HMAC-SHA256 of the raw body
 * with the integration's client secret) before any of this runs, and refuses
 * a `Request-ID` it has seen. `Sentry-Hook-Resource` says what the request is
 * about; two kinds hand an error over:
 *
 * - `issue` with action `created`
 *   (https://docs.sentry.io/organization/integrations/integration-platform/webhooks/issues/):
 *   `data.issue` carries the id and project (id and slug);
 * - `event_alert` with action `triggered`, sent by an issue alert rule whose
 *   action is the integration
 *   (https://docs.sentry.io/organization/integrations/integration-platform/webhooks/issue-alerts/):
 *   `data.event` carries `issue_id` and the numeric project id.
 *
 * Every other resource and action is ignored. Only the issue id and project
 * are taken from the payload; the issue and its latest event are then read
 * from the configured Sentry's API, so the title, project, counts and stack
 * trace are Sentry's current ones, and the payload's request, user and
 * breadcrumb data are never even parsed further.
 *
 * One GitHub issue per Sentry issue: the issue is recorded by Sentry host,
 * organization and issue id (`_shared/trackerRecords.ts`, reserved in one
 * atomic update), and a Sentry issue already recorded creates nothing and
 * asks Sentry nothing, however many alerts later fire for it.
 */

export type IntakeOutcome = 'created' | 'duplicate' | 'ignored';
export interface IntakeResult {
  [key: string]: PluginJsonValue;
  outcome: IntakeOutcome; reason: string | null; sentryIssue: string | null; repository: string | null; issue: number | null;
  started: boolean; notStarted: NotStartedReason | null;
}
const result = (outcome: IntakeOutcome, reason: string | null, extra: Partial<IntakeResult> = {}): IntakeResult => ({ outcome, reason, sentryIssue: null, repository: null, issue: null, started: false, notStarted: null, ...extra });

const SHORT_ID = /^[A-Z0-9][A-Z0-9_-]{0,63}-[A-Z0-9]{1,16}$/;
const SLUG = /^[a-z0-9][a-z0-9_-]{0,99}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:?\d{2})?$/;
const LEVELS = new Set(['fatal', 'error', 'warning', 'info', 'debug', 'sample']);
/** `ctx.propr.createIssue` refusals that prove no issue was created. */
const NOT_CREATED = new Set(['permission_denied', 'repository_not_allowed', 'invalid_input', 'not_found']);

const str = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim() : null);
const idOf = (value: unknown): string | null => {
  const id = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : str(value);
  return id && ISSUE_ID.test(id) ? id : null;
};

interface Payload { action?: unknown; data?: { issue?: { id?: unknown; project?: { id?: unknown; slug?: unknown } | null } | null; event?: { issue_id?: unknown; project?: unknown } | null } | null }

/** What the request hands over: the issue id and what the payload says of its project. */
function handedOver(resource: string | null, payload: Payload): { id: string; project: { id: string | null; slug: string | null } } | { reason: string } {
  const kind = resource ?? (payload.data?.issue ? 'issue' : payload.data?.event ? 'event_alert' : null);
  if (kind === 'issue') {
    if (payload.action !== 'created') return { reason: 'not_created' };
    const id = idOf(payload.data?.issue?.id);
    const slug = str(payload.data?.issue?.project?.slug);
    return id ? { id, project: { id: idOf(payload.data?.issue?.project?.id), slug: slug && SLUG.test(slug) ? slug : null } } : { reason: 'no_issue_id' };
  }
  if (kind === 'event_alert') {
    if (payload.action !== 'triggered') return { reason: 'not_triggered' };
    const id = idOf(payload.data?.event?.issue_id);
    return id ? { id, project: { id: idOf(payload.data?.event?.project), slug: null } } : { reason: 'no_issue_id' };
  }
  return { reason: kind === 'installation' ? 'installation' : 'not_an_issue_event' };
}

/** The latest event's environment: its `environment` tag (or field). */
function environmentOf(event: SentryEvent | null): string | null {
  if (!event) return null;
  const tags = Array.isArray(event.tags) ? event.tags as unknown[] : [];
  for (const tag of tags) {
    const [key, value] = Array.isArray(tag) ? tag : [(tag as { key?: unknown })?.key, (tag as { value?: unknown })?.value];
    if (key === 'environment' && typeof value === 'string') return value.trim().slice(0, 64) || null;
  }
  return str(event.environment)?.slice(0, 64) ?? null;
}

function summary(issue: SentryIssue, event: SentryEvent | null, shortId: string, url: string): SentryErrorSummary {
  const count = typeof issue.count === 'number' ? issue.count : Number(str(issue.count) ?? NaN);
  const time = (value: unknown) => { const t = str(value); return t && TIMESTAMP.test(t) ? t : null; };
  const level = str(issue.level);
  const slug = str(issue.project?.slug);
  return {
    shortId, url, project: slug && SLUG.test(slug) ? slug : null,
    title: str(issue.title) ?? '', culprit: str(issue.culprit)?.slice(0, 500) ?? null,
    firstSeen: time(issue.firstSeen), lastSeen: time(issue.lastSeen),
    count: Number.isSafeInteger(count) && count >= 0 ? count : null,
    environment: environmentOf(event), level: level && LEVELS.has(level) ? level : null,
    exceptions: eventExceptions(event as { entries?: unknown } | null),
  };
}

export async function handleSentryWebhook(input: PluginWebhookInput, ctx: PluginContext): Promise<IntakeResult> {
  let payload: Payload;
  try { payload = JSON.parse(input.body) as Payload; } catch { return result('ignored', 'not_json'); }
  if (!payload || typeof payload !== 'object') return result('ignored', 'not_json');
  const handed = handedOver(str(input.headers['sentry-hook-resource']), payload);
  if ('reason' in handed) return result('ignored', handed.reason);
  // The payload's project spares any further work for an unmapped one; the issue's own project is checked again below.
  if (handed.project.slug && projectRepository(ctx.settings, handed.project).problem === 'unmapped') return result('ignored', 'unmapped');
  if (!handed.project.slug && handed.project.id && !mappedById(ctx.settings, handed.project.id) && !hasSlugMapping(ctx)) return result('ignored', 'unmapped');
  const origin = sentryOrigin(ctx.settings);
  const organization = sentryOrganization(ctx.settings);
  if (!origin || !organization) throw new PluginDeliveryError('Set the Sentry URL and the organization slug in the plugin\'s settings', { permanent: true });
  const record = recordId(origin, organization, handed.id);
  const known = await readTicket(ctx, record);
  if (known) return result('duplicate', null, { sentryIssue: known.k, repository: known.r, issue: known.n ?? null });

  let issue: SentryIssue;
  let event: SentryEvent | null;
  try {
    issue = await getIssue(ctx, handed.id);
    event = await getLatestEvent(ctx, handed.id);
  } catch (error) { throw deliveryFailure(error, 'reading the Sentry issue'); }
  const shortId = str(issue.shortId);
  if (idOf(issue.id) !== handed.id || !shortId || !SHORT_ID.test(shortId)) return result('ignored', 'unreadable_issue');
  const mapping = projectRepository(ctx.settings, { id: idOf(issue.project?.id), slug: str(issue.project?.slug) });
  if (!mapping.repository) {
    ctx.log.info(`Sentry issue ${shortId} is in a project ${mapping.problem === 'ambiguous' ? 'mapped to several repositories' : 'not mapped to a repository'}; nothing was created`, { sentryIssue: shortId });
    return result('ignored', mapping.problem, { sentryIssue: shortId });
  }
  const repository = mapping.repository;
  const label = githubTriggerLabel(ctx.settings, SENTRY_SETTINGS.githubLabel);
  const error = summary(issue, event, shortId, issueWebUrl(origin, organization, handed.id));

  // Checking and reserving the Sentry issue is one atomic update: of two deliveries for it at once, only one creates a GitHub issue.
  const seen = await reserveTicket(ctx, { t: record, k: shortId, r: repository });
  if (seen) return result('duplicate', null, { sentryIssue: seen.k, repository: seen.r, issue: seen.n ?? null });
  const settings = autoStartSettings(ctx.settings);
  // The cap is taken only once the Sentry issue is reserved, so a duplicate never uses up a start.
  const decision = await decideStart(ctx, settings, { repository, count: error.count, environment: error.environment, receivedAt: input.receivedAt });
  let created: { number: number };
  try {
    created = await ctx.propr.createIssue(repository, {
      title: sentryIssueTitle(error), body: sentryIssueBody(error, startSentence(decision, settings, label)), labels: decision.start ? [label] : [],
    });
  } catch (failure) {
    if (failure instanceof PluginSdkError && NOT_CREATED.has(failure.code)) {
      await deleteTicket(ctx, record);
      if (decision.start) await releaseStart(ctx, decision.slot);
      throw new PluginDeliveryError(`The issue for ${shortId} was not created in ${repository}: ${failure.message}`, { permanent: true });
    }
    throw new PluginDeliveryError(`Creating the issue for ${shortId} in ${repository} failed and it may have been created anyway; it is not retried, so a Sentry issue creates at most one issue. Check the repository`, { permanent: true });
  }
  await writeTicket(ctx, { t: record, k: shortId, r: repository, s: 'created', n: created.number });
  const notStarted = decision.start ? null : decision.reason;
  ctx.log.info(`Created issue #${created.number} in ${repository} for Sentry issue ${shortId}${decision.start ? ', with the trigger label' : ` (not started: ${notStarted})`}`, { sentryIssue: shortId, repository, issue: created.number, started: decision.start });
  return result('created', null, { sentryIssue: shortId, repository, issue: created.number, started: decision.start, notStarted });
}

/** Whether some repository is mapped by slug: a numeric project id alone cannot rule it out. */
function hasSlugMapping(ctx: PluginContext): boolean {
  const map = ctx.settings[SENTRY_SETTINGS.repositoryProjects];
  return !!map && typeof map === 'object' && !Array.isArray(map) && Object.values(map).some(v => typeof v === 'string' && !/^\d+$/.test(v.trim()));
}
