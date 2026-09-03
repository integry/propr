import React, { useEffect, useState } from 'react';
import { Github, RefreshCw, Star, Eye, EyeOff, Image, Video } from 'lucide-react';
import { DeleteRepoDialog } from './DeleteRepoDialog';
import { RepositoryIndexingStatus, MonitoredRepo } from '../api/proprApi';
import { getRepoStatusKey } from '../api/repoIndexingApi';

type RepoStatusType = 'indexed' | 'indexing' | 'failed' | 'idle';

// --- Icons ---

const TrashIcon: React.FC<{ className?: string }> = ({ className = "w-4 h-4" }) => (
  <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
  </svg>
);

// Monospace Code Chip for commit hash
const MonoCodeChip: React.FC<{ children: React.ReactNode; href?: string }> = ({ children, href }) => {
  const baseClass = "text-[10px] font-mono text-slate-500 bg-slate-100 px-1.5 py-0.5 rounded";
  if (href) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className={`${baseClass} hover:bg-slate-200 hover:text-slate-700 transition-colors`}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </a>
    );
  }
  return <code className={baseClass}>{children}</code>;
};

// Status dot with pulsing animation for indexing
const StatusDot: React.FC<{ status: RepoStatusType; className?: string }> = ({ status, className = "" }) => {
  const dotColors = {
    indexed: 'bg-slate-400',
    indexing: 'bg-blue-500 animate-pulse',
    failed: 'bg-red-500',
    idle: 'bg-slate-300'
  };
  return <span className={`inline-block w-1.5 h-1.5 rounded-full ${dotColors[status]} ${className}`} />;
};

// Helper to format relative time
const formatRelativeTime = (timestamp: string | null): string => {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
};

// Helper to shorten commit hash
const shortenHash = (hash: string | null): string => {
  if (!hash) return '';
  return hash.substring(0, 7);
};

// Calculate progress text for indexing status
const getProgressText = (status: RepositoryIndexingStatus): string => {
  const progress = status.progress;
  if (!progress) return 'Starting...';

  if (progress.phase === 'directories') {
    const dirPercent = progress.totalDirectories > 0
      ? Math.round((progress.processedDirectories / progress.totalDirectories) * 100)
      : 0;
    return `${dirPercent}%`;
  }
  return `${progress.percentComplete || 0}%`;
};

// Get status info from indexing status
const getStatusInfo = (status: RepositoryIndexingStatus | undefined): {
  statusType: RepoStatusType;
  statusText: string;
  progressText?: string;
} => {
  if (!status) {
    return { statusType: 'idle', statusText: 'Not indexed' };
  }

  switch (status.indexing_status) {
    case 'indexing':
      return { statusType: 'indexing', statusText: 'Indexing', progressText: getProgressText(status) };
    case 'completed':
      return { statusType: 'indexed', statusText: 'Indexed' };
    case 'failed':
      return { statusType: 'failed', statusText: 'Failed' };
    case 'idle':
    default:
      return { statusType: 'idle', statusText: 'Not indexed' };
  }
};

const getRepositoryListItemClassName = (isSelected: boolean) => (
  `border-b border-slate-100 cursor-pointer transition-colors relative group ${isSelected ? 'bg-[#F0FDFA]' : 'hover:bg-slate-50/50'}`
);

const getStatusTextClassName = (statusType: RepoStatusType) => {
  const colorClass = {
    indexed: 'text-slate-500',
    indexing: 'text-blue-600',
    failed: 'text-red-600',
    idle: 'text-slate-500'
  };

  return `inline-flex items-center gap-1.5 ${colorClass[statusType]}`;
};

