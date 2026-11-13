import { useCallback, useEffect, useRef, useState } from 'react';
import type { ExtensionCatalogEntry, ExtensionLibraryRevision, ExtensionLibraryServer, ExtensionLibrarySkill, ExtensionLibraryUsage, ExtensionOAuthInstanceInfo, ExtensionSkillBundle, InstanceCatalogResponse } from '@propr/shared';
import { disconnectExtensionOAuth, getExtensionLibrary, saveExtensionLibrary, setExtensionItemEnabled, startExtensionOAuth, type ExtensionItemRef } from '../../../api/extensionProfilesApi';
import { getInstanceCatalog } from '../../../api/proprApi';
import { EMPTY_USAGE, extensionChoices, itemRefKey, ownEntry, type ExtensionChoices } from './extensionUi';

export type LibraryItems = { servers: ExtensionLibraryServer[]; skills: ExtensionLibrarySkill[] };
const NO_OAUTH: ExtensionOAuthInstanceInfo = { redirectUri: null, clientMetadataUrl: null, connections: {} };
/** The sign-in result page posts on this channel when the API shares the Settings origin. */
const OAUTH_CHANNEL = 'propr-extension-oauth';

/**
 * The saved extension library and its operations. Every change is saved at
 * once against the revision last seen: an item form, a removal, or the
 * single-item enable switch, which shows the requested state while in flight
 * and falls back to the saved state when it fails. Responses can arrive out
 * of order (two switches in flight), so a snapshot older than the one already
 * shown is dropped. Each reload bumps `loads`, which closes open forms.
 */
