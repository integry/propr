/**
 * Storage identity for the experimental Voice Briefings opt-in.
 *
 * This module stays dependency-free on purpose: the preference hook, its unit
 * tests, and the Playwright suite all derive the same device-local key without
 * importing React or any other application code.
 */

/**
 * Retained from the desktop-only release of this preference so an existing
 * desktop opt-in survives the rename instead of silently reverting to off.
 */
export const VOICE_PREFERENCE_STORAGE_PREFIX = 'propr.desktop.voice.experimental.v1';

/** Instance scope used by every non-desktop runtime (browser and installed PWA). */
export const BROWSER_VOICE_PREFERENCE_SCOPE = 'browser';

/**
 * Build the storage key for one account on one instance of this device.
 * `instanceId` is the desktop profile id, or `browser` in every other runtime.
 */
export function voicePreferenceKey(
  instanceId: string,
  baseUrl: string,
  userId: string,
): string {
  return `${VOICE_PREFERENCE_STORAGE_PREFIX}:${JSON.stringify([instanceId, baseUrl, userId])}`;
}

/** The browser-runtime key for the signed-in account on the active instance URL. */
export function browserVoicePreferenceKey(baseUrl: string, userId: string): string {
  return voicePreferenceKey(BROWSER_VOICE_PREFERENCE_SCOPE, baseUrl, userId);
}
