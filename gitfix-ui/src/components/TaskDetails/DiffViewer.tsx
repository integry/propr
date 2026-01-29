import React from 'react';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { X, FileCode, Plus, Minus } from 'lucide-react';
import { FileChange } from '../../api/fileChangesApi';

interface DiffViewerProps {
  file: FileChange;
  onClose: () => void;
}

const DiffViewer: React.FC<DiffViewerProps> = ({ file, onClose }) => {
  return (
    <div className="h-full flex flex-col bg-white rounded-lg shadow-sm border border-gray-200">
      {/* Header */}
      <div className="flex items-center justify-between p-3 border-b border-gray-200 bg-gray-50 rounded-t-lg">
        <div className="flex items-center gap-2 min-w-0">
          <FileCode className="h-4 w-4 text-blue-500 flex-shrink-0" />
          <span className="font-mono text-sm text-gray-700 truncate">{file.path}</span>
          <span className="flex items-center gap-2 text-xs flex-shrink-0">
            {file.linesAdded > 0 && (
              <span className="flex items-center text-green-600 bg-green-50 px-1.5 py-0.5 rounded">
                <Plus className="h-3 w-3 mr-0.5" />
                {file.linesAdded}
              </span>
            )}
            {file.linesRemoved > 0 && (
              <span className="flex items-center text-red-600 bg-red-50 px-1.5 py-0.5 rounded">
                <Minus className="h-3 w-3 mr-0.5" />
                {file.linesRemoved}
              </span>
            )}
          </span>
        </div>
        <button
          onClick={onClose}
          className="p-1 hover:bg-gray-200 rounded transition-colors flex-shrink-0"
          title="Close diff view"
        >
          <X className="h-5 w-5 text-gray-500" />
        </button>
      </div>

      {/* Diff Content */}
      <div className="flex-1 overflow-auto">
        {file.diff ? (
          <SyntaxHighlighter
            language="diff"
            style={vscDarkPlus}
            customStyle={{
              fontSize: '12px',
              margin: 0,
              borderRadius: 0,
              height: '100%',
              minHeight: '200px'
            }}
            showLineNumbers={false}
            wrapLines={true}
            lineProps={(lineNumber) => {
              const lines = file.diff.split('\n');
              const line = lines[lineNumber - 1] || '';
              const style: React.CSSProperties = {};

              if (line.startsWith('+') && !line.startsWith('+++')) {
                style.backgroundColor = 'rgba(46, 160, 67, 0.15)';
              } else if (line.startsWith('-') && !line.startsWith('---')) {
                style.backgroundColor = 'rgba(248, 81, 73, 0.15)';
              } else if (line.startsWith('@@')) {
                style.backgroundColor = 'rgba(56, 139, 253, 0.15)';
              }

              return { style };
            }}
          >
            {file.diff}
          </SyntaxHighlighter>
        ) : (
          <div className="flex items-center justify-center h-full text-gray-500 text-sm">
            {file.status === 'added' ? (
              <span>New file (diff not available)</span>
            ) : file.status === 'deleted' ? (
              <span>File deleted</span>
            ) : (
              <span>No diff available</span>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default DiffViewer;
