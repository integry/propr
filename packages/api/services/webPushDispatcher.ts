/* eslint-disable max-lines -- claiming, policy checks, delivery, and audit writes form one boundary */
import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import type { Knex } from 'knex';
import webPush, {
  type PushSubscription as WebPushSubscription,
  type RequestOptions as WebPushRequestOptions,
  type SendResult,
} from 'web-push';
import {
  normalizeISO8601Timestamp,
  parseNotificationAction,
  parseNotificationTarget,
  parsePushSubscriptionEndpoint,
  parseTruthyEnvValue,
  type NotificationAction,
  type NotificationKind,
  type NotificationSeverity,
  type NotificationTarget,
} from '@propr/shared';
import {
  validateWebPushConfiguration,
  WEB_PUSH_CONFIGURATION_WARNINGS,
  webPushConfigurationFromEnvironment,
  type ValidatedWebPushConfiguration,
  type WebPushServerConfiguration,
} from './webPushConfiguration.js';

const DEFAULT_INTERVAL_MS = 5_000;
const DEFAULT_BATCH_SIZE = 20;
const DEFAULT_SCAN_MULTIPLIER = 20;
const DEFAULT_LEASE_MS = 60_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const REQUEST_LEASE_SAFETY_MARGIN_MS = 5_000;
const DEFAULT_TTL_SECONDS = 5 * 60;
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_RETRY_BASE_MS = 30_000;
const DEFAULT_RETRY_CAP_MS = 15 * 60 * 1000;
const MAX_PAYLOAD_BYTES = 3_500;
const LOCAL_DEPLOYMENT_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const CLAIMABLE_AT_SQL = "CASE WHEN job.status = 'retryable' "
  + 'THEN job.next_retry_at ELSE job.created_at END';

type TimestampInput = string | number | Date;

interface DispatcherLogger {
  info(message: string): void;
  warn(message: string): void;
}

interface PushSender {
  sendNotification(
    subscription: WebPushSubscription,
    payload: string,
    options: WebPushRequestOptions,
  ): Promise<SendResult>;
}

interface CandidateRow {
  job_id: string;
  claimable_at: string;
  quiet_hours_start: string | null;
  quiet_hours_end: string | null;
  timezone: string | null;
}

interface ClaimedJobRow {
  job_id: string;
  event_id: string;
  user_id: string;
  subscription_id: string;
  attempt_count: number;
  claim_token: string;
}

interface LiveDeliveryRow extends ClaimedJobRow {
  endpoint: string;
  p256dh_key: string;
  auth_key: string;
  subscription_updated_at: string;
  kind: NotificationKind;
  severity: NotificationSeverity;
  target_json: string;
  action_json: string | null;
  quiet_hours_start: string | null;
  quiet_hours_end: string | null;
  timezone: string | null;
  badge_enabled: number | boolean | null;
}

interface AttemptOutcome {
  status: 'delivered' | 'retryable' | 'failed';
  responseStatus: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  nextRetryAt: string | null;
  revokeSubscription: boolean;
}

export interface WebPushDispatcherOptions {
  database: Knex;
  configuration?: WebPushServerConfiguration;
  sender?: PushSender;
  now?: () => TimestampInput;
  generateId?: () => string;
  logger?: DispatcherLogger;
  frontendUrl?: string;
  apiBaseUrl?: string;
  intervalMs?: number;
  batchSize?: number;
  leaseMs?: number;
  requestTimeoutMs?: number;
  ttlSeconds?: number;
  maxAttempts?: number;
  retryBaseMs?: number;
  retryCapMs?: number;
  allowInsecureLocalhost?: boolean;
}

export interface WebPushDispatcherStartResult {
  configured: boolean;
  publicKey: string | null;
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return resolved;
}

function integerEnvironment(name: string): number | undefined {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function normalizedPublicUrl(value: string | undefined, fallback: string): string {
  try {
    const url = new URL(value ?? fallback);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      throw new TypeError('unsupported URL');
    }
    url.hash = '';
    return url.toString();
  } catch {
    return new URL(fallback).toString();
  }
}

