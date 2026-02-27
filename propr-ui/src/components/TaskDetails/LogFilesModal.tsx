import React from 'react';
import { LogFilesData, SelectedLogFileData } from './types';

interface LogFilesModalProps {
  logFiles: LogFilesData | null;
  selectedLogFile: SelectedLogFileData | null;
  loadingLogFile: boolean;
  searchQuery: string;
  searchMatches: RegExpMatchArray[];
  currentMatchIndex: number;
  onClose: () => void;
  onSelectFile: (fileName: string) => void;
  onSearchChange: (query: string) => void;
  onPrevMatch: () => void;
  onNextMatch: () => void;
  logContentRef: React.RefObject<HTMLPreElement | null>;
}

const LogFilesModal: React.FC<LogFilesModalProps> = ({
  logFiles,
  selectedLogFile,
  loadingLogFile,
  searchQuery,
  searchMatches,
  currentMatchIndex,
  onClose,
  onSelectFile,
  onSearchChange,
  onPrevMatch,
  onNextMatch,
  logContentRef
}) => {
  if (!logFiles) return null;

  const highlightContent = (content: string | object): React.ReactNode => {
    if (!searchQuery) return typeof content === 'string' ? content : JSON.stringify(content, null, 2);

    const contentStr = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
    const parts = contentStr.split(new RegExp(`(${searchQuery})`, 'gi'));
    let matchCount = 0;

    return parts.map((part, index) => {
      if (part.toLowerCase() === searchQuery.toLowerCase()) {
        const isCurrentMatch = matchCount === currentMatchIndex;
        matchCount++;
        return (
          <span
            key={index}
            id={`match-${matchCount - 1}`}
            className={`${
              isCurrentMatch ? 'bg-yellow-500 text-black' : 'bg-yellow-300 text-black'
            } px-1 rounded`}
          >
            {part}
          </span>
        );
      }
      return part;
    });
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg max-w-5xl w-full max-h-[80vh] flex flex-col border border-gray-300 shadow-lg">
        <div className="flex justify-between items-center p-4 border-b border-gray-200">
          <h3 className="text-lg font-semibold text-gray-900">Log Files</h3>
          <button
            className="text-gray-500 hover:text-gray-700 text-2xl leading-none"
            onClick={onClose}
          >
            &times;
          </button>
        </div>
        <div className="flex flex-1 overflow-hidden">
          {logFiles.error ? (
            <div className="p-4 text-red-600">{logFiles.error}</div>
          ) : logFiles.logFiles && logFiles.logFiles.length > 0 ? (
            <>
              <FileList 
                logFiles={logFiles.logFiles} 
                selectedFileName={selectedLogFile?.name}
                onSelectFile={onSelectFile}
              />
              <FileContent
                selectedLogFile={selectedLogFile}
                loadingLogFile={loadingLogFile}
                searchQuery={searchQuery}
                searchMatches={searchMatches}
                currentMatchIndex={currentMatchIndex}
                onSearchChange={onSearchChange}
                onPrevMatch={onPrevMatch}
                onNextMatch={onNextMatch}
                logContentRef={logContentRef}
                highlightContent={highlightContent}
              />
            </>
          ) : (
            <p className="p-4 text-gray-600 text-center">No log files found</p>
          )}
        </div>
      </div>
    </div>
  );
};

interface FileListProps {
  logFiles: { name: string; size: number }[];
  selectedFileName?: string;
  onSelectFile: (fileName: string) => void;
}

const FileList: React.FC<FileListProps> = ({ logFiles, selectedFileName, onSelectFile }) => (
  <div className="w-1/3 border-r border-gray-200 p-4 overflow-y-auto bg-gray-50">
    <p className="mb-4 text-gray-600">Select a log file to view:</p>
    <div className="flex flex-col gap-2">
      {logFiles.map((file) => (
        <button
          key={file.name}
          onClick={() => onSelectFile(file.name)}
          className={`text-left p-3 rounded-md transition-colors border ${
            selectedFileName === file.name
              ? 'bg-blue-600 text-white border-blue-600'
              : 'bg-white text-gray-700 hover:bg-gray-100 border-gray-300'
          }`}
        >
          <div className="font-medium mb-1">{file.name}</div>
          <div className={`text-xs ${selectedFileName === file.name ? 'text-blue-100' : 'text-gray-500'}`}>
            {Math.round(file.size / 1024)} KB
          </div>
        </button>
      ))}
    </div>
  </div>
);

interface FileContentProps {
  selectedLogFile: SelectedLogFileData | null;
  loadingLogFile: boolean;
  searchQuery: string;
  searchMatches: RegExpMatchArray[];
  currentMatchIndex: number;
  onSearchChange: (query: string) => void;
  onPrevMatch: () => void;
  onNextMatch: () => void;
  logContentRef: React.RefObject<HTMLPreElement | null>;
  highlightContent: (content: string | object) => React.ReactNode;
}

const FileContent: React.FC<FileContentProps> = ({
  selectedLogFile,
  loadingLogFile,
  searchQuery,
  searchMatches,
  currentMatchIndex,
  onSearchChange,
  onPrevMatch,
  onNextMatch,
  logContentRef,
  highlightContent
}) => (
  <div className="flex-1 p-4 overflow-hidden flex flex-col">
    {selectedLogFile ? (
      <>
        <div className="flex justify-between items-center mb-4">
          <h3 className="text-lg font-semibold text-gray-900">{selectedLogFile.name}</h3>
          <div className="flex gap-2">
            <input
              type="text"
              placeholder="Search..."
              value={searchQuery}
              onChange={(e) => onSearchChange(e.target.value)}
              className="px-3 py-1 bg-white text-gray-900 rounded-md text-sm border border-gray-300 focus:ring-2 focus:ring-blue-500 focus:outline-none"
            />
            {searchMatches.length > 0 && (
              <div className="flex items-center gap-2">
                <button
                  onClick={onPrevMatch}
                  className="px-2 py-1 bg-gray-100 text-gray-700 rounded-md text-sm hover:bg-gray-200 border border-gray-300"
                >
                  ← Prev
                </button>
                <span className="text-sm text-gray-600">
                  {currentMatchIndex + 1} / {searchMatches.length}
                </span>
                <button
                  onClick={onNextMatch}
                  className="px-2 py-1 bg-gray-100 text-gray-700 rounded-md text-sm hover:bg-gray-200 border border-gray-300"
                >
                  Next →
                </button>
              </div>
            )}
          </div>
        </div>
        {loadingLogFile ? (
          <div className="text-gray-600">Loading log file...</div>
        ) : (
          <pre
            ref={logContentRef}
            className="whitespace-pre-wrap font-mono text-xs text-gray-700 bg-gray-50 p-4 rounded-md overflow-y-auto flex-1 border border-gray-200"
          >
            {selectedLogFile.isJson
              ? highlightContent(JSON.stringify(selectedLogFile.content, null, 2))
              : highlightContent(selectedLogFile.content)}
          </pre>
        )}
      </>
    ) : (
      <p className="text-gray-600 text-center">Select a log file to view its contents</p>
    )}
  </div>
);

export default LogFilesModal;
