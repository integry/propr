import React, { useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Sparkles, ChevronDown, Check } from 'lucide-react';
import { ProviderLogo } from '../ui/ProviderLogo';
import { MODEL_INFO_MAP } from '../../config/modelDefinitions';
import { useAgentsLoader } from './setupWizardHooks';
import { useAnchoredPopover } from './useAnchoredPopover';
import { useInstanceDefaultModel } from './useInstanceDefaultModel';

// Generate button content - extracted to reduce cyclomatic complexity
export const GenerateButtonContent: React.FC<{
  isNewMode: boolean;
  isCreating: boolean;
  isGenerating: boolean;
  issueCountText: string;
}> = ({ isNewMode, isCreating, isGenerating, issueCountText }) => {
  if (isNewMode && isCreating) {
    return (
      <>
        <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
        <span>Creating...</span>
      </>
    );
  }
  if (!isNewMode && isGenerating) {
    return (
      <>
        <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
        <span>Generating...</span>
      </>
    );
  }
  return (
    <>
      <Sparkles className="w-4 h-4" />
      {/* The selected Break-plan pill already shows the estimate, so narrow docks drop it to keep the model name readable. */}
      <span>Generate Plan<span className="hidden 2xl:inline"> ({issueCountText})</span></span>
    </>
  );
};

const splitModelValue = (value: string): { agent: string | null; model: string } => {
  const separator = value.indexOf(':');
  return separator === -1 ? { agent: null, model: value } : { agent: value.slice(0, separator), model: value.slice(separator + 1) };
};

const modelDisplayName = (modelId: string) => MODEL_INFO_MAP[modelId]?.name || modelId;

interface ModelMenuOption {
  value: string;
  agent: string | null;
  label: string;
  secondary?: string;
}

/** The "no explicit model" choice, named after the model it resolves to. */
const buildDefaultOption = (planDefault: string | null | undefined, instanceDefault: string | null | undefined): { option: ModelMenuOption; name: string | null } => {
  const resolved = planDefault || instanceDefault;
  const parts = resolved ? splitModelValue(resolved) : null;
  const name = parts ? modelDisplayName(parts.model) : null;
  const source = planDefault ? 'Plan Default' : 'Configured Default';
  return {
    name,
    option: { value: '', agent: parts?.agent ?? null, label: name ? `${name} (${source})` : source, secondary: parts?.agent ?? undefined },
  };
};

/**
 * The closed button says "(Default)"; the menu spells out where that default comes from.
 * It never shows a bare "Default": while the instance default loads it says so instead.
 */
const getButtonLabel = (selectedModel: string | null, defaultName: string | null, isResolvingDefault: boolean): string => {
  if (selectedModel) return modelDisplayName(selectedModel);
  if (defaultName) return `${defaultName} (Default)`;
  return isResolvingDefault ? 'Resolving model…' : 'Configured Default';
};

// A full-width selector keeps the "Model:" label at every width and lets the name use the whole row.
const FULL_WIDTH_LAYOUT = { row: 'w-full', label: '', trigger: 'flex-1' };
const INLINE_LAYOUT = { row: 'flex-1 sm:flex-initial', label: 'hidden sm:inline', trigger: 'max-w-[240px]' };

const ModelLabel: React.FC<{ disabled: boolean; className: string }> = ({ disabled, className }) => (
  <span className={`${disabled ? 'text-gray-400' : 'text-gray-500'} ${className} text-xs`}>Model:</span>
);