function isLocalDevelopmentDeployment(): boolean {
  if (process.env.NODE_ENV === 'production') return false;
  const configuredPublicUrl = process.env.API_PUBLIC_URL;
  if (configuredPublicUrl === undefined || configuredPublicUrl.length === 0) return true;
  try {
    return LOCAL_DEPLOYMENT_HOSTS.has(new URL(configuredPublicUrl).hostname.toLowerCase());
  } catch {
    return false;
  }
}

function responseHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).flatMap(([name, value]) => {
    if (value === undefined) return [];
    return [[name, Array.isArray(value) ? value.join(', ') : value]];
  }));
}

function sendInsecureLocalNotification(
  subscription: WebPushSubscription,
  payload: string,
  options: WebPushRequestOptions,
): Promise<SendResult> {
  const details = webPush.generateRequestDetails(subscription, payload, options);
  const endpoint = new URL(details.endpoint);
  return new Promise((resolve, reject) => {
    const request = httpRequest(endpoint, {
      method: details.method,
      headers: details.headers,
      timeout: options.timeout,
    }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => {
        const statusCode = response.statusCode ?? 500;
        const headers = responseHeaders(response.headers);
        if (statusCode < 200 || statusCode > 299) {
          reject(new webPush.WebPushError(
            'Received unexpected response code',
            statusCode,
            headers,
            body,
            details.endpoint,
          ));
          return;
        }
        resolve({ statusCode, headers, body });
      });
    });
    request.on('timeout', () => request.destroy(new Error('Socket timeout')));
    request.on('error', reject);
    if (details.body) request.write(details.body);
    request.end();
  });
}

function createDefaultPushSender(allowInsecureLocalhost: boolean): PushSender {
  return {
    sendNotification(subscription, payload, options) {
      const endpoint = parsePushSubscriptionEndpoint(subscription.endpoint, {
        allowInsecureLocalhost,
      });
      return endpoint.startsWith('http:')
        ? sendInsecureLocalNotification({ ...subscription, endpoint }, payload, options)
        : webPush.sendNotification({ ...subscription, endpoint }, payload, options);
    },
  };
}

function quietHourMinutes(value: string): number {
  const [hours, minutes] = value.split(':').map(Number);
  return hours * 60 + minutes;
}

export function isInNotificationQuietHours(
  at: Date,
  start: string | null,
  end: string | null,
  timezone: string | null,
): boolean {
  if (start === null || end === null || start === end) return false;
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone ?? 'UTC',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(at);
    const hour = Number(parts.find(part => part.type === 'hour')?.value);
    const minute = Number(parts.find(part => part.type === 'minute')?.value);
    if (!Number.isInteger(hour) || !Number.isInteger(minute)) return true;
    const current = hour * 60 + minute;
    const startMinutes = quietHourMinutes(start);
    const endMinutes = quietHourMinutes(end);
    return startMinutes < endMinutes
      ? current >= startMinutes && current < endMinutes
      : current >= startMinutes || current < endMinutes;
  } catch {
    // An invalid persisted timezone must fail closed instead of leaking an alert.
    return true;
  }
}

function targetPath(target: NotificationTarget): string {
  switch (target.type) {
    case 'plan': return `/studio/${encodeURIComponent(target.draftId)}`;
    case 'task': return `/tasks/${encodeURIComponent(target.taskId)}`;
    case 'review': return target.taskId
      ? `/tasks/${encodeURIComponent(target.taskId)}`
      : '/tasks';
    case 'indexing': {
      const [owner, repository] = target.repository.split('/');
      return owner && repository
        ? `/summaries/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`
        : '/repositories';
    }
    case 'pull_request': return '/repositories';
    case 'system_failure': return '/';
  }
}

function absoluteUiUrl(baseValue: string, path: string): string {
  const base = new URL(baseValue);
  const result = new URL(path, base);
  for (const [key, value] of base.searchParams) {
    if (!result.searchParams.has(key)) result.searchParams.append(key, value);
  }
  return result.toString();
}

