import type { PluginJsonValue } from '@propr/shared';
import type { ChatService } from '../_shared/chatDelivery.js';
import type { Notification, NotificationTone } from '../_shared/notifications.js';

/**
 * Discord webhook messages: one embed with the title, linked to the pull
 * request (or the first link), the facts as inline fields and the links in
 * its description. Mentions are disabled. See
 * https://docs.discord.com/developers/resources/webhook#execute-webhook and
 * https://docs.discord.com/developers/resources/message#embed-object-embed-limits.
 */

const TONE_COLORS: Record<NotificationTone, number> = { success: 0x2e7d32, failure: 0xc62828, warning: 0xf9a825, info: 0x546e7a };
/** Discord's inline markdown characters, escaped with a backslash. */
export const discordEscape = (text: string) => text.replace(/([\\*_~`|>[\]])/g, '\\$1');
/** Embed limits: a title of 256 characters, at most 25 fields. */
const LIMITS = { title: 256, fields: 25 } as const;

export function discordMessage(notification: Notification): PluginJsonValue {
  const [first] = notification.links;
  const embed: Record<string, PluginJsonValue> = {
    title: notification.title.slice(0, LIMITS.title),
    color: TONE_COLORS[notification.tone],
    fields: notification.facts.slice(0, LIMITS.fields).map(f => ({ name: f.label, value: discordEscape(f.value), inline: true })),
  };
  if (first) embed.url = first.url;
  if (notification.links.length) embed.description = notification.links.map(l => `[${discordEscape(l.label)}](${l.url})`).join(' · ');
  return { username: 'ProPR', allowed_mentions: { parse: [] }, embeds: [embed] };
}

function json(body: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(body);
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch { return null; }
}

/** Discord answers an error with `{ "code": 10015, "message": "Unknown Webhook" }`. */
function discordErrorDetail(_status: number, body: string): string | null {
  const error = json(body);
  if (!error) return null;
  const code = typeof error.code === 'number' && Number.isSafeInteger(error.code) ? error.code : null;
  const message = typeof error.message === 'string' && /^[A-Za-z0-9 .,'()-]{1,80}$/.test(error.message) ? error.message : null;
  if (code === null && message === null) return null;
  return [message, code !== null ? `code ${code}` : null].filter(Boolean).join(', ');
}

/** A 429's `retry_after` (seconds, possibly fractional) in the body. */
function discordRetryAfter(body: string): number | null {
  const value = json(body)?.retry_after;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.ceil(value * 1000) : null;
}

export const DISCORD: ChatService = {
  name: 'Discord',
  destinations: [
    { connection: 'default-webhook', label: 'the default webhook' },
    { connection: 'webhook-2', label: 'webhook 2' },
    { connection: 'webhook-3', label: 'webhook 3' },
    { connection: 'webhook-4', label: 'webhook 4' },
  ],
  render: discordMessage,
  errorDetail: discordErrorDetail,
  retryAfterFromBody: discordRetryAfter,
};
