import { useEffect, useId, useState } from 'react';
import { type ExtensionLibraryPackageServer, type ExtensionPackageResolution, type ExtensionSecretAcknowledgement, type ExtensionSecretStatus } from '@propr/shared';
import { resolveExtensionPackage } from '../../../api/extensionProfilesApi';
import { buttonClass, inputClass } from './extensionUi';
import { acknowledgementCovers, isExactVersion } from './packageServerUi';

type Patch = (patch: Partial<ExtensionLibraryPackageServer>) => void;


const lines = (text: string) => text.split('\n').map(line => line.replace(/\r$/, '')).filter(line => line.length > 0);
const envText = (env: ExtensionLibraryPackageServer['env']) => env.map(variable => `${variable.name}=${variable.value}`).join('\n');
const parseEnv = (text: string) => lines(text).map(line => {
  const index = line.indexOf('=');
  return index < 0 ? { name: line.trim(), value: '' } : { name: line.slice(0, index).trim(), value: line.slice(index + 1) };
});

/** "Check": the registry's integrity value and the executable that will run. Nothing is installed or run. */
function PackageCheck({ server }: { server: ExtensionLibraryPackageServer }) {
  const identity = `${server.ecosystem}\n${server.package}\n${server.version}\n${server.bin ?? ''}`;
  const [checked, setChecked] = useState<{ identity: string; result?: ExtensionPackageResolution; error?: string; busy?: boolean }>();
  useEffect(() => { setChecked(value => (value && value.identity !== identity ? undefined : value)); }, [identity]);
  const check = () => {
    setChecked({ identity, busy: true });
    void resolveExtensionPackage({ ecosystem: server.ecosystem, package: server.package, version: server.version, ...(server.bin ? { bin: server.bin } : {}) })
      .then(response => setChecked(value => (value?.identity === identity ? { identity, result: response.package } : value)))
      .catch(error => setChecked(value => (value?.identity === identity ? { identity, error: (error as Error).message } : value)));
  };
  const shown = checked?.identity === identity ? checked : undefined;
  return (
    <div className="space-y-2 text-sm">
      <button type="button" className={buttonClass} disabled={!server.package || !isExactVersion(server.version) || shown?.busy} onClick={check}>
        {shown?.busy ? 'Checking…' : 'Check'}
      </button>
      <p className="text-xs text-slate-500">Looks the exact version up in the npm registry. Nothing is downloaded or run.</p>
      {shown?.result && (
        <dl role="status" data-testid="extension-package-check" className="grid gap-x-3 gap-y-1 break-all rounded-md bg-teal-50 p-2 text-xs text-teal-900 sm:grid-cols-[auto_1fr]">
          <dt className="font-semibold">Version</dt><dd>{shown.result.package}@{shown.result.version}</dd>
          <dt className="font-semibold">Executable</dt><dd>{shown.result.bin}{shown.result.bins.length > 1 ? ` (of ${shown.result.bins.join(', ')})` : ''}</dd>
          <dt className="font-semibold">Integrity</dt><dd>{shown.result.integrity}</dd>
        </dl>
      )}
      {shown?.error && <p role="alert" className="rounded-md bg-red-50 p-2 text-xs text-red-800">{shown.error}</p>}
    </div>
  );
}

/** Secret variables: names are saved with the server, values are write-only. */
function SecretVariables({ server, status, values, onValues, onChange }: {
  server: ExtensionLibraryPackageServer; status?: ExtensionSecretStatus; values: Record<string, string>; onValues: (values: Record<string, string>) => void; onChange: Patch;
}) {
  const [adding, setAdding] = useState('');
  const configured = new Set(status && 'configuredEnv' in status ? status.configuredEnv ?? [] : []);
  const add = () => {
    const name = adding.trim();
    if (!name || server.secretEnv.includes(name)) return;
    onChange({ secretEnv: [...server.secretEnv, name] }); setAdding('');
  };
  return (
    <fieldset className="space-y-2 text-sm">
      <legend className="font-medium">Secret variables</legend>
      {server.secretEnv.map(name => (
        <div key={name} className="flex flex-wrap items-end gap-2">
          <label className="min-w-0 flex-1">
            {name} <span className="text-xs text-slate-500">({configured.has(name) ? 'configured' : 'not configured'}; write-only)</span>
            <input type="password" autoComplete="new-password" className={inputClass} value={values[name] ?? ''}
              placeholder={configured.has(name) ? 'Leave blank to keep the configured value' : 'Enter the value'}
              onChange={event => onValues({ ...values, [name]: event.target.value })} />
          </label>
          <button type="button" className={buttonClass} aria-label={`Remove secret variable ${name}`} onClick={() => {
            const rest = { ...values }; delete rest[name]; onValues(rest);
            onChange({ secretEnv: server.secretEnv.filter(item => item !== name) });
          }}>Remove</button>
        </div>
      ))}
      <div className="flex flex-wrap items-end gap-2">
        <label className="min-w-0 flex-1">
          New secret variable name
          <input className={inputClass} value={adding} placeholder="API_TOKEN" onChange={event => setAdding(event.target.value.toUpperCase())}
            onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); add(); } }} />
        </label>
        <button type="button" className={buttonClass} disabled={!adding.trim()} onClick={add}>Add secret variable</button>
      </div>
    </fieldset>
  );
}

