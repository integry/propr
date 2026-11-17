import { useEffect, useId, useState } from 'react';
import type { ExtensionSkillBundle } from '@propr/shared';
import { importArchiveSkill, importGithubSkill, listGithubSkillRefs, resolveGithubSkillRef, type GithubSkillRef } from '../../../api/extensionProfilesApi';
import { buttonClass, fieldErrorClass, formatSkillSize, inputClass, labelClass } from './extensionUi';
import { importCommitLabel, isFullCommit, isRepositoryName, type CommitLookup } from './extensionValidation';

/** Source, digest and declared requirements of one imported skill bundle. */
export function SkillBundleDetails({ bundle }: { bundle: ExtensionSkillBundle }) {
  const source = bundle.source.kind === 'github'
    ? `${bundle.source.repository} @ ${bundle.source.commit} / ${bundle.source.directory}`
    : `Uploaded archive: ${bundle.source.filename}`;
  const segments = source.split('/');
  return (
    <div className="space-y-1 text-[12px] leading-5 text-slate-600">
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

/** Branches and tags of a valid repository, and the loading status. */
function useGithubRefs(repository: string, valid: boolean) {
  const [refs, setRefs] = useState<GithubSkillRef[]>([]);
  const [status, setStatus] = useState('');
  useEffect(() => {
    let active = true;
    setRefs([]); setStatus('');
    if (valid) {
      setStatus('Loading branches and tags…');
      void listGithubSkillRefs(repository).then(result => {
        if (active) { setRefs(result.refs); setStatus(result.refs.length ? '' : 'No branches or tags available.'); }
      }).catch(() => { if (active) setStatus('Branches and tags unavailable. Enter an exact commit instead.'); });
    }
    return () => { active = false; };
  }, [repository, valid]);
  return { refs, status, setStatus };
}

type Lookup = CommitLookup & { repository: string };

/**
 * Checks a typed full commit against the repository, shortly after typing
 * stops. A commit resolved from a branch or tag is recorded as verified by the caller.
 * Clearing the lookup checks the same commit again; the caller does that on
 * edits and on retry, so a failed check never sticks to the form.
 */
function useTypedCommitLookup(repository: string, commit: string, lookup: Lookup | undefined, onLookup: (lookup: Lookup) => void) {
  const known = lookup?.repository === repository && lookup.commit === commit;
  const pending = isRepositoryName(repository) && isFullCommit(commit) && !known ? commit : '';
  useEffect(() => {
    if (!pending) return;
    let active = true;
    const timer = setTimeout(() => {
      void resolveGithubSkillRef(repository, pending)
        .then(result => { if (active) onLookup({ repository, commit: pending, status: result.commit === pending ? 'verified' : 'failed' }); })
        .catch(() => { if (active) onLookup({ repository, commit: pending, status: 'unavailable' }); });
    }, 400);
    return () => { active = false; clearTimeout(timer); };
  }, [pending, repository, onLookup]);
}

/** The authorized repositories, plus a typed owner/name; a typed value is listed only once it is valid. */
function RepositoryChooser({ repositories, value, onChange }: { repositories: string[]; value: string; onChange: (repository: string) => void }) {
  const selectId = useId();
  const valid = isRepositoryName(value);
  const listed = [...new Set([...repositories, ...(valid ? [value] : [])])];
  return (
    <div>
      <label htmlFor={selectId} className={labelClass}>Repository</label>
      <select id={selectId} className={inputClass} value={valid ? value : ''} onChange={event => onChange(event.target.value)}>
        <option value="">Select an authorized repository</option>
        {listed.map(repository => <option key={repository} value={repository}>{repository}</option>)}
      </select>
      <details className="mt-2">
        <summary className="cursor-pointer text-slate-600">Other repository (owner/name)</summary>
        <input className={inputClass} aria-label="Other repository (owner/name)" value={value} placeholder="owner/name"
          autoCapitalize="none" spellCheck={false} aria-invalid={Boolean(value) && !valid}
          onChange={event => onChange(event.target.value)} />
        {value && !valid && <span className={fieldErrorClass}>Use owner/name, for example acme/website.</span>}
      </details>
    </div>
  );
}

const COMMIT_TONES = { confirmed: 'text-teal-800', invalid: 'text-red-700', pending: 'text-slate-600' } as const;

function GithubSkillImport({ repositories, run, onInput }: { repositories: string[]; run: Run; onInput?: (typed: boolean) => void }) {
  const commitStatusId = useId();
  const [source, setSource] = useState({ repository: '', commit: '', directory: '' });
  const [chosenRef, setChosenRef] = useState<{ repository: string; ref: string }>();
  /** The last commit lookup: a resolved branch or tag, or a typed commit checked against the repository. */
  const [lookup, setLookup] = useState<Lookup>();
  const validRepository = isRepositoryName(source.repository);
  const { refs, status, setStatus } = useGithubRefs(source.repository, validRepository);
  const typed = Boolean(source.repository || source.commit || source.directory);
  useEffect(() => { onInput?.(typed); }, [typed, onInput]);
  useEffect(() => {
    if (!chosenRef || chosenRef.repository !== source.repository) return;
    let active = true;
    setStatus('Resolving exact commit…');
    void resolveGithubSkillRef(source.repository, chosenRef.ref).then(result => {
      if (!active) return;
      setLookup({ repository: source.repository, commit: result.commit, status: 'verified' });
      setSource(value => ({ ...value, commit: result.commit })); setStatus('');
    }).catch(() => { if (active) setStatus('Commit resolution unavailable. Select again or enter an exact commit.'); });
    return () => { active = false; };
  }, [chosenRef, source.repository, setStatus]);
  useTypedCommitLookup(source.repository, chosenRef ? '' : source.commit, lookup, setLookup);
  /** Forgets a lookup that did not verify, so the commit as typed next is checked again. */
  const forgetUnverified = () => setLookup(value => value?.status === 'verified' ? value : undefined);
  const setRepository = (repository: string) => {
    setChosenRef(undefined); forgetUnverified(); setSource(value => ({ ...value, repository: repository.trim(), commit: '' }));
  };
  const commitLabel = validRepository ? importCommitLabel(source.commit, lookup?.repository === source.repository ? lookup : undefined) : null;
  const verified = commitLabel?.tone === 'confirmed';
  return (
    <details className="text-sm">
      <summary className="cursor-pointer font-medium">Import from an authorized GitHub repository</summary>
      <div className="mt-3 grid gap-3">
        <RepositoryChooser repositories={repositories} value={source.repository} onChange={setRepository} />
        <label className={labelClass}>Branch or tag
          <select className={inputClass} value={chosenRef?.repository === source.repository ? chosenRef.ref : ''} disabled={!validRepository}
            onChange={event => { setSource(value => ({ ...value, commit: '' })); setChosenRef(event.target.value ? { repository: source.repository, ref: event.target.value } : undefined); }}>
            <option value="">Select a branch or tag</option>
            {refs.map(ref => <option key={ref.ref} value={ref.ref}>{ref.kind === 'branch' ? 'Branch' : 'Tag'}: {ref.name}</option>)}
          </select>
        </label>
        {status && <p role="status" className="text-[12px] leading-5 text-slate-600">{status}</p>}
        {commitLabel && (
          <p id={commitStatusId} data-testid="extension-skill-commit" data-tone={commitLabel.tone} className={`break-all text-[12px] leading-5 ${COMMIT_TONES[commitLabel.tone]}`}>
            {commitLabel.text}{verified && <> <code>{source.commit}</code></>}
            {lookup?.repository === source.repository && lookup.commit === source.commit && lookup.status === 'unavailable' && (
              <> <button type="button" className="font-medium underline" onClick={forgetUnverified}>Check again</button></>
            )}
          </p>
        )}
        <details>
          <summary className="cursor-pointer text-slate-600">Use an exact commit</summary>
          <label className={labelClass}>Exact 40-character commit
            <input className={`${inputClass} font-mono`} value={source.commit} autoCapitalize="none" spellCheck={false} maxLength={64}
              aria-describedby={commitLabel ? commitStatusId : undefined} aria-invalid={commitLabel?.tone === 'invalid'}
              onChange={event => { setChosenRef(undefined); forgetUnverified(); setSource(value => ({ ...value, commit: event.target.value.trim() })); }} />
          </label>
        </details>
        <label className={labelClass}>Relative skill directory
          <input className={inputClass} value={source.directory} placeholder="skills/review" autoCapitalize="none" spellCheck={false}
            onChange={event => setSource(value => ({ ...value, directory: event.target.value }))} />
        </label>
        <button type="button" className={`${buttonClass} justify-self-start`} disabled={!verified || !source.directory}
          onClick={() => run(async () => (await importGithubSkill(source.repository, source.commit, source.directory)).bundle)}>
          Import pinned skill
        </button>
      </div>
    </details>
  );
}

/** Choose a skill bundle for a new library skill: an imported bundle, an archive upload or a pinned GitHub commit. */
export function ExtensionSkillSource({ available, repositories, onBundle, onBusy, onError, onInput }: {
  available: ExtensionSkillBundle[];
  repositories: string[];
  onBundle: (bundle: ExtensionSkillBundle) => void;
  onBusy: (busy: boolean) => void;
  onError: (message: string) => void;
  /** Whether anything is typed into the GitHub import, so closing the form asks first. */
  onInput?: (typed: boolean) => void;
}) {
  const run: Run = work => {
    onBusy(true); onError('');
    void work().then(onBundle).catch(e => onError((e as Error).message)).finally(() => onBusy(false));
  };
  return (
    <div className="space-y-3">
      {available.length > 0 && (
        <label className={labelClass}>
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
      <label className={labelClass}>
        Import a tar or tar.gz archive
        <input type="file" accept=".tar,.tar.gz,.tgz" className="mt-2 block max-w-full text-sm" onChange={event => {
          const file = event.target.files?.[0];
          if (file) run(async () => (await importArchiveSkill(file)).bundle);
          event.target.value = '';
        }} />
      </label>
      <GithubSkillImport repositories={repositories} run={run} onInput={onInput} />
    </div>
  );
}
