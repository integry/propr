import { definePluginHandler, type PluginEventInput, type PluginSettingOptionsInput, type PluginSettingOptionsResult, type PluginWebhookInput } from '@propr/shared';
import { handleLinearWebhook, type IntakeResult } from './intake.js';
import { teamAndProjectOptions, workflowStateOptions } from './options.js';
import { syncTicket, type SyncResult } from './sync.js';

/**
 * Linear. Every exported function of this module is a handler.
 *
 * - `onLinearWebhook`: a verified Linear webhook; adding the trigger label to
 *   a mapped ticket creates one GitHub issue for it.
 * - `sync`: ProPR's progress on a ticket's issue and pull request, posted
 *   back to the ticket as the settings switch on.
 * - `teamOptions`, `stateOptions`: the configure form's choices (`optionsFrom`).
 */
export const onLinearWebhook = definePluginHandler<PluginWebhookInput, IntakeResult>((input, ctx) => handleLinearWebhook(input, ctx));

export const sync = definePluginHandler<PluginEventInput, SyncResult>((input, ctx) => syncTicket(input, ctx));

export const teamOptions = definePluginHandler<PluginSettingOptionsInput, PluginSettingOptionsResult>((_input, ctx) => teamAndProjectOptions(ctx));

export const stateOptions = definePluginHandler<PluginSettingOptionsInput, PluginSettingOptionsResult>((_input, ctx) => workflowStateOptions(ctx));
