import { useState } from 'react';
import type { ExtensionLibraryRevision } from '@propr/shared';
import { extensionLibraryHistory, validateExtensionLibrary } from '../../api/extensionProfilesApi';
import { SettingsSection } from './SettingsLayout';
import { AgentExtensionsDescription } from './AgentExtensionsGuide';
import { ExtensionServersList } from './extensions/ExtensionServersList';
import { ExtensionSkillsList } from './extensions/ExtensionSkillsList';
import { buttonClass } from './extensions/extensionUi';
import { useExtensionLibrary, type ExtensionLibraryState } from './extensions/useExtensionLibrary';

const describeValidation = (results: Awaited<ReturnType<typeof validateExtensionLibrary>>['results']) =>
  results.map(r => `${r.name}: ${r.status === 'not_validated' || r.reachable === null ? 'not tested' : r.reachable ? 'reachable' : 'not reachable'}`)
    .join(' · ') || 'No enabled MCP servers.';
const formatDate = (at: string | number) => new Date(at).toLocaleString();

/** Placeholder rows while the library loads. */
const LibrarySkeleton = () => (
  <div data-testid="extension-library-skeleton" aria-busy="true" aria-label="Loading skills and MCP servers" className="space-y-3 rounded-lg border border-slate-200 p-3 sm:p-5">
    {['h-4 w-2/5', 'h-12 w-full', 'h-12 w-full', 'h-4 w-1/3', 'h-12 w-full'].map((size, index) => (
      <div key={index} className={`animate-pulse rounded bg-slate-200/70 ${size}`} />
    ))}
  </div>
);

/** Connection test, reload and the revision history (when the library changed, and who changed it). */
function LibraryTools({ state, library }: { state: ExtensionLibraryState; library: ExtensionLibraryRevision }) {
  const [history, setHistory] = useState<ExtensionLibraryRevision[]>([]);
  const [busy, setBusy] = useState(false);
  const run = (work: () => Promise<void>) => {
    setBusy(true); state.setError(''); state.setNotice('');
    void work().catch(e => state.setError((e as Error).message)).finally(() => setBusy(false));
  };
  return (
    <div className="space-y-3 border-t border-slate-200 pt-4">
      <div className="flex flex-wrap gap-2">
        <button type="button" className={buttonClass} disabled={busy} onClick={() => run(async () => { await state.reload(); setHistory([]); state.setNotice('Library reloaded.'); })}>Reload</button>
        {library.revision > 0 && (
          <>
            <button type="button" className={buttonClass} disabled={busy}
              onClick={() => run(async () => state.setNotice(describeValidation((await validateExtensionLibrary()).results)))}>Test connections</button>
            <button type="button" className={buttonClass} disabled={busy}
              onClick={() => run(async () => setHistory((await extensionLibraryHistory()).revisions))}>Revision history</button>
          </>
        )}
      </div>
      {history.length > 0 && (
        <ul aria-label="Revision history" className="space-y-1 text-[12px] leading-5 text-slate-600">
          {history.map(revision => (
            <li key={revision.revision}>{formatDate(revision.updatedAt)} · {revision.auditActor}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Instance Settings → Skills & MCP servers: the extension library as two flat lists. */
export default function AgentExtensionsSection() {
  const state = useExtensionLibrary();
  const { library } = state;
  return (
    <SettingsSection title="Skills & MCP servers" description={<AgentExtensionsDescription />}>
      <div className="max-w-4xl space-y-5">
        {state.error && <p role="alert" className="rounded-md bg-red-50 p-3 text-sm text-red-800">{state.error}</p>}
        {state.notice && <p role="status" className="text-sm text-teal-800">{state.notice}</p>}
        {!library && !state.error && <LibrarySkeleton />}
        {library && (
          <div className="space-y-6 rounded-lg border border-slate-200 bg-slate-50/50 p-3 sm:p-5">
            <p data-testid="extension-library-status" data-revision={library.revision} className="text-[12px] leading-5 text-slate-500">
              {library.revision > 0 && `Last changed ${formatDate(library.updatedAt)}. `}Changes apply to new runs.
            </p>
            {/* Reloading remounts the lists, closing forms opened on the earlier settings. */}
            <ExtensionServersList key={`servers-${state.loads}`} state={state} />
            <ExtensionSkillsList key={`skills-${state.loads}`} state={state} />
            <LibraryTools state={state} library={library} />
          </div>
        )}
      </div>
    </SettingsSection>
  );
}
