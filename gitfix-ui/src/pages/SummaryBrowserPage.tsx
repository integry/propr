import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Book, ChevronLeft, Search, Loader2 } from 'lucide-react';
import SummaryBrowser from '../components/SummaryBrowser';
import { getAvailableGithubRepos } from '../api/gitfixApi';

interface ReposResponse {
  repos: string[];
}

const SummaryBrowserPage: React.FC = () => {
  const { owner, repo } = useParams<{ owner?: string; repo?: string }>();
  const navigate = useNavigate();
  const [repos, setRepos] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');

  useEffect(() => {
    async function fetchRepos() {
      try {
        setLoading(true);
        const data = await getAvailableGithubRepos() as ReposResponse;
        setRepos(data.repos || []);
      } catch (err) {
        console.error('Failed to fetch repositories:', err);
      } finally {
        setLoading(false);
      }
    }
    fetchRepos();
  }, []);

  const filteredRepos = repos.filter(r =>
    r.toLowerCase().includes(searchQuery.toLowerCase())
  );

  // If owner and repo are provided, show the browser
  if (owner && repo) {
    return (
      <div>
        <button
          onClick={() => navigate('/repositories')}
          className="flex items-center gap-2 text-gray-600 hover:text-gray-800 mb-4 transition-colors"
        >
          <ChevronLeft className="w-4 h-4" />
          Back to repositories
        </button>

        <SummaryBrowser owner={owner} repo={repo} />
      </div>
    );
  }

  // Otherwise, show repository selection
  return (
    <div>
      <div className="mb-6">
        <h2 className="text-2xl font-semibold text-gray-800 flex items-center gap-3">
          <Book className="w-7 h-7 text-primary-600" />
          File Summaries
        </h2>
        <p className="text-gray-600 mt-1">
          Browse AI-generated summaries for files and directories in your repositories.
        </p>
      </div>

      {/* Search input */}
      <div className="relative mb-4 max-w-md">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
        <input
          type="text"
          placeholder="Search repositories..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-primary-500 outline-none"
        />
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
          <span className="ml-2 text-gray-500">Loading repositories...</span>
        </div>
      ) : filteredRepos.length === 0 ? (
        <div className="text-center py-12 bg-gray-50 rounded-lg border border-gray-200">
          <Book className="w-12 h-12 text-gray-300 mx-auto mb-3" />
          <p className="text-gray-600">
            {searchQuery ? 'No repositories match your search' : 'No repositories configured'}
          </p>
          <p className="text-sm text-gray-500 mt-1">
            {!searchQuery && 'Add repositories in Settings to start browsing summaries.'}
          </p>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {filteredRepos.map((repoFullName) => {
            const [repoOwner, repoName] = repoFullName.split('/');
            return (
              <button
                key={repoFullName}
                onClick={() => navigate(`/summaries/${repoOwner}/${repoName}`)}
                className="flex items-center gap-3 p-4 bg-white border border-gray-200 rounded-lg hover:border-primary-300 hover:shadow-sm transition-all text-left group"
              >
                <div className="w-10 h-10 bg-gray-100 rounded-lg flex items-center justify-center group-hover:bg-primary-50 transition-colors">
                  <Book className="w-5 h-5 text-gray-500 group-hover:text-primary-600" />
                </div>
                <div className="min-w-0">
                  <p className="font-medium text-gray-800 truncate">{repoName}</p>
                  <p className="text-xs text-gray-500">{repoOwner}</p>
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default SummaryBrowserPage;
