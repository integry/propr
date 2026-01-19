import React, { useState, useEffect, useRef } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import SystemStatus from './SystemStatus';
import TaskQueueStats from './TaskQueueStats';
import TaskStatsChart from './TaskStatsChart';
import RepositoryReport from './RepositoryReport';
import RepositoryBreakdown from './RepositoryBreakdown';
import TaskList from './TaskList';
import { getRepoConfig, createDraft, uploadAttachment } from '../api/gitfixApi';
import { resizeImage } from './TaskPlanner/imageUtils';
import { getPlannerSettings } from '../hooks/usePlannerSettings';
import { X, Paperclip, Loader2, Image } from 'lucide-react';

interface Repo {
  name: string;
  enabled: boolean;
  baseBranch?: string;
}

// Component for displaying file preview with image thumbnails
const FilePreview: React.FC<{
  file: File;
  index: number;
  onRemove: (index: number) => void;
}> = ({ file, index, onRemove }) => {
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const isImage = file.type.startsWith('image/');

  useEffect(() => {
    if (isImage) {
      const url = URL.createObjectURL(file);
      setPreviewUrl(url);
      return () => URL.revokeObjectURL(url);
    }
  }, [file, isImage]);

  return (
    <div className="inline-flex flex-col items-center bg-gray-50 border border-gray-200 rounded-lg p-2 relative group">
      <button
        onClick={() => onRemove(index)}
        className="absolute -top-2 -right-2 w-5 h-5 bg-red-500 text-white rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity hover:bg-red-600 z-10"
        title="Remove"
        type="button"
      >
        <X className="w-3 h-3" />
      </button>

      {isImage && previewUrl ? (
        <div className="w-20 h-20 mb-1.5 overflow-hidden rounded bg-gray-100 flex items-center justify-center">
          <img
            src={previewUrl}
            alt={file.name}
            className="max-w-full max-h-full object-contain"
          />
        </div>
      ) : (
        <div className="w-20 h-20 mb-1.5 overflow-hidden rounded bg-gray-100 flex items-center justify-center">
          <Paperclip className="w-6 h-6 text-gray-400" />
        </div>
      )}

      <div className="flex items-center gap-1 max-w-[80px]">
        {isImage ? (
          <Image className="w-3 h-3 text-indigo-500 flex-shrink-0" />
        ) : (
          <Paperclip className="w-3 h-3 text-gray-500 flex-shrink-0" />
        )}
        <span className="text-xs text-gray-700 truncate" title={file.name}>
          {file.name}
        </span>
      </div>
    </div>
  );
};

