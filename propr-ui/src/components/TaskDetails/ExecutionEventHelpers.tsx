import React from 'react';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { LiveEvent, TaskInfo } from './types';
import { formatDisplayPath, stripWorkspacePrefixes } from './utils';
import {
  FileText,
  FileCode,
  FileJson,
  File,
  FolderSearch,
  Terminal,
  Edit3,
  Eye,
  CheckCircle2,
  XCircle,
  Wrench,
  Lightbulb,
  Globe
} from 'lucide-react';

// Get file icon based on file extension
export const getFileIcon = (filePath: string) => {
  const ext = filePath.split('.').pop()?.toLowerCase() || '';

  if (['ts', 'tsx', 'js', 'jsx'].includes(ext)) {
    return <FileCode className="h-3.5 w-3.5 text-blue-500" />;
  }
  if (['json', 'yaml', 'yml'].includes(ext)) {
    return <FileJson className="h-3.5 w-3.5 text-yellow-500" />;
  }
  if (['md', 'txt', 'env'].includes(ext)) {
    return <FileText className="h-3.5 w-3.5 text-gray-500" />;
  }
  return <File className="h-3.5 w-3.5 text-gray-400" />;
};

// Get tool icon based on tool name
export const getToolIcon = (toolName: string) => {
  const name = toolName.toLowerCase();

  if (name === 'read') return <Eye className="h-3.5 w-3.5" />;
  if (name === 'edit') return <Edit3 className="h-3.5 w-3.5" />;
  if (name === 'write') return <FileText className="h-3.5 w-3.5" />;
  if (name === 'glob' || name === 'grep') return <FolderSearch className="h-3.5 w-3.5" />;
  if (name === 'bash') return <Terminal className="h-3.5 w-3.5" />;
  if (name === 'webfetch' || name === 'websearch') return <Globe className="h-3.5 w-3.5" />;

  return <Wrench className="h-3.5 w-3.5" />;
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

// Get category label and color for terminal-style display
export const getCategoryDisplay = (event: LiveEvent): { label: string; color: string } => {
  if (event.type === 'thought') {
    return { label: 'THOUGHT', color: 'text-blue-600' };
  }
  if (event.type === 'tool_result') {
    return event.isError
      ? { label: 'ERROR', color: 'text-red-600' }
      : { label: 'RESULT', color: 'text-green-600' };
  }

  const toolName = event.toolName?.toUpperCase() || 'TOOL';
  return { label: toolName, color: 'text-gray-600' };
};

export const getEventIcon = (event: LiveEvent): React.ReactNode => {
  if (event.type === 'thought') return <Lightbulb className="h-3.5 w-3.5 text-blue-600" />;
  if (event.type === 'tool_use') return getToolIcon(event.toolName || '');
  if (event.type === 'tool_result') {
    return event.isError ? <XCircle className="h-3.5 w-3.5 text-red-500" /> : <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />;
  }
  return <FileText className="h-3.5 w-3.5 text-gray-400" />;
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

export const renderClickablePath = (fullPath: string, taskInfo: TaskInfo | null): React.ReactNode => {
  const cleanPath = formatDisplayPath(fullPath);

  if (!cleanPath || !cleanPath.includes('/') || cleanPath.startsWith('http')) {
    return (
      <span className="font-mono text-xs flex items-center gap-1">
        {getFileIcon(cleanPath)}
        {cleanPath}
      </span>
    );
  }

  const REPO_BASE_URL = taskInfo?.repoOwner && taskInfo?.repoName
    ? `https://github.com/${taskInfo.repoOwner}/${taskInfo.repoName}/blob/main`
    : null;

  if (!REPO_BASE_URL) {
    return (
      <span className="font-mono text-xs flex items-center gap-1">
        {getFileIcon(cleanPath)}
        {cleanPath}
      </span>
    );
  }

  return (
    <a
      href={`${REPO_BASE_URL}/${cleanPath}`}
      target="_blank"
      rel="noopener noreferrer"
      className="font-mono text-xs text-blue-600 hover:text-blue-700 underline flex items-center gap-1"
    >
      {getFileIcon(cleanPath)}
      {cleanPath}
    </a>
  );
};

interface SyntaxHighlightedResultProps {
  result: string;
  language: string;
  maxHeight?: string;
}

export const SyntaxHighlightedResult: React.FC<SyntaxHighlightedResultProps> = ({
  result,
  language,
  maxHeight = '200px'
}) => {
  const showLineNumbers = language !== 'diff';

  return (
    <SyntaxHighlighter
      language={language}
      style={vscDarkPlus}
      customStyle={{
        fontSize: '11px',
        borderRadius: '0.25rem',
        margin: 0,
        maxHeight,
        overflow: 'auto'
      }}
      showLineNumbers={showLineNumbers}
      wrapLines={showLineNumbers}
    >
      {result}
    </SyntaxHighlighter>
  );
};
