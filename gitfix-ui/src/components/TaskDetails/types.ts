export interface HistoryItemMetadata {
  model?: string;
  pr?: { url?: string; number?: number };
  pullRequest?: { url?: string; number?: number };
  description?: string;
}

export interface HistoryItem {
  state?: string;
  timestamp?: string;
  promptPath?: string;
  logsPath?: string;
  reason?: string;
  metadata?: HistoryItemMetadata;
}

export interface TaskInfo {
  title?: string;
  subtitle?: string;
  type?: string;
  number?: number;
  repoOwner?: string;
  repoName?: string;
  modelName?: string;
  model?: string;
  llmProvider?: string;
}

export interface PromptData {
  prompt?: string;
  error?: string;
  sessionId?: string;
  model?: string;
  timestamp?: string;
  isRetry?: boolean;
  issueRef?: {
    repoOwner?: string;
    repoName?: string;
    number?: number;
  };
}

export interface LogFileInfo {
  name: string;
  path: string;
  size: number;
  type: string;
}

export interface LogFilesData {
  sessionId?: string;
  logFiles?: LogFileInfo[];
  error?: string;
  files?: Record<string, string>;
}

export interface SelectedLogFileData {
  name: string;
  content: string | object;
  isJson: boolean;
}

export interface TodoItem {
  id: string;
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
}

export interface LiveEvent {
  type: 'thought' | 'tool_use' | 'tool_result';
  content?: string;
  timestamp?: string;
  toolName?: string;
  input?: { file_path?: string; command?: string };
  result?: string | object;
  isError?: boolean;
}

export interface LiveDetails {
  events: LiveEvent[];
  todos: TodoItem[];
  currentTask: string | null;
}

export interface AnalysisData {
  report?: string;
  analysis?: string;
  content?: string;
  error?: string;
}

export interface MarkdownPart {
  type: 'text' | 'code';
  content: string;
  language?: string;
}
