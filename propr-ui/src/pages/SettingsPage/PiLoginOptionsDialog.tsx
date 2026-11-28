import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  getPiProviderInfo,
  isValidAgentLoginProvider,
  type AgentLoginOptions,
} from '@propr/shared';
import type { AgentConfig } from '../../api/proprApi';
import { ProviderLogo } from '../../components/ui/ProviderLogo';
import { piLoginProviderChoices } from './piAgentFieldsUtils';

interface PiLoginOptionsDialogProps {
  agent: AgentConfig;
  onStart: (options: AgentLoginOptions) => void;
  onClose: () => void;
}

const OTHER_PROVIDER = '__other__';

const PiLoginOptionsDialog: React.FC<PiLoginOptionsDialogProps> = ({ agent, onStart, onClose }) => {
  const choices = useMemo(() => piLoginProviderChoices(agent), [agent]);
  const [selected, setSelected] = useState(choices[0] ?? OTHER_PROVIDER);
  const [customProvider, setCustomProvider] = useState('');
  const provider = (selected === OTHER_PROVIDER ? customProvider : selected).trim().toLowerCase();
  const info = getPiProviderInfo(provider);
  // The method follows the resolved provider (a listed one or a typed custom
  // id): a choice made for one provider never carries over to another.
  // Providers without an account sign-in only take an API key.
  const [methodChoice, setMethodChoice] = useState<{ provider: string; apiKey: boolean } | undefined>();
  const keyOnly = info !== undefined && !info.accountLogin;
  const apiKey = keyOnly || (methodChoice?.provider === provider ? methodChoice.apiKey : false);
  const setApiKey = (value: boolean) => setMethodChoice({ provider, apiKey: value });
  const dialogRef = useRef<HTMLDivElement>(null);
  const valid = isValidAgentLoginProvider(provider);

  useEffect(() => {
    dialogRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const changeProvider = (next: string) => setSelected(next);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!valid) return;
    onStart({ provider, ...(apiKey && { apiKey: true }) });
  };

  return (
    <div
      data-testid="agent-login-backdrop"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onMouseDown={event => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="pi-login-title"
        tabIndex={-1}
        className="flex w-full max-w-lg flex-col overflow-hidden rounded-lg bg-white shadow-xl"
      >
        <form onSubmit={submit}>
          <div className="flex items-center gap-3 border-b border-gray-200 px-5 py-4">
            <ProviderLogo provider="pi" className="h-6 w-6 flex-shrink-0 text-gray-700" />
            <div className="min-w-0">
              <h2 id="pi-login-title" className="truncate text-lg font-semibold text-gray-900">
                Log in to {agent.alias}
              </h2>
              <p className="truncate text-xs text-gray-500">Credentials are saved to {agent.configPath}</p>
            </div>
          </div>

          <div className="space-y-4 p-5">
            <div>
              <label htmlFor="pi-login-provider" className="mb-1.5 block text-sm font-medium text-gray-700">
                Provider
              </label>
              <select
                id="pi-login-provider"
                value={selected}
                onChange={event => changeProvider(event.target.value)}
                className="w-full rounded-md border border-gray-300 bg-gray-50 px-3 py-1.5 text-sm text-gray-900 focus:border-primary-500 focus:ring-2 focus:ring-primary-500"
              >
                {choices.map(id => (
                  <option key={id} value={id}>
                    {getPiProviderInfo(id)?.label ?? id} ({id})
                  </option>
                ))}
                <option value={OTHER_PROVIDER}>Other provider…</option>
              </select>
              {selected === OTHER_PROVIDER && (
                <input
                  aria-label="Pi provider id"
                  value={customProvider}
                  onChange={event => setCustomProvider(event.target.value)}
                  placeholder="e.g. fireworks"
                  autoComplete="off"
                  spellCheck={false}
                  className="mt-2 w-full rounded-md border border-gray-300 bg-gray-50 px-3 py-1.5 font-mono text-sm text-gray-900 focus:border-primary-500 focus:ring-2 focus:ring-primary-500"
                />
              )}
              <p className="mt-1 text-xs text-gray-500">
                Pi keeps one login per provider. Log in again to add another provider.
              </p>
            </div>

            <fieldset>
              <legend className="mb-1.5 block text-sm font-medium text-gray-700">Login method</legend>
              <div className="grid grid-cols-2 gap-2">
                {[
                  { value: false, label: 'Sign in with an account', hint: 'Device code or a pasted redirect URL' },
                  { value: true, label: 'Save an API key', hint: 'Typed into the login terminal' },
                ].map(option => (
                  <button
                    key={option.label}
                    type="button"
                    aria-pressed={apiKey === option.value}
                    disabled={!option.value && keyOnly}
                    onClick={() => setApiKey(option.value)}
                    className={`rounded-md border px-3 py-2 text-left text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                      apiKey === option.value
                        ? 'border-primary-500 bg-primary-50 text-primary-700'
                        : 'border-gray-300 bg-white text-gray-700 hover:bg-gray-50'
                    }`}
                  >
                    {option.label}
                    <span className="mt-0.5 block text-xs font-normal text-gray-500">{option.hint}</span>
                  </button>
                ))}
              </div>
            </fieldset>
          </div>

          <div className="flex justify-end gap-2 border-t border-gray-200 px-5 py-3">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!valid}
              className="rounded-md bg-primary-600 px-4 py-2 text-sm font-medium text-white hover:bg-primary-700 disabled:cursor-not-allowed disabled:bg-gray-300"
            >
              Start login
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default PiLoginOptionsDialog;