function notificationActionUrl(
  action: NotificationAction,
  frontendUrl: string,
): string {
  return action.type === 'navigate'
    ? absoluteUiUrl(frontendUrl, action.href)
    : action.href;
}

function parseStoredJson(value: string): unknown {
  return JSON.parse(value) as unknown;
}

function buildSafePayload(
  row: LiveDeliveryRow,
  unreadCount: number | null,
  frontendUrl: string,
  apiBaseUrl: string,
): string {
  const target = parseNotificationTarget(parseStoredJson(row.target_json));
  const action = row.action_json === null
    ? null
    : parseNotificationAction(parseStoredJson(row.action_json));
  const fallbackDeepLink = absoluteUiUrl(frontendUrl, targetPath(target));
  const deepLink = action?.type === 'navigate'
    ? notificationActionUrl(action, frontendUrl)
    : fallbackDeepLink;
  const actions = action === null ? [] : [{
    action: 'view',
    title: 'View details',
    url: notificationActionUrl(action, frontendUrl),
  }];
  const summary = row.severity === 'error' || row.severity === 'warning'
    ? 'An operational alert needs your attention.'
    : 'A ProPR update is available.';
  const payload = {
    version: 1,
    eventId: row.event_id,
    kind: row.kind,
    severity: row.severity,
    title: 'ProPR notification',
    body: summary,
    deepLink,
    apiBaseUrl,
    unreadCount,
    actions,
  };
  let serialized = JSON.stringify(payload);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_PAYLOAD_BYTES) {
    serialized = JSON.stringify({ ...payload, actions: [] });
  }
  if (Buffer.byteLength(serialized, 'utf8') > MAX_PAYLOAD_BYTES) {
    throw new Error('safe_payload_too_large');
  }
  return serialized;
}

function statusFromError(error: unknown): number | null {
  if (typeof error !== 'object' || error === null || !('statusCode' in error)) return null;
  const value = (error as { statusCode?: unknown }).statusCode;
  return Number.isInteger(value) && Number(value) >= 100 && Number(value) <= 599
    ? Number(value)
    : null;
}

function isTransientStatus(status: number | null): boolean {
  return status === null || status === 408 || status === 425 || status === 429
    || (status >= 500 && status <= 599);
}

function safeFailureSummary(status: number | null, transient: boolean): {
  code: string;
  message: string;
} {
  if (status !== null) {
    return {
      code: `http_${status}`,
      message: transient
        ? 'Push provider returned a transient HTTP status'
        : 'Push provider rejected the delivery request',
    };
  }
  return {
    code: 'network_error',
    message: 'Push delivery failed before a provider response was received',
  };
}

export class WebPushDispatcher {
  private readonly database: Knex;
  private readonly configuration: ValidatedWebPushConfiguration;
  private readonly sender: PushSender;
  private readonly allowInsecureLocalhost: boolean;
  private readonly now: () => TimestampInput;
  private readonly generateId: () => string;
  private readonly logger: DispatcherLogger;
  private readonly frontendUrl: string;
  private readonly apiBaseUrl: string;
  private readonly intervalMs: number;
  private readonly batchSize: number;
  private readonly leaseMs: number;
  private readonly requestTimeoutMs: number;
  private readonly ttlSeconds: number;
  private readonly maxAttempts: number;
  private readonly retryBaseMs: number;
  private readonly retryCapMs: number;
  private timer: NodeJS.Timeout | undefined;
  private activeRun: Promise<number> | undefined;
  private warned = false;

