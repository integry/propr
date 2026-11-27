import React, { useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { PI_PROVIDERS } from '@propr/shared';
import { buildPiModelId, describePiModel, piApiKeyEnvNames } from './piAgentFieldsUtils';

interface PiAgentFieldsProps {
  supportedModels: string[];
  defaultModel?: string;
  envVars: Record<string, string>;
  /** Show the API key inputs (API-key credentials, or keys already saved). */
  showApiKeys: boolean;
  apiKeyError?: string;
  onEnvVarChange: (name: string, value: string) => void;
  onAddModel: (modelId: string) => void;
}

const inputClass = 'w-full rounded-md border border-gray-300 bg-gray-50 px-3 py-1.5 font-mono text-sm text-gray-900 focus:border-primary-500 focus:ring-2 focus:ring-primary-500';

function ApiKeyInput({ name, value, onChange }: { name: string; value: string; onChange: (value: string) => void }) {
  const [visible, setVisible] = useState(false);
  const provider = PI_PROVIDERS.find(entry => entry.apiKeyEnv === name);
  return (
    <div>
      <label className="mb-1 block font-mono text-xs text-gray-600" htmlFor={`pi-env-${name}`}>
        {name}{provider ? <span className="ml-1 font-sans text-gray-400">({provider.label})</span> : null}
      </label>
      <div className="relative">
        <input
          id={`pi-env-${name}`}
          type={visible ? 'text' : 'password'}
          value={value}
          onChange={event => onChange(event.target.value)}
          placeholder={`Enter your ${provider?.label ?? name} key`}
          autoComplete="off"
          className={`${inputClass} pr-10`}
        />
        <button
          type="button"
          onClick={() => setVisible(!visible)}
          className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
          title={visible ? 'Hide API key' : 'Show API key'}
        >
          {visible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
        </button>
      </div>
    </div>
  );
}

const PiAgentFields: React.FC<PiAgentFieldsProps> = ({
  supportedModels, defaultModel, envVars, showApiKeys, apiKeyError, onEnvVarChange, onAddModel,
}) => {
  const [provider, setProvider] = useState(PI_PROVIDERS[0].id);
  const [model, setModel] = useState('');
  const modelId = buildPiModelId(provider, model);
  const duplicate = modelId !== undefined && supportedModels.includes(modelId);
  const apiKeyNames = piApiKeyEnvNames(supportedModels, defaultModel, envVars);

  const addModel = () => {
    if (!modelId || duplicate) return;
    onAddModel(modelId);
    setModel('');
  };

  return (
    <>
      {showApiKeys && (
        <div>
          <span className="mb-1.5 block text-sm font-medium text-gray-700">Provider API keys</span>
          {apiKeyNames.length > 0 ? (
            <div className="space-y-2">
              {apiKeyNames.map(name => (
                <ApiKeyInput key={name} name={name} value={envVars[name] || ''} onChange={value => onEnvVarChange(name, value)} />
              ))}
            </div>
          ) : (
            <p className="text-xs text-gray-500">Select a model from a provider that takes an API key.</p>
          )}
          {apiKeyError && <p className="mt-1 text-xs text-red-600">{apiKeyError}</p>}
          <p className="mt-1 text-xs text-gray-500">
            Keys are passed to Pi as environment variables, one per provider.
          </p>
        </div>
      )}

      <div>
        <span className="mb-1.5 block text-sm font-medium text-gray-700">Add a Pi model</span>
        <div className="flex flex-wrap gap-2">
          <label className="sr-only" htmlFor="pi-model-provider">Pi model provider</label>
          <select
            id="pi-model-provider"
            value={provider}
            onChange={event => setProvider(event.target.value)}
            className="rounded-md border border-gray-300 bg-gray-50 px-3 py-1.5 text-sm text-gray-900 focus:border-primary-500 focus:ring-2 focus:ring-primary-500"
          >
            {PI_PROVIDERS.map(entry => (
              <option key={entry.id} value={entry.id}>{entry.label}</option>
            ))}
          </select>
          <label className="sr-only" htmlFor="pi-model-id">Pi model id</label>
          <input
            id="pi-model-id"
            value={model}
            onChange={event => setModel(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter') {
                event.preventDefault();
                addModel();
              }
            }}
            placeholder={provider === 'openrouter' ? 'e.g. qwen/qwen3-coder' : 'Model id as Pi names it'}
            autoComplete="off"
            spellCheck={false}
            className={`${inputClass} min-w-0 flex-1`}
          />
          <button
            type="button"
            onClick={addModel}
            disabled={!modelId || duplicate}
            className="rounded-md bg-gray-100 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-200 disabled:cursor-not-allowed disabled:text-gray-400"
          >
            Add
          </button>
        </div>
        <p className="mt-1 text-xs text-gray-500">
          {duplicate
            ? 'This model is already in the list.'
            : modelId
              ? `Adds ${describePiModel(modelId)}.`
              : 'Enter the model id as Pi names it for this provider.'}
        </p>
      </div>
    </>
  );
};

export default PiAgentFields;
