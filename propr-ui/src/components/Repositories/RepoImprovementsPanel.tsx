import React, { useState, useEffect } from 'react';
import { Sparkles, Loader2, ChevronDown, Check } from 'lucide-react';

/**
 * Available improvement categories for repository analysis
 */
export const IMPROVEMENT_CATEGORIES = [
  { id: 'code-quality', label: 'Code Quality', description: 'Identify code smells and refactoring opportunities' },
  { id: 'performance', label: 'Performance', description: 'Find performance bottlenecks and optimization opportunities' },
  { id: 'security', label: 'Security', description: 'Detect potential security vulnerabilities' },
  { id: 'testing', label: 'Testing', description: 'Suggest test coverage improvements' },
  { id: 'documentation', label: 'Documentation', description: 'Identify missing or outdated documentation' },
  { id: 'architecture', label: 'Architecture', description: 'Analyze architectural patterns and suggest improvements' },
] as const;

export type ImprovementCategory = typeof IMPROVEMENT_CATEGORIES[number]['id'];

export interface ReferenceRepo {
  id: string;
  name: string;
  alias?: string;
}

export interface RepoImprovementsPanelProps {
  /** Available repositories to use as reference */
  availableRepos?: ReferenceRepo[];
  /** Callback when generating suggestions is triggered */
  onGenerateSuggestions?: (params: {
    categories: ImprovementCategory[];
    customPrompt: string;
    referenceRepoId: string | null;
  }) => Promise<void>;
  /** Repository name to display */
  repositoryName?: string;
  /** Whether the panel is disabled */
  disabled?: boolean;
}

const RepoImprovementsPanel: React.FC<RepoImprovementsPanelProps> = ({
  availableRepos = [],
  onGenerateSuggestions,
  repositoryName,
  disabled = false,
}) => {
  const [selectedCategories, setSelectedCategories] = useState<Set<ImprovementCategory>>(new Set());
  const [customPrompt, setCustomPrompt] = useState('');
  const [selectedReferenceRepo, setSelectedReferenceRepo] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);

  // Reset state when repository changes
  useEffect(() => {
    setSelectedCategories(new Set());
    setCustomPrompt('');
    setSelectedReferenceRepo(null);
    setIsLoading(false);
  }, [repositoryName]);

  const toggleCategory = (categoryId: ImprovementCategory) => {
    if (disabled || isLoading) return;
    setSelectedCategories((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(categoryId)) {
        newSet.delete(categoryId);
      } else {
        newSet.add(categoryId);
      }
      return newSet;
    });
  };

  const handleGenerate = async () => {
    if (isLoading || disabled) return;
    if (selectedCategories.size === 0 && !customPrompt.trim()) return;

    setIsLoading(true);
    try {
      if (onGenerateSuggestions) {
        await onGenerateSuggestions({
          categories: Array.from(selectedCategories),
          customPrompt: customPrompt.trim(),
          referenceRepoId: selectedReferenceRepo,
        });
      }
    } finally {
      setIsLoading(false);
    }
  };

  const canGenerate = (selectedCategories.size > 0 || customPrompt.trim()) && !isLoading && !disabled;

  return (
    <div className="flex flex-col h-full bg-slate-50">
      {/* Content Area */}
      <div
        className="flex-1 overflow-y-auto px-4 py-4 space-y-6"
        style={{
          scrollbarWidth: 'thin',
          scrollbarColor: '#d1d5db transparent',
        }}
      >
        {/* Header */}
        <div className="text-center px-4 pt-2">
          <div className="w-12 h-12 rounded-full bg-teal-100 flex items-center justify-center mb-3 mx-auto">
            <Sparkles size={24} className="text-teal-600" />
          </div>
          <h3 className="text-sm font-medium text-gray-700 mb-1">
            {repositoryName ? `Improve ${repositoryName}` : 'Repository Improvements'}
          </h3>
          <p className="text-xs text-gray-500 max-w-xs mx-auto">
            Select improvement categories or provide custom instructions to generate AI-powered suggestions.
          </p>
        </div>

        {/* Category Buttons */}
        <div className="space-y-2">
          <label className="block text-xs font-medium text-gray-600 uppercase tracking-wide">
            Improvement Categories
          </label>
          <div className="grid grid-cols-2 gap-2">
            {IMPROVEMENT_CATEGORIES.map((category) => {
              const isSelected = selectedCategories.has(category.id);
              return (
                <button
                  key={category.id}
                  onClick={() => toggleCategory(category.id)}
                  disabled={disabled || isLoading}
                  className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-left transition-all text-sm
                    ${isSelected
                      ? 'bg-teal-50 border-teal-300 text-teal-700'
                      : 'bg-white border-gray-200 text-gray-600 hover:border-gray-300 hover:bg-gray-50'
                    }
                    ${disabled || isLoading ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}
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
            })}
          </div>
        </div>

        {/* Custom Instructions */}
        <div className="space-y-2">
          <label className="block text-xs font-medium text-gray-600 uppercase tracking-wide">
            Custom Instructions
          </label>
          <textarea
            value={customPrompt}
            onChange={(e) => setCustomPrompt(e.target.value)}
            disabled={disabled || isLoading}
            placeholder="Add specific areas to focus on or additional context..."
            className={`w-full px-3 py-2 bg-white border border-gray-200 rounded-lg text-sm text-gray-700 placeholder-gray-400 resize-none focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-transparent
              ${disabled || isLoading ? 'opacity-50 cursor-not-allowed' : ''}
            `}
            rows={3}
          />
        </div>

        {/* Reference Repository Selector */}
        {availableRepos.length > 0 && (
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
                onClick={() => !disabled && !isLoading && setIsDropdownOpen(!isDropdownOpen)}
                disabled={disabled || isLoading}
                className={`w-full flex items-center justify-between px-3 py-2 bg-white border border-gray-200 rounded-lg text-sm text-left transition-colors
                  ${disabled || isLoading ? 'opacity-50 cursor-not-allowed' : 'hover:border-gray-300 focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-transparent'}
                `}
              >
                <span className={selectedReferenceRepo ? 'text-gray-700' : 'text-gray-400'}>
                  {selectedReferenceRepo
                    ? availableRepos.find((r) => r.id === selectedReferenceRepo)?.alias ||
                      availableRepos.find((r) => r.id === selectedReferenceRepo)?.name ||
                      'Select repository'
                    : 'Select repository'}
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
                    onClick={() => {
                      setSelectedReferenceRepo(null);
                      setIsDropdownOpen(false);
                    }}
                    className="w-full px-3 py-2 text-left text-sm text-gray-400 hover:bg-gray-50"
                  >
                    None
                  </button>
                  {availableRepos.map((repo) => (
                    <button
                      key={repo.id}
                      type="button"
                      onClick={() => {
                        setSelectedReferenceRepo(repo.id);
                        setIsDropdownOpen(false);
                      }}
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
        )}
      </div>

      {/* Generate Button - Fixed at bottom */}
      <div className="flex-shrink-0 p-4 border-t border-gray-200 bg-white">
        <button
          onClick={handleGenerate}
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
        {selectedCategories.size === 0 && !customPrompt.trim() && !isLoading && (
          <p className="text-xs text-gray-400 text-center mt-2">
            Select at least one category or add custom instructions
          </p>
        )}
      </div>
    </div>
  );
};

export default RepoImprovementsPanel;
