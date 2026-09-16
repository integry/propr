import React, { useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { isAgentLoginSupported } from '@propr/shared';
import { AgentConfig } from '../../api/proprApi';
import { type AgentType, MODEL_INFO_MAP, typeBadgeColors } from '../../config/modelDefinitions';
import { ProviderLogo } from '../../components/ui/ProviderLogo';

const CopyIcon: React.FC<{ className?: string }> = ({ className = 'w-4 h-4' }) => (
  <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
  </svg>
);

const CheckIcon: React.FC<{ className?: string }> = ({ className = 'w-4 h-4' }) => (
  <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
  </svg>
);

const PencilIcon: React.FC<{ className?: string }> = ({ className = 'w-4 h-4' }) => (
  <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
  </svg>
);

const TrashIcon: React.FC<{ className?: string }> = ({ className = 'w-4 h-4' }) => (
  <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
  </svg>
);

const GitHubIcon: React.FC<{ className?: string }> = ({ className = 'w-4 h-4' }) => (
  <svg className={className} fill="currentColor" viewBox="0 0 24 24">
    <path fillRule="evenodd" clipRule="evenodd" d="M12 2C6.477 2 2 6.477 2 12c0 4.42 2.865 8.17 6.839 9.49.5.092.682-.217.682-.482 0-.237-.008-.866-.013-1.7-2.782.604-3.369-1.34-3.369-1.34-.454-1.156-1.11-1.463-1.11-1.463-.908-.62.069-.608.069-.608 1.003.07 1.531 1.03 1.531 1.03.892 1.529 2.341 1.087 2.91.831.092-.646.35-1.086.636-1.336-2.22-.253-4.555-1.11-4.555-4.943 0-1.091.39-1.984 1.029-2.683-.103-.253-.446-1.27.098-2.647 0 0 .84-.269 2.75 1.025A9.578 9.578 0 0112 6.836c.85.004 1.705.114 2.504.336 1.909-1.294 2.747-1.025 2.747-1.025.546 1.377.203 2.394.1 2.647.64.699 1.028 1.592 1.028 2.683 0 3.842-2.339 4.687-4.566 4.935.359.309.678.919.678 1.852 0 1.336-.012 2.415-.012 2.743 0 .267.18.578.688.48C19.138 20.167 22 16.418 22 12c0-5.523-4.477-10-10-10z" />
  </svg>
);

const CodeChip: React.FC<{ children: React.ReactNode; className?: string }> = ({ children, className = '' }) => (
  <code className={`rounded-md border border-gray-200 bg-gray-100 px-1.5 py-0.5 font-mono text-xs text-gray-700 ${className}`}>
    {children}
  </code>
);

const CopyButton: React.FC<{ text: string; className?: string }> = ({ text, className = '' }) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = (event: React.MouseEvent) => {
    event.stopPropagation();
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <button
      onClick={handleCopy}
      className={`text-gray-400 hover:text-gray-600 transition-colors inline-flex items-center justify-center ${className}`}
      title="Copy to clipboard"
    >
      {copied ? <CheckIcon className="w-3 h-3 text-green-500" /> : <CopyIcon className="w-3 h-3" />}
    </button>
  );
};

function getModelDisplayName(modelId: string, modelInfo: typeof MODEL_INFO_MAP[string] | undefined): string {
  if (modelInfo?.name) return modelInfo.name;
  const gptMatch = modelId.match(/^gpt-(\d+(?:\.\d+)?)(?:-(.+))?$/i);
  if (!gptMatch) return modelId;
  const suffix = gptMatch[2]
    ? ` ${gptMatch[2].split('-').map(part => part.charAt(0).toUpperCase() + part.slice(1)).join(' ')}`
    : '';
  return `GPT-${gptMatch[1]}${suffix}`;
}

const getAgentTypeLabel = (type: AgentType) => type === 'opencode' ? 'OpenCode' : type === 'muse' ? 'Muse Code' : type;

