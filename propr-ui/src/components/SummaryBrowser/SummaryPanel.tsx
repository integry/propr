import React from 'react';
import { FileText, Folder, FileCode, FileJson, File, ExternalLink } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import type { SummaryEntry } from '../../api/summaryApi';

interface SummaryPanelProps {
  selectedEntry: SummaryEntry | null;
  owner: string;
  repo: string;
}

/**
 * Get the appropriate icon for a file based on its extension
 */
function getFileIcon(fileName: string, size: string = 'w-5 h-5'): React.ReactNode {
  const ext = fileName.split('.').pop()?.toLowerCase() || '';

  // Code files
  if (['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'].includes(ext)) {
    return <FileCode className={`${size} text-blue-500`} />;
  }

  // JSON/Config files
  if (['json', 'yaml', 'yml', 'toml', 'xml'].includes(ext)) {
    return <FileJson className={`${size} text-yellow-600`} />;
  }

  // Markdown/Docs
  if (['md', 'mdx', 'rst', 'txt'].includes(ext)) {
    return <FileText className={`${size} text-gray-500`} />;
  }

  // Python
  if (['py', 'pyi', 'pyx'].includes(ext)) {
    return <FileCode className={`${size} text-green-600`} />;
  }

  // Rust/Go
  if (['rs', 'go'].includes(ext)) {
    return <FileCode className={`${size} text-orange-500`} />;
  }

  // CSS/Style files
  if (['css', 'scss', 'sass', 'less'].includes(ext)) {
    return <FileCode className={`${size} text-purple-500`} />;
  }

  // Default file icon
  return <File className={`${size} text-gray-400`} />;
}

const SummaryPanel: React.FC<SummaryPanelProps> = ({ selectedEntry, owner, repo }) => {
  return (
    <div className="flex-1 flex flex-col overflow-auto bg-[#1e1e1e]">
      <AnimatePresence mode="wait">
        {selectedEntry ? (
          <motion.div
            key={selectedEntry.path}
            initial={{ opacity: 0, x: 10 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -10 }}
            transition={{ duration: 0.15 }}
            className="flex flex-col h-full"
          >
            {/* Header bar - VS Code style */}
            <div className="flex items-center gap-2 px-4 py-2 bg-[#252526] border-b border-[#3c3c3c]">
              {selectedEntry.entryType === 'directory' ? (
                <Folder className="w-4 h-4 text-yellow-400 flex-shrink-0" />
              ) : (
                getFileIcon(selectedEntry.name, 'w-4 h-4')
              )}
              <h4 className="font-medium text-slate-200 truncate font-mono text-sm" title={selectedEntry.path}>
                {selectedEntry.path || '/'}
              </h4>
              <a
                href={`https://github.com/${owner}/${repo}/${selectedEntry.entryType === 'directory' ? 'tree' : 'blob'}/HEAD/${selectedEntry.path}`}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1 text-slate-400 hover:text-blue-400 flex-shrink-0 ml-auto"
                title="View on GitHub"
              >
                <ExternalLink className="w-4 h-4" />
              </a>
            </div>

            {/* Entry type badge */}
            <div className="px-4 py-2 bg-[#252526]">
              <span
                className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                  selectedEntry.entryType === 'directory'
                    ? 'bg-yellow-900/50 text-yellow-300'
                    : 'bg-blue-900/50 text-blue-300'
                }`}
              >
                {selectedEntry.entryType === 'directory' ? 'Directory' : 'File'}
              </span>
            </div>

            {/* Summary content - VS Code dark theme */}
            <div className="flex-1 overflow-auto p-4">
              {selectedEntry.summary ? (
                <div>
                  <h5 className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-3">
                    Summary
                  </h5>
                  <p className="text-sm text-slate-300 whitespace-pre-wrap leading-relaxed font-mono">
                    {selectedEntry.summary}
                  </p>
                </div>
              ) : (
                <div className="flex items-center justify-center h-full">
                  <p className="text-sm text-slate-500 italic text-center">
                    No summary available for this {selectedEntry.entryType}
                  </p>
                </div>
              )}
            </div>
          </motion.div>
        ) : (
          <motion.div
            key="empty"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="flex flex-col items-center justify-center h-full min-h-[180px] text-slate-500"
          >
            <FileText className="w-8 h-8 mb-2 text-slate-600" />
            <p className="text-sm">Select a file or directory to view its summary</p>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

export default SummaryPanel;
