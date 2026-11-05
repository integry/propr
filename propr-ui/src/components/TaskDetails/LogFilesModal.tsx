import React, { useId } from 'react';
import { ChevronDown, ChevronUp, X } from 'lucide-react';
import { LogFilesData, SelectedLogFileData } from './types';
import TaskDialog from './TaskDialog';
import { logSearchText, splitLogMatches } from './logSearch';

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

/**
 * The run's log files. Wide screens list the files beside the open one; phones
 * stack the list above it, each part scrolling inside the dialog. While an
 * on-screen keyboard clips the dialog (`data-visual-viewport="clipped"` on its
 * layer), the phone layout compacts: the list yields height first and the open
 * file's name takes one line, so at least three lines of the log stay readable.
 * A band too short for that (under 10rem, where the whole dialog scrolls; see
 * TaskDialog) gives the log a scroll area of three lines up to the band less a
 * strip, so a swipe beside or above it still scrolls the dialog back to search.
 */
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

  return (
    <TaskDialog title="Log Files" closeLabel="Close log files" onClose={onClose} sizeClass="sm:h-[85vh] sm:max-w-5xl" testId="log-files-dialog">
      <div className="flex min-h-0 flex-1 flex-col md:flex-row group-data-[visual-viewport=clipped]:overflow-y-auto">
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
            />
          </>
        ) : (
          <p className="p-4 text-gray-600 text-center">No log files found</p>
        )}
      </div>
    </TaskDialog>
  );
};

/** A reported byte size; small files stay in bytes so a nonempty file never reads as 0 KB. */
function formatLogFileSize(bytes: number): string {
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

interface FileListProps {
  logFiles: { name: string; size?: number }[];
  selectedFileName?: string;
  onSelectFile: (fileName: string) => void;
}

const FileList: React.FC<FileListProps> = ({ logFiles, selectedFileName, onSelectFile }) => {
  const headingId = useId();
  return (
    <nav
      aria-labelledby={headingId}
      data-testid="log-file-list"
      className="max-h-[35%] flex-none overflow-y-auto border-b border-gray-200 bg-gray-50 p-3 group-data-[visual-viewport=clipped]:min-h-14 group-data-[visual-viewport=clipped]:shrink group-data-[visual-viewport=clipped]:py-1.5 md:max-h-none md:w-72 md:border-b-0 md:border-r md:p-4 lg:w-80"
    >
      <p id={headingId} className="mb-2 text-sm text-gray-600 group-data-[visual-viewport=clipped]:sr-only md:mb-4 md:text-base">Select a log file to view:</p>
      <div className="flex flex-col gap-2">
        {logFiles.map((file) => (
          <button
            key={file.name}
            type="button"
            onClick={() => onSelectFile(file.name)}
            aria-current={selectedFileName === file.name ? 'true' : undefined}
            className={`min-h-11 text-left px-3 py-2 rounded-md transition-colors border focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-1 ${
              selectedFileName === file.name
                ? 'bg-blue-600 text-white border-blue-600'
                : 'bg-white text-gray-700 hover:bg-gray-100 border-gray-300'
            }`}
          >
            <div className="font-medium text-sm [overflow-wrap:anywhere]">{file.name}</div>
            {typeof file.size === 'number' && Number.isFinite(file.size) && (
              <div className={`text-xs ${selectedFileName === file.name ? 'text-blue-100' : 'text-gray-500'}`}>
                {formatLogFileSize(file.size)}
              </div>
            )}
          </button>
        ))}
      </div>
    </nav>
  );
};

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
}

const matchButtonClass = 'inline-flex min-h-11 min-w-11 items-center justify-center rounded-md border border-gray-300 bg-gray-100 text-gray-700 hover:bg-gray-200 disabled:cursor-not-allowed disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500';

