import { LiveEvent } from './types';
import { formatDisplayPath, stripWorkspacePrefixes } from './utils';

// Get file icon class based on file extension (returns icon name for use with lucide)
export const getFileIconType = (filePath: string): 'code' | 'json' | 'text' | 'default' => {
  const ext = filePath.split('.').pop()?.toLowerCase() || '';

  if (['ts', 'tsx', 'js', 'jsx'].includes(ext)) {
    return 'code';
  }
  if (['json', 'yaml', 'yml'].includes(ext)) {
    return 'json';
  }
  if (['md', 'txt', 'env'].includes(ext)) {
    return 'text';
  }
  return 'default';
};

// Get tool icon type based on tool name
export const getToolIconType = (toolName: string): 'read' | 'edit' | 'write' | 'search' | 'terminal' | 'web' | 'default' => {
  const name = toolName.toLowerCase();

  if (name === 'read') return 'read';
  if (name === 'edit') return 'edit';
  if (name === 'write') return 'write';
  if (name === 'glob' || name === 'grep') return 'search';
  if (name === 'bash') return 'terminal';
  if (name === 'webfetch' || name === 'websearch') return 'web';

  return 'default';
};

// Detect if content is a diff
const isDiffContent = (content: string): boolean => {
  if (!content) return false;
  const lines = content.split('\n').slice(0, 10);
  const diffPatterns = [
    /^[+-]{3}\s/,        // --- or +++ at start
    /^@@\s.*@@/,         // @@ line numbers @@
    /^[+-]\s/,           // + or - at start of line
    /^diff --git/,       // git diff header
  ];

  return lines.some(line =>
    diffPatterns.some(pattern => pattern.test(line))
  );
};

// Language extension to syntax highlighter mapping
const LANG_MAP: Record<string, string> = {
  'ts': 'typescript',
  'tsx': 'tsx',
  'js': 'javascript',
  'jsx': 'jsx',
  'json': 'json',
  'yaml': 'yaml',
  'yml': 'yaml',
  'md': 'markdown',
  'py': 'python',
  'sh': 'bash',
  'bash': 'bash',
  'css': 'css',
  'scss': 'scss',
  'html': 'html',
  'xml': 'xml',
  'sql': 'sql',
  'go': 'go',
  'rs': 'rust',
  'java': 'java',
  'rb': 'ruby',
  'php': 'php',
};

// Detect language from file path or content
export const detectLanguage = (filePath?: string, content?: string): string => {
  if (filePath) {
    const ext = filePath.split('.').pop()?.toLowerCase() || '';
    if (LANG_MAP[ext]) return LANG_MAP[ext];
  }

  // Check content for diff patterns
  if (content && isDiffContent(content)) {
    return 'diff';
  }

  return 'text';
};

// Check if tool is typically noisy (should be collapsed by default)
export const isNoisyTool = (toolName: string): boolean => {
  const name = toolName.toLowerCase();
  return ['read', 'glob', 'grep', 'todowrite'].includes(name);
};

export const formatToolResult = (result: string | object | undefined): string => {
  let resultText: string;
  if (typeof result === 'string') {
    resultText = result;
  } else if (result === undefined) {
    resultText = '(undefined)';
  } else if (result === null) {
    resultText = '(null)';
  } else {
    try {
      resultText = JSON.stringify(result, null, 2);
    } catch {
      resultText = String(result);
    }
  }
  return stripWorkspacePrefixes(resultText);
};

// Get category label and color for terminal-style display (Professional Console aesthetic)
// Uses desaturated colors that don't "glow" too harshly against the dark zinc-950 background
export const getCategoryDisplay = (event: LiveEvent): { label: string; color: string } => {
  if (event.type === 'thought') {
    // Desaturated gray-blue for AI thoughts - quiet, non-glowing
    return { label: 'THOUGHT', color: 'text-slate-400' };
  }
  if (event.type === 'tool_result') {
    return event.isError
      ? { label: 'ERROR', color: 'text-red-400/80' }
      // Soft "Matrix" teal for success/results
      : { label: 'RESULT', color: 'text-emerald-400/80' };
  }

  // Dimmed zinc for action labels
  const toolName = event.toolName?.toUpperCase() || 'TOOL';
  return { label: toolName, color: 'text-zinc-500' };
};

// Get event icon type for rendering
export const getEventIconType = (event: LiveEvent): 'thought' | 'tool' | 'success' | 'error' | 'default' => {
  if (event.type === 'thought') return 'thought';
  if (event.type === 'tool_use') return 'tool';
  if (event.type === 'tool_result') {
    return event.isError ? 'error' : 'success';
  }
  return 'default';
};

// Extract summary from event content
export const extractEventSummary = (event: LiveEvent): string => {
  if (event.type === 'thought' && event.content) {
    const firstLine = event.content.split('\n')[0];
    return firstLine.length > 60 ? firstLine.substring(0, 57) + '...' : firstLine;
  }

  if (event.type === 'tool_use') {
    if (event.input?.file_path) {
      return formatDisplayPath(event.input.file_path);
    }
    if (event.input?.command) {
      const cmd = event.input.command;
      return cmd.length > 50 ? cmd.substring(0, 47) + '...' : cmd;
    }
    return event.toolName || '';
  }

  if (event.type === 'tool_result') {
    const resultStr = formatToolResult(event.result);
    const truncated = resultStr.slice(0, 50).replace(/\n/g, ' ');
    return truncated + (resultStr.length > 50 ? '...' : '');
  }

  return '';
};
