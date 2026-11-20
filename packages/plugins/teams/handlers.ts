import { definePluginHandler, type PluginEventInput } from '@propr/shared';
import { deliverChatNotification, type ChatDeliveryResult } from '../_shared/chatDelivery.js';
import { TEAMS } from './format.js';

/**
 * Microsoft Teams: each subscribed event the settings select is posted as an
 * Adaptive Card to the default Workflows webhook URL, or to the one
 * Repository destinations names for its repository. Only `notify` is
 * exported: every exported function of this module is a handler.
 */
export const notify = definePluginHandler<PluginEventInput, ChatDeliveryResult>((input, ctx) => deliverChatNotification(TEAMS, input, ctx));
