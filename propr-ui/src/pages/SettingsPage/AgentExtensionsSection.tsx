/* eslint-disable max-lines -- profile editing and discovery share the same editor state and callbacks */
import { useEffect, useId, useState, type Dispatch, type SetStateAction } from 'react';
import type {
  InstanceCatalogResponse,
  ExtensionCatalogEntry,
  ExtensionMcpDescriptor,
  ExtensionProfileInput,
  ExtensionProfileRevision,
  ExtensionSelection,
  ExtensionSkillBundle,
} from '@propr/shared';
import {
  discoverExtensionTools,
  listGithubSkillRefs,
  resolveGithubSkillRef,
  type GithubSkillRef,
  deleteExtensionProfile,
  extensionProfileHistory,
  importArchiveSkill,
  importGithubSkill,
  listExtensionProfiles,
  saveExtensionProfile,
  validateExtensionProfile,
} from '../../api/extensionProfilesApi';
import { getInstanceCatalog } from '../../api/proprApi';
import { SettingsSection } from './SettingsLayout';
import { AgentExtensionsDescription } from './AgentExtensionsGuide';
const nextServerName = (servers: ExtensionMcpDescriptor[]) => {
  let number = 1;
  while (servers.some((server) => server.name === `server-${number}`)) number++;
  return `server-${number}`;
};
const blank = (): ExtensionProfileInput => ({
  version: 1,
  name: '',
  enabled: true,
  agentScope: [],
  repositoryScope: [],
  mcpServers: [],
  skillBundleIds: [],
});
const selection = (profile: ExtensionProfileRevision): ExtensionSelection => ({
  instanceId: profile.instanceId,
  profileId: profile.profileId,
  revision: profile.revision,
});
const inputClass =
  'mt-1 block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm';
const buttonClass =
  'rounded-md border border-slate-300 px-3 py-2 text-sm font-medium disabled:opacity-50 hover:bg-slate-50';
function ItemPicker({ label, options, selected, onChange, hint, allowManual = false }: {
  label: string;
  options: string[];
  selected: string[];
  onChange: (items: string[]) => void;
  hint?: string;
  allowManual?: boolean;
}) {
  const [manual, setManual] = useState('');
  const [unlisted, setUnlisted] = useState(() => selected.filter((item) => !options.includes(item)));
  const items = [...new Set([...options, ...unlisted, ...selected])];
  return (
    <fieldset className="space-y-2 text-sm">
      <legend className="font-medium">{label}</legend>
      {hint && <p className="text-xs text-slate-500">{hint}</p>}
      <div className="max-h-48 space-y-2 overflow-y-auto rounded-md border border-slate-200 bg-white p-3">
        {items.length === 0 && <p className="text-slate-500">No available items yet.</p>}
        {items.map((item) => (
          <label key={item} className="flex items-center gap-2 break-all">
            <input type="checkbox" checked={selected.includes(item)} onChange={(e) =>
              onChange(e.target.checked ? [...selected, item] : selected.filter((v) => v !== item))
            } />
            {item}
          </label>
        ))}
      </div>
      {allowManual && (
        <details>
          <summary className="cursor-pointer text-slate-600">Advanced: add an unlisted item</summary>
          <div className="mt-2 flex items-end gap-2">
            <label className="flex-1">Unlisted {label.toLowerCase()} item
              <input className={inputClass} value={manual} onChange={(e) => setManual(e.target.value)} />
            </label>
            <button type="button" className={buttonClass} disabled={!manual.trim()} onClick={() => {
              setUnlisted((values) => [...new Set([...values, manual.trim()])]);
              onChange([...new Set([...selected, manual.trim()])]);
              setManual('');
            }}>Add item</button>
          </div>
        </details>
      )}
    </fieldset>
  );
}

