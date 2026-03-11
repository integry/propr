import React from 'react';
import { Sparkles, Loader2, ChevronDown, Check, ArrowRight } from 'lucide-react';
import {
  HEALTH_CATEGORIES,
  GROWTH_CATEGORIES,
  ImprovementCategory,
  ReferenceRepo,
  SuggestionItem,
} from './RepoImprovementsPanel.types';

type CategoryType = typeof HEALTH_CATEGORIES[number] | typeof GROWTH_CATEGORIES[number];

export interface CategoryButtonProps {
  category: CategoryType;
  isSelected: boolean;
  disabled: boolean;
  onClick: () => void;
}

/**
 * Toggle Pill style category button - Segmented Pills per Studio spec
 * - Inactive: Gray outline on transparent background
 * - Active: Solid Brand Teal with checkmark icon
 */
export const CategoryButton: React.FC<CategoryButtonProps> = ({
  category,
  isSelected,
  disabled,
  onClick,
}) => (
  <button
    onClick={onClick}
    disabled={disabled}
    className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border text-xs font-medium transition-all
      ${isSelected
        ? 'bg-teal-600 border-teal-600 text-white'
        : 'bg-transparent border-slate-300 text-slate-600 hover:border-teal-400 hover:text-teal-600'
      }
      ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}
    `}
    title={category.description}
  >
    {isSelected && <Check size={12} className="flex-shrink-0" />}
    <span className="whitespace-nowrap">
      {'emoji' in category && category.emoji} {category.label}
    </span>
  </button>
);

/**
 * Section header for category groups - Utility Style
 */
export const CategoryGroupHeader: React.FC<{ title: string }> = ({ title }) => (
  <div className="text-[10px] uppercase font-bold text-slate-500 tracking-wider mb-2">
    {title}
  </div>
);

export interface CategoryGridProps {
  healthCategories: typeof HEALTH_CATEGORIES;
  growthCategories: typeof GROWTH_CATEGORIES;
  selectedCategories: Set<ImprovementCategory>;
  disabled: boolean;
  onToggle: (categoryId: ImprovementCategory) => void;
}

/**
 * Grouped category grid with Health and Growth sections
 */
export const CategoryGrid: React.FC<CategoryGridProps> = ({
  healthCategories,
  growthCategories,
  selectedCategories,
  disabled,
  onToggle,
}) => (
  <div className="space-y-4">
    {/* System Health Group */}
    <div>
      <CategoryGroupHeader title="System Health" />
      <div className="flex flex-wrap gap-2">
        {healthCategories.map((category) => (
          <CategoryButton
            key={category.id}
            category={category}
            isSelected={selectedCategories.has(category.id as ImprovementCategory)}
            disabled={disabled}
            onClick={() => onToggle(category.id as ImprovementCategory)}
          />
        ))}
      </div>
    </div>

    {/* Product Growth Group */}
    <div>
      <CategoryGroupHeader title="Product Growth" />
      <div className="flex flex-wrap gap-2">
        {growthCategories.map((category) => (
          <CategoryButton
            key={category.id}
            category={category}
            isSelected={selectedCategories.has(category.id as ImprovementCategory)}
            disabled={disabled}
            onClick={() => onToggle(category.id as ImprovementCategory)}
          />
        ))}
      </div>
    </div>
  </div>
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
      <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-wider">
        Reference Repository (Optional)
      </label>
      <p className="text-xs text-slate-500 mb-2">
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
  <div className="flex-shrink-0 p-4 border-t border-slate-200 bg-white shadow-[0_-2px_8px_rgba(0,0,0,0.04)]">
    <button
      onClick={onClick}
      disabled={!canGenerate}
      className={`w-full flex items-center justify-center gap-2 px-4 py-3 rounded-lg text-sm font-semibold transition-all
        ${canGenerate
          ? 'bg-teal-600 text-white hover:bg-teal-700 shadow-sm'
          : 'bg-slate-200 text-slate-400 cursor-not-allowed'
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
      <p className="text-xs text-slate-400 text-center mt-2">
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
  <div className="flex-shrink-0 p-4 border-t border-slate-200 bg-white shadow-[0_-2px_8px_rgba(0,0,0,0.04)]">
    <button
      onClick={onClick}
      className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-lg text-sm font-semibold transition-all bg-teal-600 text-white hover:bg-teal-700 shadow-sm"
    >
      <ArrowRight size={16} />
      <span>Create Plan from Selected ({selectedCount})</span>
    </button>
  </div>
);

export interface SuggestionRowProps {
  suggestion: SuggestionItem;
  index: number;
  onToggle: (index: number) => void;
}

/**
 * Dense two-line suggestion row - sits directly on tinted background
 * with teal vertical accent line for "Live Insight" indicator
 */
export const SuggestionRow: React.FC<SuggestionRowProps> = ({
  suggestion,
  index,
  onToggle,
}) => (
  <button
    onClick={() => onToggle(index)}
    className={`w-full text-left py-3 px-3 transition-all flex items-start gap-3 border-l-2 ${
      suggestion.isSelected
        ? 'border-l-teal-500 bg-teal-50/30'
        : 'border-l-teal-400 hover:bg-slate-100/50'
    }`}
  >
    {/* Checkbox */}
    <div
      className={`w-4 h-4 rounded border flex items-center justify-center flex-shrink-0 mt-0.5
        ${suggestion.isSelected
          ? 'bg-teal-500 border-teal-500'
          : 'border-slate-300 bg-white'
        }
      `}
    >
      {suggestion.isSelected && <Check size={12} className="text-white" />}
    </div>
    {/* Two-line content */}
    <div className="flex-1 min-w-0">
      <h4 className={`text-sm font-semibold leading-tight ${
        suggestion.isSelected ? 'text-teal-700' : 'text-slate-700'
      }`}>
        {suggestion.title}
      </h4>
      <p className="text-xs text-slate-500 leading-snug mt-0.5 line-clamp-2">
        {suggestion.description}
      </p>
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
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-wider">
          Generated Suggestions
        </label>
        <span className="text-xs text-slate-400">
          {selectedCount} of {suggestions.length} selected
        </span>
      </div>
      {/* Dense list directly on tinted background - no cards */}
      <div className="divide-y divide-slate-100">
        {suggestions.map((suggestion, index) => (
          <SuggestionRow
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
