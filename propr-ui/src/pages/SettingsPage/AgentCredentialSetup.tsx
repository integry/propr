import React from 'react';
import { isAgentLoginSupported } from '@propr/shared';
import {
  AGENT_DEFAULTS,
  type AgentType,
} from '../../config/modelDefinitions';
import type { CredentialSetup } from './agentCredentialSetupUtils';

interface AgentCredentialSetupProps {
  isEditing: boolean;
  type: AgentType;
  configPath: string;
  credentialSetup: CredentialSetup;
  configPathError?: string;
  onCredentialSetupChange: (value: CredentialSetup) => void;
  onConfigPathChange: (value: string) => void;
}

const AgentCredentialSetup: React.FC<AgentCredentialSetupProps> = ({
  isEditing,
  type,
  configPath,
  credentialSetup,
  configPathError,
  onCredentialSetupChange,
  onConfigPathChange,
}) => {
  const supportsLogin = isAgentLoginSupported(type);

  return (
    <>
      {!isEditing && supportsLogin && (
        <div>
          <span className="block text-gray-700 mb-1.5 font-medium text-sm">Credentials</span>
          <div className="grid grid-cols-2 gap-2" role="group" aria-label="Credential setup">
            {[
              { value: 'login' as const, label: 'Log in to a new account' },
              { value: 'existing' as const, label: 'Use existing config' },
            ].map(option => (
              <button
                key={option.value}
                type="button"
                aria-pressed={credentialSetup === option.value}
                onClick={() => onCredentialSetupChange(option.value)}
                className={`rounded-md border px-3 py-2 text-left text-sm font-medium transition-colors ${
                  credentialSetup === option.value
                    ? 'border-primary-500 bg-primary-50 text-primary-700'
                    : 'border-gray-300 bg-white text-gray-700 hover:bg-gray-50'
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>
          {credentialSetup === 'login' && (
            <div className="mt-2 rounded-md border border-cyan-200 bg-cyan-50 px-3 py-2 text-xs text-cyan-900">
              ProPR will keep this account isolated at{' '}
              <code className="break-all font-mono">{configPath}</code> and open the provider login after saving.
            </div>
          )}
        </div>
      )}

      {(isEditing || !supportsLogin || credentialSetup === 'existing') && (
        <div>
          <label className="block text-gray-700 mb-1.5 font-medium text-sm" htmlFor="configPath">
            Config Path
          </label>
          <input
            type="text"
            id="configPath"
            value={configPath}
            onChange={event => onConfigPathChange(event.target.value)}
            placeholder={AGENT_DEFAULTS[type].configPath}
            className={`w-full px-3 py-1.5 bg-gray-50 text-gray-900 border rounded-md focus:ring-2 focus:ring-primary-500 focus:border-primary-500 font-mono text-sm ${
              configPathError ? 'border-red-500' : 'border-gray-300'
            }`}
          />
          {configPathError && <p className="mt-1 text-xs text-red-600">{configPathError}</p>}
          {!isEditing && credentialSetup === 'existing' && (
            <p className="mt-1 text-xs text-gray-500">
              ProPR will reuse this directory. Provider login and agent runs may refresh files in it.
            </p>
          )}
        </div>
      )}
    </>
  );
};

export default AgentCredentialSetup;
