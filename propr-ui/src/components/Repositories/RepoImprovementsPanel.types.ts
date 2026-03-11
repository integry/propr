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

/**
 * Represents a single improvement suggestion with selection state
 */
export interface SuggestionItem {
  title: string;
  description: string;
  isSelected: boolean;
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
  /** List of generated suggestions with selection state */
  suggestions?: SuggestionItem[];
  /** Callback when a suggestion's selection state is toggled */
  onToggleSuggestion?: (index: number) => void;
}
