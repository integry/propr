import React from 'react';
import { FileText, Folder, FileCode, FileJson, File, ExternalLink, Copy } from 'lucide-react';
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

/**
 * Copy path to clipboard
 */
function copyToClipboard(text: string) {
  navigator.clipboard.writeText(text).catch(console.error);
}

const SummaryPanel: React.FC<SummaryPanelProps> = ({ selectedEntry, owner, repo }) => {
  return (
    <div className="flex-1 flex flex-col overflow-hidden m-2 ml-0">
      <AnimatePresence mode="wait">
        {selectedEntry ? (
          <motion.div
            key={selectedEntry.path}
            initial={{ opacity: 0, x: 10 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -10 }}
            transition={{ duration: 0.15 }}
            className="flex flex-col h-full bg-white border border-gray-200 rounded-md overflow-hidden"
          >
            {/* IDE Tab Header - light mode */}
            <div className="flex items-center gap-2 px-3 py-2 bg-slate-50 border-b border-gray-200 flex-shrink-0">
              {selectedEntry.entryType === 'directory' ? (
                <Folder className="w-4 h-4 text-yellow-500 flex-shrink-0" />
              ) : (
                getFileIcon(selectedEntry.name, 'w-4 h-4')
              )}
              <span className="font-mono text-xs text-slate-700 truncate flex-1" title={selectedEntry.path}>
                {selectedEntry.name}
              </span>
              {/* Ghost buttons */}
              <button
                onClick={() => copyToClipboard(selectedEntry.path)}
                className="flex items-center gap-1 px-2 py-1 text-xs text-slate-500 hover:text-slate-700 hover:bg-slate-100 rounded transition-colors"
                title="Copy path"
              >
                <Copy className="w-3 h-3" />
              </button>
              <a
                href={`https://github.com/${owner}/${repo}/${selectedEntry.entryType === 'directory' ? 'tree' : 'blob'}/HEAD/${selectedEntry.path}`}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1 px-2 py-1 text-xs text-slate-500 hover:text-blue-600 hover:bg-slate-100 rounded transition-colors"
                title="Open on GitHub"
              >
                <ExternalLink className="w-3 h-3" />
              </a>
            </div>

            {/* Summary content - light mode with high-contrast typography */}
            <div className="flex-1 overflow-auto p-4">
              {selectedEntry.summary ? (
                <div>
                  <h5 className="text-[10px] font-bold text-slate-900 uppercase tracking-wider mb-3">
                    Summary
                  </h5>
                  <p className="text-sm text-slate-800 whitespace-pre-wrap leading-relaxed">
                    {selectedEntry.summary}
                  </p>
                </div>
              ) : (
                <div className="flex items-center justify-center h-full">
                  <p className="text-sm text-slate-400 italic text-center">
                    No summary available for this {selectedEntry.entryType}
                  </p>
                </div>
              )}

              {/* Entry type badge - now at bottom */}
              <div className="mt-4 pt-3 border-t border-gray-100">
                <span
                  className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                    selectedEntry.entryType === 'directory'
                      ? 'bg-yellow-50 text-yellow-700 border border-yellow-200'
                      : 'bg-blue-50 text-blue-700 border border-blue-200'
                  }`}
                >
                  {selectedEntry.entryType === 'directory' ? 'Directory' : 'File'}
                </span>
                <code className="ml-2 px-1.5 py-0.5 bg-gray-100 text-gray-600 text-xs font-mono rounded border border-gray-200">
                  {selectedEntry.path}
                </code>
              </div>
            </div>
          </motion.div>
        ) : (
          <motion.div
            key="empty"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="flex flex-col items-center justify-center h-full min-h-[180px] bg-white border border-gray-200 rounded-md"
          >
            <FileText className="w-8 h-8 mb-2 text-slate-300" />
            <p className="text-sm text-slate-400">Select a file or directory to view its summary</p>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

export default SummaryPanel;
