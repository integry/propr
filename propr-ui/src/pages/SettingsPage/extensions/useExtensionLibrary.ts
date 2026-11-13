import { useCallback, useEffect, useRef, useState } from 'react';
import type { ExtensionCatalogEntry, ExtensionLibraryRevision, ExtensionLibraryServer, ExtensionLibrarySkill, ExtensionLibraryUsage, ExtensionSkillBundle, InstanceCatalogResponse } from '@propr/shared';
import { getExtensionLibrary, saveExtensionLibrary, setExtensionItemEnabled, type ExtensionItemRef } from '../../../api/extensionProfilesApi';
import { getInstanceCatalog } from '../../../api/proprApi';
import { EMPTY_USAGE, extensionChoices, itemRefKey, type ExtensionChoices } from './extensionUi';

export type LibraryItems = { servers: ExtensionLibraryServer[]; skills: ExtensionLibrarySkill[] };

/**
 * The saved extension library and its operations. Every change is saved at
 * once against the revision last seen: an item form, a removal, or the
 * single-item enable switch, which shows the requested state while in flight
 * and falls back to the saved state when it fails.
 */
export function useExtensionLibrary() {
  const [library, setLibrary] = useState<ExtensionLibraryRevision>();
  const [catalog, setCatalog] = useState<ExtensionCatalogEntry[]>([]);
  const [bundles, setBundles] = useState<ExtensionSkillBundle[]>([]);
  const [usage, setUsage] = useState<ExtensionLibraryUsage>(EMPTY_USAGE);
  const [choices, setChoices] = useState<ExtensionChoices>(() => extensionChoices({ agents: [], repositories: [] }));
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const current = useRef<ExtensionLibraryRevision | undefined>(undefined);
  const adopt = useCallback((next: ExtensionLibraryRevision) => { current.current = next; setLibrary(next); }, []);
  const reload = useCallback(async () => {
    const result = await getExtensionLibrary();
    adopt(result.library);
    setCatalog(result.catalog ?? []);
    setBundles(result.bundles ?? []);
    setUsage(result.usage ?? EMPTY_USAGE);
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
    }).catch(e => { if (active) setError((e as Error).message); });
    return () => { active = false; };
  }, [adopt]);

  /** Save the library with `change` applied to the latest saved items; errors are thrown to the caller. */
  const save = useCallback(async (change: (items: LibraryItems) => LibraryItems, secrets: Record<string, string | null> = {}) => {
    const base = current.current;
    if (!base) throw new Error('The extension library is not loaded yet.');
    const next = change({ servers: base.servers, skills: base.skills });
    const result = await saveExtensionLibrary({ version: 1, servers: next.servers, skills: next.skills }, base.revision, secrets);
    adopt(result.library);
    setError('');
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

  const addBundle = useCallback((bundle: ExtensionSkillBundle) =>
    setBundles(items => [...items.filter(existing => existing.id !== bundle.id), bundle]), []);
  /** The checkbox state of an item: the requested state while its toggle is in flight. */
  const shownEnabled = (ref: ExtensionItemRef, saved: boolean) => pending[itemRefKey(ref)] ?? saved;
  const isPending = (ref: ExtensionItemRef) => itemRefKey(ref) in pending;
  return { library, catalog, bundles, usage, choices, error, notice, setError, setNotice, reload, save, toggle, remove, addBundle, shownEnabled, isPending };
}
export type ExtensionLibraryState = ReturnType<typeof useExtensionLibrary>;