  constructor(options: WebPushDispatcherOptions) {
    this.database = options.database;
    this.configuration = validateWebPushConfiguration(
      options.configuration ?? webPushConfigurationFromEnvironment(),
    );
    const insecureLocalhostRequested = options.allowInsecureLocalhost
      ?? parseTruthyEnvValue(process.env.PROPR_ALLOW_INSECURE_LOCAL_WEB_PUSH);
    this.allowInsecureLocalhost = insecureLocalhostRequested
      && isLocalDevelopmentDeployment();
    this.sender = options.sender ?? createDefaultPushSender(this.allowInsecureLocalhost);
    this.now = options.now ?? (() => new Date());
    this.generateId = options.generateId ?? randomUUID;
    this.logger = options.logger ?? console;
    this.frontendUrl = normalizedPublicUrl(
      options.frontendUrl ?? process.env.FRONTEND_URL,
      'http://localhost:5173',
    );
    this.apiBaseUrl = normalizedPublicUrl(
      options.apiBaseUrl ?? process.env.API_PUBLIC_URL,
      'http://localhost:4000',
    );
    this.intervalMs = positiveInteger(
      options.intervalMs ?? integerEnvironment('WEB_PUSH_DISPATCH_INTERVAL_MS'),
      DEFAULT_INTERVAL_MS,
      'intervalMs',
    );
    this.batchSize = positiveInteger(
      options.batchSize ?? integerEnvironment('WEB_PUSH_DISPATCH_BATCH_SIZE'),
      DEFAULT_BATCH_SIZE,
      'batchSize',
    );
    this.leaseMs = positiveInteger(
      options.leaseMs ?? integerEnvironment('WEB_PUSH_DELIVERY_LEASE_MS'),
      DEFAULT_LEASE_MS,
      'leaseMs',
    );
    this.requestTimeoutMs = positiveInteger(
      options.requestTimeoutMs ?? integerEnvironment('WEB_PUSH_REQUEST_TIMEOUT_MS'),
      DEFAULT_REQUEST_TIMEOUT_MS,
      'requestTimeoutMs',
    );
    this.ttlSeconds = positiveInteger(
      options.ttlSeconds ?? integerEnvironment('WEB_PUSH_TTL_SECONDS'),
      DEFAULT_TTL_SECONDS,
      'ttlSeconds',
    );
    this.maxAttempts = positiveInteger(
      options.maxAttempts ?? integerEnvironment('WEB_PUSH_MAX_ATTEMPTS'),
      DEFAULT_MAX_ATTEMPTS,
      'maxAttempts',
    );
    this.retryBaseMs = positiveInteger(
      options.retryBaseMs ?? integerEnvironment('WEB_PUSH_RETRY_BASE_MS'),
      DEFAULT_RETRY_BASE_MS,
      'retryBaseMs',
    );
    this.retryCapMs = positiveInteger(
      options.retryCapMs ?? integerEnvironment('WEB_PUSH_RETRY_CAP_MS'),
      DEFAULT_RETRY_CAP_MS,
      'retryCapMs',
    );
    if (this.retryCapMs < this.retryBaseMs) {
      throw new TypeError('retryCapMs must be at least retryBaseMs');
    }
    if (this.leaseMs <= this.requestTimeoutMs) {
      throw new TypeError('leaseMs must exceed requestTimeoutMs');
    }
  }

  start(): WebPushDispatcherStartResult {
    if (!this.configuration.configured) {
      if (!this.warned && this.configuration.issue !== 'disabled') {
        this.warned = true;
        this.logger.warn(`[notifications] Web Push dispatcher disabled: ${
          WEB_PUSH_CONFIGURATION_WARNINGS[this.configuration.issue]
        }`);
      }
      return { configured: false, publicKey: null };
    }
    if (!this.timer) {
      this.timer = setInterval(() => { void this.runOnce(); }, this.intervalMs);
      this.timer.unref();
      void this.runOnce();
      this.logger.info('[notifications] Web Push dispatcher started');
    }
    return { configured: true, publicKey: this.configuration.publicKey };
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.activeRun;
  }

  runOnce(): Promise<number> {
    if (!this.configuration.configured) return Promise.resolve(0);
    if (this.activeRun) return this.activeRun;
    const run = this.dispatchBatch().catch(() => {
      this.logger.warn('[notifications] Web Push dispatcher run failed');
      return 0;
    }).finally(() => {
      if (this.activeRun === run) this.activeRun = undefined;
    });
    this.activeRun = run;
    return run;
  }

