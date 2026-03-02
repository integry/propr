import { LiveEvent, ParsedAnalysis, HistoryItem } from './types';

export const WORKSPACE_PREFIXES = [
  '/home/node/workspace/',
  /\/tmp\/git-processor\/worktrees\/[^\/]+\/[^\/]+\/[^\/]+\//
];

export const formatDisplayPath = (fullPath: string): string => {
  if (!fullPath || typeof fullPath !== 'string') {
    return fullPath;
  }
  
  for (const prefix of WORKSPACE_PREFIXES) {
    if (typeof prefix === 'string' && fullPath.startsWith(prefix)) {
      return fullPath.substring(prefix.length);
    } else if (prefix instanceof RegExp) {
      const match = fullPath.match(prefix);
      if (match) {
        return fullPath.substring(match[0].length);
      }
    }
  }
  
  return fullPath;
};

export const formatDateOnly = (dateString: string): string => {
  return new Date(dateString).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
};

export const formatTimeOnly = (dateString: string): string => {
  return new Date(dateString).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
};

export const formatDate = (dateString: string): string => {
  return new Date(dateString).toLocaleString();
};

export const formatModelName = (modelId: string | undefined): string => {
  if (!modelId) return 'Unknown Model';
  const modelMap: Record<string, string> = {
    'claude-sonnet-4-5-20250929': 'Claude Sonnet 4.5',
    'claude-sonnet-3-5-20240620': 'Claude Sonnet 3.5',
    'claude-opus-3-20240229': 'Claude Opus 3',
    'claude-haiku-3-20240307': 'Claude Haiku 3',
  };
  return modelMap[modelId] || modelId;
};

export const formatRelativeTime = (milliseconds: number): string => {
  const seconds = Math.floor(milliseconds / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds}s`;
};

export const getStatusIcon = (status: string): string => {
  if (status === 'COMPLETED') return '✅';
  if (status === 'FAILED') return '❌';
  if (['PROCESSING', 'CLAUDE_EXECUTION', 'POST_PROCESSING'].includes(status)) return '⏳';
  return '📋';
};

export const stripWorkspacePrefixes = (text: string): string => {
  let result = text;
  for (const prefix of WORKSPACE_PREFIXES) {
    if (typeof prefix === 'string') {
      result = result.split(prefix).join('');
    } else if (prefix instanceof RegExp) {
      result = result.replace(new RegExp(prefix.source, 'g'), '');
    }
  }
  return result;
};

// ThinkingLog helper - Pattern lists for thought type detection
const SUMMARY_PATTERNS = ['implementation summary', 'summary:', 'completed:', 'successfully'];
const ANALYSIS_PATTERNS = ['i will analyze', 'let me analyze', 'looking at', 'examining', 'reviewing', 'understanding', 'i need to understand', 'let me understand'];
const SEARCH_PATTERNS = ['searching', 'let me search', 'looking for', 'finding'];
const ACTION_PATTERNS = ['now let me', 'i will create', 'i will update', 'i will modify', 'i will add', 'i will implement', 'let me create', 'let me update', 'let me modify', 'let me add', 'creating', 'updating', 'modifying'];

const matchesAnyPattern = (content: string, patterns: string[]): boolean =>
  patterns.some(pattern => content.includes(pattern));

// Detect the type of thought based on content
export const detectThoughtType = (content: string): 'analysis' | 'action' | 'summary' | 'search' => {
  const lowerContent = content.toLowerCase();

  if (matchesAnyPattern(lowerContent, SUMMARY_PATTERNS)) return 'summary';
  if (matchesAnyPattern(lowerContent, ANALYSIS_PATTERNS)) return 'analysis';
  if (matchesAnyPattern(lowerContent, SEARCH_PATTERNS)) return 'search';
  if (matchesAnyPattern(lowerContent, ACTION_PATTERNS)) return 'action';

  return 'analysis';
};

// ExecutionEventLog helpers - Event categories for filtering
export type EventCategory = 'thought' | 'tool_use' | 'tool_result' | 'read' | 'write' | 'bash' | 'search';

// Get category for an event
export const getEventCategory = (event: LiveEvent): EventCategory => {
  if (event.type === 'thought') return 'thought';
  if (event.type === 'tool_result') return 'tool_result';

  const toolName = event.toolName?.toLowerCase() || '';
  if (toolName === 'read') return 'read';
  if (toolName === 'write' || toolName === 'edit') return 'write';
  if (toolName === 'bash') return 'bash';
  if (toolName === 'glob' || toolName === 'grep') return 'search';

  return 'tool_use';
};

// Parse analysis data from raw analysis object (handles double-encoded JSON)
export const parseAnalysisData = (rawAnalysis: unknown): ParsedAnalysis | null => {
  if (!rawAnalysis) return null;

  let parsed = rawAnalysis;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
      if (typeof parsed === 'string') {
        parsed = JSON.parse(parsed);
      }
    } catch {
      return null;
    }
  }

  if (typeof parsed === 'object' && parsed !== null && 'report' in parsed) {
    const analysisObj = parsed as { report?: string };
    if (analysisObj.report) {
      try {
        let reportText = analysisObj.report;
        const jsonMatch = reportText.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
        if (jsonMatch) {
          reportText = jsonMatch[1].trim();
        }
        return JSON.parse(reportText);
      } catch {
        return null;
      }
    }
  }

  return parsed as ParsedAnalysis;
};

// Generate initial content for follow-up modal based on analysis data
export const generateFollowupContent = (
  analysis: unknown,
  history: HistoryItem[] | null | undefined
): string => {
  const parsedAnalysis = parseAnalysisData(analysis);

  if (!parsedAnalysis) {
    return 'Please address the following based on the previous task execution:\n\n';
  }

  const parts: string[] = [];
  const latestState = history?.[history.length - 1]?.state?.toUpperCase();
  const isFailed = latestState === 'FAILED';

  if (isFailed && parsedAnalysis.error_analysis) {
    parts.push('## Issue to Fix\n');
    parts.push(parsedAnalysis.error_analysis);
    parts.push('\n');
  }

  if (parsedAnalysis.recommendations && parsedAnalysis.recommendations.length > 0) {
    parts.push('## Recommendations to Address\n');
    parsedAnalysis.recommendations.forEach((rec, idx) => {
      parts.push(`${idx + 1}. ${rec}`);
    });
    parts.push('\n');
  }

  if (parsedAnalysis.implementation_critique) {
    parts.push('## Implementation Feedback\n');
    parts.push(parsedAnalysis.implementation_critique);
    parts.push('\n');
  }

  if (parts.length === 0) {
    return 'Please address the following based on the previous task execution:\n\n';
  }

  return parts.join('\n');
};
