import { definePluginHandler, type PluginEventInput, type PluginSettingOptions, type PluginSettingOptionsInput, type PluginWebhookInput } from '@propr/shared';
import { handleJiraWebhook, type IntakeResult } from './intake.js';
import { settingOptions } from './settings.js';
import { syncJiraTicket, type SyncResult } from './sync.js';

/**
 * Jira Cloud. Every exported function of this module is a handler.
 *
 * - `onJiraWebhook`: a verified Jira webhook request; a ticket that gets the
 *   trigger label in a mapped project creates one GitHub issue.
 * - `syncBack`: a ProPR event about a ticket handed over; comments on it and
 *   moves it to the configured status, as the settings switch on.
 * - `projectOptions`, `stateOptions`: the choices of the configure form's
 *   `optionsFrom` settings, from Jira's REST API.
 */
export const onJiraWebhook = definePluginHandler<PluginWebhookInput, IntakeResult>((input, ctx) => handleJiraWebhook(input, ctx));

export const syncBack = definePluginHandler<PluginEventInput, SyncResult>((input, ctx) => syncJiraTicket(input, ctx));

export const projectOptions = definePluginHandler<PluginSettingOptionsInput, PluginSettingOptions>((input, ctx) => settingOptions('projectOptions', input, ctx));
export const stateOptions = definePluginHandler<PluginSettingOptionsInput, PluginSettingOptions>((input, ctx) => settingOptions('stateOptions', input, ctx));