export function useExtensionLibrary() {
  const [library, setLibrary] = useState<ExtensionLibraryRevision>();
  const [catalog, setCatalog] = useState<ExtensionCatalogEntry[]>([]);
  const [bundles, setBundles] = useState<ExtensionSkillBundle[]>([]);
  const [usage, setUsage] = useState<ExtensionLibraryUsage>(EMPTY_USAGE);
  const [oauth, setOAuth] = useState<ExtensionOAuthInstanceInfo>(NO_OAUTH);
  const oauthShown = useRef(oauth);
  oauthShown.current = oauth;
  /**
   * Servers whose sign-in tab is open, each with the `connectedAt` of the connection it had when the sign-in started
   * (null without one): their state is refreshed when this tab regains focus. A Reconnect starts from a connection that
   * is already `connected`, so a sign-in is finished only once a connection made after it started is shown.
   */
  const [signingIn, setSigningIn] = useState<Record<string, number | null>>({});
  const signingInCount = Object.keys(signingIn).length;
  const [oauthBusy, setOAuthBusy] = useState<Record<string, boolean>>({});
  const [choices, setChoices] = useState<ExtensionChoices>(() => extensionChoices({ agents: [], repositories: [] }));
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [loads, setLoads] = useState(0);
  const current = useRef<ExtensionLibraryRevision | undefined>(undefined);
  const adopt = useCallback((next: ExtensionLibraryRevision) => {
    if (current.current && next.revision < current.current.revision) return;
    current.current = next; setLibrary(next);
  }, []);
  const reload = useCallback(async () => {
    const result = await getExtensionLibrary();
    adopt(result.library);
    setLoads(count => count + 1);
    setCatalog(result.catalog ?? []);
    setBundles(result.bundles ?? []);
    setUsage(result.usage ?? EMPTY_USAGE);
    setOAuth(result.oauth ?? NO_OAUTH);
  }, [adopt]);
  useEffect(() => {
    let active = true;
    void getInstanceCatalog().then((result: InstanceCatalogResponse) => { if (active) setChoices(extensionChoices(result)); })
      .catch(() => { if (active) setChoices(extensionChoices({ agents: [], repositories: [] }, true)); });
    void getExtensionLibrary().then(result => {
      if (!active) return;
      adopt(result.library);
      setCatalog(result.catalog ?? []);
      setBundles(result.bundles ?? []);
      setUsage(result.usage ?? EMPTY_USAGE);
      setOAuth(result.oauth ?? NO_OAUTH);
    }).catch(e => { if (active) setError((e as Error).message); });
    return () => { active = false; };
  }, [adopt]);

  /** Save the library with `change` applied to the latest saved items; errors are thrown to the caller. */
  const save = useCallback(async (change: (items: LibraryItems) => LibraryItems, secrets: Record<string, string | null> = {}, acknowledgements: string[] = []) => {
    const base = current.current;
    if (!base) throw new Error('The extension library is not loaded yet.');
    const next = change({ servers: base.servers, skills: base.skills });
    const items = { version: 1 as const, servers: next.servers, skills: next.skills };
    const result = acknowledgements.length ? await saveExtensionLibrary(items, base.revision, secrets, acknowledgements) : await saveExtensionLibrary(items, base.revision, secrets);
    adopt(result.library);
    setError('');
    // A changed URL, authentication or client discards an OAuth connection: show the current state.
    if (next.servers.some(server => server.kind === 'https' && server.authentication === 'oauth') || base.servers.some(server => server.kind === 'https' && server.authentication === 'oauth')) {
      void getExtensionLibrary().then(read => setOAuth(read.oauth ?? NO_OAUTH)).catch(() => {});
    }
  }, [adopt]);

  const toggle = useCallback(async (ref: ExtensionItemRef, label: string, enabled: boolean) => {
    const key = itemRefKey(ref);
    setPending(values => ({ ...values, [key]: enabled }));
    setError(''); setNotice('');
    try {
      adopt((await setExtensionItemEnabled(ref, enabled)).library);
      setNotice(enabled ? `${label} switched on for new runs.` : `${label} switched off for new runs. Its settings are kept.`);
    } catch (e) {
      setError(`${label} could not be switched ${enabled ? 'on' : 'off'}: ${(e as Error).message}`);
    } finally {
      setPending(values => { const next = { ...values }; delete next[key]; return next; });
    }
  }, [adopt]);

  const remove = useCallback(async (ref: ExtensionItemRef, label: string) => {
    setError(''); setNotice('');
    try {
      await save(items => ({
        servers: items.servers.filter(server => ref.kind !== 'server' || server.name !== ref.name),
        skills: items.skills.filter(skill => ref.kind !== 'skill' || skill.bundleId !== ref.bundleId),
      }));
      setNotice(`${label} removed from the library.`);
    } catch (e) { setError((e as Error).message); }
  }, [save]);

  /** Re-read connection state without closing open forms. */
  const refreshConnections = useCallback(async () => {
    const result = await getExtensionLibrary();
    adopt(result.library);
    const next = result.oauth ?? NO_OAUTH;
    setOAuth(next);
    setSigningIn(names => {
      const open = Object.entries(names).filter(([name, before]) => {
        const connection = ownEntry(next.connections, name);
        return connection?.state !== 'connected' || connection.connectedAt === before;
      });
      return open.length === Object.keys(names).length ? names : Object.fromEntries(open);
    });
  }, [adopt]);
  useEffect(() => {
    if (!signingInCount) return;
    const refresh = () => { if (document.visibilityState !== 'hidden') void refreshConnections().catch(() => {}); };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(OAUTH_CHANNEL);
    if (channel) channel.onmessage = refresh;
    return () => { window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh); channel?.close(); };
  }, [signingInCount, refreshConnections]);

  /**
   * Open the provider's sign-in page in a new tab. The tab is opened at once,
   * inside the click, so it is not blocked; it is detached from this page
   * before it navigates to the provider.
   */
  const connectOAuth = useCallback(async (name: string) => {
    const tab = window.open('', '_blank');
    if (tab) tab.opener = null;
    const before = ownEntry(oauthShown.current.connections, name)?.connectedAt ?? null;
    setError(''); setNotice('');
    setOAuthBusy(values => ({ ...values, [name]: true }));
    try {
      const { authorizationUrl } = await startExtensionOAuth(name);
      if (tab) tab.location.href = authorizationUrl; else window.open(authorizationUrl, '_blank', 'noopener,noreferrer');
      setSigningIn(names => ({ ...names, [name]: before }));
      setNotice(`Finish signing in to ${name} in the new tab. This list refreshes when you come back.`);
    } catch (e) {
      tab?.close();
      setError(`${name} could not start a sign-in: ${(e as Error).message}`);
    } finally {
      setOAuthBusy(values => { const next = { ...values }; delete next[name]; return next; });
    }
  }, []);
  const disconnectOAuth = useCallback(async (name: string) => {
    setError(''); setNotice('');
    setOAuthBusy(values => ({ ...values, [name]: true }));
    try {
      const { revoked } = await disconnectExtensionOAuth(name);
      await refreshConnections();
      setNotice(revoked ? `${name} disconnected; the provider revoked its tokens.` : `${name} disconnected; its stored tokens were deleted.`);
    } catch (e) { setError(`${name} could not be disconnected: ${(e as Error).message}`); }
    finally { setOAuthBusy(values => { const next = { ...values }; delete next[name]; return next; }); }
  }, [refreshConnections]);

  const addBundle = useCallback((bundle: ExtensionSkillBundle) =>
    setBundles(items => [...items.filter(existing => existing.id !== bundle.id), bundle]), []);
  /** The checkbox state of an item: the requested state while its toggle is in flight. */
  const shownEnabled = (ref: ExtensionItemRef, saved: boolean) => pending[itemRefKey(ref)] ?? saved;
  const isPending = (ref: ExtensionItemRef) => itemRefKey(ref) in pending;
  return {
    library, loads, catalog, bundles, usage, choices, error, notice, setError, setNotice, reload, save, toggle, remove, addBundle, shownEnabled, isPending,
    oauth, connectOAuth, disconnectOAuth, refreshConnections, isOAuthBusy: (name: string) => Boolean(oauthBusy[name]),
  };
}
export type ExtensionLibraryState = ReturnType<typeof useExtensionLibrary>;
