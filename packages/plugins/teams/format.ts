import type { PluginJsonValue } from '@propr/shared';
import type { ChatService } from '../_shared/chatDelivery.js';
import type { Notification, NotificationTone } from '../_shared/notifications.js';

/**
 * Microsoft Teams Workflows webhook messages: a `message` with one Adaptive
 * Card attachment holding the title, a FactSet of the facts and an
 * `Action.OpenUrl` per link. See
 * https://learn.microsoft.com/en-us/microsoftteams/platform/webhooks-and-connectors/how-to/add-incoming-webhook
 * and https://learn.microsoft.com/en-us/microsoftteams/platform/webhooks-and-connectors/how-to/connectors-using.
 */

const TONE_COLORS: Record<NotificationTone, string> = { success: 'good', failure: 'attention', warning: 'warning', info: 'default' };
export const ADAPTIVE_CARD_CONTENT_TYPE = 'application/vnd.microsoft.card.adaptive';
/** Teams rejects messages over 28 KB; a card here is well under 2 KB. */
export const TEAMS_MESSAGE_LIMIT_BYTES = 28 * 1024;

export function teamsMessage(notification: Notification): PluginJsonValue {
  const body: PluginJsonValue[] = [
    { type: 'TextBlock', text: notification.title, weight: 'Bolder', size: 'Medium', wrap: true, color: TONE_COLORS[notification.tone] },
  ];
  if (notification.facts.length) body.push({ type: 'FactSet', facts: notification.facts.map(f => ({ title: f.label, value: f.value })) });
  return {
    type: 'message',
    attachments: [{
      contentType: ADAPTIVE_CARD_CONTENT_TYPE,
      contentUrl: null,
      content: {
        $schema: 'http://adaptivecards.io/schemas/adaptive-card.json', type: 'AdaptiveCard', version: '1.2',
        body,
        actions: notification.links.map(l => ({ type: 'Action.OpenUrl', title: l.label, url: l.url })),
      },
    }],
  };
}

/** A Workflows (Power Automate) error: `{ "error": { "code": "WorkflowNotFound", "message": "…" } }`. Only the code is repeated. */
function teamsErrorDetail(_status: number, body: string): string | null {
  try {
    const code = (JSON.parse(body) as { error?: { code?: unknown } })?.error?.code;
    return typeof code === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(code) ? code : null;
  } catch { return null; }
}

export const TEAMS: ChatService = {
  name: 'Teams',
  destinations: [
    { connection: 'default-webhook', label: 'the default webhook' },
    { connection: 'webhook-2', label: 'webhook 2' },
    { connection: 'webhook-3', label: 'webhook 3' },
    { connection: 'webhook-4', label: 'webhook 4' },
  ],
  render: teamsMessage,
  errorDetail: teamsErrorDetail,
};
