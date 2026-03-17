import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Sparkles, Clock } from 'lucide-react';
import {
  IMPROVEMENT_CATEGORIES,
  HEALTH_CATEGORIES,
  GROWTH_CATEGORIES,
  ImprovementCategory,
  ReferenceRepo,
  RepoImprovementsPanelProps,
  SuggestionItem,
  GenerationTimingMetadata,
  GenerateSuggestionsResult,
} from './RepoImprovementsPanel.types';
import {
  CategoryGrid,
  ReferenceRepoSelector,
  GenerateButton,
  SelectedSuggestionsFooter,
  SuggestionsList,
} from './RepoImprovementsPanelComponents';
import { createTodo } from '../../api/repoTodosApi';
import ModelContextSelector from './ModelContextSelector';

// Re-export types for external consumers
export type { ImprovementCategory, ReferenceRepo, RepoImprovementsPanelProps, SuggestionItem, GenerateSuggestionsResult };
export { IMPROVEMENT_CATEGORIES, HEALTH_CATEGORIES, GROWTH_CATEGORIES };

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

/** Header component for the improvements panel - sits directly on tinted background */
const ImprovementsPanelHeader: React.FC<{ repositoryName?: string }> = ({ repositoryName }) => (
  <div className="flex items-center gap-3">
    <div className="w-8 h-8 rounded-lg bg-teal-100 flex items-center justify-center flex-shrink-0">
      <Sparkles size={16} className="text-teal-600" />
    </div>
    <div>
      <h3 className="text-sm font-semibold text-slate-800">
        {repositoryName ? `Improve ${repositoryName}` : 'Repository Improvements'}
      </h3>
      <p className="text-xs text-slate-500">
        Select categories or add custom instructions
      </p>
    </div>
  </div>
);

/** Timing display component */
const TimingDisplay: React.FC<{ timingMetadata?: GenerationTimingMetadata }> = ({ timingMetadata }) => {
  if (!timingMetadata?.actualDurationMs) return null;
  return (
    <div className="flex items-center justify-center gap-1.5 text-xs text-slate-400 py-1">
      <Clock size={12} />
      <span>Generated in {formatDuration(timingMetadata.actualDurationMs)}</span>
      {timingMetadata.estimatedDurationMs && (
        <span className="text-slate-300">
          (est. {formatDuration(timingMetadata.estimatedDurationMs)})
        </span>
      )}
    </div>
  );
};

const RepoImprovementsPanel: React.FC<RepoImprovementsPanelProps> = ({
  availableRepos = [],
  onGenerateSuggestions,
  repositoryName,
  repositoryId,
  disabled = false,
  suggestions = [],
  onToggleSuggestion,
  defaultModel = 'claude:claude-haiku-4-5-20251001',
  defaultContextLevel = 50,
  lastGenerationTiming,
  onTodosSaved,
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
  const [isSavingTodos, setIsSavingTodos] = useState(false);

  useEffect(() => {
    setSelectedCategories(new Set());
    setCustomPrompt('');
    setSelectedReferenceRepo(null);
    setIsLoading(false);
    setSelectedModel(defaultModel);
    setContextLevel(defaultContextLevel);
    setTimingMetadata(undefined);
  }, [repositoryName, defaultModel, defaultContextLevel]);

  const toggleCategory = useCallback((categoryId: ImprovementCategory) => {
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
  }, [disabled, isLoading]);

  const handleGenerate = useCallback(async () => {
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
        if (result?.timing) {
          setTimingMetadata(result.timing);
        }
      }
    } finally {
      setIsLoading(false);
    }
  }, [isLoading, disabled, selectedCategories, customPrompt, onGenerateSuggestions, selectedReferenceRepo, selectedModel, contextLevel]);

  const handleSelectRepo = useCallback((repoId: string | null) => {
    setSelectedReferenceRepo(repoId);
    setIsDropdownOpen(false);
  }, []);

  const handleToggleDropdown = useCallback(() => {
    if (!disabled && !isLoading) {
      setIsDropdownOpen((prev) => !prev);
    }
  }, [disabled, isLoading]);

  const isDisabledState = disabled || isLoading;
  const hasCustomPrompt = !!customPrompt.trim();
  const canGenerate = (selectedCategories.size > 0 || hasCustomPrompt) && !isLoading && !disabled;
  const showHint = selectedCategories.size === 0 && !hasCustomPrompt && !isLoading;
  const selectedSuggestions = suggestions.filter(s => s.isSelected);
  const hasSelectedSuggestions = selectedSuggestions.length > 0;

  const handleCreatePlanFromSelected = useCallback(() => {
    const prompt = selectedSuggestions
      .map((suggestion, index) => `${index + 1}. ${suggestion.title}\n   ${suggestion.description}`)
      .join('\n\n');

    navigate('/studio/new', {
      state: {
        initialPrompt: prompt,
        initialRepository: repositoryId,
      },
    });
  }, [selectedSuggestions, navigate, repositoryId]);

  const handleSaveToTodos = useCallback(async () => {
    if (!repositoryId || selectedSuggestions.length === 0) return;

    setIsSavingTodos(true);
    try {
      const createdTodoIds: string[] = [];
      for (const suggestion of selectedSuggestions) {
        const content = `${suggestion.title}\n${suggestion.description}`;
        const todo = await createTodo({
          repository: repositoryId,
          content,
        });
        createdTodoIds.push(todo.todoId);
      }
      // Notify parent that todos were saved successfully
      if (onTodosSaved) {
        onTodosSaved(createdTodoIds);
      }
    } catch (err) {
      console.error('Failed to save todos:', err);
    } finally {
      setIsSavingTodos(false);
    }
  }, [repositoryId, selectedSuggestions, onTodosSaved]);

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
        <ImprovementsPanelHeader repositoryName={repositoryName} />

        {/* Category Toggle Chips - Grouped by Health and Growth */}
        <CategoryGrid
          healthCategories={HEALTH_CATEGORIES}
          growthCategories={GROWTH_CATEGORIES}
          selectedCategories={selectedCategories}
          disabled={isDisabledState}
          onToggle={toggleCategory}
        />

        {/* Custom Instructions */}
        <div className="space-y-2">
          <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-wider">
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
            onToggleDropdown={handleToggleDropdown}
            onSelectRepo={handleSelectRepo}
          />
        )}

        {/* Generated Suggestions List */}
        {suggestions.length > 0 && onToggleSuggestion && (
          <>
            <TimingDisplay timingMetadata={timingMetadata} />
            <SuggestionsList
              suggestions={suggestions}
              onToggleSuggestion={onToggleSuggestion}
            />
          </>
        )}
      </div>

      {/* Footer Button - Show Create Plan + Save to To-Dos if suggestions selected, otherwise Generate */}
      {hasSelectedSuggestions ? (
        <SelectedSuggestionsFooter
          selectedCount={selectedSuggestions.length}
          onCreatePlan={handleCreatePlanFromSelected}
          onSaveToTodos={handleSaveToTodos}
          isSavingTodos={isSavingTodos}
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
