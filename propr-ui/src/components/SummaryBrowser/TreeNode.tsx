import React from 'react';
import {
  ChevronRight,
  ChevronDown,
  FileText,
  Folder,
  FolderOpen,
  Loader2,
  FileCode,
  FileJson,
  File,
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import type { SummaryEntry } from '../../api/summaryApi';
import type { TreeNodeState } from './index';

interface TreeNodeProps {
  entry: SummaryEntry;
  depth: number;
  nodeStates: Record<string, TreeNodeState>;
  selectedPath: string | null;
  onSelect: (entry: SummaryEntry) => void;
}

/**
 * Get the appropriate icon for a file based on its extension
 */
function getFileIcon(fileName: string): React.ReactNode {
  const ext = fileName.split('.').pop()?.toLowerCase() || '';

  // Code files
  if (['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'].includes(ext)) {
    return <FileCode className="w-4 h-4 text-blue-500" />;
  }

  // JSON/Config files
  if (['json', 'yaml', 'yml', 'toml', 'xml'].includes(ext)) {
    return <FileJson className="w-4 h-4 text-yellow-600" />;
  }

  // Markdown/Docs
  if (['md', 'mdx', 'rst', 'txt'].includes(ext)) {
    return <FileText className="w-4 h-4 text-gray-500" />;
  }

  // Python
  if (['py', 'pyi', 'pyx'].includes(ext)) {
    return <FileCode className="w-4 h-4 text-green-600" />;
  }

  // Rust/Go
  if (['rs', 'go'].includes(ext)) {
    return <FileCode className="w-4 h-4 text-orange-500" />;
  }

  // CSS/Style files
  if (['css', 'scss', 'sass', 'less'].includes(ext)) {
    return <FileCode className="w-4 h-4 text-purple-500" />;
  }

  // Default file icon
  return <File className="w-4 h-4 text-gray-400" />;
}

const TreeNode: React.FC<TreeNodeProps> = ({
  entry,
  depth,
  nodeStates,
  selectedPath,
  onSelect,
}) => {
  const state = nodeStates[entry.path] || { expanded: false, children: null, loading: false };
  const isDirectory = entry.entryType === 'directory';
  const isSelected = selectedPath === entry.path;
  // IDE-style indentation with fixed-width gutter and guide lines
  const indentWidth = 16;
  const paddingLeft = 8;
  const iconGutterWidth = 20; // Fixed width for icons

  return (
    <div className="relative">
      {/* Vertical guide lines for nesting - 1px subtle lines for deep structures */}
      {depth > 0 && (
        <div className="absolute top-0 bottom-0 left-0 flex pointer-events-none">
          {Array.from({ length: depth }).map((_, i) => (
            <div
              key={i}
              className="absolute top-0 bottom-0 border-l border-slate-100"
              style={{ left: paddingLeft + i * indentWidth + indentWidth / 2 - 1 }}
            />
          ))}
        </div>
      )}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.15 }}
        className={`flex items-center gap-1 py-0.5 cursor-pointer transition-colors font-mono text-[11px] ${
          isSelected
            ? 'bg-teal-50'
            : 'hover:bg-slate-100'
        }`}
        style={{ paddingLeft: paddingLeft + depth * indentWidth, paddingRight: 8 }}
        onClick={() => onSelect(entry)}
      >
        {/* Fixed-width icon gutter for consistent alignment */}
        <span className="flex items-center gap-0.5" style={{ width: iconGutterWidth + 20, minWidth: iconGutterWidth + 20 }}>
          {/* Expand/collapse icon for directories */}
          {isDirectory ? (
            <span className="w-4 h-4 flex items-center justify-center text-slate-500 flex-shrink-0">
              {state.loading ? (
                <Loader2 className="w-3 h-3 animate-spin" />
              ) : (
                <motion.span
                  animate={{ rotate: state.expanded ? 90 : 0 }}
                  transition={{ duration: 0.15 }}
                >
                  {state.expanded ? (
                    <ChevronDown className="w-4 h-4" />
                  ) : (
                    <ChevronRight className="w-4 h-4" />
                  )}
                </motion.span>
              )}
            </span>
          ) : (
            <span className="w-4 flex-shrink-0" />
          )}

          {/* File/folder icon */}
          <span className="flex-shrink-0">
            {isDirectory ? (
              state.expanded ? (
                <FolderOpen className="w-4 h-4 text-yellow-500" />
              ) : (
                <Folder className="w-4 h-4 text-yellow-500" />
              )
            ) : (
              getFileIcon(entry.name)
            )}
          </span>
        </span>

        {/* Entry name - monospace IDE style */}
        <span
          className={`truncate ${isDirectory ? 'font-medium text-slate-700' : 'text-slate-600'}`}
          title={entry.name}
        >
          {entry.name}
        </span>

        {/* Summary indicator */}
        {entry.summary && (
          <span className="ml-auto text-xs text-slate-400 hidden sm:inline flex-shrink-0" title="Has summary">
            <FileText className="w-3 h-3" />
          </span>
        )}
      </motion.div>

      {/* Render children if expanded */}
      <AnimatePresence initial={false}>
        {isDirectory && state.expanded && state.children && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.2 }}
          >
            {state.children.length === 0 ? (
              <p
                className="text-xs text-slate-400 italic py-1 font-mono"
                style={{ paddingLeft: paddingLeft + (depth + 1) * indentWidth + 24 }}
              >
                Empty directory
              </p>
            ) : (
              state.children.map((child) => (
                <TreeNode
                  key={child.path}
                  entry={child}
                  depth={depth + 1}
                  nodeStates={nodeStates}
                  selectedPath={selectedPath}
                  onSelect={onSelect}
                />
              ))
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

export default TreeNode;
