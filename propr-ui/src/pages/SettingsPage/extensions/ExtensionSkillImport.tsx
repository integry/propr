import { useEffect, useId, useState } from 'react';
import type { ExtensionSkillBundle } from '@propr/shared';
import { importArchiveSkill, importGithubSkill, listGithubSkillRefs, resolveGithubSkillRef, type GithubSkillRef } from '../../../api/extensionProfilesApi';
import { buttonClass, formatSkillSize, inputClass } from './extensionUi';

/** Source, digest and declared requirements of one imported skill bundle. */
export function SkillBundleDetails({ bundle }: { bundle: ExtensionSkillBundle }) {
  const source = bundle.source.kind === 'github'
    ? `${bundle.source.repository} @ ${bundle.source.commit} / ${bundle.source.directory}`
    : bundle.source.kind === 'plugin'
      ? `Plugin ${bundle.source.plugin} ${bundle.source.version} / ${bundle.source.path}`
      : `Uploaded archive: ${bundle.source.filename}`;
  const segments = source.split('/');
  return (
    <div className="space-y-1 text-xs text-slate-600">
      <p>{bundle.files} files · <span title={`${bundle.bytes} bytes`}>{formatSkillSize(bundle.bytes)}</span></p>
      <p className="break-all font-mono">SHA-256 {bundle.digest}</p>
      <p title={source}>
        {segments.map((segment, index) => (
          <span key={index} className="inline-block max-w-full truncate whitespace-pre align-bottom">{segment}{index < segments.length - 1 ? '/' : ''}</span>
        ))}
      </p>
      <p>Declared requirements: {bundle.requirements.join(', ') || 'none'}. Requirements grant no capabilities.</p>
    </div>
  );
}

type Run = (work: () => Promise<ExtensionSkillBundle>) => void;

function GithubSkillImport({ repositories, run }: { repositories: string[]; run: Run }) {
  const repositoryId = useId();
  const [source, setSource] = useState({ repository: '', commit: '', directory: '' });
  const [refs, setRefs] = useState<GithubSkillRef[]>([]);
  const [chosenRef, setChosenRef] = useState<{ repository: string; ref: string }>();
  const [status, setStatus] = useState('');
  useEffect(() => {
    let active = true;
    setRefs([]); setChosenRef(undefined); setStatus('');
    if (source.repository) {
      setStatus('Loading branches and tags…');
      void listGithubSkillRefs(source.repository).then(result => {
        if (active) { setRefs(result.refs); setStatus(result.refs.length ? '' : 'No branches or tags available.'); }
      }).catch(() => { if (active) setStatus('Branches and tags unavailable. Enter an exact commit instead.'); });
    }
    return () => { active = false; };
  }, [source.repository]);
  useEffect(() => {
    if (!chosenRef || chosenRef.repository !== source.repository) return;
    let active = true;
    setStatus('Resolving exact commit…');
    void resolveGithubSkillRef(source.repository, chosenRef.ref).then(result => {
      if (active) { setSource(value => ({ ...value, commit: result.commit })); setStatus('Commit resolved. Confirm the SHA below before importing.'); }
    }).catch(() => { if (active) setStatus('Commit resolution unavailable. Select again or enter an exact commit.'); });
    return () => { active = false; };
  }, [chosenRef, source.repository]);
  const setRepository = (repository: string) => setSource(value => ({ ...value, repository, commit: '' }));
  return (
    <details className="text-sm">
      <summary className="cursor-pointer font-medium">Import from an authorized GitHub repository</summary>
      <div className="mt-3 grid gap-3">
        <div>
          <label htmlFor={repositoryId}>Repository</label>
          <select id={repositoryId} className={inputClass} value={source.repository} onChange={event => setRepository(event.target.value)}>
            <option value="">Select an authorized repository</option>
            {[...new Set([...repositories, source.repository].filter(Boolean))].map(repository => <option key={repository} value={repository}>{repository}</option>)}
          </select>
          <details className="mt-2">
            <summary className="cursor-pointer text-slate-600">Use an unlisted repository</summary>
            <label>Unlisted repository
              <input className={inputClass} value={source.repository} placeholder="team/project" onChange={event => setRepository(event.target.value)} />
            </label>
          </details>
        </div>
        <label>Branch or tag
          <select className={inputClass} value={chosenRef?.repository === source.repository ? chosenRef.ref : ''}
            onChange={event => { setSource(value => ({ ...value, commit: '' })); setChosenRef(event.target.value ? { repository: source.repository, ref: event.target.value } : undefined); }}>
            <option value="">Select a branch or tag</option>
            {refs.map(ref => <option key={ref.ref} value={ref.ref}>{ref.kind === 'branch' ? 'Branch' : 'Tag'}: {ref.name}</option>)}
          </select>
        </label>
        {status && <p role="status" className="text-xs text-slate-600">{status}</p>}
        {source.commit && <p className="break-all">Confirmed import commit: <code>{source.commit}</code></p>}
        <details>
          <summary className="cursor-pointer text-slate-600">Use an exact commit</summary>
          <label>Exact 40-character commit
            <input className={inputClass} value={source.commit} onChange={event => { setChosenRef(undefined); setSource(value => ({ ...value, commit: event.target.value })); }} />
          </label>
        </details>
        <label>Relative skill directory
          <input className={inputClass} value={source.directory} placeholder="skills/review" onChange={event => setSource(value => ({ ...value, directory: event.target.value }))} />
        </label>
        <button type="button" className={buttonClass} disabled={!/^[0-9a-f]{40}$/.test(source.commit) || !source.repository || !source.directory}
          onClick={() => run(async () => (await importGithubSkill(source.repository, source.commit, source.directory)).bundle)}>
          Import pinned skill
        </button>
      </div>
    </details>
  );
}

/** Choose a skill bundle for a new library skill: an imported bundle, an archive upload or a pinned GitHub commit. */
export function ExtensionSkillSource({ available, repositories, onBundle, onBusy, onError }: {
  available: ExtensionSkillBundle[];
  repositories: string[];
  onBundle: (bundle: ExtensionSkillBundle) => void;
  onBusy: (busy: boolean) => void;
  onError: (message: string) => void;
}) {
  const run: Run = work => {
    onBusy(true); onError('');
    void work().then(onBundle).catch(e => onError((e as Error).message)).finally(() => onBusy(false));
  };
  return (
    <div className="space-y-3">
      {available.length > 0 && (
        <label className="block text-sm">
          Use an imported skill
          <select className={inputClass} value="" onChange={event => {
            const bundle = available.find(item => item.id === event.target.value);
            if (bundle) onBundle(bundle);
          }}>
            <option value="">Select a skill bundle</option>
            {available.map(bundle => <option key={bundle.id} value={bundle.id}>{bundle.name} · {bundle.digest.slice(0, 12)}</option>)}
          </select>
        </label>
      )}
      <label className="block text-sm">
        Import a tar or tar.gz archive
        <input type="file" accept=".tar,.tar.gz,.tgz" className="mt-2 block max-w-full text-sm" onChange={event => {
          const file = event.target.files?.[0];
          if (file) run(async () => (await importArchiveSkill(file)).bundle);
          event.target.value = '';
        }} />
      </label>
      <GithubSkillImport repositories={repositories} run={run} />
    </div>
  );
}
