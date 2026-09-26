import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Check, Layers3, Search, X } from 'lucide-react';
import { ProviderLogo } from '../ui/ProviderLogo';

export interface AgentModelSelection {
  agentId: string;
  modelId: string;
}

export interface AgentModelOption extends AgentModelSelection {
  agentAlias: string;
  syntheticConfigId?: string;
  modelName: string;
}

const isSameAgentModel = (
  left: AgentModelSelection,
  right: AgentModelSelection,
) => left.agentId === right.agentId && left.modelId === right.modelId;

interface ModelSelectorProps {
  options: AgentModelOption[];
  selectedModels: AgentModelSelection[];
  onSelectedModelsChange: (selectedModels: AgentModelSelection[]) => void;
  onClear: () => void;
}

const ModelSelector: React.FC<ModelSelectorProps> = ({
  options,
  selectedModels,
  onSelectedModelsChange,
  onClear,
}) => {
  const [search, setSearch] = useState('');
  const [isOpen, setIsOpen] = useState(false);
  const [activeOptionIndex, setActiveOptionIndex] = useState(0);
  const selectorRef = useRef<HTMLDivElement>(null);
  const comboboxRef = useRef<HTMLInputElement>(null);
  const optionsId = useId();

  const getOptionId = (option: AgentModelOption) =>
    `${optionsId}-option-${encodeURIComponent(JSON.stringify([option.agentId, option.modelId]))}`;

  const filteredOptions = useMemo(() => {
    const terms = search.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return options;

    return options.filter(option => {
      const searchableText = `${option.agentAlias} ${option.modelName} ${option.modelId}`.toLocaleLowerCase();
      return terms.every(term => searchableText.includes(term));
    });
  }, [options, search]);

  const selectedOptions = useMemo(() => selectedModels
    .map(selection => options.find(option => isSameAgentModel(option, selection)))
    .filter((option): option is AgentModelOption => Boolean(option)), [options, selectedModels]);

  const activeOption = isOpen && filteredOptions.length > 0
    ? filteredOptions[Math.min(activeOptionIndex, filteredOptions.length - 1)]
    : undefined;
  const activeOptionId = activeOption ? getOptionId(activeOption) : undefined;

  useEffect(() => {
    const closeSelector = (event: PointerEvent) => {
      if (!selectorRef.current?.contains(event.target as Node)) setIsOpen(false);
    };

    document.addEventListener('pointerdown', closeSelector);
    return () => document.removeEventListener('pointerdown', closeSelector);
  }, []);

  useEffect(() => {
    if (!activeOptionId) return;
    document.getElementById(activeOptionId)?.scrollIntoView?.({ block: 'nearest' });
  }, [activeOptionId]);

  const toggleSelection = (option: AgentModelOption) => {
    const isSelected = selectedModels.some(selected => isSameAgentModel(selected, option));
    onSelectedModelsChange(isSelected
      ? selectedModels.filter(selected => !isSameAgentModel(selected, option))
      : [...selectedModels, { agentId: option.agentId, modelId: option.modelId }]);
  };

  const selectOption = (option: AgentModelOption) => {
    toggleSelection(option);
    setSearch('');
    setActiveOptionIndex(0);
    comboboxRef.current?.focus();
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Tab') {
      setIsOpen(false);
      return;
    }
    if (event.key === 'Escape') {
      setIsOpen(false);
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setIsOpen(true);
      setActiveOptionIndex(current => {
        if (filteredOptions.length === 0) return 0;
        const direction = event.key === 'ArrowDown' ? 1 : -1;
        return (current + direction + filteredOptions.length) % filteredOptions.length;
      });
      return;
    }
    if (event.key === 'Enter' && isOpen && filteredOptions.length > 0) {
      event.preventDefault();
      selectOption(filteredOptions[Math.min(activeOptionIndex, filteredOptions.length - 1)]);
    }
  };

  return (
    <div
      className="relative z-10 min-w-0 flex-shrink-0 border-b border-slate-200 bg-white"
      ref={selectorRef}
      onBlur={event => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setIsOpen(false);
      }}
    >
      <div className="relative">
        <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden="true" />
        <input
          ref={comboboxRef}
          type="text"
          role="combobox"
          aria-label="Search and add models to compare"
          aria-controls={optionsId}
          aria-expanded={isOpen}
          aria-autocomplete="list"
          aria-activedescendant={activeOptionId}
          autoComplete="off"
          value={search}
          onFocus={() => {
            setIsOpen(true);
            setActiveOptionIndex(0);
          }}
          onChange={event => {
            setSearch(event.target.value);
            setIsOpen(true);
            setActiveOptionIndex(0);
          }}
          onKeyDown={handleKeyDown}
          placeholder="Search models to compare…"
          className="w-full border-b border-slate-200 bg-white py-3 pl-10 pr-3 text-sm placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-teal-500 sm:pl-11 sm:pr-4"
        />
      </div>

      <div className="flex min-h-12 min-w-0 items-center gap-1 px-3 py-1.5 sm:min-h-10 sm:gap-2 sm:px-4 sm:py-2">
        <div className="scrollbar-stealth flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto">
          {selectedOptions.length > 0 ? selectedOptions.map(option => (
            <button
              key={JSON.stringify([option.agentId, option.modelId])}
              type="button"
              onClick={() => toggleSelection(option)}
              aria-label={`${option.agentAlias}: ${option.modelName}`}
              aria-pressed="true"
              title={`Remove ${option.modelName}`}
              className="inline-flex min-h-8 max-w-[85vw] flex-shrink-0 items-center gap-1.5 rounded border border-slate-200 bg-slate-100 px-2 py-1 font-mono text-[12px] text-slate-700 transition-colors hover:border-slate-300 hover:bg-slate-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 sm:max-w-none"
            >
              {option.syntheticConfigId
                ? <Layers3 className="h-3 w-3" aria-hidden="true" />
                : <ProviderLogo provider={option.agentAlias} className="h-3 w-3" />}
              <span className="truncate">{option.modelName}</span>
              <X className="h-3 w-3 text-slate-400" aria-hidden="true" />
            </button>
          )) : (
            <span className={`whitespace-nowrap text-[11px] ${options.length > 0 ? 'text-amber-600' : 'text-slate-500'}`}>
              {options.length > 0 ? 'Select at least one model to start chatting' : 'No enabled models available.'}
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={onClear}
          className="min-h-9 flex-shrink-0 rounded px-2 py-1 text-xs text-slate-400 transition-colors hover:bg-slate-50 hover:text-slate-700"
          title="Clear History"
        >
          Clear
        </button>
      </div>

      {isOpen && (
        <div
          id={optionsId}
          role="listbox"
          aria-label="Available models"
          aria-multiselectable="true"
          className="scrollbar-stealth absolute left-2 right-2 top-[45px] z-20 max-h-[min(18rem,calc(100dvh-12rem))] overflow-y-auto overscroll-contain rounded-md border border-slate-200 bg-white py-1 shadow-xl sm:left-3 sm:right-3 sm:top-[46px] sm:max-h-72"
        >
          {filteredOptions.length > 0 ? filteredOptions.map((option, index) => {
            const isSelected = selectedModels.some(selected => isSameAgentModel(selected, option));
            return (
              <button
                key={JSON.stringify([option.agentId, option.modelId])}
                id={getOptionId(option)}
                type="button"
                role="option"
                tabIndex={-1}
                aria-selected={isSelected}
                onMouseEnter={() => setActiveOptionIndex(index)}
                onPointerDown={event => event.preventDefault()}
                onClick={() => selectOption(option)}
                className={`flex min-h-11 w-full items-center gap-2 px-3 py-2 text-left transition-colors ${
                  index === activeOptionIndex ? 'bg-slate-100' : 'hover:bg-slate-50'
                }`}
              >
                <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center">
                  {option.syntheticConfigId
                    ? <Layers3 className="h-4 w-4 text-slate-500" aria-hidden="true" />
                    : <ProviderLogo provider={option.agentAlias} className="h-4 w-4" />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-medium text-slate-800">{option.modelName}</span>
                  <span className="block truncate font-mono text-[10px] text-slate-400">{option.agentAlias} · {option.modelId}</span>
                </span>
                {isSelected && <Check className="h-4 w-4 flex-shrink-0 text-teal-600" aria-hidden="true" />}
              </button>
            );
          }) : (
            <div className="px-3 py-6 text-center text-sm text-slate-500">
              No models match “{search.trim()}”.
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default ModelSelector;
