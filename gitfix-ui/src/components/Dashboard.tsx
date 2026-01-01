import React, { useState, useEffect } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import SystemStatus from './SystemStatus';
import TaskQueueStats from './TaskQueueStats';
import TaskStatsChart from './TaskStatsChart';
import RepositoryReport from './RepositoryReport';
import TaskList from './TaskList';
import { getRepoConfig, createDraft } from '../api/gitfixApi';

interface Repo {
  name: string;
  enabled: boolean;
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
              if (name) {
                return { name, enabled };
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
      <div className="bg-gradient-to-r from-indigo-600 to-purple-600 rounded-lg p-6 mb-8 shadow-lg">
        <div className="flex justify-between items-center mb-4">
          <h3 className="text-xl font-semibold text-white flex items-center gap-2">
            <span>✨</span> Start New AI Plan
          </h3>
          <Link
            to="/plans"
            className="text-sm text-indigo-100 hover:text-white underline"
          >
            View History
          </Link>
        </div>
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-indigo-100 mb-2">Repository</label>
            <select
              value={selectedRepo}
              onChange={(e) => setSelectedRepo(e.target.value)}
              className="w-full px-3 py-2 bg-white/10 text-white border border-white/20 rounded-md focus:ring-2 focus:ring-white/50 focus:border-white/50"
              disabled={repos.length === 0}
            >
              {repos.length === 0 ? (
                <option value="">No repositories configured</option>
              ) : (
                repos.map(repo => (
                  <option key={repo.name} value={repo.name} className="text-gray-900">
                    {repo.name}
                  </option>
                ))
              )}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-indigo-100 mb-2">What do you want to build?</label>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Describe the feature or task you want to implement..."
              rows={3}
              className="w-full px-3 py-2 bg-white/10 text-white placeholder-white/50 border border-white/20 rounded-md focus:ring-2 focus:ring-white/50 focus:border-white/50 resize-none"
            />
          </div>
          {error && (
            <div className="p-3 bg-red-500/20 border border-red-400/30 rounded-md text-red-100 text-sm">
              {error}
            </div>
          )}
          <button
            onClick={handleStartPlanning}
            disabled={isCreating || !selectedRepo || !prompt.trim()}
            className={`w-full py-3 font-medium rounded-md transition-colors ${
              isCreating || !selectedRepo || !prompt.trim()
                ? 'bg-white/20 text-white/50 cursor-not-allowed'
                : 'bg-white text-indigo-600 hover:bg-indigo-50 cursor-pointer'
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