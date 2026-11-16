import {
  PLUGIN_REPOSITORY_PATTERN, PluginDeliveryError, PluginSdkError,
  type PluginContext, type PluginJsonValue, type PluginSettingValues, type PluginWebhookInput, type PluginWebhookRequest, type PluginWebhookResponse,
} from '@propr/shared';
import { SlackApiError, deliveryFailure, permalink, postMessage, userGroupMembers } from './api.js';
import { slackEscape } from './format.js';
import { deleteMention, mentionExpired, readMention, writeMention } from './mentionRecords.js';
import { rememberThread } from './threads.js';

/**
 * Slack app mode, inbound: the Events API request URL is the plugin's
 * `events` webhook. ProPR verifies each request (`slack-v0`: the
 * `X-Slack-Signature` HMAC of `v0:<timestamp>:<body>`, timestamp within five
 * minutes) before any of this runs; `slackChallenge` answers the URL
 * verification challenge at once.
 *
 * An `app_mention` from an allowed person, in a channel Repository channels
 * maps to exactly one repository, creates one GitHub issue there: the title
 * is the first line of the request, the body the request quoted, with a link
 * back to the Slack message, and its only label the Trigger label, so ProPR
 * starts a task through the normal label-triggered intake. The message text
 * is untrusted: it is the issue's title and body and nothing else. It never
 * chooses the repository (the channel does), the labels or the model. The
 * reply in the thread links the issue; the issue's pull request is then
 * posted in the same thread.
 */

export const SLACK_APP_SETTINGS = {
  repositoryChannels: 'repositoryChannels', defaultChannel: 'defaultChannel', allowedUsers: 'allowedUsers', allowedUserGroup: 'allowedUserGroup',
  triggerLabel: 'triggerLabel', mode: 'mode',
} as const;
export const DEFAULT_TRIGGER_LABEL = 'AI';
/** The longest request text taken into an issue, and the longest issue title. */
export const MENTION_LIMITS = { textChars: 4_000, titleChars: 100 } as const;

const CHANNEL_ID = /^[CGD][A-Z0-9]{2,30}$/;
const USER_ID = /^[UW][A-Z0-9]{2,30}$/;
const USER_GROUP_ID = /^S[A-Z0-9]{2,30}$/;
const MESSAGE_TS = /^\d{1,12}\.\d{1,9}$/;
/** A label ProPR could use as a trigger: no commas, no control characters, at most 50 characters. */
const LABEL = /^[^\s,\x00-\x1f\x7f][^,\x00-\x1f\x7f]{0,49}$/;

/** Slack's URL verification: echo the challenge as plain text. Any other request goes to the handler. */
export function slackChallengeResponse(request: PluginWebhookRequest): PluginWebhookResponse | null {
  let body: { type?: unknown; challenge?: unknown };
  try { body = JSON.parse(request.body) as typeof body; } catch { return null; }
  if (!body || body.type !== 'url_verification' || typeof body.challenge !== 'string') return null;
  // Slack's challenge is a short token; anything else is not echoed.
  return /^[A-Za-z0-9_-]{1,200}$/.test(body.challenge) ? { contentType: 'text/plain', body: body.challenge } : null;
}

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
const list = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string').map(v => v.trim()).filter(Boolean) : []);

/** The repositories Repository channels maps to `channel` (channel ids compared without letter case). */
export function channelRepositories(settings: PluginSettingValues, channel: string): string[] {
  const map = settings[SLACK_APP_SETTINGS.repositoryChannels];
  if (!map || typeof map !== 'object' || Array.isArray(map)) return [];
  const wanted = channel.toUpperCase();
  return [...new Set(Object.entries(map)
    .filter(([repository, value]) => PLUGIN_REPOSITORY_PATTERN.test(repository) && typeof value === 'string' && value.trim().toUpperCase() === wanted)
    .map(([repository]) => repository))];
}

/** The channel app mode posts a repository's updates to: its Repository channels entry, else the Default channel; null for none. */
export function repositoryChannel(settings: PluginSettingValues, repository: string): string | null {
  const map = settings[SLACK_APP_SETTINGS.repositoryChannels];
  const name = repository.toLowerCase();
  const entry = map && typeof map === 'object' && !Array.isArray(map) ? Object.entries(map).find(([key]) => key.toLowerCase() === name)?.[1] : undefined;
  const channel = (typeof entry === 'string' && entry.trim() ? entry : text(settings[SLACK_APP_SETTINGS.defaultChannel])).trim().toUpperCase();
  return CHANNEL_ID.test(channel) ? channel : null;
}

