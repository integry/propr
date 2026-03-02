import React from 'react';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { LiveEvent, TaskInfo } from './types';
import { formatDisplayPath } from './utils';
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
import {
  getFileIconType,
  getToolIconType,
  getEventIconType,
} from './ExecutionEventUtils';

// File icon component - desaturated colors for zinc palette terminal
export const FileIcon: React.FC<{ filePath: string }> = ({ filePath }) => {
  const iconType = getFileIconType(filePath);

  switch (iconType) {
    case 'code':
      return <FileCode className="h-3.5 w-3.5 text-blue-400/80" />;
    case 'json':
      return <FileJson className="h-3.5 w-3.5 text-amber-400/80" />;
    case 'text':
      return <FileText className="h-3.5 w-3.5 text-zinc-400" />;
    default:
      return <File className="h-3.5 w-3.5 text-zinc-500" />;
  }
};

// Tool icon component - muted zinc colors for terminal aesthetic
export const ToolIcon: React.FC<{ toolName: string }> = ({ toolName }) => {
  const iconType = getToolIconType(toolName);

  switch (iconType) {
    case 'read':
      return <Eye className="h-3.5 w-3.5 text-zinc-400" />;
    case 'edit':
      return <Edit3 className="h-3.5 w-3.5 text-zinc-400" />;
    case 'write':
      return <FileText className="h-3.5 w-3.5 text-zinc-400" />;
    case 'search':
      return <FolderSearch className="h-3.5 w-3.5 text-zinc-400" />;
    case 'terminal':
      return <Terminal className="h-3.5 w-3.5 text-zinc-400" />;
    case 'web':
      return <Globe className="h-3.5 w-3.5 text-zinc-400" />;
    default:
      return <Wrench className="h-3.5 w-3.5 text-zinc-400" />;
  }
};

// Event icon component - Professional Console aesthetic (desaturated colors for zinc palette)
export const EventIcon: React.FC<{ event: LiveEvent }> = ({ event }) => {
  const iconType = getEventIconType(event);

  switch (iconType) {
    case 'thought':
      // Desaturated gray-blue for AI thoughts - quiet, non-glowing
      return <Lightbulb className="h-3.5 w-3.5 text-slate-400" />;
    case 'tool':
      return <ToolIcon toolName={event.toolName || ''} />;
    case 'success':
      return <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400/80" />;
    case 'error':
      return <XCircle className="h-3.5 w-3.5 text-red-400/80" />;
    default:
      return <FileText className="h-3.5 w-3.5 text-zinc-500" />;
  }
};

// Clickable path component - Updated for dark terminal background
export const ClickablePath: React.FC<{ fullPath: string; taskInfo: TaskInfo | null }> = ({ fullPath, taskInfo }) => {
  const cleanPath = formatDisplayPath(fullPath);

  if (!cleanPath || !cleanPath.includes('/') || cleanPath.startsWith('http')) {
    return (
      <span className="font-mono text-xs flex items-center gap-1 text-zinc-300">
        <FileIcon filePath={cleanPath} />
        {cleanPath}
      </span>
    );
  }

  const REPO_BASE_URL = taskInfo?.repoOwner && taskInfo?.repoName
    ? `https://github.com/${taskInfo.repoOwner}/${taskInfo.repoName}/blob/main`
    : null;

  if (!REPO_BASE_URL) {
    return (
      <span className="font-mono text-xs flex items-center gap-1 text-zinc-300">
        <FileIcon filePath={cleanPath} />
        {cleanPath}
      </span>
    );
  }

  return (
    <a
      href={`${REPO_BASE_URL}/${cleanPath}`}
      target="_blank"
      rel="noopener noreferrer"
      className="font-mono text-xs text-blue-400/80 hover:text-blue-300 underline flex items-center gap-1"
    >
      <FileIcon filePath={cleanPath} />
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
    <div className="border border-zinc-800 rounded">
      <SyntaxHighlighter
        language={language}
        style={vscDarkPlus}
        customStyle={{
          fontSize: '11px',
          borderRadius: '0.25rem',
          margin: 0,
          maxHeight,
          overflow: 'auto',
          background: 'transparent'
        }}
        showLineNumbers={showLineNumbers}
        wrapLines={showLineNumbers}
      >
        {result}
      </SyntaxHighlighter>
    </div>
  );
};
