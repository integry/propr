import { definePluginHandler, type PluginEventInput, type PluginSettingOptions, type PluginSettingOptionsInput, type PluginWebhookInput } from '@propr/shared';
import { handleLinearWebhook, type IntakeResult } from './intake.js';
import { settingOptions } from './settings.js';
import { syncLinearTicket, type SyncResult } from './sync.js';

/**
 * Linear. Every exported function of this module is a handler.
 *
 * - `onLinearWebhook`: a verified Linear webhook request; a ticket that gets
 *   the trigger label in a mapped team or project creates one GitHub issue.
 * - `syncBack`: a ProPR event about a ticket handed over; comments on it and
 *   moves it to the configured state, as the settings switch on.
 * - `teamOptions`, `projectOptions`, `stateOptions`: the choices of the
 *   configure form's `optionsFrom` settings, from Linear's API.
 */
export const onLinearWebhook = definePluginHandler<PluginWebhookInput, IntakeResult>((input, ctx) => handleLinearWebhook(input, ctx));

export const syncBack = definePluginHandler<PluginEventInput, SyncResult>((input, ctx) => syncLinearTicket(input, ctx));

export const teamOptions = definePluginHandler<PluginSettingOptionsInput, PluginSettingOptions>((input, ctx) => settingOptions('teamOptions', input, ctx));
export const projectOptions = definePluginHandler<PluginSettingOptionsInput, PluginSettingOptions>((input, ctx) => settingOptions('projectOptions', input, ctx));
export const stateOptions = definePluginHandler<PluginSettingOptionsInput, PluginSettingOptions>((input, ctx) => settingOptions('stateOptions', input, ctx));