// Action buttons component to reduce complexity
const RepositoryActionButtons: React.FC<{
  repo: MonitoredRepo;
  statusType: RepoStatusType;
  onToggle: (repoId: string) => void;
  onReindex: (repoName: string, baseBranch?: string) => void;
  onDeleteClick: () => void;
  onToggleStar: (repoId: string) => void;
  onToggleHidden: (repoId: string) => void;
  isReadOnly?: boolean;
}> = ({ repo, statusType, onToggle, onReindex, onDeleteClick, onToggleStar, onToggleHidden, isReadOnly = false }) => (
  <div className="flex items-center gap-1 flex-shrink-0 w-full sm:w-auto justify-end" onClick={(e) => e.stopPropagation()}>
    {/* Star Button */}
    <button
      onClick={() => onToggleStar(repo.id)}
      disabled={isReadOnly}
      className={`p-1.5 rounded transition-colors ${
        repo.starred
          ? 'text-amber-500 hover:text-amber-600 hover:bg-amber-50'
          : 'text-slate-300 opacity-0 group-hover:opacity-100 hover:text-amber-500 hover:bg-amber-50'
      }`}
      title={repo.starred ? 'Unstar repository' : 'Star repository'}
    >
      <Star className={`w-3.5 h-3.5 ${repo.starred ? 'fill-current' : ''}`} />
    </button>

    {/* Hide/Unhide Button */}
    <button
      onClick={() => onToggleHidden(repo.id)}
      disabled={isReadOnly}
      className={`p-1.5 rounded transition-colors ${
        repo.hidden
          ? 'text-slate-500 hover:text-slate-700 hover:bg-slate-100'
          : 'text-slate-300 opacity-0 group-hover:opacity-100 hover:text-slate-500 hover:bg-slate-100'
      }`}
      title={repo.hidden ? 'Unhide repository' : 'Hide repository'}
    >
      {repo.hidden ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
    </button>

    {/* Reindex Button - Gray ghost style */}
    <button
      onClick={() => onReindex(repo.name, repo.baseBranch)}
      className="p-1.5 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded transition-colors"
      title="Reindex Repository"
      disabled={statusType === 'indexing' || isReadOnly}
    >
      <RefreshCw className={`w-3.5 h-3.5 ${statusType === 'indexing' ? 'animate-spin opacity-50' : ''}`} />
    </button>

    {/* Toggle Switch */}
    <label className="relative inline-flex items-center cursor-pointer">
      <input
        type="checkbox"
        checked={repo.enabled}
        onChange={() => onToggle(repo.id)}
        disabled={isReadOnly}
        className="sr-only peer"
      />
      <div className="w-7 h-4 bg-gray-200 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-teal-500/20 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-3 after:w-3 after:transition-all peer-checked:bg-teal-500"></div>
    </label>

    {/* Delete Button - Only visible on hover */}
    <button
      onClick={onDeleteClick}
      disabled={isReadOnly}
      className="p-1.5 text-slate-300 opacity-0 group-hover:opacity-100 hover:text-red-600 hover:bg-red-50 rounded transition-all"
      title="Remove repository"
    >
      <TrashIcon className="w-3.5 h-3.5" />
    </button>
  </div>
);

const AutoCiFollowupControl: React.FC<{
  repo: MonitoredRepo;
  onToggle: (repoId: string) => void;
  isReadOnly: boolean;
}> = ({ repo, onToggle, isReadOnly }) => {
  if (isReadOnly) return null;

  return (
    <label
      className="mt-2 inline-flex items-center gap-2 text-[11px] text-slate-600 cursor-pointer"
      title="Automatically create follow-up work when CI fails"
      onClick={(e) => e.stopPropagation()}
    >
      <input
        type="checkbox"
        checked={repo.autoFollowupOnFailedCi === true}
        onChange={() => onToggle(repo.id)}
        className="sr-only peer"
        aria-label={`Automatic CI follow-up for ${repo.name}`}
      />
      <span className="relative w-7 h-4 bg-slate-200 rounded-full peer-focus:ring-2 peer-focus:ring-teal-500/20 peer-checked:bg-teal-500 after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:h-3 after:w-3 after:rounded-full after:bg-white after:border after:border-slate-300 after:transition-all peer-checked:after:translate-x-full" />
      <span>Auto CI follow-up</span>
      <span className={`rounded px-1.5 py-0.5 font-medium ${repo.autoFollowupOnFailedCi ? 'bg-teal-50 text-teal-700' : 'bg-slate-100 text-slate-500'}`}>
        {repo.autoFollowupOnFailedCi ? 'On' : 'Off'}
      </span>
    </label>
  );
};

type VisualPreviewSettings = NonNullable<MonitoredRepo['visualPreview']>;

const VisualPreviewControl: React.FC<{
  repo: MonitoredRepo;
  onUpdate: (repoId: string, settings: VisualPreviewSettings) => void;
  isReadOnly: boolean;
}> = ({ repo, onUpdate, isReadOnly }) => {
  const settings: VisualPreviewSettings = repo.visualPreview || { enabled: false, types: ['image'] };
  const [instructions, setInstructions] = useState(settings.instructions || '');

  useEffect(() => setInstructions(settings.instructions || ''), [settings.instructions]);

  if (isReadOnly) return null;

  const toggleType = (type: 'image' | 'video') => {
    const selected = settings.types.includes(type);
    if (selected && settings.types.length === 1) return;
    onUpdate(repo.id, {
      ...settings,
      types: selected ? settings.types.filter(candidate => candidate !== type) : [...settings.types, type]
    });
  };

  return (
    <div className="mt-2 text-[11px] text-slate-600" onClick={(event) => event.stopPropagation()}>
      <label className="inline-flex items-center gap-2 cursor-pointer" title="Generate focused media for changes with a visible result">
        <input
          type="checkbox"
          checked={settings.enabled}
          onChange={() => onUpdate(repo.id, { ...settings, enabled: !settings.enabled })}
          className="sr-only peer"
          aria-label={`Visual previews for ${repo.name}`}
        />
        <span className="relative w-7 h-4 bg-slate-200 rounded-full peer-focus:ring-2 peer-focus:ring-teal-500/20 peer-checked:bg-teal-500 after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:h-3 after:w-3 after:rounded-full after:bg-white after:border after:border-slate-300 after:transition-all peer-checked:after:translate-x-full" />
        <span>Visual previews</span>
        <span className={`rounded px-1.5 py-0.5 font-medium ${settings.enabled ? 'bg-teal-50 text-teal-700' : 'bg-slate-100 text-slate-500'}`}>
          {settings.enabled ? 'On' : 'Off'}
        </span>
      </label>

      {settings.enabled && (
        <div className="mt-2 ml-9 space-y-2" onClick={(event) => event.stopPropagation()}>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => toggleType('image')}
              className={`inline-flex items-center gap-1 rounded border px-2 py-1 transition-colors ${settings.types.includes('image') ? 'border-teal-300 bg-teal-50 text-teal-700' : 'border-slate-200 bg-white text-slate-500'}`}
              aria-pressed={settings.types.includes('image')}
              title={settings.types.length === 1 && settings.types.includes('image') ? 'At least one preview type is required' : 'Include image previews'}
            >
              <Image className="h-3 w-3" /> Images
            </button>
            <button
              type="button"
              onClick={() => toggleType('video')}
              className={`inline-flex items-center gap-1 rounded border px-2 py-1 transition-colors ${settings.types.includes('video') ? 'border-teal-300 bg-teal-50 text-teal-700' : 'border-slate-200 bg-white text-slate-500'}`}
              aria-pressed={settings.types.includes('video')}
              title={settings.types.length === 1 && settings.types.includes('video') ? 'At least one preview type is required' : 'Include video previews'}
            >
              <Video className="h-3 w-3" /> Videos
            </button>
          </div>
          <textarea
            value={instructions}
            onChange={(event) => setInstructions(event.target.value)}
            onBlur={() => {
              const normalized = instructions.trim();
              if (normalized !== (settings.instructions || '')) {
                onUpdate(repo.id, { ...settings, instructions: normalized || undefined });
              }
            }}
            maxLength={4000}
            rows={2}
            className="w-full max-w-sm resize-y rounded border border-slate-200 bg-white px-2 py-1.5 text-[11px] text-slate-700 placeholder:text-slate-400 focus:border-teal-400 focus:outline-none focus:ring-1 focus:ring-teal-400"
            placeholder="Optional: capture separate desktop and mobile views…"
            aria-label={`Visual preview instructions for ${repo.name}`}
          />
        </div>
      )}
    </div>
  );
};