// eslint-disable-next-line complexity -- profile editing and discovery share the same editor state and callbacks
function ServerEditor({
  server,
  catalog,
  knownTools,
  endpoints,
  current,
  secret,
  onChange,
  onSecret,
  onRemove,
}: {
  server: ExtensionMcpDescriptor;
  catalog: ExtensionCatalogEntry[];
  knownTools: string[];
  endpoints: string[];
  current?: ExtensionProfileRevision;
  secret: string | null | undefined;
  onChange: (patch: Partial<ExtensionMcpDescriptor>) => void;
  onSecret: (value: string) => void;
  onRemove: () => void;
}) {
  const url = server.kind === 'https' ? server.url : '';
  const [probe, setProbe] = useState<{ url: string; attempt: number }>();
  const [discovered, setDiscovered] = useState<{ url: string; tools: string[] }>();
  const [discoveryStatus, setDiscoveryStatus] = useState('');
  useEffect(() => {
    setDiscoveryStatus('');
    if (!probe || probe.url !== url) return;
    let active = true;
    setDiscoveryStatus('Discovering tools…');
    void discoverExtensionTools(url).then(result => {
      if (active) { setDiscovered({ url, tools: result.tools }); setDiscoveryStatus(result.tools.length ? 'Tools discovered. Select the allowed tools below.' : 'No tools discovered.'); }
    }).catch(() => { if (active) setDiscoveryStatus('Discovery unavailable. This probe uses no credentials; Advanced entry remains available.'); });
    return () => { active = false; };
  }, [probe, url]);
  return (
    <div className="space-y-3 rounded-md border border-slate-200 bg-white p-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-sm">
          Stable server name
          <input
            className={inputClass}
            value={server.name}
            onChange={(e) => onChange({ name: e.target.value })}
          />
        </label>
        {server.kind === 'https' ? (
          <div className="space-y-2 text-sm">
            {endpoints.length > 0 && <label className="block">
              Use a saved HTTPS endpoint
              <select className={inputClass} value="" onChange={(e) => {
                if (e.target.value) onChange({ url: e.target.value });
              }}>
                <option value="">Select an endpoint</option>
                {endpoints.map((url) => <option key={url} value={url}>{url}</option>)}
              </select>
            </label>}
          <label className="block text-sm">
            HTTPS endpoint
            <input
              className={inputClass}
              value={server.url}
              placeholder="https://tools.example.com/mcp"
              onChange={(e) => onChange({ url: e.target.value })}
            />
          </label>
          </div>
        ) : (
          <div className="text-xs break-all">
            <p>Operator catalog entry: {server.catalogId}</p>
            <p>SHA-256 {server.digest}</p>
            <p>
              Operator secrets:{' '}
              {(
                current?.secrets[server.name] ??
                catalog.find((c) => c.id === server.catalogId)?.secrets
              )?.configured
                ? 'configured'
                : 'not configured'}
            </p>
          </div>
        )}
      </div>
      {server.kind === 'https' && <div className="space-y-2 text-sm">
        <button type="button" className={buttonClass} disabled={!url || discoveryStatus === 'Discovering tools…'}
          onClick={() => setProbe({ url, attempt: (probe?.attempt ?? 0) + 1 })}>Discover tools</button>
        <p className="text-xs text-slate-500">Probe this endpoint without credentials to find selectable tools.</p>
        {discoveryStatus && <p role="status">{discoveryStatus}</p>}
      </div>}
      <ItemPicker
        label="Allowed tools"
        options={server.kind === 'catalog'
          ? catalog.find((c) => c.id === server.catalogId && c.digest === server.digest)?.tools ?? server.tools
          : [...new Set([...knownTools, ...(discovered?.url === url ? discovered.tools : [])])]}
        selected={server.tools}
        onChange={(tools) => onChange({ tools })}
        allowManual={server.kind === 'https'}
        hint={server.kind === 'https' ? 'Discover tools or choose from saved configurations for this endpoint. Use Advanced for tools that cannot be discovered.' : undefined}
      />
      <div className="flex flex-wrap items-end gap-4">
        <label className="text-sm">
          Capability
          <select
            className={inputClass}
            value={server.capability}
            disabled={server.kind === 'catalog'}
            onChange={(e) => onChange({ capability: e.target.value as 'read' | 'write' })}
          >
            <option value="read">Read</option>
            <option value="write">Write — requires run authorization</option>
          </select>
        </label>
        {server.kind === 'https' && (
          <label className="text-sm">
            Authentication
            <select
              className={inputClass}
              value={server.authentication}
              onChange={(e) =>
                onChange({
                  authentication: e.target.value as 'none' | 'bearer',
                })
              }
            >
              <option value="none">None</option>
              <option value="bearer">Bearer token</option>
            </select>
          </label>
        )}
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={server.enabled}
            onChange={(e) => onChange({ enabled: e.target.checked })}
          />
          Enabled
        </label>
      </div>
      {server.kind === 'https' && server.authentication === 'bearer' && (
        <label className="block text-sm">
          Replace bearer token{' '}
          <span className="text-xs text-slate-500">
            ({current?.secrets[server.name]?.configured ? 'configured' : 'not configured'};
            write-only)
          </span>
          <input
            type="password"
            autoComplete="new-password"
            className={inputClass}
            value={secret ?? ''}
            placeholder="Leave blank to keep the configured token"
            onChange={(e) => onSecret(e.target.value)}
          />
        </label>
      )}
      <button type="button" className="text-sm text-red-700" onClick={onRemove}>
        Remove server
      </button>
    </div>
  );
}

