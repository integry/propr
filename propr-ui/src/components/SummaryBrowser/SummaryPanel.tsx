import React from 'react';
import { FileText, Folder, FileCode, FileJson, File } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import type { SummaryEntry } from '../../api/summaryApi';

interface SummaryPanelProps {
  selectedEntry: SummaryEntry | null;
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

const SummaryPanel: React.FC<SummaryPanelProps> = ({ selectedEntry }) => {
  return (
    <div className="md:w-1/2 p-4 bg-gray-50 min-h-[200px]">
      <AnimatePresence mode="wait">
        {selectedEntry ? (
          <motion.div
            key={selectedEntry.path}
            initial={{ opacity: 0, x: 10 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -10 }}
            transition={{ duration: 0.15 }}
          >
            {/* Header with icon and path */}
            <div className="flex items-center gap-2 mb-3">
              {selectedEntry.entryType === 'directory' ? (
                <Folder className="w-5 h-5 text-yellow-500 flex-shrink-0" />
              ) : (
                getFileIcon(selectedEntry.name)
              )}
              <h4 className="font-medium text-gray-800 truncate font-mono text-sm" title={selectedEntry.path}>
                {selectedEntry.path || '/'}
              </h4>
            </div>

            {/* Entry type badge */}
            <div className="mb-3">
              <span
                className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                  selectedEntry.entryType === 'directory'
                    ? 'bg-yellow-100 text-yellow-800'
                    : 'bg-blue-100 text-blue-800'
                }`}
              >
                {selectedEntry.entryType === 'directory' ? 'Directory' : 'File'}
              </span>
            </div>

            {/* Summary content */}
            {selectedEntry.summary ? (
              <div className="bg-white border border-gray-200 rounded-lg p-4 shadow-sm">
                <h5 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">
                  Summary
                </h5>
                <p className="text-sm text-gray-700 whitespace-pre-wrap leading-relaxed">
                  {selectedEntry.summary}
                </p>
              </div>
            ) : (
              <div className="bg-white border border-gray-200 rounded-lg p-4">
                <p className="text-sm text-gray-400 italic text-center">
                  No summary available for this {selectedEntry.entryType}
                </p>
              </div>
            )}
          </motion.div>
        ) : (
          <motion.div
            key="empty"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="flex flex-col items-center justify-center h-full min-h-[180px] text-gray-400"
          >
            <FileText className="w-8 h-8 mb-2 text-gray-300" />
            <p className="text-sm">Select a file or directory to view its summary</p>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

export default SummaryPanel;
