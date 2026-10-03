import React, { useEffect, useId, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, ChevronUp, LogIn, MoreHorizontal, Pencil, Trash2 } from 'lucide-react';
import { isAgentLoginSupported } from '@propr/shared';
import { AgentConfig } from '../../api/proprApi';
import { type AgentType, MODEL_INFO_MAP } from '../../config/modelDefinitions';
import { ProviderLogo } from '../../components/ui/ProviderLogo';
import './AgentCard.css';
import type { AgentHealthState } from './useAgentHealth';
import AgentHealthFeedback from './AgentHealthFeedback';

const AliasChip: React.FC<{ alias: string; modelId: string }> = ({ alias, modelId }) => {
  const [copyStatus, setCopyStatus] = useState<'copied' | 'failed' | null>(null);

  useEffect(() => {
    if (!copyStatus) return;
    const timeout = setTimeout(() => setCopyStatus(null), 2000);
    return () => clearTimeout(timeout);
  }, [copyStatus]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(alias);
      setCopyStatus('copied');
    } catch {
      setCopyStatus('failed');
    }
  };

  return (
    <div className="min-w-0 text-right">
      <button
        type="button"
        onClick={() => void handleCopy()}
        aria-label={`Copy ${alias}`}
        title={`${modelId} — Click to copy ${alias}`}
        className="max-w-full truncate rounded-sm border border-slate-200 bg-slate-100 px-1.5 py-0.5 align-middle font-mono text-[10px] leading-4 text-slate-700 transition-colors hover:bg-slate-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500"
      >
        {copyStatus === 'copied' ? 'Copied' : copyStatus === 'failed' ? 'Copy failed' : alias}
      </button>
      <span role="status" className="sr-only">
        {copyStatus === 'copied' ? `Copied ${alias}` : copyStatus === 'failed' ? `Could not copy ${alias}` : ''}
      </span>
    </div>
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

// The catalog is ordered for capability rather than release date, so unknown
// and custom model IDs intentionally stay visible.
const LEGACY_MODEL_IDS: Partial<Record<AgentType, ReadonlySet<string>>> = {
  claude: new Set([
    'claude-fable-5', 'claude-opus-5', 'claude-sonnet-5', 'claude-opus-4-8',
    'claude-opus-4-7', 'claude-opus-4-6', 'claude-sonnet-4-6',
    'claude-opus-4-5-20251101', 'claude-sonnet-4-5-20250929', 'claude-haiku-4-5-20251001',
  ]),
  codex: new Set([
    'gpt-5.5', 'gpt-5.5-pro', 'gpt-5.4', 'gpt-5.4-pro', 'gpt-5.4-mini', 'gpt-5.4-nano',
    'gpt-5.3-codex', 'gpt-5.3-codex-spark', 'gpt-5.2', 'gpt-5-mini', 'gpt-5-nano',
  ]),
  antigravity: new Set([
    'antigravity-gemini-3.6-flash', 'antigravity-gemini-3.5-flash',
    'antigravity-gemini-3.1-pro',
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
  <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,30%)] items-center gap-2 px-2 py-1 text-sm transition-colors hover:bg-slate-50">
    <div className="flex items-center gap-1.5 flex-1 min-w-0">
      <button
        type="button"
        onClick={onSelect}
        disabled={selectionDisabled || !onSelect}
        aria-label={`Select ${getModelDisplayName(modelId, modelInfo)}${customLabel ? ` (${customLabel})` : ''} from ${agentAlias} in Playground`}
        className="flex min-w-0 items-center gap-1.5 rounded-sm text-left enabled:cursor-pointer enabled:hover:text-teal-700 enabled:focus-visible:outline-none enabled:focus-visible:ring-2 enabled:focus-visible:ring-teal-500 disabled:cursor-default"
      >
        <span title={getModelDisplayName(modelId, modelInfo)} className={`truncate text-[13px] ${isDefault ? 'font-medium text-gray-900' : 'text-gray-700'}`}>
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

    <div className="text-right font-mono text-[11px] text-slate-500">
      {modelInfo?.contextWindow && (
        <span title={`${modelInfo.contextWindow} context window`}>
          {modelInfo.contextWindow}<span className="sr-only"> context</span>
        </span>
      )}
    </div>

    <AliasChip alias={modelInfo?.shortAlias || modelId} modelId={modelId} />
  </div>
);

const LegacyModelsToggle: React.FC<{
  count: number;
  expanded: boolean;
  onToggle: () => void;
}> = ({ count, expanded, onToggle }) => {
  if (count === 0) return null;

  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={expanded}
      className="flex min-h-8 w-full cursor-pointer items-center justify-center gap-1.5 border-y border-dashed border-slate-200 bg-transparent py-2 text-[11px] font-medium text-slate-500 transition-colors hover:border-slate-300 hover:bg-slate-50 hover:text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-teal-500"
    >
      {expanded
        ? <ChevronUp className="h-3.5 w-3.5" aria-hidden="true" />
        : <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />}
      {expanded
        ? 'Hide legacy models'
        : `Show ${count} legacy ${count === 1 ? 'model' : 'models'}`}
    </button>
  );
};