  private async dispatchBatch(): Promise<number> {
    await this.cancelIneligibleJobs();
    const scanSize = this.batchSize * DEFAULT_SCAN_MULTIPLIER;
    let cursor: Pick<CandidateRow, 'claimable_at' | 'job_id'> | undefined;
    let delivered = 0;
    while (delivered < this.batchSize) {
      const query = this.database<CandidateRow>('push_delivery_claimable_jobs as job')
        .leftJoin(
          'notification_preference_settings as settings',
          'settings.user_id',
          'job.user_id',
        )
        .select(
          'job.job_id',
          this.database.raw(`${CLAIMABLE_AT_SQL} as claimable_at`),
          'settings.quiet_hours_start',
          'settings.quiet_hours_end',
          'settings.timezone',
        )
        .orderByRaw(`${CLAIMABLE_AT_SQL} ASC`)
        .orderBy('job.job_id', 'asc')
        .limit(scanSize);
      if (cursor) {
        const after = cursor;
        query.andWhere(afterCursor => {
          afterCursor.whereRaw(`${CLAIMABLE_AT_SQL} > ?`, [after.claimable_at])
            .orWhere(sameTimestamp => {
              sameTimestamp.whereRaw(`${CLAIMABLE_AT_SQL} = ?`, [after.claimable_at])
                .andWhere('job.job_id', '>', after.job_id);
            });
        });
      }
      const candidates = await query;
      if (candidates.length === 0) break;
      const lastCandidate = candidates[candidates.length - 1];
      cursor = {
        claimable_at: lastCandidate.claimable_at,
        job_id: lastCandidate.job_id,
      };

      for (const candidate of candidates) {
        if (delivered >= this.batchSize) break;
        const now = new Date(this.now());
        if (isInNotificationQuietHours(
          now,
          candidate.quiet_hours_start,
          candidate.quiet_hours_end,
          candidate.timezone,
        )) continue;
        const claimed = await this.claim(candidate.job_id, now);
        if (!claimed) continue;
        await this.deliver(claimed);
        delivered += 1;
      }
      if (candidates.length < scanSize) break;
    }
    return delivered;
  }

  private async cancelIneligibleJobs(): Promise<void> {
    const jobIds = await this.database('push_delivery_jobs_requiring_cancellation')
      .select('job_id')
      .limit(this.batchSize * DEFAULT_SCAN_MULTIPLIER) as Array<{ job_id: string }>;
    if (jobIds.length === 0) return;
    await this.database('push_delivery_jobs')
      .whereIn('job_id', jobIds.map(row => row.job_id))
      .update({
        status: 'cancelled',
        next_retry_at: null,
        claim_token: null,
        claimed_at: null,
        lease_expires_at: null,
      });
  }

  private async claim(jobId: string, at: Date): Promise<ClaimedJobRow | null> {
    const claimedAt = normalizeISO8601Timestamp(at);
    const leaseExpiresAt = normalizeISO8601Timestamp(at.getTime() + this.leaseMs);
    const claimToken = this.generateId();
    const rows = await this.database('push_delivery_jobs')
      .where({ job_id: jobId })
      .whereExists(function claimable() {
        this.select(this.client.raw('1'))
          .from('push_delivery_claimable_jobs as claimable')
          .whereRaw('claimable.job_id = push_delivery_jobs.job_id');
      })
      .update({
        status: 'processing',
        next_retry_at: null,
        claim_token: claimToken,
        claimed_at: claimedAt,
        lease_expires_at: leaseExpiresAt,
      })
      .returning([
        'job_id', 'event_id', 'user_id', 'subscription_id',
        'attempt_count', 'claim_token',
      ]) as ClaimedJobRow[];
    return rows[0] ?? null;
  }