const FileContent: React.FC<FileContentProps> = ({
  selectedLogFile,
  loadingLogFile,
  searchQuery,
  searchMatches,
  currentMatchIndex,
  onSearchChange,
  onPrevMatch,
  onNextMatch,
  logContentRef
}) => {
  const searchId = useId();
  if (!selectedLogFile) {
    return (
      <div className="min-h-0 min-w-0 flex-1 p-4">
        <p className="text-gray-600 text-center">Select a log file to view its contents</p>
      </div>
    );
  }

  const content = logSearchText(selectedLogFile.content, selectedLogFile.isJson);
  const hasMatches = searchMatches.length > 0;
  // Enter steps to the next match and Shift+Enter to the previous one, as in a browser's find bar.
  const onSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter' || !hasMatches) return;
    event.preventDefault();
    if (event.shiftKey) onPrevMatch();
    else onNextMatch();
  };

  return (
    <section aria-labelledby={`${searchId}-title`} className="flex min-h-0 min-w-0 flex-1 flex-col p-3 group-data-[visual-viewport=clipped]:flex-[1_0_9.75rem] group-data-[visual-viewport=clipped]:py-1.5 md:p-4 [@container(max-height:10rem)]:!flex-auto">
      <div className="mb-3 flex flex-none flex-col gap-2 group-data-[visual-viewport=clipped]:mb-1.5 group-data-[visual-viewport=clipped]:gap-1">
        <h3 id={`${searchId}-title`} className="text-base font-semibold text-gray-900 [overflow-wrap:anywhere] group-data-[visual-viewport=clipped]:truncate md:text-lg">{selectedLogFile.name}</h3>
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor={searchId} className="sr-only">Search log</label>
          <div className="relative min-w-[10rem] flex-1">
            <input
              id={searchId}
              type="text"
              placeholder="Search..."
              value={searchQuery}
              onChange={(e) => onSearchChange(e.target.value)}
              onKeyDown={onSearchKeyDown}
              className="min-h-11 w-full rounded-md border border-gray-300 bg-white py-1 pl-3 pr-11 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => onSearchChange('')}
                aria-label="Clear log search"
                className="absolute inset-y-0 right-0 inline-flex min-w-11 items-center justify-center rounded-r-md text-gray-500 hover:text-gray-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
              >
                <X size={16} aria-hidden="true" />
              </button>
            )}
          </div>
          {searchQuery && (
            <div className="flex flex-none items-center gap-1">
              <span role="status" className="min-w-[4.5rem] text-center text-sm tabular-nums text-gray-600">
                {hasMatches ? `${currentMatchIndex + 1} / ${searchMatches.length}` : 'No matches'}
              </span>
              <button type="button" onClick={onPrevMatch} disabled={!hasMatches} aria-label="Previous match" className={matchButtonClass}>
                <ChevronUp size={18} aria-hidden="true" />
              </button>
              <button type="button" onClick={onNextMatch} disabled={!hasMatches} aria-label="Next match" className={matchButtonClass}>
                <ChevronDown size={18} aria-hidden="true" />
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
          tabIndex={0}
          aria-label={`Contents of ${selectedLogFile.name}`}
          data-testid="log-file-content"
          className="min-h-0 flex-1 overflow-y-auto whitespace-pre-wrap [overflow-wrap:anywhere] rounded-md border border-gray-200 bg-gray-50 p-3 font-mono text-xs text-gray-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 group-data-[visual-viewport=clipped]:min-h-[4.125rem] group-data-[visual-viewport=clipped]:p-2 md:p-4 [@container(max-height:10rem)]:h-[max(3.625rem,calc(100cqh-1.5rem))] [@container(max-height:10rem)]:flex-none [@container(max-height:10rem)]:!min-h-0 [@container(max-height:10rem)]:!p-1"
        >
          {splitLogMatches(content, searchQuery).map((segment, index) => segment.matchIndex === undefined ? segment.text : (
            <mark
              key={index}
              data-match-index={segment.matchIndex}
              aria-current={segment.matchIndex === currentMatchIndex ? 'true' : undefined}
              className={`${segment.matchIndex === currentMatchIndex ? 'bg-yellow-500' : 'bg-yellow-300'} rounded px-0.5 text-black`}
            >
              {segment.text}
            </mark>
          ))}
        </pre>
      )}
    </section>
  );
};

export default LogFilesModal;
