import {
  definePluginHandler, definePluginWebhookResponder, type PluginEventInput, type PluginWebhookInput,
} from '@propr/shared';
import { deliverChatNotification, type ChatDeliveryResult } from '../_shared/chatDelivery.js';
import { deliverAppNotification } from './appDelivery.js';
import { SLACK } from './format.js';
import { SLACK_APP_SETTINGS, handleSlackEvent, slackChallengeResponse, type MentionResult } from './mentions.js';

/**
 * Slack. Every exported function of this module is a handler (or, for
 * `slackChallenge`, a webhook respond function).
 *
 * - `notify`: each subscribed event the settings select. In incoming-webhook
 *   mode (the default) it is posted to the default webhook URL, or to the one
 *   Repository destinations names for its repository; in app mode it is posted
 *   with the bot token to the repository's channel, one thread per pull request.
 * - `onSlackEvent`: a verified Events API request; a bot mention may create an issue.
 * - `slackChallenge`: answers Slack's URL verification challenge at once.
 */
export const notify = definePluginHandler<PluginEventInput, ChatDeliveryResult>((input, ctx) => (ctx.settings[SLACK_APP_SETTINGS.mode] === 'app'
  ? deliverAppNotification(input, ctx)
  : deliverChatNotification(SLACK, input, ctx)));

export const onSlackEvent = definePluginHandler<PluginWebhookInput, MentionResult>((input, ctx) => handleSlackEvent(input, ctx));

export const slackChallenge = definePluginWebhookResponder(slackChallengeResponse);
