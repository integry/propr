import { useCallback, useEffect, useRef, useState } from 'react';
import { getExtensionLibrary } from '../../api/extensionProfilesApi';
import {
  approvePlugin, disconnectPluginOAuth, getPlugin, installPlugin, setPluginConnection, setPluginEnabled, setPluginRepositories, setPluginSettings,
  startPluginOAuth, uninstallPlugin, type PluginView,
} from '../../api/pluginsApi';

/** The sign-in result page posts on this channel when the API shares the page's origin. */
const OAUTH_CHANNEL = 'propr-extension-oauth';
/** Connect stays available when the redirect URI could not be read; the API then explains a refusal. */
const UNKNOWN_REDIRECT = 'unknown';

/** Where a refusal is shown: settings refusals go next to their fields, uninstall refusals in its confirmation. */
type Area = 'general' | 'settings' | 'uninstall';
const NO_ERRORS: Record<Area, string> = { general: '', settings: '', uninstall: '' };
const message = (error: unknown) => (error instanceof Error ? error.message : 'Plugin operation unavailable.');

/** The redirect URI of the extension OAuth sign-in, read only when the plugin has an OAuth connection. */
function useRedirectUri(view: PluginView | null) {
  const needed = Boolean(view?.installation && view.connections.some(c => c.type === 'oauth'));
  const [redirectUri, setRedirectUri] = useState<string | null>(UNKNOWN_REDIRECT);
  useEffect(() => {
    if (!needed) return;
    let active = true;
    void getExtensionLibrary().then(result => { if (active && result.oauth) setRedirectUri(result.oauth.redirectUri); }).catch(() => {});
    return () => { active = false; };
  }, [needed]);
  return redirectUri;
}

/** Load one plugin and run each step's action, keeping the latest plugin read. */
export function usePluginDetail(id: string) {
  const [view, setView] = useState<PluginView | null>(null);
  const [loadError, setLoadError] = useState('');
  const [errors, setErrors] = useState<Record<Area, string>>(NO_ERRORS);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [oauthBusy, setOAuthBusy] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  const current = useRef(id);
  current.current = id;

  // Every read and every mutation boundary takes the next number; a read applies only while it is still the latest,
  // so a read started before (or during) a mutation never replaces the state that mutation returned.
  const sequence = useRef(0);
  // One plugin mutation at a time, claimed synchronously so a second click cannot start before the re-render.
  const mutating = useRef(false);

  const reload = useCallback(async () => {
    const at = ++sequence.current;
    const latest = () => current.current === id && sequence.current === at && !mutating.current;
    try {
      const { plugin } = await getPlugin(id);
      if (latest()) { setView(plugin); setLoadError(''); }
    } catch (error) { if (latest()) setLoadError(message(error)); }
  }, [id]);
  useEffect(() => { setView(null); setLoadError(''); void reload(); }, [reload]);

  // Refresh after a sign-in in another tab: on focus, on return to the tab, or when the result page posts.
  useEffect(() => {
    if (!signingIn) return;
    const refresh = () => { if (document.visibilityState !== 'hidden') void reload(); };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(OAUTH_CHANNEL);
    if (channel) channel.onmessage = refresh;
    return () => { window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh); channel?.close(); };
  }, [signingIn, reload]);

  const run = useCallback(async (work: () => Promise<{ plugin: PluginView }>, done: string, area: Area = 'general') => {
    if (mutating.current) return false;
    mutating.current = true; sequence.current += 1;
    setBusy(true); setErrors(NO_ERRORS); setNotice('');
    let failed = false;
    try {
      const { plugin } = await work();
      setView(plugin); setNotice(done);
      return true;
    } catch (error) {
      failed = true;
      setErrors(values => ({ ...values, [area]: message(error) }));
      return false;
    } finally {
      // Reads that started before or during the mutation are now stale.
      sequence.current += 1; mutating.current = false;
      setBusy(false);
      // A refused mutation returns no plugin: read the current state again instead of keeping a dropped read's gap.
      if (failed) void reload();
    }
  }, [reload]);

  /** Open the provider's sign-in page in a new tab, inside the click so it is not blocked, detached from this page. */
  const connectOAuth = useCallback(async (name: string) => {
    const tab = window.open('', '_blank');
    if (tab) tab.opener = null;
    setOAuthBusy(name); setErrors(NO_ERRORS); setNotice('');
    try {
      const { authorizationUrl } = await startPluginOAuth(id, name);
      if (tab) tab.location.href = authorizationUrl; else window.open(authorizationUrl, '_blank', 'noopener,noreferrer');
      setSigningIn(true);
      setNotice('Finish signing in in the new tab. This page refreshes when you come back.');
    } catch (error) {
      tab?.close();
      setErrors(values => ({ ...values, general: `The sign-in could not start: ${message(error)}` }));
    } finally { setOAuthBusy(null); }
  }, [id]);
  const disconnectOAuth = useCallback(async (name: string) => {
    if (mutating.current) return;
    setOAuthBusy(name);
    try { await run(() => disconnectPluginOAuth(id, name), 'Disconnected. Its stored tokens were deleted.'); } finally { setOAuthBusy(null); }
  }, [id, run]);

  return {
    view, loadError, errors, notice, busy, reload,
    redirectUri: useRedirectUri(view),
    // Another plugin mutation also holds the OAuth controls, so a disconnect cannot race it.
    oauthBusy: (name: string) => busy || oauthBusy === name,
    connectOAuth, disconnectOAuth,
    install: (acknowledged: string[]) => run(() => installPlugin(id, acknowledged), 'Installed. Connect it, then enable it.'),
    approve: (acknowledged: string[]) => run(() => approvePlugin(id, acknowledged), 'Approved.'),
    setSecret: (name: string, value: string | null) => run(() => setPluginConnection(id, name, value), value === null ? 'Connection cleared.' : 'Connection saved.'),
    setSettings: (settings: Parameters<typeof setPluginSettings>[1]) => run(() => setPluginSettings(id, settings), 'Settings saved.', 'settings'),
    setRepositories: (repositories: string[]) => run(() => setPluginRepositories(id, repositories), 'Repository limit saved.'),
    setEnabled: (enabled: boolean) => run(() => setPluginEnabled(id, enabled), enabled ? 'Enabled.' : 'Disabled. Its settings and connections are kept.'),
    uninstall: () => run(() => uninstallPlugin(id), 'Uninstalled.', 'uninstall'),
  };
}
