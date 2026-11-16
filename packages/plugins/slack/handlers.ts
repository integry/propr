import { definePluginHandler, type PluginEventInput } from '@propr/shared';
import { deliverChatNotification, type ChatDeliveryResult } from '../_shared/chatDelivery.js';
import { SLACK } from './format.js';

/**
 * Slack (incoming-webhook mode): each subscribed event the settings select is
 * posted to the default webhook URL, or to the one Repository destinations
 * names for its repository. Only `notify` is exported: every exported
 * function of this module is a handler.
 */
export const notify = definePluginHandler<PluginEventInput, ChatDeliveryResult>((input, ctx) => deliverChatNotification(SLACK, input, ctx));
