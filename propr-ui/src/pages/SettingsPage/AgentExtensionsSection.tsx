import { useState } from 'react';
import type { ExtensionLibraryRevision } from '@propr/shared';
import { extensionLibraryHistory, validateExtensionLibrary } from '../../api/extensionProfilesApi';
import { SettingsSection } from './SettingsLayout';
import { AgentExtensionsDescription, AgentExtensionsExplanation } from './AgentExtensionsGuide';
import { ExtensionServersList } from './extensions/ExtensionServersList';
import { ExtensionSkillsList } from './extensions/ExtensionSkillsList';
import { buttonClass } from './extensions/extensionUi';
import { useExtensionLibrary, type ExtensionLibraryState } from './extensions/useExtensionLibrary';

const describeValidation = (results: Awaited<ReturnType<typeof validateExtensionLibrary>>['results']) =>
  results.map(r => `${r.name}: ${r.status === 'not_validated' || r.reachable === null ? 'not validated' : r.reachable ? 'reachable' : 'unavailable'}`)
    .join(' · ') || 'No enabled MCP servers.';

/** Connectivity validation, reload and the revision history (who changed the library, when). */
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
              onClick={() => run(async () => state.setNotice(describeValidation((await validateExtensionLibrary()).results)))}>Validate saved MCP connectivity</button>
            <button type="button" className={buttonClass} disabled={busy}
              onClick={() => run(async () => setHistory((await extensionLibraryHistory()).revisions))}>Revision history</button>
          </>
        )}
      </div>
      {history.length > 0 && (
        <ul aria-label="Revision history" className="space-y-2 text-xs text-slate-600">
          {history.map(revision => (
            <li key={revision.revision}>
              Revision {revision.revision} · {new Date(revision.updatedAt).toLocaleString()} · administrator {revision.auditActor} · {revision.servers.length} servers · {revision.skills.length} skills
            </li>
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
        {!library && !state.error && <p className="text-sm text-slate-500">Loading the extension library…</p>}
        {library && (
          <div className="space-y-6 rounded-lg border border-slate-200 bg-slate-50/50 p-3 sm:p-5">
            <div className="space-y-2">
              <AgentExtensionsExplanation />
              <p className="text-xs text-slate-500">
                {library.revision > 0 ? `Revision ${library.revision} · updated ${new Date(library.updatedAt).toLocaleString()}.` : 'Nothing saved yet.'}
                {' '}Changes apply to new runs at once; running tasks keep the items they started with.
              </p>
            </div>
            <ExtensionServersList state={state} />
            <ExtensionSkillsList state={state} />
            <LibraryTools state={state} library={library} />
          </div>
        )}
      </div>
    </SettingsSection>
  );
}