// The catalog is ordered for capability rather than release date, so unknown
// and custom model IDs intentionally stay visible.
const LEGACY_MODEL_IDS: Partial<Record<AgentType, ReadonlySet<string>>> = {
  claude: new Set([
    'claude-fable-5', 'claude-opus-4-7', 'claude-opus-4-6', 'claude-sonnet-4-6',
    'claude-opus-4-5-20251101', 'claude-sonnet-4-5-20250929', 'claude-haiku-4-5-20251001',
  ]),
  codex: new Set([
    'gpt-5.5', 'gpt-5.5-pro', 'gpt-5.4', 'gpt-5.4-pro', 'gpt-5.4-mini', 'gpt-5.4-nano',
    'gpt-5.3-codex', 'gpt-5.3-codex-spark', 'gpt-5.2', 'gpt-5-mini', 'gpt-5-nano',
  ]),
  antigravity: new Set([
    'antigravity-gemini-3.6-flash-medium', 'antigravity-gemini-3.6-flash-high',
    'antigravity-gemini-3.6-flash-low', 'antigravity-gemini-3.5-flash-medium',
    'antigravity-gemini-3.5-flash-high', 'antigravity-gemini-3.5-flash-low',
    'antigravity-gemini-3.1-pro-low', 'antigravity-gemini-3.1-pro-high',
  ]),
};

const isLegacyModel = (agentType: AgentType, modelId: string) =>
  LEGACY_MODEL_IDS[agentType]?.has(modelId) ?? false;

const ModelRow: React.FC<{
  modelId: string;
  modelInfo: typeof MODEL_INFO_MAP[string] | undefined;
  isDefault: boolean;
  customLabel?: string;
  agentAlias: string;
  onSelect?: () => void;
  selectionDisabled?: boolean;
}> = ({
  modelId,
  modelInfo,
  isDefault,
  customLabel,
  agentAlias,
  onSelect,
  selectionDisabled = false,
}) => (
  <div className="flex flex-wrap items-center px-2 py-1 text-sm transition-colors hover:bg-slate-50 xl:flex-nowrap">
    <div className="flex items-center gap-1.5 flex-1 min-w-0">
      <button
        type="button"
        onClick={onSelect}
        disabled={selectionDisabled || !onSelect}
        aria-label={`Select ${getModelDisplayName(modelId, modelInfo)}${customLabel ? ` (${customLabel})` : ''} from ${agentAlias} in Playground`}
        className="flex min-w-0 items-center gap-1.5 rounded-sm text-left enabled:cursor-pointer enabled:hover:text-teal-700 enabled:focus-visible:outline-none enabled:focus-visible:ring-2 enabled:focus-visible:ring-teal-500 disabled:cursor-default"
      >
        <span className={`truncate text-[13px] ${isDefault ? 'font-medium text-gray-900' : 'text-gray-700'}`}>
          {getModelDisplayName(modelId, modelInfo)}
        </span>
        {customLabel && (
          <span className="px-1 py-0.5 bg-amber-50 text-amber-700 border border-amber-200 text-[9px] rounded font-medium flex-shrink-0">
            {customLabel}
          </span>
        )}
        {isDefault && (
          <span className="px-1 py-0.5 bg-teal-50 text-teal-700 border border-teal-200 text-[8px] rounded uppercase font-semibold tracking-wide flex-shrink-0">
            Default
          </span>
        )}
      </button>
    </div>

    <div className="mr-3 hidden w-14 flex-shrink-0 text-right xl:block">
      {modelInfo?.contextWindow && (
        <span className="font-mono text-[11px] text-gray-500">{modelInfo.contextWindow}</span>
      )}
    </div>

    <div className="scrollbar-stealth mt-2 flex w-full min-w-0 flex-nowrap items-center justify-start gap-1 overflow-x-auto pb-1 xl:mt-0 xl:w-[220px] xl:flex-wrap xl:justify-end xl:overflow-visible xl:pb-0">
      <span className="inline-flex flex-shrink-0 items-center gap-0.5">
        <CodeChip className="bg-purple-50 text-purple-700 border-purple-200 text-[10px]">{modelId}</CodeChip>
        <CopyButton text={modelId} className="hover:text-purple-600" />
      </span>
      {modelInfo?.shortAlias && (
        <span className="inline-flex flex-shrink-0 items-center gap-0.5">
          <CodeChip className="text-[10px]">{modelInfo.shortAlias}</CodeChip>
          <CopyButton text={modelInfo.shortAlias} />
        </span>
      )}
    </div>
  </div>
);

interface AgentCardProps {
  agent: AgentConfig;
  onLogin: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onToggle: () => void;
  onSelectModel?: (agentId: string, modelId: string) => void;
  readOnly?: boolean;
}