interface AgentCardProps {
  agent: AgentConfig;
  onLogin: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onToggle: () => void;
  onSelectModel?: (agentId: string, modelId: string) => void;
  readOnly?: boolean;
  health?: AgentHealthState;
  onRecheck?: () => void;
}

const AgentHeaderStatus: React.FC<{ enabled: boolean; health?: AgentHealthState }> = ({ enabled, health }) => {
  if (!enabled || health?.status === 'disabled') return (
    <span role="status" className="inline-flex items-center gap-1 text-[11px] text-slate-400">
      <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full border border-slate-400" />
      Inactive
    </span>
  );
  if (health?.status !== 'ready' && health?.status !== 'checking') return null;
  const ready = health.status === 'ready';
  return (
    <span role="status" title={ready ? `Checked with ${health.model}` : 'Checking agent…'} className="inline-flex shrink-0 items-center gap-1 text-[11px] text-slate-500">
      <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${ready ? 'bg-emerald-500' : 'animate-pulse bg-slate-400'}`} />
      {ready ? 'Ready' : <><span aria-hidden="true">Checking…</span><span className="sr-only">Checking agent…</span></>}
    </span>
  );
};

const AgentCard: React.FC<AgentCardProps> = ({
  agent,
  onLogin,
  onEdit,
  onDelete,
  onToggle,
  onSelectModel,
  readOnly = false,
  health,
  onRecheck,
}) => {
  const [expanded, setExpanded] = useState(agent.type === 'claude' || agent.type === 'codex');
  const [showLegacyModels, setShowLegacyModels] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const modelsId = useId();
  const menuId = useId();
  const menuRef = useRef<HTMLDivElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus();
    const closeOutside = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMenuOpen(false);
        menuButtonRef.current?.focus();
      }
    };
    document.addEventListener('pointerdown', closeOutside);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOutside);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [menuOpen]);

  const runAction = (action: () => void) => {
    setMenuOpen(false);
    menuButtonRef.current?.focus();
    action();
  };

  const handleMenuKeyDown = (event: React.KeyboardEvent) => {
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? []);
    if (!items.length) return;
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    let nextIndex: number;
    switch (event.key) {
      case 'ArrowDown': nextIndex = (index + 1) % items.length; break;
      case 'ArrowUp': nextIndex = (index - 1 + items.length) % items.length; break;
      case 'Home': nextIndex = 0; break;
      case 'End': nextIndex = items.length - 1; break;
      default: return;
    }
    event.preventDefault();
    items[nextIndex].focus();
  };
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
    <div className={`coding-agent-card relative border-b border-slate-100 py-4 first:pt-0 ${menuOpen ? 'z-30' : ''}`}>
      <div className={`coding-agent-header grid items-center gap-x-2 gap-y-1 ${menuOpen ? 'coding-agent-header-menu-open' : ''}`}>
        <button
          type="button"
          onClick={() => setExpanded(current => !current)}
          aria-expanded={expanded}
          aria-controls={modelsId}
          aria-label={`${expanded ? 'Collapse' : 'Expand'} ${agent.alias} models`}
          className="coding-agent-name flex min-h-8 min-w-0 items-center gap-2 rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500"
        >
          {expanded
            ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-slate-500" aria-hidden="true" />
            : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-slate-500" aria-hidden="true" />}
          <ProviderLogo provider={agent.type} className="h-5 w-5 shrink-0 text-slate-700" />
          <span className="min-w-0 truncate font-semibold text-slate-900" title={agent.alias}>{agent.alias}</span>
          <span className="shrink-0 text-[11px] text-slate-500">
            ({currentModels.length} {currentModels.length === 1 ? 'model' : 'models'})
          </span>
        </button>

        <div className="coding-agent-actions flex items-center justify-end gap-2">
          <label className={`relative inline-flex items-center ${readOnly ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'}`}>
            <input
              type="checkbox"
              aria-label={`Enable ${agent.alias}`}
              checked={agent.enabled}
              onChange={onToggle}
              disabled={readOnly}
              className="sr-only peer"
            />
            <div className="w-8 h-4 bg-gray-200 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-primary-500 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-3 after:w-3 after:transition-all peer-checked:bg-primary-600"></div>
          </label>

          <div
            ref={menuRef}
            className="relative"
            onBlur={event => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setMenuOpen(false);
            }}
          >
            <button
              ref={menuButtonRef}
              type="button"
              onClick={() => setMenuOpen(current => !current)}
              aria-label={`More actions for ${agent.alias}`}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              aria-controls={menuOpen ? menuId : undefined}
              className="flex h-8 w-8 items-center justify-center rounded text-slate-500 hover:bg-slate-100 hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500"
            >
              <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
            </button>
            {menuOpen && (
              <div
                id={menuId}
                role="menu"
                aria-label={`Actions for ${agent.alias}`}
                onKeyDown={handleMenuKeyDown}
                className="absolute right-0 top-full z-20 mt-1 w-44 rounded-md border border-slate-200 bg-white p-1 shadow-lg"
              >
                {isAgentLoginSupported(agent.type) && !(health?.status === 'error' && health.errorCode === 'rate_limit') && (
                  <button type="button" role="menuitem" disabled={readOnly} onClick={() => runAction(onLogin)} className="flex min-h-9 w-full items-center gap-2 rounded px-2 text-left text-xs text-slate-700 hover:bg-slate-50 focus:bg-slate-50 focus:outline-none disabled:cursor-not-allowed disabled:text-slate-300">
                    <LogIn className="h-3.5 w-3.5" aria-hidden="true" />Log in
                  </button>
                )}
                <button type="button" role="menuitem" disabled={readOnly} onClick={() => runAction(onEdit)} className="flex min-h-9 w-full items-center gap-2 rounded px-2 text-left text-xs text-slate-700 hover:bg-slate-50 focus:bg-slate-50 focus:outline-none disabled:cursor-not-allowed disabled:text-slate-300">
                  <Pencil className="h-3.5 w-3.5" aria-hidden="true" />Edit path
                </button>
                <button type="button" role="menuitem" disabled={readOnly} onClick={() => runAction(onDelete)} className="flex min-h-9 w-full items-center gap-2 rounded px-2 text-left text-xs text-red-600 hover:bg-red-50 focus:bg-red-50 focus:outline-none disabled:cursor-not-allowed disabled:text-slate-300">
                  <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />Delete provider
                </button>
              </div>
            )}
          </div>
        </div>

        <code className="coding-agent-path min-w-0 truncate font-mono text-[11px] text-slate-500" title={agent.configPath}>
          {agent.configPath}
        </code>
        <div className="coding-agent-status min-w-0">
          <AgentHeaderStatus enabled={agent.enabled} health={health} />
        </div>
      </div>

      {agent.enabled && health?.status === 'error' && (
        <AgentHealthFeedback agent={agent} health={health} onLogin={onLogin} onRecheck={onRecheck} readOnly={readOnly} />
      )}

      <div id={modelsId} hidden={!expanded} className="mt-2">
        {currentModels.map(renderModelRow)}
        <LegacyModelsToggle
          count={legacyModels.length}
          expanded={showLegacyModels}
          onToggle={() => setShowLegacyModels(current => !current)}
        />
        {showLegacyModels && legacyModels.map(renderModelRow)}
      </div>
    </div>
  );
};

export default AgentCard;