  private async liveDelivery(claimed: ClaimedJobRow): Promise<LiveDeliveryRow | null> {
    return this.database('push_delivery_jobs as job')
      .join('notification_user_states as recipient', function recipientJoin() {
        this.on('recipient.event_id', '=', 'job.event_id')
          .andOn('recipient.user_id', '=', 'job.user_id');
      })
      .join('notification_events as event', 'event.event_id', 'job.event_id')
      .join('notification_preferences as preference', function preferenceJoin() {
        this.on('preference.user_id', '=', 'job.user_id')
          .andOn('preference.notification_kind', '=', 'event.kind');
      })
      .join('push_subscriptions as subscription', function subscriptionJoin() {
        this.on('subscription.subscription_id', '=', 'job.subscription_id')
          .andOn('subscription.user_id', '=', 'job.user_id');
      })
      .leftJoin(
        'notification_preference_settings as settings',
        'settings.user_id',
        'job.user_id',
      )
      .select(
        'job.job_id', 'job.event_id', 'job.user_id', 'job.subscription_id',
        'job.attempt_count', 'job.claim_token',
        'subscription.endpoint', 'subscription.p256dh_key', 'subscription.auth_key',
        'subscription.updated_at as subscription_updated_at',
        'event.kind', 'event.severity', 'event.target_json', 'event.action_json',
        'settings.quiet_hours_start', 'settings.quiet_hours_end', 'settings.timezone',
        'settings.badge_enabled',
      )
      .where({
        'job.job_id': claimed.job_id,
        'job.status': 'processing',
        'job.claim_token': claimed.claim_token,
        'recipient.push_enabled': true,
        'preference.push_enabled': true,
      })
      .whereNull('subscription.revoked_at')
      .whereNotNull('subscription.p256dh_key')
      .whereNotNull('subscription.auth_key')
      .andWhere(expiration => {
        expiration.whereNull('subscription.expires_at')
          .orWhere('subscription.expires_at', '>', normalizeISO8601Timestamp(this.now()));
      })
      .first() as Promise<LiveDeliveryRow | null>;
  }

  private async renewClaimForRequest(claimed: ClaimedJobRow, at: Date): Promise<boolean> {
    const renewedAt = normalizeISO8601Timestamp(at);
    const leaseExpiresAt = normalizeISO8601Timestamp(
      at.getTime() + Math.max(
        this.leaseMs,
        this.requestTimeoutMs + REQUEST_LEASE_SAFETY_MARGIN_MS,
      ),
    );
    const renewed = await this.database('push_delivery_jobs')
      .where({
        job_id: claimed.job_id,
        status: 'processing',
        claim_token: claimed.claim_token,
      })
      .andWhere('lease_expires_at', '>', renewedAt)
      .update({ lease_expires_at: leaseExpiresAt });
    return renewed === 1;
  }

  private async deliver(claimed: ClaimedJobRow): Promise<void> {
    const configuration = this.configuration;
    if (!configuration.configured) return;
    const live = await this.liveDelivery(claimed);
    if (!live) return;
    const policyCheckedAt = new Date(this.now());
    if (isInNotificationQuietHours(
      policyCheckedAt,
      live.quiet_hours_start,
      live.quiet_hours_end,
      live.timezone,
    )) return;
    const attemptNumber = live.attempt_count + 1;

    let endpoint: string;
    let payload: string;
    try {
      endpoint = parsePushSubscriptionEndpoint(live.endpoint, {
        allowInsecureLocalhost: this.allowInsecureLocalhost,
      });
      const unreadCount = live.badge_enabled === null || Boolean(live.badge_enabled)
        ? await this.unreadCount(live.user_id)
        : null;
      payload = buildSafePayload(
        live,
        unreadCount,
        this.frontendUrl,
        this.apiBaseUrl,
      );
    } catch (error) {
      const attemptedAt = normalizeISO8601Timestamp(policyCheckedAt);
      const outcome = error instanceof Error && error.message === 'safe_payload_too_large'
        ? {
          status: 'failed' as const, responseStatus: null, errorCode: 'payload_too_large',
          errorMessage: 'Safe push payload exceeded the delivery size limit',
          nextRetryAt: null, revokeSubscription: false,
        }
        : this.failureOutcome(statusFromError(error), attemptNumber, policyCheckedAt);
      await this.recordOutcome(live, attemptedAt, attemptNumber, outcome);
      return;
    }

    const attemptedAtDate = new Date(this.now());
    if (!await this.renewClaimForRequest(live, attemptedAtDate)) return;
    const attemptedAt = normalizeISO8601Timestamp(attemptedAtDate);
    let outcome: AttemptOutcome;
    try {
      const response = await this.sender.sendNotification({
        endpoint,
        keys: { p256dh: live.p256dh_key, auth: live.auth_key },
      }, payload, {
        TTL: this.ttlSeconds,
        timeout: this.requestTimeoutMs,
        urgency: live.severity === 'error' ? 'high' : 'normal',
        vapidDetails: {
          subject: configuration.subject,
          publicKey: configuration.publicKey,
          privateKey: configuration.privateKey,
        },
      });
      outcome = response.statusCode >= 200 && response.statusCode <= 299
        ? {
          status: 'delivered', responseStatus: response.statusCode,
          errorCode: null, errorMessage: null, nextRetryAt: null,
          revokeSubscription: false,
        }
        : this.failureOutcome(response.statusCode, attemptNumber, attemptedAtDate);
    } catch (error) {
      outcome = this.failureOutcome(statusFromError(error), attemptNumber, attemptedAtDate);
    }
    await this.recordOutcome(live, attemptedAt, attemptNumber, outcome);
  }