const AgentCard: React.FC<AgentCardProps> = ({
  agent,
  onLogin,
  onEdit,
  onDelete,
  onToggle,
  onSelectModel,
  readOnly = false,
}) => {
  const [showLegacyModels, setShowLegacyModels] = useState(false);
  const currentModels = agent.supportedModels.filter(modelId => !isLegacyModel(agent.type, modelId));
  const legacyModels = agent.supportedModels.filter(modelId => isLegacyModel(agent.type, modelId));

  const renderModelRow = (modelId: string) => (
    <ModelRow
      key={modelId}
      modelId={modelId}
      modelInfo={MODEL_INFO_MAP[modelId]}
      isDefault={agent.defaultModel === modelId}
      customLabel={agent.modelCustomLabels?.[modelId]}
      agentAlias={agent.alias}
      onSelect={() => onSelectModel?.(agent.id, modelId)}
      selectionDisabled={!agent.enabled || !onSelectModel}
    />
  );

  return (
    <div className="border-b border-slate-100 py-4 first:pt-0">
      <div className="flex flex-col gap-2 xl:flex-row xl:items-center xl:justify-between">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <ProviderLogo provider={agent.type} className="w-5 h-5 text-gray-700 flex-shrink-0" />
          <span className="min-w-0 truncate font-semibold text-gray-900">{agent.alias}</span>
          <span className={`px-1.5 py-0.5 text-[10px] font-medium rounded border capitalize ${typeBadgeColors[agent.type]}`}>
            {getAgentTypeLabel(agent.type)}
          </span>
          <span className="min-w-0 basis-full xl:basis-auto">
            <CodeChip className="block max-w-full truncate">{agent.configPath}</CodeChip>
          </span>
        </div>

        <div className="flex items-center gap-1.5 self-end xl:self-auto">
          {isAgentLoginSupported(agent.type) && (
            <button
              onClick={onLogin}
              disabled={readOnly}
              className={`rounded border px-2 py-1 text-[11px] font-medium transition-colors ${
                readOnly
                  ? 'cursor-not-allowed border-gray-200 text-gray-300'
                  : 'border-gray-300 text-gray-600 hover:border-primary-300 hover:bg-primary-50 hover:text-primary-700'
              }`}
              title={readOnly ? 'Demo mode is read-only' : `Log in to ${agent.alias}`}
            >
              Log in
            </button>
          )}

          <label className={`relative inline-flex items-center ${readOnly ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'}`}>
            <input
              type="checkbox"
              checked={agent.enabled}
              onChange={onToggle}
              disabled={readOnly}
              className="sr-only peer"
            />
            <div className="w-8 h-4 bg-gray-200 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-primary-500 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-3 after:w-3 after:transition-all peer-checked:bg-primary-600"></div>
          </label>

          <button
            onClick={onEdit}
            disabled={readOnly}
            className={`p-1 rounded transition-colors ${readOnly ? 'cursor-not-allowed text-gray-300' : 'text-gray-400 hover:text-gray-600 hover:bg-gray-50'}`}
            title={readOnly ? 'Demo mode is read-only' : 'Edit agent'}
          >
            <PencilIcon className="w-3.5 h-3.5" />
          </button>

          <button
            onClick={onDelete}
            disabled={readOnly}
            className={`p-1 rounded transition-colors ${readOnly ? 'cursor-not-allowed text-gray-300' : 'text-gray-400 hover:text-red-600 hover:bg-red-50'}`}
            title={readOnly ? 'Demo mode is read-only' : 'Delete agent'}
          >
            <TrashIcon className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      <div className="mt-3 xl:ml-7">
        <div className="hidden items-center border-b border-slate-100 px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-gray-400 xl:flex">
          <div className="flex-1">Model</div>
          <div className="w-14 text-right flex-shrink-0 mr-3">Context</div>
          <div className="flex items-center gap-1 w-[220px] justify-end">
            <GitHubIcon className="w-3 h-3" />
            <span>ID / Alias</span>
          </div>
        </div>

        {currentModels.map(renderModelRow)}
        {legacyModels.length > 0 && (
          <button
            type="button"
            onClick={() => setShowLegacyModels(current => !current)}
            aria-expanded={showLegacyModels}
            className="flex min-h-11 w-full cursor-pointer items-center justify-center gap-1.5 border-y border-dashed border-slate-200 bg-transparent py-2 text-[11px] font-medium text-slate-500 transition-colors hover:border-slate-300 hover:bg-slate-50 hover:text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-teal-500 xl:min-h-0"
          >
            {showLegacyModels
              ? <ChevronUp className="h-3.5 w-3.5" aria-hidden="true" />
              : <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />}
            {showLegacyModels
              ? 'Hide legacy models'
              : `Show ${legacyModels.length} legacy ${legacyModels.length === 1 ? 'model' : 'models'}`}
          </button>
        )}
        {showLegacyModels && legacyModels.map(renderModelRow)}
      </div>
    </div>
  );
};

export default AgentCard;