/**
 * Package, exact version, executable, arguments and variables of a local
 * package server, the "Check" registry lookup, and the secret variables with
 * the container trust-boundary warning and its acknowledgement.
 */
export function PackageServerFields({ server, status, acknowledgement, secretValues, onSecretValues, acknowledged, onAcknowledged, onChange }: {
  server: ExtensionLibraryPackageServer;
  status?: ExtensionSecretStatus;
  /** The saved acknowledgement of this server, if any. */
  acknowledgement?: ExtensionSecretAcknowledgement;
  secretValues: Record<string, string>;
  onSecretValues: (values: Record<string, string>) => void;
  acknowledged: boolean;
  onAcknowledged: (acknowledged: boolean) => void;
  onChange: Patch;
}) {
  const warningId = useId();
  const [argsText, setArgsText] = useState(() => server.args.join('\n'));
  const [env, setEnv] = useState(() => envText(server.env));
  const versionInvalid = server.version !== '' && !isExactVersion(server.version);
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-sm">
          Package registry
          <select className={inputClass} value={server.ecosystem} onChange={() => onChange({ ecosystem: 'npm' })}>
            <option value="npm">npm</option>
          </select>
          <span className="mt-1 block text-xs text-slate-500">Public npm registry only. PyPI packages are not supported yet.</span>
        </label>
        <label className="text-sm">
          Package
          <input className={inputClass} value={server.package} placeholder="@scope/mcp-server" autoCapitalize="none" spellCheck={false}
            onChange={event => onChange({ package: event.target.value.trim() })} />
        </label>
        <label className="text-sm">
          Exact version
          <input className={inputClass} value={server.version} placeholder="1.2.3" aria-invalid={versionInvalid} spellCheck={false}
            onChange={event => onChange({ version: event.target.value.trim() })} />
          <span className={`mt-1 block text-xs ${versionInvalid ? 'text-red-700' : 'text-slate-500'}`}>
            {versionInvalid ? 'Enter an exact version such as 1.2.3. Ranges and tags (latest, ^1.2) are not accepted.' : 'Changing the version later is an explicit edit and a new library revision.'}
          </span>
        </label>
        <label className="text-sm">
          Executable (optional)
          <input className={inputClass} value={server.bin ?? ''} placeholder="Only when the package has several" spellCheck={false}
            onChange={event => onChange({ bin: event.target.value.trim() || undefined })} />
        </label>
      </div>
      <PackageCheck server={server} />
      {server.integrity && <p className="break-all text-xs text-slate-600">Pinned integrity: {server.integrity}</p>}
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-sm">
          Arguments
          <textarea className={`${inputClass} font-mono`} rows={3} value={argsText} spellCheck={false} placeholder={'--read-only\n--port=0'}
            onChange={event => { setArgsText(event.target.value); onChange({ args: lines(event.target.value) }); }} />
          <span className="mt-1 block text-xs text-slate-500">One argument per line, passed as is. No shell.</span>
        </label>
        <label className="text-sm">
          Variables
          <textarea className={`${inputClass} font-mono`} rows={3} value={env} spellCheck={false} placeholder="LOG_LEVEL=info"
            onChange={event => { setEnv(event.target.value); onChange({ env: parseEnv(event.target.value) }); }} />
          <span className="mt-1 block text-xs text-slate-500">One NAME=value per line. Plain values, saved with the server and shown here.</span>
        </label>
      </div>
      <SecretVariables server={server} status={status} values={secretValues} onValues={onSecretValues} onChange={onChange} />
      {server.secretEnv.length > 0 && (
        <div className="space-y-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
          <p id={warningId}>
            This server runs in the same container as the agent. The agent, its shell commands and the repository’s setup scripts can read
            these secret values; output redaction does not stop that. HTTPS servers keep their credential in ProPR instead. Use a narrowly
            scoped credential that is safe for the agent to hold.
          </p>
          <label className="flex items-start gap-2">
            <input type="checkbox" className="mt-0.5 h-4 w-4" checked={acknowledged} aria-describedby={warningId} onChange={event => onAcknowledged(event.target.checked)} />
            <span>I understand that these values are readable inside the task container.</span>
          </label>
          {acknowledgement && acknowledgementCovers(acknowledgement, server) && (
            <p className="text-xs">Acknowledged by user {acknowledgement.actor} on {new Date(acknowledgement.at).toLocaleString()}.</p>
          )}
        </div>
      )}
    </div>
  );
}
