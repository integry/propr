import React from 'react';
import { Sparkles, Loader2, ChevronDown, Check, ArrowRight } from 'lucide-react';
import {
  IMPROVEMENT_CATEGORIES,
  ReferenceRepo,
  SuggestionItem,
} from './RepoImprovementsPanel.types';

export interface CategoryButtonProps {
  category: typeof IMPROVEMENT_CATEGORIES[number];
  isSelected: boolean;
  disabled: boolean;
  onClick: () => void;
}

export const CategoryButton: React.FC<CategoryButtonProps> = ({
  category,
  isSelected,
  disabled,
  onClick,
}) => (
  <button
    onClick={onClick}
    disabled={disabled}
    className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-left transition-all text-sm
      ${isSelected
        ? 'bg-teal-50 border-teal-300 text-teal-700'
        : 'bg-white border-gray-200 text-gray-600 hover:border-gray-300 hover:bg-gray-50'
      }
      ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}
    `}
    title={category.description}
  >
    <div
      className={`w-4 h-4 rounded border flex items-center justify-center flex-shrink-0
        ${isSelected
          ? 'bg-teal-500 border-teal-500'
          : 'border-gray-300 bg-white'
        }
      `}
    >
      {isSelected && <Check size={12} className="text-white" />}
    </div>
    <span className="truncate">{category.label}</span>
  </button>
);

export interface ReferenceRepoSelectorProps {
  availableRepos: ReferenceRepo[];
  selectedReferenceRepo: string | null;
  isDropdownOpen: boolean;
  disabled: boolean;
  onToggleDropdown: () => void;
  onSelectRepo: (repoId: string | null) => void;
}

export const ReferenceRepoSelector: React.FC<ReferenceRepoSelectorProps> = ({
  availableRepos,
  selectedReferenceRepo,
  isDropdownOpen,
  disabled,
  onToggleDropdown,
  onSelectRepo,
}) => {
  const selectedRepo = availableRepos.find((r) => r.id === selectedReferenceRepo);
  const displayName = selectedRepo?.alias || selectedRepo?.name || 'Select repository';

  return (
    <div className="space-y-2">
      <label className="block text-xs font-medium text-gray-600 uppercase tracking-wide">
        Reference Repository (Optional)
      </label>
      <p className="text-xs text-gray-500 mb-2">
        Use another repository as a reference for best practices and patterns.
      </p>
      <div className="relative">
        <button
          type="button"
          onClick={onToggleDropdown}
          disabled={disabled}
          className={`w-full flex items-center justify-between px-3 py-2 bg-white border border-gray-200 rounded-lg text-sm text-left transition-colors
            ${disabled ? 'opacity-50 cursor-not-allowed' : 'hover:border-gray-300 focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-transparent'}
          `}
        >
          <span className={selectedReferenceRepo ? 'text-gray-700' : 'text-gray-400'}>
            {selectedReferenceRepo ? displayName : 'Select repository'}
          </span>
          <ChevronDown
            size={16}
            className={`text-gray-400 transition-transform ${isDropdownOpen ? 'rotate-180' : ''}`}
          />
        </button>

        {isDropdownOpen && (
          <div className="absolute z-10 w-full mt-1 bg-white border border-gray-200 rounded-lg shadow-lg max-h-48 overflow-y-auto">
            <button
              type="button"
              onClick={() => onSelectRepo(null)}
              className="w-full px-3 py-2 text-left text-sm text-gray-400 hover:bg-gray-50"
            >
              None
            </button>
            {availableRepos.map((repo) => (
              <button
                key={repo.id}
                type="button"
                onClick={() => onSelectRepo(repo.id)}
                className={`w-full px-3 py-2 text-left text-sm hover:bg-gray-50 flex items-center justify-between
                  ${selectedReferenceRepo === repo.id ? 'text-teal-600 bg-teal-50' : 'text-gray-700'}
                `}
              >
                <span>{repo.alias || repo.name}</span>
                {selectedReferenceRepo === repo.id && (
                  <Check size={14} className="text-teal-500" />
                )}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export interface GenerateButtonProps {
  isLoading: boolean;
  canGenerate: boolean;
  showHint: boolean;
  onClick: () => void;
}

export const GenerateButton: React.FC<GenerateButtonProps> = ({
  isLoading,
  canGenerate,
  showHint,
  onClick,
}) => (
  <div className="flex-shrink-0 p-4 border-t border-gray-200 bg-white">
    <button
      onClick={onClick}
      disabled={!canGenerate}
      className={`w-full flex items-center justify-center gap-2 px-4 py-3 rounded-lg text-sm font-medium transition-colors
        ${canGenerate
          ? 'bg-teal-600 text-white hover:bg-teal-700'
          : 'bg-gray-200 text-gray-400 cursor-not-allowed'
        }
      `}
    >
      {isLoading ? (
        <>
          <Loader2 size={16} className="animate-spin" />
          <span>Generating Suggestions...</span>
        </>
      ) : (
        <>
          <Sparkles size={16} />
          <span>Generate Suggestions</span>
        </>
      )}
    </button>
    {showHint && (
      <p className="text-xs text-gray-400 text-center mt-2">
        Select at least one category or add custom instructions
      </p>
    )}
  </div>
);

export interface CreatePlanButtonProps {
  selectedCount: number;
  onClick: () => void;
}

export const CreatePlanButton: React.FC<CreatePlanButtonProps> = ({
  selectedCount,
  onClick,
}) => (
  <div className="flex-shrink-0 p-4 border-t border-gray-200 bg-white">
    <button
      onClick={onClick}
      className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-lg text-sm font-medium transition-colors bg-teal-600 text-white hover:bg-teal-700"
    >
      <ArrowRight size={16} />
      <span>Create Plan from Selected ({selectedCount})</span>
    </button>
  </div>
);

export interface SuggestionCardProps {
  suggestion: SuggestionItem;
  index: number;
  onToggle: (index: number) => void;
}

export const SuggestionCard: React.FC<SuggestionCardProps> = ({
  suggestion,
  index,
  onToggle,
}) => (
  <button
    onClick={() => onToggle(index)}
    className={`w-full text-left p-4 rounded-lg border transition-all
      ${suggestion.isSelected
        ? 'bg-teal-50 border-teal-300 ring-1 ring-teal-300'
        : 'bg-white border-gray-200 hover:border-gray-300 hover:bg-gray-50'
      }
    `}
  >
    <div className="flex items-start gap-3">
      <div
        className={`w-5 h-5 rounded border flex items-center justify-center flex-shrink-0 mt-0.5
          ${suggestion.isSelected
            ? 'bg-teal-500 border-teal-500'
            : 'border-gray-300 bg-white'
          }
        `}
      >
        {suggestion.isSelected && <Check size={14} className="text-white" />}
      </div>
      <div className="flex-1 min-w-0">
        <h4 className={`text-sm font-medium mb-1
          ${suggestion.isSelected ? 'text-teal-700' : 'text-gray-700'}
        `}>
          {suggestion.title}
        </h4>
        <p className="text-xs text-gray-500 leading-relaxed">
          {suggestion.description}
        </p>
      </div>
    </div>
  </button>
);

export interface SuggestionsListProps {
  suggestions: SuggestionItem[];
  onToggleSuggestion: (index: number) => void;
}

export const SuggestionsList: React.FC<SuggestionsListProps> = ({
  suggestions,
  onToggleSuggestion,
}) => {
  const selectedCount = suggestions.filter(s => s.isSelected).length;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <label className="block text-xs font-medium text-gray-600 uppercase tracking-wide">
          Generated Suggestions
        </label>
        <span className="text-xs text-gray-500">
          {selectedCount} of {suggestions.length} selected
        </span>
      </div>
      <div className="space-y-2">
        {suggestions.map((suggestion, index) => (
          <SuggestionCard
            key={index}
            suggestion={suggestion}
            index={index}
            onToggle={onToggleSuggestion}
          />
        ))}
      </div>
    </div>
  );
};
