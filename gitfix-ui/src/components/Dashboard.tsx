import React, { useState, useEffect, useRef } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import SystemStatus from './SystemStatus';
import TaskQueueStats from './TaskQueueStats';
import TaskStatsChart from './TaskStatsChart';
import RepositoryReport from './RepositoryReport';
import RepositoryBreakdown from './RepositoryBreakdown';
import TaskList from './TaskList';
import { getRepoConfig, createDraft, uploadAttachment } from '../api/gitfixApi';
import { X, Paperclip, Loader2 } from 'lucide-react';

interface Repo {
  name: string;
  enabled: boolean;
  baseBranch?: string;
}

const Dashboard: React.FC = () => {
  const navigate = useNavigate();
  const [repos, setRepos] = useState<Repo[]>([]);
  const [selectedRepo, setSelectedRepo] = useState<string>('');
  const [prompt, setPrompt] = useState<string>('');
  const [isCreating, setIsCreating] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
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
          setSelectedRepo(enabledRepos[0].name);
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

  return (
    <div>
      <div className="bg-white border border-gray-200 rounded-lg p-6 mb-8 shadow-sm">
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
              className="w-full px-3 py-2 bg-white text-gray-900 border border-gray-300 rounded-md focus:ring-2 focus:ring-red-500 focus:border-red-500"
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
              placeholder="Describe the feature or task you want to implement..."
              rows={3}
              className="w-full px-3 py-2 bg-white text-gray-900 placeholder-gray-400 border border-gray-300 rounded-md focus:ring-2 focus:ring-red-500 focus:border-red-500 resize-none"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Attachments (optional)</label>
            {selectedFiles.length > 0 && (
              <div className="flex flex-wrap gap-2 mb-2">
                {selectedFiles.map((file, index) => (
                  <div
                    key={`${file.name}-${index}`}
                    className="inline-flex items-center gap-1.5 bg-gray-100 border border-gray-200 rounded-md px-2 py-1 text-sm text-gray-700"
                  >
                    <Paperclip className="w-3.5 h-3.5 text-gray-500" />
                    <span className="max-w-[150px] truncate">{file.name}</span>
                    <button
                      onClick={() => handleRemoveFile(index)}
                      className="text-gray-400 hover:text-red-500 transition-colors"
                      type="button"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
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
              className="inline-flex items-center gap-1.5 text-sm text-gray-600 hover:text-red-600 cursor-pointer transition-colors"
            >
              <Paperclip className="w-4 h-4" />
              Attach screenshots, logs, or files
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
                : 'bg-red-600 text-white hover:bg-red-700 cursor-pointer'
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