const Dashboard: React.FC = () => {
  const navigate = useNavigate();
  const [repos, setRepos] = useState<Repo[]>([]);
  const [selectedRepo, setSelectedRepo] = useState<string>('');
  const [prompt, setPrompt] = useState<string>('');
  const [isCreating, setIsCreating] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [isPastingImage, setIsPastingImage] = useState<boolean>(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const loadRepos = async () => {
      try {
        const data = await getRepoConfig() as { repos_to_monitor?: unknown[] };
        const rawRepos = data.repos_to_monitor || [];

        // Transform and validate the data to ensure correct format
        const validRepos: Repo[] = rawRepos
          .map((repo: unknown) => {
            if (typeof repo === 'string') {
              return { name: repo, enabled: true };
            } else if (repo && typeof repo === 'object') {
              const repoObj = repo as Record<string, unknown>;
              const name = (repoObj.name as string) || (repoObj.full_name as string);
              const enabled = typeof repoObj.enabled === 'boolean' ? repoObj.enabled : true;
              const baseBranch = repoObj.baseBranch as string | undefined;
              if (name) {
                return { name, enabled, baseBranch };
              }
            }
            return null;
          })
          .filter((repo): repo is Repo => repo !== null && repo.name !== undefined);

        const enabledRepos = validRepos.filter((r: Repo) => r.enabled);
        setRepos(enabledRepos);

        if (enabledRepos.length > 0) {
          // Try to use the last used repository from localStorage
          const savedSettings = getPlannerSettings();
          const lastRepo = savedSettings.lastRepository;

          // Check if the last used repository is still available
          const isLastRepoAvailable = lastRepo && enabledRepos.some(r => r.name === lastRepo);

          if (isLastRepoAvailable) {
            setSelectedRepo(lastRepo);
          } else {
            // Fall back to first available repository
            setSelectedRepo(enabledRepos[0].name);
          }
        }
      } catch (err) {
        console.error('Failed to load repositories:', err);
      }
    };
    loadRepos();
  }, []);

  const handleStartPlanning = async () => {
    if (!selectedRepo || !prompt.trim()) return;

    setIsCreating(true);
    setError(null);
    try {
      const draft = await createDraft(selectedRepo, prompt.trim());

      // Upload any selected files to the draft
      for (const file of selectedFiles) {
        try {
          await uploadAttachment(draft.draft_id, file);
        } catch (uploadErr) {
          console.error('Failed to upload attachment:', uploadErr);
          // Continue with navigation even if some uploads fail
        }
      }

      navigate(`/tasks/plan/${draft.draft_id}`);
    } catch (err) {
      setError((err as Error).message || 'Failed to create draft');
    } finally {
      setIsCreating(false);
    }
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files && files.length > 0) {
      setSelectedFiles(prev => [...prev, ...Array.from(files)]);
    }
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const handleRemoveFile = (index: number) => {
    setSelectedFiles(prev => prev.filter((_, i) => i !== index));
  };

  const handlePaste = async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items;
    if (!items) return;

    for (const item of Array.from(items)) {
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        const blob = item.getAsFile();
        if (!blob) continue;

        const filename = `pasted-image-${Date.now()}.png`;
        const file = new File([blob], filename, { type: blob.type });

        setIsPastingImage(true);
        setError(null);
        try {
          const processedFile = await resizeImage(file);
          setSelectedFiles(prev => [...prev, processedFile]);
        } catch (err) {
          setError('Failed to process pasted image');
          console.error('Paste error:', err);
        } finally {
          setIsPastingImage(false);
        }
        return;
      }
    }
  };

  return (
    <div>
      <div className="bg-white border border-gray-200 rounded-lg p-6 mb-8 shadow-md hover:shadow-lg transition-shadow border-t-4 border-t-indigo-500">
        <div className="flex justify-between items-center mb-4">
          <h3 className="text-xl font-semibold text-gray-900 flex items-center gap-2">
            <span>✨</span> Start New AI Plan
          </h3>
          <Link
            to="/plans"
            className="text-sm text-gray-500 hover:text-gray-700 underline"
          >
            View History
          </Link>
        </div>
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Repository</label>
            <select
              value={selectedRepo}
              onChange={(e) => setSelectedRepo(e.target.value)}
              className="w-full px-3 py-2 bg-white text-gray-900 border border-gray-300 rounded-md focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
              disabled={repos.length === 0}
            >
              {repos.length === 0 ? (
                <option value="">No repositories configured</option>
              ) : (
                repos.map(repo => (
                  <option key={repo.name} value={repo.name}>
                    {repo.baseBranch ? `${repo.name} (${repo.baseBranch})` : repo.name}
                  </option>
                ))
              )}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">What do you want to build?</label>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onPaste={handlePaste}
              placeholder="Describe the feature or task you want to implement..."
              rows={3}
              className="w-full px-3 py-2 bg-white text-gray-900 placeholder-gray-400 border border-gray-300 rounded-md focus:ring-2 focus:ring-primary-500 focus:border-primary-500 resize-none"
            />
            <p className="text-xs text-gray-400 mt-1">Tip: You can paste screenshots directly into this field</p>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Attachments (optional)</label>
            {selectedFiles.length > 0 && (
              <div className="flex flex-wrap gap-3 mb-3">
                {selectedFiles.map((file, index) => (
                  <FilePreview
                    key={`${file.name}-${index}`}
                    file={file}
                    index={index}
                    onRemove={handleRemoveFile}
                  />
                ))}
              </div>
            )}
            <input
              type="file"
              ref={fileInputRef}
              onChange={handleFileSelect}
              className="hidden"
              id="dashboard-file-upload"
              accept="image/*,.log,.txt,.json,.md,.csv"
              multiple
            />
            <label
              htmlFor="dashboard-file-upload"
              className={`inline-flex items-center gap-1.5 text-sm text-gray-600 hover:text-primary-600 cursor-pointer transition-colors ${isPastingImage ? 'opacity-50' : ''}`}
            >
              {isPastingImage ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Processing pasted image...
                </>
              ) : (
                <>
                  <Paperclip className="w-4 h-4" />
                  Attach screenshots, logs, or files
                </>
              )}
            </label>
          </div>
          {error && (
            <div className="p-3 bg-red-50 border border-red-200 rounded-md text-red-700 text-sm">
              {error}
            </div>
          )}
          <button
            onClick={handleStartPlanning}
            disabled={isCreating || !selectedRepo || !prompt.trim()}
            className={`w-full py-3 font-medium rounded-md transition-colors ${
              isCreating || !selectedRepo || !prompt.trim()
                ? 'bg-gray-100 text-gray-400 cursor-not-allowed'
                : 'bg-primary-600 text-white hover:bg-primary-700 cursor-pointer'
            }`}
          >
            {isCreating ? (
              <span className="inline-flex items-center justify-center gap-2">
                <Loader2 className="w-4 h-4 animate-spin" />
                {selectedFiles.length > 0 ? 'Creating & uploading files...' : 'Creating...'}
              </span>
            ) : (
              'Start Planning'
            )}
          </button>
        </div>
      </div>

      <h2 className="text-2xl font-semibold text-white mb-6">System Overview</h2>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">
        <SystemStatus />
        <TaskQueueStats />
      </div>

      <h2 className="text-2xl font-semibold text-white mb-6">Task Statistics</h2>
      <div className="mb-8">
        <TaskStatsChart />
      </div>

      <h2 className="text-2xl font-semibold text-white mb-6">Repository Metrics</h2>
      <div className="mb-8">
        <RepositoryReport />
      </div>

      <div className="mb-8">
        <RepositoryBreakdown />
      </div>

      <div>
        <h3 className="text-xl font-semibold text-white mb-4">Recent Tasks</h3>
        <TaskList
          limit={5}
          showViewAll={true}
          hideFilters={true}
        />
      </div>
    </div>
  );
};

export default Dashboard;