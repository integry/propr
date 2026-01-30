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
  const { path, linesAdded, linesRemoved, diff, status } = file;

  // Get display name for the file path (just the filename)
  const fileName = path.split('/').pop() || path;

  // Get status label
  const getStatusLabel = () => {
    switch (status) {
      case 'added':
        return <span className="text-green-600 text-xs font-medium px-2 py-0.5 bg-green-100 rounded">NEW</span>;
      case 'deleted':
        return <span className="text-red-600 text-xs font-medium px-2 py-0.5 bg-red-100 rounded">DELETED</span>;
      case 'renamed':
        return <span className="text-yellow-600 text-xs font-medium px-2 py-0.5 bg-yellow-100 rounded">RENAMED</span>;
      default:
        return <span className="text-blue-600 text-xs font-medium px-2 py-0.5 bg-blue-100 rounded">MODIFIED</span>;
    }
  };

  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 h-full flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 bg-gray-50">
        <div className="flex items-center gap-3 min-w-0">
          <FileCode className="h-5 w-5 text-gray-600 flex-shrink-0" />
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="font-medium text-gray-900 truncate">{fileName}</span>
              {getStatusLabel()}
            </div>
            <div className="text-xs text-gray-500 truncate">{path}</div>
          </div>
        </div>
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-3 text-sm font-mono">
            <span className="flex items-center text-green-600">
              <Plus className="h-4 w-4 mr-0.5" />
              {linesAdded}
            </span>
            <span className="flex items-center text-red-500">
              <Minus className="h-4 w-4 mr-0.5" />
              {linesRemoved}
            </span>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded hover:bg-gray-200 transition-colors"
            title="Close diff view"
          >
            <X className="h-5 w-5 text-gray-600" />
          </button>
        </div>
      </div>

      {/* Diff Content */}
      <div className="flex-1 overflow-auto">
        {diff ? (
          <SyntaxHighlighter
            language="diff"
            style={vscDarkPlus}
            customStyle={{
              fontSize: '12px',
              margin: 0,
              borderRadius: 0,
              minHeight: '100%'
            }}
            showLineNumbers={false}
            wrapLines={true}
            lineProps={(lineNumber) => {
              const lines = diff.split('\n');
              const line = lines[lineNumber - 1] || '';
              const style: React.CSSProperties = { display: 'block' };

              if (line.startsWith('+') && !line.startsWith('+++')) {
                style.backgroundColor = 'rgba(46, 160, 67, 0.15)';
              } else if (line.startsWith('-') && !line.startsWith('---')) {
                style.backgroundColor = 'rgba(248, 81, 73, 0.15)';
              } else if (line.startsWith('@@')) {
                style.backgroundColor = 'rgba(56, 139, 253, 0.15)';
                style.color = '#79c0ff';
              }

              return { style };
            }}
          >
            {diff}
          </SyntaxHighlighter>
        ) : (
          <div className="flex items-center justify-center h-full text-gray-500">
            <div className="text-center">
              <FileCode className="h-12 w-12 mx-auto mb-2 text-gray-400" />
              <p>No diff content available</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default DiffViewer;