/** The Trigger label setting, checked: an invalid one fails the delivery rather than create an issue nothing picks up. */
export function triggerLabel(settings: PluginSettingValues): string {
  const value = settings[SLACK_APP_SETTINGS.triggerLabel];
  const label = typeof value === 'string' && value.trim() ? value.trim() : DEFAULT_TRIGGER_LABEL;
  if (!LABEL.test(label)) throw new PluginDeliveryError('The Trigger label setting is not a usable label (no commas, at most 50 characters). Fix the plugin\'s settings', { permanent: true });
  return label;
}

/**
 * Slack message text as plain text: the bot's own mention removed, user,
 * channel and group mentions and links in readable form, Slack's `&amp;`,
 * `&lt;` and `&gt;` decoded, control characters dropped. See
 * https://docs.slack.dev/messaging/formatting-message-text.
 */
export function slackPlainText(raw: string, botUserId: string | null): string {
  let value = raw.replace(/\r\n?/g, '\n');
  if (!botUserId) value = value.replace(/^\s*<@[A-Z0-9]+(?:\|[^>]*)?>/, '');
  value = value
    .replace(/<@([A-Z0-9]+)(?:\|([^>]*))?>/g, (_m, id: string, label?: string) => (id === botUserId ? '' : `@${label || id}`))
    .replace(/<#([A-Z0-9]+)(?:\|([^>]*))?>/g, (_m, id: string, name?: string) => `#${name || id}`)
    .replace(/<!subteam\^([A-Z0-9]+)(?:\|([^>]*))?>/g, (_m, id: string, name?: string) => name || `@${id}`)
    .replace(/<!(here|channel|everyone)(?:\|[^>]*)?>/g, '@$1')
    .replace(/<!date\^[^|>]*\|([^>]*)>/g, '$1')
    .replace(/<!([^|>]*)(?:\|([^>]*))?>/g, (_m, name: string, label?: string) => label || name)
    .replace(/<((?:https?|mailto):[^|>]+)\|([^>]*)>/g, (_m, url: string, label: string) => (label && label !== url ? `${label} (${url})` : url))
    .replace(/<((?:https?|mailto):[^|>]+)>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/[\x00-\x08\x0b-\x1f\x7f‪-‮⁦-⁩]/g, '');
  return value.split('\n').map(line => line.replace(/\s+$/, '')).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** The issue title: the first non-empty line, whitespace collapsed, without `<` and `>`, at most `MENTION_LIMITS.titleChars`. */
export function issueTitle(plain: string): string {
  const line = plain.split('\n').map(l => l.replace(/[<>]/g, '').replace(/\s+/g, ' ').trim()).find(Boolean) ?? '';
  return line.length > MENTION_LIMITS.titleChars ? `${line.slice(0, MENTION_LIMITS.titleChars - 1).trimEnd()}…` : line;
}

/**
 * The request as inert GitHub Markdown: every line quoted, `&`, `<` and `>`
 * written as entities (so no HTML, and no hidden `<!-- … -->` marker ProPR
 * reads), and `@` mentions broken with a word joiner so nobody is notified.
 */
export function quotedRequest(plain: string): string {
  const capped = plain.length > MENTION_LIMITS.textChars ? `${plain.slice(0, MENTION_LIMITS.textChars)}…` : plain;
  return capped
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/(^|[^A-Za-z0-9_])@(?=[A-Za-z0-9])/g, '$1@⁠')
    .split('\n').map(line => (line ? `> ${line}` : '>')).join('\n');
}

export function issueBody(plain: string, link: string | null): string {
  return [
    'Requested in Slack by mentioning the ProPR bot. The request, as written:',
    '',
    quotedRequest(plain),
    '',
    link ? `[The Slack message](${link})` : 'The Slack message has no link.',
    '',
    '_Created by the ProPR Slack plugin. The repository comes from the Slack channel and the label from the plugin\'s settings; the request text chooses neither, nor the model._',
  ].join('\n');
}

interface SlackEnvelope {
  type?: unknown; event_id?: unknown; team_id?: unknown;
  authorizations?: { user_id?: unknown; is_bot?: unknown }[];
  event?: { type?: unknown; user?: unknown; bot_id?: unknown; subtype?: unknown; text?: unknown; ts?: unknown; thread_ts?: unknown; channel?: unknown };
}

export type MentionOutcome = 'created' | 'duplicate' | 'refused' | 'ignored';
export interface MentionResult { [key: string]: PluginJsonValue; outcome: MentionOutcome; reason: string | null; repository: string | null; issue: number | null }
const result = (outcome: MentionOutcome, reason: string | null, repository: string | null = null, issue: number | null = null): MentionResult => ({ outcome, reason, repository, issue });

/** Whether `user` may start tasks: listed in Allowed users, or a member of the Allowed user group. Nobody when neither is set. */
async function allowed(ctx: PluginContext, user: string): Promise<boolean> {
  if (list(ctx.settings[SLACK_APP_SETTINGS.allowedUsers]).some(id => id.toUpperCase() === user)) return true;
  const group = text(ctx.settings[SLACK_APP_SETTINGS.allowedUserGroup]).toUpperCase();
  if (!group) return false;
  if (!USER_GROUP_ID.test(group)) {
    ctx.log.warn('The allowed user group setting is not a Slack user group ID (S…); only the listed users may start tasks');
    return false;
  }
  try {
    return (await userGroupMembers(ctx, group)).some(id => id.toUpperCase() === user);
  } catch (error) {
    if (error instanceof SlackApiError && error.permanent) {
      ctx.log.warn('Slack refused the user group lookup; only the listed users may start tasks', { code: error.code });
      return false;
    }
    throw deliveryFailure(error, 'the user group lookup');
  }
}

/** A reply in the thread. A refusal Slack gives (the bot left the channel) is logged; anything that may succeed later fails the delivery. */
async function reply(ctx: PluginContext, channel: string, threadTs: string, message: string, what: string): Promise<boolean> {
  try {
    await postMessage(ctx, channel, { text: message }, threadTs);
    return true;
  } catch (error) {
    if (error instanceof SlackApiError && error.permanent) {
      ctx.log.warn(`Slack refused ${what}`, { code: error.code });
      return false;
    }
    throw deliveryFailure(error, what);
  }
}

/** `ctx.propr.createIssue` refusals that prove no issue was created. */
const NOT_CREATED = new Set(['permission_denied', 'repository_not_allowed', 'invalid_input', 'not_found']);

const createdReply = (repository: string, number: number, url: string | undefined, label: string) => {
  const name = `${repository}#${number}`;
  const linked = url && /^https:\/\//.test(url) ? `<${slackEscape(url)}|${slackEscape(name)}>` : slackEscape(name);
  return `:memo: Created issue ${linked} with the \`${slackEscape(label)}\` label; ProPR starts a task for it. Updates about its pull request will follow in this thread.`;
};

/** Handle one verified Events API request. */
export async function handleSlackEvent(input: PluginWebhookInput, ctx: PluginContext): Promise<MentionResult> {
  let envelope: SlackEnvelope;
  try { envelope = JSON.parse(input.body) as SlackEnvelope; } catch { return result('ignored', 'not_json'); }
  if (!envelope || typeof envelope !== 'object' || envelope.type !== 'event_callback') return result('ignored', 'not_an_event');
  const event = envelope.event;
  if (!event || event.type !== 'app_mention') return result('ignored', 'not_a_mention');

  const authorizations = Array.isArray(envelope.authorizations) ? envelope.authorizations : [];
  const bot = (authorizations.find(a => a?.is_bot === true) ?? authorizations[0])?.user_id;
  const botUserId = typeof bot === 'string' && USER_ID.test(bot) ? bot : null;
  const user = typeof event.user === 'string' ? event.user.toUpperCase() : '';
  // A bot's message (this app's own included), an edit or any other subtype is never a request; nothing is replied.
  if (event.bot_id !== undefined || event.subtype !== undefined || !USER_ID.test(user) || user === botUserId) return result('ignored', 'bot_message');
  const channel = typeof event.channel === 'string' ? event.channel.toUpperCase() : '';
  const ts = typeof event.ts === 'string' ? event.ts : '';
  if (!CHANNEL_ID.test(channel) || !MESSAGE_TS.test(ts)) return result('ignored', 'not_a_message');
  const threadTs = typeof event.thread_ts === 'string' && MESSAGE_TS.test(event.thread_ts) ? event.thread_ts : ts;
  const message = `${channel}:${ts}`;
  // Too old for a retry of a mention ProPR could have handled: its record may be gone, so it must not reach creation. Nothing is replied.
  if (mentionExpired(ts, input.receivedAt)) {
    ctx.log.info('Ignored a Slack mention older than the retry window');
    return result('ignored', 'expired');
  }

  const seen = await readMention(ctx, message);
  if (seen) {
    // The same Slack message again (a retry of the event): no second issue. A reply the first attempt did not get to is posted now.
    if (seen.s === 'created' && seen.r && seen.n) {
      if (await reply(ctx, channel, threadTs, createdReply(seen.r, seen.n, seen.u, triggerLabel(ctx.settings)), 'the reply with the issue link')) await writeMention(ctx, { ...seen, s: 'replied' });
    }
    return result('duplicate', seen.s, seen.r ?? null, seen.n ?? null);
  }

  if (!(await allowed(ctx, user))) {
    await reply(ctx, channel, threadTs, `Sorry <@${user}>, only people on this workspace's ProPR allow-list can start tasks from Slack. Ask your ProPR administrator if you need access.`, 'the refusal');
    await writeMention(ctx, { m: message, s: 'refused' });
    ctx.log.info('Refused a mention from a user who is not on the allow-list');
    return result('refused', 'not_allowed');
  }
  const repositories = channelRepositories(ctx.settings, channel);
  if (repositories.length !== 1) {
    const why = repositories.length ? 'is connected to several repositories, so ProPR cannot tell which one you mean' : 'is not connected to a repository';
    await reply(ctx, channel, threadTs, `This channel ${why}. Ask your ProPR administrator to map it to one repository in the Slack plugin's Repository channels setting.`, 'the reply');
    await writeMention(ctx, { m: message, s: 'ignored' });
    return result('ignored', repositories.length ? 'ambiguous_channel' : 'unmapped_channel');
  }
  const [repository] = repositories;
  const plain = slackPlainText(typeof event.text === 'string' ? event.text : '', botUserId);
  const title = issueTitle(plain);
  if (!title) {
    await reply(ctx, channel, threadTs, 'Mention me with what you want done, for example: `@ProPR Fix the redirect after login`. The first line becomes the issue title.', 'the reply');
    await writeMention(ctx, { m: message, s: 'ignored' });
    return result('ignored', 'empty_request');
  }
  const label = triggerLabel(ctx.settings);
  const link = await permalink(ctx, channel, ts);

  if (!(await writeMention(ctx, { m: message, s: 'pending', r: repository }))) {
    // No room to remember this mention without forgetting one that still stands for an issue: it is taken in later instead.
    ctx.log.warn('Too many recent Slack mentions are remembered to take in another one now; it is retried later');
    throw new PluginDeliveryError('Too many recent Slack mentions to take in another one now; it is retried later', { retryAfterMs: 10 * 60_000 });
  }
  let created: { number: number; url: string };
  try {
    created = await ctx.propr.createIssue(repository, { title, body: issueBody(plain, link), labels: [label] });
  } catch (error) {
    if (error instanceof PluginSdkError && NOT_CREATED.has(error.code)) {
      await deleteMention(ctx, message);
      await reply(ctx, channel, threadTs, `ProPR could not create an issue in ${slackEscape(repository)} (${error.code}). Ask your ProPR administrator to check the Slack plugin's repositories and permissions.`, 'the reply');
      await writeMention(ctx, { m: message, s: 'refused', r: repository });
      throw new PluginDeliveryError(`The issue was not created in ${repository}: ${error.message}`, { permanent: true });
    }
    // The issue may have been created: a retry must not create a second one.
    throw new PluginDeliveryError(`Creating the issue in ${repository} failed and it may have been created anyway; it is not retried, so a request creates at most one issue. Check the repository`, { permanent: true });
  }
  await writeMention(ctx, { m: message, s: 'created', r: repository, n: created.number, u: created.url });
  await rememberThread(ctx, repository, created.number, 'issue', channel, threadTs);
  ctx.log.info(`Created issue #${created.number} in ${repository} from a Slack mention`, { repository, issue: created.number });
  if (await reply(ctx, channel, threadTs, createdReply(repository, created.number, created.url, label), 'the reply with the issue link')) {
    await writeMention(ctx, { m: message, s: 'replied', r: repository, n: created.number, u: created.url });
  }
  return result('created', null, repository, created.number);
}
