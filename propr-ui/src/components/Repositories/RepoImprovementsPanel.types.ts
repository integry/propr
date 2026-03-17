/**
 * Available improvement categories for repository analysis, grouped by Health and Growth
 */

// System Health (Maintenance) categories
export const HEALTH_CATEGORIES = [
  { id: 'code-quality', label: 'Code Quality', emoji: '🔧', description: 'Identify code smells and refactoring opportunities' },
  { id: 'security', label: 'Security', emoji: '🔒', description: 'Detect potential security vulnerabilities' },
  { id: 'performance', label: 'Performance', emoji: '⚡', description: 'Find performance bottlenecks and optimization opportunities' },
  { id: 'documentation', label: 'Documentation', emoji: '📚', description: 'Identify missing or outdated documentation' },
  { id: 'testing', label: 'Testing', emoji: '🧪', description: 'Suggest test coverage improvements' },
] as const;

// Product Growth (Functional) categories
export const GROWTH_CATEGORIES = [
  { id: 'new-features', label: 'New Feature Ideas', emoji: '✨', description: 'What features are missing based on current project scope?' },
  { id: 'tech-debt', label: 'Tech Debt Reduction', emoji: '🛠️', description: 'Where is the code most brittle and hard to extend?' },
  { id: 'ux-ui', label: 'UX & UI Improvements', emoji: '📱', description: 'Refine interfaces and interaction logic' },
  { id: 'scalability', label: 'API & Scalability', emoji: '🌍', description: 'Improve interface design and throughput bottlenecks' },
] as const;

// Combined categories for backward compatibility
export const IMPROVEMENT_CATEGORIES = [
  ...HEALTH_CATEGORIES,
  ...GROWTH_CATEGORIES,
] as const;

export type ImprovementCategory = typeof IMPROVEMENT_CATEGORIES[number]['id'];

export interface ReferenceRepo {
  id: string;
  name: string;
  alias?: string;
}

/**
 * Represents a single improvement suggestion with selection state
 */
export interface SuggestionItem {
  title: string;
  description: string;
  isSelected: boolean;
}

/**
 * Timing metadata for generation requests
 */
export interface GenerationTimingMetadata {
  /** Estimated duration for the LLM call in milliseconds */
  estimatedDurationMs?: number;
  /** Actual duration for the LLM call in milliseconds */
  actualDurationMs?: number;
  /** Whether the estimate is based on historical data */
  isHistoricalEstimate?: boolean;
}

/**
 * Result from generating suggestions including timing metadata
 */
export interface GenerateSuggestionsResult {
  suggestions: SuggestionItem[];
  timing?: GenerationTimingMetadata;
}

export interface RepoImprovementsPanelProps {
  /** Available repositories to use as reference */
  availableRepos?: ReferenceRepo[];
  /** Callback when generating suggestions is triggered - returns suggestions with timing */
  onGenerateSuggestions?: (params: {
    categories: ImprovementCategory[];
    customPrompt: string;
    referenceRepoId: string | null;
    model: string;
    contextLevel: number;
  }) => Promise<GenerateSuggestionsResult | void>;
  /** Repository name to display */
  repositoryName?: string;
  /** Full repository identifier (e.g., 'owner/repo') for navigation */
  repositoryId?: string;
  /** Whether the panel is disabled */
  disabled?: boolean;
  /** List of generated suggestions with selection state */
  suggestions?: SuggestionItem[];
  /** Callback when a suggestion's selection state is toggled */
  onToggleSuggestion?: (index: number) => void;
  /** Default model to use */
  defaultModel?: string;
  /** Default context level */
  defaultContextLevel?: number;
  /** Last generation timing metadata */
  lastGenerationTiming?: GenerationTimingMetadata;
  /** Callback when todos are saved successfully - receives the created todo IDs */
  onTodosSaved?: (todoIds: string[]) => void;
}
