import React, { useEffect, useMemo, useState } from 'react';
import { ExternalLink, KeyRound } from 'lucide-react';
import {
  pastedAgentCredentialDefinitions,
  type AgentCredentialStatusResponse,
  type PastedAgentCredentialKind,
} from '@propr/shared';
import type { AgentType } from '../../config/modelDefinitions';
import { clearAgentCredential, getAgentCredentials } from '../../api/agentCredentialApi';
import InlineCodeText from './InlineCodeText';

export interface PendingAgentCredential {
  kind: PastedAgentCredentialKind;
  value: string;
}

interface AgentPastedCredentialsProps {
  type: AgentType;
  /** A saved agent: its stored credentials are shown (set + last four characters) and can be removed. */
  agentId?: string;
  value: PendingAgentCredential | null;
  onChange: (next: PendingAgentCredential | null) => void;
  error?: string;
}

const inputClass = 'w-full px-3 py-1.5 bg-gray-50 text-gray-900 border rounded-md focus:ring-2 focus:ring-primary-500 focus:border-primary-500 font-mono text-sm';

const StoredCredentialStatus: React.FC<{
  label: string;
  stored?: { set: boolean; last4?: string };
  loginPresent: boolean;
  removing: boolean;
  onRemove: () => void;
}> = ({ label, stored, loginPresent, removing, onRemove }) => (
  <div className="mb-2 flex flex-wrap items-center gap-2 text-xs" role="status">
    <KeyRound className="h-3.5 w-3.5 text-gray-500" aria-hidden="true" />
    {stored?.set ? (
      <>
        <span className="font-medium text-emerald-700">
          {label}: set{stored.last4 ? <> · ends in <code className="font-mono">{stored.last4}</code></> : null}
        </span>
        <button
          type="button"
          onClick={onRemove}
          disabled={removing}
          className="rounded border border-gray-300 bg-white px-2 py-0.5 font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {removing ? 'Removing…' : 'Remove'}
        </button>
      </>
    ) : (
      <span className="text-gray-600">{label}: not set</span>
    )}
    {loginPresent && <span className="text-gray-600">· interactive login stored</span>}
  </div>
);

const CredentialInput: React.FC<{
  id: string;
  label: string;
  multiline: boolean;
  placeholder: string;
  value: string;
  invalid: boolean;
  onChange: (value: string) => void;
}> = ({ id, label, multiline, placeholder, value, invalid, onChange }) => {
  const className = `${inputClass} ${invalid ? 'border-red-500' : 'border-gray-300'}`;
  return (
    <>
      <label className="sr-only" htmlFor={id}>{label}</label>
      {multiline ? (
        <textarea id={id} value={value} onChange={event => onChange(event.target.value)} placeholder={placeholder}
          rows={4} spellCheck={false} autoComplete="off" className={className} />
      ) : (
        <input id={id} type="password" value={value} onChange={event => onChange(event.target.value)} placeholder={placeholder}
          autoComplete="new-password" spellCheck={false} className={className} />
      )}
    </>
  );
};

/**
 * Write-only credential entry: the value goes to the agent's credential store
 * when the agent is saved and is never shown again. Saved agents show which
 * kinds are set, with the last four characters only.
 */
const AgentPastedCredentials: React.FC<AgentPastedCredentialsProps> = ({ type, agentId, value, onChange, error }) => {
  const definitions = useMemo(() => pastedAgentCredentialDefinitions(type), [type]);
  const [selected, setSelected] = useState<PastedAgentCredentialKind | undefined>(value?.kind ?? definitions[0]?.kind);
  const [status, setStatus] = useState<AgentCredentialStatusResponse | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);

  useEffect(() => {
    if (!definitions.some(definition => definition.kind === selected)) setSelected(definitions[0]?.kind);
  }, [definitions, selected]);

  useEffect(() => {
    let cancelled = false;
    setStatus(null);
    if (!agentId) return;
    getAgentCredentials(agentId)
      .then(result => { if (!cancelled) setStatus(result); })
      .catch(() => { if (!cancelled) setStatus(null); });
    return () => { cancelled = true; };
  }, [agentId, type]);

  if (definitions.length === 0) return null;
  const definition = definitions.find(item => item.kind === selected) ?? definitions[0];
  const stored = status?.credentials.find(item => item.kind === definition.kind);
  const draft = value?.kind === definition.kind ? value.value : '';

  const select = (kind: PastedAgentCredentialKind) => {
    setSelected(kind);
    if (value && value.kind !== kind) onChange(null);
  };
  const update = (next: string) => onChange(next ? { kind: definition.kind, value: next } : null);
  const remove = async () => {
    if (!agentId) return;
    setRemoving(true);
    setStatusError(null);
    try {
      setStatus(await clearAgentCredential(agentId, definition.kind));
    } catch (removeError) {
      setStatusError((removeError as Error).message);
    } finally {
      setRemoving(false);
    }
  };

  return (
    <div data-testid="agent-pasted-credentials">
      <span className="block text-gray-700 mb-1.5 font-medium text-sm">
        {agentId ? 'Paste credentials' : 'Credential to paste'}
      </span>
      {definitions.length > 1 && (
        <div className="grid grid-cols-2 gap-2 mb-2" role="group" aria-label="Credential type">
          {definitions.map(item => (
            <button
              key={item.kind}
              type="button"
              aria-pressed={item.kind === definition.kind}
              onClick={() => select(item.kind)}
              className={`rounded-md border px-3 py-1.5 text-left text-xs font-medium transition-colors ${
                item.kind === definition.kind
                  ? 'border-primary-500 bg-primary-50 text-primary-700'
                  : 'border-gray-300 bg-white text-gray-700 hover:bg-gray-50'
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
      {agentId && status && (
        <StoredCredentialStatus label={definition.label} stored={stored} loginPresent={status.loginPresent} removing={removing} onRemove={() => void remove()} />
      )}
      {statusError && <p className="mb-1 text-xs text-red-600">{statusError}</p>}
      <CredentialInput
        id={`pasted-credential-${definition.kind}`}
        label={definition.label}
        multiline={definition.multiline}
        placeholder={stored?.set && !definition.multiline ? 'Paste a new value to replace it' : definition.placeholder}
        value={draft}
        invalid={Boolean(error)}
        onChange={update}
      />
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
      <p className="mt-1 text-xs text-gray-500"><InlineCodeText text={definition.description} /></p>
      <p className="mt-1 text-xs text-gray-500 flex flex-wrap items-center gap-x-1">
        Stored in this agent&apos;s credential store when you save, and never shown again. Get it from:
        {definition.links.map((link, index) => (
          <React.Fragment key={link.url}>
            {index > 0 && ' or '}
            <a href={link.url} target="_blank" rel="noopener noreferrer" className="text-primary-600 hover:text-primary-700 inline-flex items-center gap-0.5">
              {link.label} <ExternalLink className="w-3 h-3" />
            </a>
          </React.Fragment>
        ))}
      </p>
    </div>
  );
};

export default AgentPastedCredentials;
