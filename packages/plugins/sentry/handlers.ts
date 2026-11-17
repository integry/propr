import { definePluginHandler, type PluginEventInput, type PluginSettingOptions, type PluginSettingOptionsInput, type PluginWebhookInput } from '@propr/shared';
import { handleSentryWebhook, type IntakeResult } from './intake.js';
import { settingOptions } from './settings.js';
import { syncSentryIssue, type SyncResult } from './sync.js';

/**
 * Sentry. Every exported function of this module is a handler.
 *
 * - `onSentryWebhook`: a verified Sentry webhook request; an error of a
 *   mapped project creates one GitHub issue.
 * - `syncBack`: a ProPR event about a Sentry issue handed over; when its pull
 *   request merges, a note on the Sentry issue and optionally resolving it.
 * - `projectOptions`: the choices of Repository projects, from Sentry's API.
 */
export const onSentryWebhook = definePluginHandler<PluginWebhookInput, IntakeResult>((input, ctx) => handleSentryWebhook(input, ctx));

export const syncBack = definePluginHandler<PluginEventInput, SyncResult>((input, ctx) => syncSentryIssue(input, ctx));

export const projectOptions = definePluginHandler<PluginSettingOptionsInput, PluginSettingOptions>((input, ctx) => settingOptions(input, ctx));
