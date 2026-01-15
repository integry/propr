import React, { useState, useEffect } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import SystemStatus from './SystemStatus';
import TaskQueueStats from './TaskQueueStats';
import TaskStatsChart from './TaskStatsChart';
import RepositoryReport from './RepositoryReport';
import RepositoryBreakdown from './RepositoryBreakdown';
import TaskList from './TaskList';
import { getRepoConfig, createDraft } from '../api/gitfixApi';

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
      navigate(`/tasks/plan/${draft.draft_id}`);
    } catch (err) {
      setError((err as Error).message || 'Failed to create draft');
    } finally {
      setIsCreating(false);
    }
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
            {isCreating ? 'Creating...' : 'Start Planning'}
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