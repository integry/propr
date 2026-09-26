import { useCallback, useSyncExternalStore } from 'react';
import { API_BASE_URL, getDesktopConnectionScope, subscribeDesktopConnectionScope } from '../api/apiClient';
import { isDesktopRuntime } from '../config/runtimeMode';
import { useCurrentUser } from '../contexts/AuthContext';
import { useDesktop, type DesktopContextValue } from '../desktop/DesktopContext';
import { browserVoicePreferenceKey, voicePreferenceKey } from '../voice/voicePreferenceKey';

const CHANGE_EVENT = 'propr:voice-preference';
const failedDisables = new Set<string>();

export function readVoicePreference(key: string | null): boolean {
  if (!key || failedDisables.has(key)) return false;
  try { return localStorage.getItem(key) === 'true'; } catch { return false; }
}

export function subscribeVoicePreference(listener: () => void): () => void {
  window.addEventListener(CHANGE_EVENT, listener);
  window.addEventListener('storage', listener);
  return () => {
    window.removeEventListener(CHANGE_EVENT, listener);
    window.removeEventListener('storage', listener);
  };
}

export function saveVoicePreference(key: string, enabled: boolean): void {
  // A failed write must still stop voice immediately for this session.
  if (!enabled) failedDisables.add(key);
  try {
    localStorage.setItem(key, String(enabled));
    failedDisables.delete(key);
  } finally {
    window.dispatchEvent(new Event(CHANGE_EVENT));
  }
}

/** The instance a browser or installed PWA is signed in to, however it was configured. */
function activeInstanceUrl(): string {
  return API_BASE_URL || window.location.origin;
}

function desktopScopeKey(
  desktop: DesktopContextValue | null,
  connection: ReturnType<typeof getDesktopConnectionScope>,
  userId: string,
): string | null {
  return desktop && connection
    && connection.profileId === desktop.profile.id
    && desktop.connection.status === 'ready'
    && connection.transportScope === desktop.connection.transportScope
    ? voicePreferenceKey(desktop.profile.id, desktop.profile.baseUrl, userId)
    : null;
}

/**
 * Voice Briefings are experimental, so every runtime keeps them off until the
 * signed-in user opts in. Like other local UI preferences the choice stays on
 * this device; never inherit a disclosure acknowledgement, another account's
 * opt-in, or a choice made against a different instance.
 */
export function useVoicePreference() {
  const desktop = useDesktop();
  const user = useCurrentUser();
  const connection = useSyncExternalStore(subscribeDesktopConnectionScope, getDesktopConnectionScope);
  // Republished with the connection scope, so a switched hosted tunnel or
  // desktop profile resolves that instance's own stored choice.
  const instanceUrl = useSyncExternalStore(subscribeDesktopConnectionScope, activeInstanceUrl);
  const key = !user
    ? null
    : isDesktopRuntime()
      ? desktopScopeKey(desktop, connection, user.id)
      : browserVoicePreferenceKey(instanceUrl, user.id);
  const isEnabled = useCallback(
    () => connection === getDesktopConnectionScope() && readVoicePreference(key),
    [connection, key],
  );
  const enabled = useSyncExternalStore(subscribeVoicePreference, isEnabled);
  const setEnabled = (next: boolean) => {
    if (key && connection === getDesktopConnectionScope()) saveVoicePreference(key, next);
  };
  return { enabled, isEnabled, setEnabled, available: key !== null, key, connection };
}
