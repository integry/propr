import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Sparkles, Clock } from 'lucide-react';
import {
  IMPROVEMENT_CATEGORIES,
  ImprovementCategory,
  ReferenceRepo,
  RepoImprovementsPanelProps,
  SuggestionItem,
  GenerationTimingMetadata,
  GenerateSuggestionsResult,
} from './RepoImprovementsPanel.types';
import {
  CategoryButton,
  ReferenceRepoSelector,
  GenerateButton,
  CreatePlanButton,
  SuggestionsList,
} from './RepoImprovementsPanelComponents';
import ModelContextSelector from './ModelContextSelector';

// Re-export types for external consumers
export type { ImprovementCategory, ReferenceRepo, RepoImprovementsPanelProps, SuggestionItem, GenerateSuggestionsResult };
export { IMPROVEMENT_CATEGORIES };

/** Format duration for display (e.g., "1m 30s") */
const formatDuration = (ms: number): string => {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  if (seconds === 0) return `${minutes}m`;
  return `${minutes}m ${seconds}s`;
};

const RepoImprovementsPanel: React.FC<RepoImprovementsPanelProps> = ({
  availableRepos = [],
  onGenerateSuggestions,
  repositoryName,
  repositoryId,
  disabled = false,
  suggestions = [],
  onToggleSuggestion,
  defaultModel = 'claude-haiku-4-5-20251001',
  defaultContextLevel = 50,
  lastGenerationTiming,
}) => {
  const navigate = useNavigate();
  const [selectedCategories, setSelectedCategories] = useState<Set<ImprovementCategory>>(new Set());
  const [customPrompt, setCustomPrompt] = useState('');
  const [selectedReferenceRepo, setSelectedReferenceRepo] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const [selectedModel, setSelectedModel] = useState(defaultModel);
  const [contextLevel, setContextLevel] = useState(defaultContextLevel);
  const [timingMetadata, setTimingMetadata] = useState<GenerationTimingMetadata | undefined>(lastGenerationTiming);

  useEffect(() => {
    setSelectedCategories(new Set());
    setCustomPrompt('');
    setSelectedReferenceRepo(null);
    setIsLoading(false);
    setSelectedModel(defaultModel);
    setContextLevel(defaultContextLevel);
    setTimingMetadata(undefined);
  }, [repositoryName, defaultModel, defaultContextLevel]);

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
    setTimingMetadata(undefined);
    try {
      if (onGenerateSuggestions) {
        const result = await onGenerateSuggestions({
          categories: Array.from(selectedCategories),
          customPrompt: customPrompt.trim(),
          referenceRepoId: selectedReferenceRepo,
          model: selectedModel,
          contextLevel,
        });
        // Capture timing metadata if returned
        if (result?.timing) {
          setTimingMetadata(result.timing);
        }
      }
    } finally {
      setIsLoading(false);
    }
  };

  const handleSelectRepo = (repoId: string | null) => {
    setSelectedReferenceRepo(repoId);
    setIsDropdownOpen(false);
  };

  const isDisabledState = disabled || isLoading;
  const canGenerate = (selectedCategories.size > 0 || !!customPrompt.trim()) && !isLoading && !disabled;
  const showHint = selectedCategories.size === 0 && !customPrompt.trim() && !isLoading;
  const selectedSuggestions = suggestions.filter(s => s.isSelected);
  const hasSelectedSuggestions = selectedSuggestions.length > 0;

  const handleCreatePlanFromSelected = () => {
    // Format suggestions into a numbered list
    const prompt = selectedSuggestions
      .map((suggestion, index) => `${index + 1}. ${suggestion.title}\n   ${suggestion.description}`)
      .join('\n\n');

    // Navigate to the studio with the prompt and repository in state
    navigate('/studio/new', {
      state: {
        initialPrompt: prompt,
        initialRepository: repositoryId,
      },
    });
  };

  return (
    <div className="flex flex-col h-full bg-slate-50">
      {/* Model and Context Level Selector */}
      <ModelContextSelector
        selectedModel={selectedModel}
        onModelChange={setSelectedModel}
        contextLevel={contextLevel}
        onContextLevelChange={setContextLevel}
        disabled={isLoading || disabled}
      />

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
            {IMPROVEMENT_CATEGORIES.map((category) => (
              <CategoryButton
                key={category.id}
                category={category}
                isSelected={selectedCategories.has(category.id)}
                disabled={isDisabledState}
                onClick={() => toggleCategory(category.id)}
              />
            ))}
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
            disabled={isDisabledState}
            placeholder="Add specific areas to focus on or additional context..."
            className={`w-full px-3 py-2 bg-white border border-gray-200 rounded-lg text-sm text-gray-700 placeholder-gray-400 resize-none focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-transparent
              ${isDisabledState ? 'opacity-50 cursor-not-allowed' : ''}
            `}
            rows={3}
          />
        </div>

        {/* Reference Repository Selector */}
        {availableRepos.length > 0 && (
          <ReferenceRepoSelector
            availableRepos={availableRepos}
            selectedReferenceRepo={selectedReferenceRepo}
            isDropdownOpen={isDropdownOpen}
            disabled={isDisabledState}
            onToggleDropdown={() => !isDisabledState && setIsDropdownOpen(!isDropdownOpen)}
            onSelectRepo={handleSelectRepo}
          />
        )}

        {/* Generated Suggestions List */}
        {suggestions.length > 0 && onToggleSuggestion && (
          <>
            {/* Timing metadata display */}
            {timingMetadata?.actualDurationMs && (
              <div className="flex items-center justify-center gap-1.5 text-xs text-slate-400 py-1">
                <Clock size={12} />
                <span>Generated in {formatDuration(timingMetadata.actualDurationMs)}</span>
                {timingMetadata.estimatedDurationMs && (
                  <span className="text-slate-300">
                    (est. {formatDuration(timingMetadata.estimatedDurationMs)})
                  </span>
                )}
              </div>
            )}
            <SuggestionsList
              suggestions={suggestions}
              onToggleSuggestion={onToggleSuggestion}
            />
          </>
        )}
      </div>

      {/* Footer Button - Show Create Plan if suggestions selected, otherwise Generate */}
      {hasSelectedSuggestions ? (
        <CreatePlanButton
          selectedCount={selectedSuggestions.length}
          onClick={handleCreatePlanFromSelected}
        />
      ) : (
        <GenerateButton
          isLoading={isLoading}
          canGenerate={canGenerate}
          showHint={showHint}
          onClick={handleGenerate}
        />
      )}
    </div>
  );
};

export default RepoImprovementsPanel;