  private failureOutcome(
    responseStatus: number | null,
    attemptNumber: number,
    attemptedAt: Date,
  ): AttemptOutcome {
    const revokeSubscription = responseStatus === 404 || responseStatus === 410;
    const transient = !revokeSubscription && isTransientStatus(responseStatus);
    const retryable = transient && attemptNumber < this.maxAttempts;
    const summary = safeFailureSummary(responseStatus, transient);
    const delay = Math.min(
      this.retryCapMs,
      this.retryBaseMs * (2 ** Math.min(attemptNumber - 1, 30)),
    );
    return {
      status: retryable ? 'retryable' : 'failed',
      responseStatus,
      errorCode: retryable || !transient ? summary.code : 'retry_exhausted',
      errorMessage: retryable || !transient
        ? summary.message
        : 'Push delivery stopped after the retry limit was reached',
      nextRetryAt: retryable
        ? normalizeISO8601Timestamp(attemptedAt.getTime() + delay)
        : null,
      revokeSubscription,
    };
  }

  private async recordOutcome(
    live: LiveDeliveryRow,
    attemptedAt: string,
    attemptNumber: number,
    outcome: AttemptOutcome,
  ): Promise<void> {
    await this.database.transaction(async transaction => {
      if (outcome.revokeSubscription) {
        await transaction('push_subscriptions')
          .where({
            subscription_id: live.subscription_id,
            user_id: live.user_id,
            endpoint: live.endpoint,
            p256dh_key: live.p256dh_key,
            auth_key: live.auth_key,
            updated_at: live.subscription_updated_at,
          })
          .whereNull('revoked_at')
          .update({ revoked_at: attemptedAt });
      } else if (outcome.status === 'delivered') {
        await transaction('push_subscriptions')
          .where({
            subscription_id: live.subscription_id,
            user_id: live.user_id,
          })
          .whereNull('revoked_at')
          .update({ last_used_at: attemptedAt });
      }

      await transaction('push_delivery_attempts').insert({
        attempt_id: this.generateId(),
        job_id: live.job_id,
        attempt_number: attemptNumber,
        status: outcome.status,
        response_status: outcome.responseStatus,
        error_code: outcome.errorCode,
        error_message: outcome.errorMessage,
        attempted_at: attemptedAt,
        next_retry_at: outcome.nextRetryAt,
        claim_token: live.claim_token,
        created_at: attemptedAt,
      });
    });
  }

  private async unreadCount(userId: string): Promise<number> {
    const row = await this.database('notification_user_states')
      .where({ user_id: userId, inbox_enabled: true })
      .whereNull('read_at')
      .whereNull('dismissed_at')
      .count({ count: '*' })
      .first() as { count?: number | string } | undefined;
    const count = Number(row?.count ?? 0);
    return Number.isSafeInteger(count) && count >= 0 ? count : 0;
  }
}

export function createWebPushDispatcher(
  database: Knex,
  options: Omit<WebPushDispatcherOptions, 'database'> = {},
): WebPushDispatcher {
  return new WebPushDispatcher({ ...options, database });
}
