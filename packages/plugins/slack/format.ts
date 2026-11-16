import type { PluginJsonValue } from '@propr/shared';
import type { ChatService } from '../_shared/chatDelivery.js';
import type { Notification, NotificationTone } from '../_shared/notifications.js';

/**
 * Slack incoming-webhook messages: a `text` fallback (shown in notifications)
 * and Block Kit blocks: a `section` with the title, a `section` of fields
 * for the facts and a `context` line of links. See
 * https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks
 * and https://docs.slack.dev/messaging/formatting-message-text.
 */

const TONE_EMOJI: Record<NotificationTone, string> = { success: ':white_check_mark:', failure: ':x:', warning: ':warning:', info: ':information_source:' };
/** Slack's control characters in mrkdwn text: `&`, `<` and `>` must be escaped. */
export const slackEscape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/** Section blocks take at most 10 fields. */
const MAX_FIELDS = 10;

export function slackMessage(notification: Notification): PluginJsonValue {
  const blocks: PluginJsonValue[] = [
    { type: 'section', text: { type: 'mrkdwn', text: `${TONE_EMOJI[notification.tone]} *${slackEscape(notification.title)}*` } },
  ];
  if (notification.facts.length) {
    blocks.push({ type: 'section', fields: notification.facts.slice(0, MAX_FIELDS).map(f => ({ type: 'mrkdwn', text: `*${slackEscape(f.label)}*\n${slackEscape(f.value)}` })) });
  }
  if (notification.links.length) {
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: notification.links.map(l => `<${slackEscape(l.url)}|${slackEscape(l.label)}>`).join('  ·  ') }] });
  }
  return { text: notification.title, blocks };
}

/** Slack answers an error with a plain-text code such as `channel_not_found` or `invalid_payload`. */
const slackErrorDetail = (_status: number, body: string): string | null => (/^[a-z_]{1,64}$/.test(body.trim()) ? body.trim() : null);

export const SLACK: ChatService = {
  name: 'Slack',
  destinations: [
    { connection: 'default-webhook', label: 'the default webhook' },
    { connection: 'webhook-2', label: 'webhook 2' },
    { connection: 'webhook-3', label: 'webhook 3' },
    { connection: 'webhook-4', label: 'webhook 4' },
  ],
  render: slackMessage,
  errorDetail: slackErrorDetail,
};