interface RepositoryListItemProps {
  repo: MonitoredRepo;
  indexingStatuses: Record<string, RepositoryIndexingStatus>;
  onToggle: (repoId: string) => void;
  onToggleAutoCiFollowup: (repoId: string) => void;
  onUpdateVisualPreview: (repoId: string, settings: VisualPreviewSettings) => void;
  onRemove: (repoId: string) => void | Promise<void>;
  onStopIndexing: (repoName: string, baseBranch?: string) => void;
  onReindex: (repoName: string, baseBranch?: string) => void;
  onToggleStar: (repoId: string) => void;
  onToggleHidden: (repoId: string) => void;
  isSelected?: boolean;
  onSelect?: (repoId: string) => void;
  isReadOnly?: boolean;
}

export const RepositoryListItem: React.FC<RepositoryListItemProps> = ({
  repo,
  indexingStatuses,
  onToggle,
  onToggleAutoCiFollowup,
  onUpdateVisualPreview,
  onRemove,
  onStopIndexing,
  onReindex,
  onToggleStar,
  onToggleHidden,
  isSelected = false,
  onSelect,
  isReadOnly = false,
}) => {
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  const handleDeleteClick = () => {
    if (isReadOnly) return;
    setIsDeleteDialogOpen(true);
  };

  const handleDeleteClose = () => {
    setIsDeleteDialogOpen(false);
  };

  const handleDeleteConfirm = async () => {
    setIsDeleting(true);
    try {
      await onRemove(repo.id);
    } finally {
      setIsDeleting(false);
      setIsDeleteDialogOpen(false);
    }
  };

  // Get indexing status for this repo
  const repoStatus = indexingStatuses[getRepoStatusKey(repo.name, repo.baseBranch)];
  const { statusType, statusText, progressText } = getStatusInfo(repoStatus);
  const shortHash = shortenHash(repoStatus?.last_indexed_hash);
  const relativeTime = formatRelativeTime(repoStatus?.last_indexed_at);
  const commitUrl = repoStatus?.full_name && repoStatus?.last_indexed_hash
    ? `https://github.com/${repoStatus.full_name}/commit/${repoStatus.last_indexed_hash}`
    : undefined;
  const itemClassName = getRepositoryListItemClassName(isSelected);
  const statusClassName = getStatusTextClassName(statusType);

  return (
    <div
      className={itemClassName}
      onClick={() => onSelect?.(repo.id)}
    >
      {/* Right-edge teal rail for selected state - points toward right pane */}
      {isSelected && (
        <div className="absolute right-0 top-0 bottom-0 w-[3px] bg-teal-500" />
      )}
      {/* --- Repository Row: Two-Line "Pulse" Layout --- */}
      <div className={`flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 py-3 px-4 ${repo.enabled ? 'opacity-100' : 'opacity-50'}`}>
        {/* Left Content: Identity + Status */}
        <div className="flex-1 min-w-0 pr-3">
          {/* Line 1: Repository Name + GitHub Link */}
          <div className="flex items-center gap-2 mb-1">
            <span className="font-semibold text-slate-900 truncate">
              {repo.alias || repo.name}
            </span>
            {repo.alias && (
              <span className="text-[10px] font-mono text-slate-400 truncate">
                {repo.name}
              </span>
            )}
            <a
              href={`https://github.com/${repo.name}`}
              target="_blank"
              rel="noopener noreferrer"
              className="p-0.5 text-slate-400 hover:text-slate-700 transition-colors flex-shrink-0"
              title="View on GitHub"
              onClick={(e) => e.stopPropagation()}
            >
              <Github className="w-3 h-3" />
            </a>
          </div>

          {/* Line 2: Status + Commit Hash + Timestamp */}
          <div className="flex items-center gap-2 text-xs">
            {/* Status Indicator */}
            <span className={statusClassName}>
              <StatusDot status={statusType} />
              <span>{statusText}</span>
              {progressText && <span className="text-blue-500">({progressText})</span>}
            </span>

            {/* Commit Hash Chip */}
            {shortHash && (
              <MonoCodeChip href={commitUrl}>{shortHash}</MonoCodeChip>
            )}

            {/* Relative Timestamp */}
            {relativeTime && statusType === 'indexed' && (
              <span className="text-slate-400">{relativeTime}</span>
            )}

            {/* Stop button for indexing */}
            {statusType === 'indexing' && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onStopIndexing(repo.name, repo.baseBranch);
                }}
                className="p-0.5 text-red-400 hover:text-red-600 hover:bg-red-50 rounded transition-colors"
                title="Stop Indexing"
              >
                <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 20 20">
                  <path d="M10 18a8 8 0 100-16 8 8 0 000 16zM8 7a1 1 0 00-1 1v4a1 1 0 001 1h4a1 1 0 001-1V8a1 1 0 00-1-1H8z" />
                </svg>
              </button>
            )}
          </div>

          <AutoCiFollowupControl
            repo={repo}
            onToggle={onToggleAutoCiFollowup}
            isReadOnly={isReadOnly}
          />
          <VisualPreviewControl
            repo={repo}
            onUpdate={onUpdateVisualPreview}
            isReadOnly={isReadOnly}
          />
        </div>

        {/* Right Action Gutter: Fixed-width area for maintenance tools */}
        <RepositoryActionButtons
          repo={repo}
          statusType={statusType}
          onToggle={onToggle}
          onReindex={onReindex}
          onDeleteClick={handleDeleteClick}
          onToggleStar={onToggleStar}
          onToggleHidden={onToggleHidden}
          isReadOnly={isReadOnly}
        />
      </div>

      <DeleteRepoDialog
        isOpen={isDeleteDialogOpen}
        repoName={repo.name}
        onClose={handleDeleteClose}
        onConfirm={handleDeleteConfirm}
        isLoading={isDeleting}
      />
    </div>
  );
};