const ModelMenuOptions: React.FC<{
  options: ModelMenuOption[];
  selectedValue: string;
  onChoose: (value: string) => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLButtonElement>) => void;
}> = ({ options, selectedValue, onChoose, onKeyDown }) => (
  <>
    {options.map(option => {
      const isSelected = option.value === selectedValue;
      return (
        <button
          key={option.value || 'default'}
          type="button"
          role="option"
          aria-selected={isSelected}
          autoFocus={isSelected}
          onClick={() => onChoose(option.value)}
          onKeyDown={onKeyDown}
          className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs focus:outline-none focus:bg-slate-100 hover:bg-slate-50 ${isSelected ? 'font-medium text-slate-900' : 'text-slate-700'}`}
        >
          <Check className={`w-3.5 h-3.5 flex-shrink-0 ${isSelected ? 'text-teal-600' : 'invisible'}`} aria-hidden="true" />
          {option.agent && <ProviderLogo provider={option.agent} className="w-3.5 h-3.5 flex-shrink-0" />}
          <span className="whitespace-nowrap">{option.label}</span>
          {option.secondary && <span className="ml-auto pl-4 font-mono text-[11px] text-slate-400">{option.secondary}</span>}
        </button>
      );
    })}
  </>
);

/**
 * Plan generation / refinement model picker. The "use the default" choice always names the
 * model it resolves to — "Claude Opus 5.5 (Default)" — so nobody has to guess which model
 * (and price tier) a generation call will run on.
 */
export const ModelSelector: React.FC<{
  agents: ReturnType<typeof useAgentsLoader>;
  generationModel: string | null;
  onModelChange: (value: string | null) => void;
  /** Plan-level model used when nothing is selected; falls back to the instance default. */
  defaultModel?: string | null;
  disabled?: boolean;
  /** Fills its row with the "Model:" label visible at every width, for stacked (mobile) layouts. */
  fullWidth?: boolean;
  /** Drops the "Model:" label when the surrounding settings row already labels it. */
  hideLabel?: boolean;
}> = ({ agents, generationModel, onModelChange, defaultModel, disabled = false, fullWidth, hideLabel }) => {
  const instanceDefaultModel = useInstanceDefaultModel();
  const { open, position, toggle, close, containerRef, popoverRef } = useAnchoredPopover();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listboxId = useId();
  const enabledAgents = agents.filter(agent => agent.enabled);

  if (enabledAgents.length === 0) {
    return null;
  }

  const { option: defaultOption, name: defaultName } = buildDefaultOption(defaultModel, instanceDefaultModel);
  const options: ModelMenuOption[] = [
    defaultOption,
    ...enabledAgents.flatMap(agent =>
      (agent.supportedModels || []).map(modelId => ({
        value: `${agent.alias}:${modelId}`,
        agent: agent.alias,
        label: modelDisplayName(modelId),
        secondary: agent.alias,
      }))
    ),
  ];

  const selectedValue = generationModel || '';
  const selectedParts = generationModel ? splitModelValue(generationModel) : null;
  const buttonAgent = selectedParts ? selectedParts.agent : defaultOption.agent;
  const layout = fullWidth ? FULL_WIDTH_LAYOUT : INLINE_LAYOUT;
  const buttonLabel = getButtonLabel(selectedParts?.model ?? null, defaultName, !defaultModel && instanceDefaultModel === undefined);

  const choose = (value: string) => {
    close();
    triggerRef.current?.focus();
    if (value !== selectedValue) onModelChange(value || null);
  };

  const focusOption = (from: HTMLElement, step: number) => {
    const items = Array.from(popoverRef.current?.querySelectorAll<HTMLElement>('[role="option"]') ?? []);
    if (items.length === 0) return;
    const index = items.indexOf(from);
    items[(index + step + items.length) % items.length].focus();
  };

  const handleOptionKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      focusOption(event.currentTarget, event.key === 'ArrowDown' ? 1 : -1);
    } else if (event.key === 'Escape' || event.key === 'Tab') {
      close();
      triggerRef.current?.focus();
    }
  };

  return (
    <div className={`flex items-center gap-1.5 sm:gap-2 text-xs sm:text-sm min-w-0 ${layout.row} ${disabled ? 'text-gray-400' : 'text-gray-600'}`}>
      {!hideLabel && <ModelLabel disabled={disabled} className={layout.label} />}
      <div ref={containerRef} className={`relative inline-flex min-w-0 items-center ${layout.trigger}`}>
        <button
          ref={triggerRef}
          type="button"
          onClick={toggle}
          onKeyDown={event => {
            if (!open && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
              event.preventDefault();
              toggle();
            }
          }}
          disabled={disabled}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={open ? listboxId : undefined}
          aria-label={`Model: ${buttonLabel}`}
          title={disabled ? 'Model is locked while plan generation is running' : `${buttonLabel}${buttonAgent ? ` via ${buttonAgent}` : ''}`}
          data-testid="planner-model-selector"
          className={`inline-flex w-full min-w-0 items-center gap-1.5 rounded-md border py-1 pl-2 pr-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-indigo-500 focus:border-indigo-500 transition-colors ${disabled ? 'bg-gray-100 border-gray-200 text-gray-400 cursor-not-allowed' : 'bg-white border-gray-200 text-gray-700 hover:border-gray-300 cursor-pointer'}`}
        >
          {buttonAgent && (
            <ProviderLogo provider={buttonAgent} className={`w-4 h-4 flex-shrink-0 ${disabled ? 'opacity-40 grayscale' : ''}`} />
          )}
          <span className="truncate">{buttonLabel}</span>
          <ChevronDown className={`ml-auto w-3.5 h-3.5 sm:w-4 sm:h-4 flex-shrink-0 ${disabled ? 'text-gray-300' : 'text-gray-400'}`} />
        </button>
        {position && createPortal(
          <div
            ref={popoverRef}
            id={listboxId}
            role="listbox"
            aria-label="Plan model"
            style={position}
            className="fixed z-50 w-max min-w-[220px] max-w-[calc(100vw-2rem)] overflow-y-auto rounded-md border border-slate-200 bg-white py-1 shadow-lg"
          >
            <ModelMenuOptions options={options} selectedValue={selectedValue} onChoose={choose} onKeyDown={handleOptionKeyDown} />
          </div>,
          document.body
        )}
      </div>
    </div>
  );
};