type GithubSkillSource = { repository: string; commit: string; directory: string };

function formatSkillSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} ${bytes === 1 ? 'byte' : 'bytes'}`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  const exponent = Math.min(Math.floor(Math.log2(bytes) / 10), units.length);
  return `${(bytes / 1024 ** exponent).toFixed(1)} ${units[exponent - 1]}`;
}

function SkillSource({ source }: { source: ExtensionSkillBundle['source'] }) {
  const label = source.kind === 'github'
    ? `${source.repository} @ ${source.commit} / ${source.directory}`
    : `Uploaded archive: ${source.filename}`;
  const segments = label.split('/');
  return (
    <p className="mt-1" title={label}>
      {segments.map((segment, index) => (
        <span key={index} className="inline-block max-w-full truncate align-bottom whitespace-pre">
          {segment}{index < segments.length - 1 ? '/' : ''}
        </span>
      ))}
    </p>
  );
}

function SkillsEditor({
  bundles,
  availableBundles,
  repositories,
  github,
  setGithub,
  action,
  addBundle,
  onRemove,
}: {
  bundles: ExtensionSkillBundle[];
  availableBundles: ExtensionSkillBundle[];
  repositories: string[];
  github: GithubSkillSource;
  setGithub: Dispatch<SetStateAction<GithubSkillSource>>;
  action: (run: () => Promise<void>) => Promise<void>;
  addBundle: (bundle: ExtensionSkillBundle) => void;
  onRemove: (id: string) => void;
}) {
  const repositoryId = useId();
  const [refs, setRefs] = useState<GithubSkillRef[]>([]);
  const [chosenRef, setChosenRef] = useState<{ repository: string; ref: string }>();
  const [sourceStatus, setSourceStatus] = useState('');
  useEffect(() => {
    let active = true;
    setRefs([]); setChosenRef(undefined); setSourceStatus('');
    if (github.repository) {
      setSourceStatus('Loading branches and tags…');
      void listGithubSkillRefs(github.repository).then(result => {
        if (active) { setRefs(result.refs); setSourceStatus(result.refs.length ? '' : 'No branches or tags available.'); }
      }).catch(() => { if (active) setSourceStatus('Branches and tags unavailable. Use an exact commit under Advanced.'); });
    }
    return () => { active = false; };
  }, [github.repository]);
  useEffect(() => {
    if (!chosenRef || chosenRef.repository !== github.repository) return;
    let active = true;
    setSourceStatus('Resolving exact commit…');
    void resolveGithubSkillRef(github.repository, chosenRef.ref).then(result => {
      if (active) { setGithub(g => ({ ...g, commit: result.commit })); setSourceStatus('Commit resolved. Confirm the SHA below before importing.'); }
    }).catch(() => { if (active) setSourceStatus('Commit resolution unavailable. Select again or use Advanced.'); });
    return () => { active = false; };
  }, [chosenRef, github.repository, setGithub]);
  return (
    <>
      <h4 className="text-sm font-semibold">Validated skills</h4>
      <label className="block text-sm">
        Add an existing validated skill
        <select className={inputClass} value="" disabled={!availableBundles.length} onChange={(e) => {
          const bundle = availableBundles.find((b) => b.id === e.target.value);
          if (bundle) addBundle(bundle);
        }}>
          <option value="">Select a skill bundle</option>
          {availableBundles.map((b) => <option key={b.id} value={b.id}>{b.name} · {b.digest.slice(0, 12)}</option>)}
        </select>
      </label>
      {bundles.map((b) => (
        <div key={b.id} className="rounded-md border border-slate-200 bg-white p-3 text-xs">
          <p className="font-semibold">
            {b.name} · {b.files} files · <span title={`${b.bytes} bytes`}>{formatSkillSize(b.bytes)}</span>
          </p>
          <p className="mt-1 break-all font-mono">SHA-256 {b.digest}</p>
          <SkillSource source={b.source} />
          <p className="mt-1">
            Declared requirements: {b.requirements.join(', ') || 'none'}. Authorize capabilities
            separately.
          </p>
          <button type="button" className="mt-2 text-red-700" onClick={() => onRemove(b.id)}>
            Remove skill
          </button>
        </div>
      ))}
      <label className="block text-sm">
        Import a bounded tar or tar.gz archive
        <input
          type="file"
          accept=".tar,.tar.gz,.tgz"
          className="mt-2 block text-sm"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void action(async () => addBundle((await importArchiveSkill(file)).bundle));
            e.target.value = '';
          }}
        />
      </label>
      <details className="text-sm">
        <summary className="cursor-pointer font-medium">
          Import from an authorized GitHub repository
        </summary>
        <div className="mt-3 grid gap-3">
          <div>
          <label htmlFor={repositoryId}>Repository</label>
            <select id={repositoryId} className={inputClass} value={github.repository} onChange={(e) => setGithub((g) => ({ ...g, repository: e.target.value, commit: '' }))}>
              <option value="">Select an authorized repository</option>
              {[...new Set([...repositories, github.repository].filter(Boolean))].map((repository) =>
                <option key={repository} value={repository}>{repository}</option>)}
            </select>
            <details className="mt-2">
              <summary className="cursor-pointer text-slate-600">Advanced: use an unlisted repository</summary>
              <label>Unlisted repository
                <input className={inputClass} value={github.repository} placeholder="team/project"
                  onChange={(e) => setGithub((g) => ({ ...g, repository: e.target.value, commit: '' }))} />
              </label>
            </details>
          </div>
          <label>Branch or tag
            <select className={inputClass} value={chosenRef?.repository === github.repository ? chosenRef.ref : ''}
              onChange={(e) => { setGithub(g => ({ ...g, commit: '' })); setChosenRef(e.target.value ? { repository: github.repository, ref: e.target.value } : undefined); }}>
              <option value="">Select a branch or tag</option>
              {refs.map(ref => <option key={ref.ref} value={ref.ref}>{ref.kind === 'branch' ? 'Branch' : 'Tag'}: {ref.name}</option>)}
            </select>
          </label>
          {sourceStatus && <p role="status" className="text-xs text-slate-600">{sourceStatus}</p>}
          {github.commit && <p className="break-all text-sm">Confirmed import commit: <code>{github.commit}</code></p>}
          <details className="text-sm">
            <summary className="cursor-pointer text-slate-600">Advanced: use an exact commit</summary>
            <label>Exact 40-character commit
              <input className={inputClass} value={github.commit} onChange={(e) => { setChosenRef(undefined); setGithub(g => ({ ...g, commit: e.target.value })); }} />
            </label>
          </details>
          <label>
            Relative skill directory
            <input
              className={inputClass}
              value={github.directory}
              onChange={(e) => setGithub((g) => ({ ...g, directory: e.target.value }))}
              placeholder="skills/review"
            />
          </label>
          <button
            type="button"
            className={buttonClass}
            disabled={!/^[0-9a-f]{40}$/.test(github.commit) || !github.repository || !github.directory}
            onClick={() =>
              void action(async () =>
                addBundle(
                  (await importGithubSkill(github.repository, github.commit, github.directory))
                    .bundle,
                ),
              )
            }
          >
            Import pinned skill
          </button>
        </div>
      </details>
    </>
  );
}

export default function AgentExtensionsSection() {
  const [github, setGithub] = useState({
    repository: '',
    commit: '',
    directory: '',
  });
  const [instanceCatalog, setInstanceCatalog] = useState<InstanceCatalogResponse>({ agents: [], repositories: [] });
  const [catalogError, setCatalogError] = useState(false);
  const [catalog, setCatalog] = useState<ExtensionCatalogEntry[]>([]);
  const [profiles, setProfiles] = useState<ExtensionProfileRevision[]>([]);
  const [current, setCurrent] = useState<ExtensionProfileRevision>();
  const [draft, setDraft] = useState<ExtensionProfileInput>(blank);
  const [editorVersion, setEditorVersion] = useState(0);
  const [editing, setEditing] = useState(false);
  const [secrets, setSecrets] = useState<Record<number, string | null>>({});
  const [availableBundles, setAvailableBundles] = useState<ExtensionSkillBundle[]>([]);
  const [bundles, setBundles] = useState<ExtensionSkillBundle[]>([]);
  const [history, setHistory] = useState<ExtensionProfileRevision[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const refresh = async () => {
    const result = await listExtensionProfiles();
    setProfiles(result.profiles);
    setCatalog(result.catalog ?? []);
    setAvailableBundles(result.bundles ?? []);
  };
  useEffect(() => {
    let active = true;
    void getInstanceCatalog().then((result) => {
      if (active) setInstanceCatalog(result);
    }).catch(() => { if (active) setCatalogError(true); });
    void listExtensionProfiles()
      .then((result) => {
        if (active) {
          setProfiles(result.profiles);
          setCatalog(result.catalog ?? []);
          setAvailableBundles(result.bundles ?? []);
        }
      })
      .catch((e) => {
        if (active) setError((e as Error).message);
      });
    return () => {
      active = false;
    };
  }, []);
  const action = async (run: () => Promise<void>) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await run();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const open = (profile?: ExtensionProfileRevision) => {
    setEditorVersion((v) => v + 1);
    setCurrent(profile);
    setDraft(
      profile
        ? {
            version: 1,
            name: profile.name,
            enabled: profile.enabled,
            agentScope: profile.agentScope,
            repositoryScope: profile.repositoryScope,
            mcpServers: profile.mcpServers,
            skillBundleIds: profile.skillBundleIds,
          }
        : blank(),
    );
    setBundles(profile?.skillBundles ?? []);
    setSecrets({});
    setHistory([]);
    setNotice('');
    setEditing(true);
  };
  const changeServer = (index: number, patch: Partial<ExtensionMcpDescriptor>) => {
    const server = draft.mcpServers[index];
    if (('authentication' in patch && patch.authentication === 'none') || ('url' in patch && patch.url !== undefined && server?.kind === 'https' && patch.url !== server.url)) {
      setSecrets((values) => {
        const next = { ...values };
        delete next[index];
        return next;
      });
    }
    setDraft((d) => ({
      ...d,
      mcpServers: d.mcpServers.map((s, i) =>
        i === index ? ({ ...s, ...patch } as ExtensionMcpDescriptor) : s,
      ),
    }));
  };
  const addBundle = (bundle: ExtensionSkillBundle) => {
    setAvailableBundles((items) => [...items.filter((existing) => existing.id !== bundle.id), bundle]);
    setBundles((b) => [...b.filter((existing) => existing.id !== bundle.id), bundle]);
    setDraft((d) => ({
      ...d,
      skillBundleIds: [...new Set([...d.skillBundleIds, bundle.id])],
    }));
    setNotice('Validated skill bundle added. Save the profile to select it.');
  };
  return (
    <SettingsSection
      title="Skills & MCP servers"
      description={<AgentExtensionsDescription />}
    >
      <div className="max-w-4xl space-y-5">
        {error && (
          <p role="alert" className="rounded-md bg-red-50 p-3 text-sm text-red-800">
            {error}
          </p>
        )}
        {notice && (
          <p role="status" className="text-sm text-teal-800">
            {notice}
          </p>
        )}
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-slate-800">Extension profiles</h3>
          <button type="button" className={buttonClass} disabled={busy} onClick={() => open()}>
            New profile
          </button>
        </div>
        {profiles.length === 0 && (
          <p className="text-sm text-slate-500">
            No profiles configured. Create a profile to authorize tools and attach validated skills.
          </p>
        )}
        <ul className="divide-y rounded-lg border border-slate-200">
          {profiles.map((p) => (
            <li
              key={p.profileId}
              className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
            >
              <div>
                <p className="text-sm font-medium text-slate-900">{p.name}</p>
                <p className="mt-1 text-xs text-slate-500">
                  Revision {p.revision} · {p.enabled ? 'Enabled' : 'Disabled'} ·{' '}
                  {p.mcpServers.filter((s) => s.enabled).length} MCP servers ·{' '}
                  {p.skillBundles.length} skill bundles
                </p>
              </div>
              <button type="button" className={buttonClass} disabled={busy} onClick={() => open(p)}>
                Edit profile
              </button>
            </li>
          ))}
        </ul>
        {editing && (
          <fieldset
            key={editorVersion}
            disabled={busy}
            className="space-y-5 rounded-lg border border-slate-200 bg-slate-50/50 p-4 sm:p-5"
          >
            <div className="flex justify-between gap-3">
              <h3 className="font-semibold text-slate-900">
                {current ? `Edit ${current.name}` : 'New extension profile'}
              </h3>
              <button
                type="button"
                onClick={() => {
                  setSecrets({});
                  setEditing(false);
                }}
                className="text-sm text-slate-500"
              >
                Close
              </button>
            </div>
            <label className="block text-sm font-medium">
              Profile name
              <input
                className={inputClass}
                value={draft.name}
                onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
                maxLength={100}
              />
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={draft.enabled}
                onChange={(e) => setDraft((d) => ({ ...d, enabled: e.target.checked }))}
              />
              Enabled for new launches
            </label>
            {catalogError && <p role="status" className="text-sm text-amber-800">Agent and repository choices could not be loaded. Reopen Settings to retry, or use Advanced to add an unlisted item.</p>}
            <div className="grid gap-4 sm:grid-cols-2">
              <ItemPicker label="Agents" options={instanceCatalog.agents.filter((a) => a.enabled && a.kind !== 'synthetic' && (a.type === 'claude' || a.type === 'codex') && /^[A-Za-z0-9_-]{1,100}$/.test(a.alias)).map((a) => a.alias)}
                selected={draft.agentScope} onChange={(agentScope) => setDraft((d) => ({ ...d, agentScope }))}
                hint="Leave all unchecked to allow any agent." allowManual />
              <ItemPicker label="Repositories" options={instanceCatalog.repositories.map((r) => r.name)}
                selected={draft.repositoryScope} onChange={(repositoryScope) => setDraft((d) => ({ ...d, repositoryScope }))}
                hint="Leave all unchecked to allow any repository." allowManual />
            </div>
            <div className="flex items-center justify-between">
              <h4 className="text-sm font-semibold">MCP servers</h4>
              <button
                type="button"
                className={buttonClass}
                disabled={draft.mcpServers.length >= 8}
                onClick={() =>
                  setDraft((d) => ({
                    ...d,
                    mcpServers: [
                      ...d.mcpServers,
                      {
                        kind: 'https',
                        name: nextServerName(d.mcpServers),
                        url: '',
                        enabled: true,
                        tools: [],
                        capability: 'read',
                        authentication: 'none',
                      },
                    ],
                  }))
                }
              >
                Add HTTPS server
              </button>
            </div>
            <label className="block text-sm">
              Add operator catalog entry
              <select
                className={inputClass}
                value=""
                disabled={draft.mcpServers.length >= 8 || !catalog.length}
                onChange={(e) => {
                  const entry = catalog.find((c) => c.id === e.target.value);
                  if (entry)
                    setDraft((d) => ({
                      ...d,
                      mcpServers: [
                        ...d.mcpServers,
                        {
                          kind: 'catalog',
                          name: nextServerName(d.mcpServers),
                          catalogId: entry.id,
                          digest: entry.digest,
                          enabled: true,
                          tools: [...entry.tools],
                          capability: entry.capability,
                        },
                      ],
                    }));
                }}
              >
                <option value="">Select an installed entry</option>
                {catalog.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.id}
                  </option>
                ))}
              </select>
            </label>
            {draft.mcpServers.map((server, index) => (
              <ServerEditor
                key={index}
                server={server}
                catalog={catalog}
                endpoints={[...new Set(profiles.flatMap((p) => p.mcpServers.flatMap((s) => s.kind === 'https' ? [s.url] : [])))]}
                knownTools={server.kind === 'https' ? profiles.flatMap((p) => p.mcpServers.flatMap((s) =>
                  s.kind === 'https' && s.url === server.url ? s.tools : [])) : []}
                current={current}
                secret={secrets[index]}
                onChange={(patch) => changeServer(index, patch)}
                onSecret={(value) =>
                  setSecrets((values) => {
                    const next = { ...values };
                    if (value) next[index] = value;
                    else delete next[index];
                    return next;
                  })
                }
                onRemove={() => {
                  setEditorVersion((v) => v + 1);
                  setDraft((d) => ({
                    ...d,
                    mcpServers: d.mcpServers.filter((_, i) => i !== index),
                  }));
                  setSecrets((values) => {
                    return Object.fromEntries(Object.entries(values)
                      .filter(([key]) => Number(key) !== index)
                      .map(([key, value]) => [Number(key) > index ? Number(key) - 1 : Number(key), value]));
                  });
                }}
              />
            ))}
            <SkillsEditor
              bundles={bundles.filter((b) => draft.skillBundleIds.includes(b.id))}
              availableBundles={[...new Map(availableBundles.concat(profiles.flatMap((p) => p.skillBundles), bundles).map((b) => [b.id, b])).values()].filter((b) => !draft.skillBundleIds.includes(b.id))}
              repositories={instanceCatalog.repositories.map((r) => r.name)}
              github={github}
              setGithub={setGithub}
              action={action}
              addBundle={addBundle}
              onRemove={(id) =>
                setDraft((d) => ({
                  ...d,
                  skillBundleIds: d.skillBundleIds.filter((selected) => selected !== id),
                }))
              }
            />
            <p className="text-xs leading-5 text-slate-500">
              Saving creates an immutable revision. Secret replacement invalidates older launches.
              Disabling or deleting blocks new launches; running snapshots keep their selected
              revision.
            </p>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className={`${buttonClass} bg-teal-700 text-white hover:bg-teal-800`}
                onClick={() =>
                  void action(async () => {
                    const result = await saveExtensionProfile(
                      draft,
                      Object.fromEntries(draft.mcpServers.flatMap((server, index) =>
                        server.kind === 'https' && server.authentication === 'bearer' && Object.prototype.hasOwnProperty.call(secrets, index)
                          ? [[server.name, secrets[index]]] : [])),
                      current ? selection(current) : undefined,
                    );
                    setSecrets({});
                    open(result.profile);
                    await refresh();
                    setNotice('Profile revision saved.');
                  })
                }
              >
                Save revision
              </button>
              {current && (
                <>
                  <button
                    type="button"
                    className={buttonClass}
                    onClick={() =>
                      void action(async () => {
                        const result = await validateExtensionProfile(selection(current));
                        setNotice(
                          result.results
                            .map(
                              (r) =>
                                `${r.name}: ${r.status === 'not_validated' || r.reachable === null ? 'not validated' : r.reachable ? 'reachable' : 'unavailable'}`,
                            )
                            .join(' · ') || 'No enabled MCP servers.',
                        );
                      })
                    }
                  >
                    Validate saved MCP connectivity
                  </button>
                  <button
                    type="button"
                    className={buttonClass}
                    onClick={() =>
                      void action(async () =>
                        setHistory((await extensionProfileHistory(current.profileId)).revisions),
                      )
                    }
                  >
                    Revision history
                  </button>
                  <button
                    type="button"
                    className={`${buttonClass} text-red-700`}
                    onClick={() =>
                      void action(async () => {
                        await deleteExtensionProfile(selection(current));
                        setCurrent(undefined);
                        setSecrets({});
                        setEditing(false);
                        await refresh();
                        setNotice('Profile deleted for new launches.');
                      })
                    }
                  >
                    Delete profile
                  </button>
                </>
              )}
            </div>
            {history.length > 0 && (
              <ul className="space-y-2 text-xs text-slate-600">
                {history.map((p) => (
                  <li key={p.revision}>
                    Revision {p.revision} · {new Date(p.updatedAt).toLocaleString()} · administrator{' '}
                    {p.auditActor} · {p.enabled ? 'enabled' : 'disabled'} · {p.mcpServers.length}{' '}
                    servers · {p.skillBundles.length} bundles
                  </li>
                ))}
              </ul>
            )}
          </fieldset>
        )}
      </div>
    </SettingsSection>
  );
}
