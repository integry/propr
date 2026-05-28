import React, { useState, useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { GripVertical, ArrowLeft } from 'lucide-react';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useRepositoryManagement } from '../hooks/useRepositoryManagement';
import { AddRepositoryModal } from '../components/AddRepositoryModal';
import { RepoActionContainer } from '../components/Repositories';
import { RepositorySaveStatusFooter } from '../components/RepositorySaveStatusFooter';
import { RepositoriesPageHeader } from '../components/RepositoriesPageHeader';
import { RepositoryListContent } from '../components/RepositoryListContent';
import { useDemoMode } from '../contexts/DemoModeContext';

const RepositoriesPage: React.FC = () => {
  useDocumentTitle('Repositories');
  const location = useLocation();
  const { isDemoMode } = useDemoMode();

  const {
    repos, loading, error, availableRepos, indexingStatuses, saveStatus, showHiddenRepos,
    filteredRepos, hiddenCount, handleStopIndexing, handleReindexRepo, handleAddRepo,
    handleRemoveRepo, handleToggleRepo, handleToggleStar, handleToggleHidden,
    handleToggleShowHidden, handleRetry
  } = useRepositoryManagement();

  const [newRepo, setNewRepo] = useState<string>('');
  const [newAlias, setNewAlias] = useState<string>('');
  const [newBaseBranch, setNewBaseBranch] = useState<string>('');
  const [isModalOpen, setIsModalOpen] = useState<boolean>(false);
  const [selectedRepoId, setSelectedRepoId] = useState<string | null>(null);
  const [navActiveTab, setNavActiveTab] = useState<'chat' | 'improve' | 'browse' | 'todos' | undefined>(undefined);

  // Handle navigation state from QuickAddTodo "View Todos" link
  useEffect(() => {
    const state = location.state as { selectRepo?: string; activeTab?: string } | null;
    if (state?.selectRepo && repos.length > 0) {
      const match = repos.find(r => r.name === state.selectRepo);
      if (match) {
        setSelectedRepoId(match.id);
        if (state.activeTab === 'todos') {
          setNavActiveTab('todos');
        }
      }
      // Clear navigation state so it doesn't re-trigger
      window.history.replaceState({}, '');
    }
  }, [location.state, repos]);

  const handleOpenModal = () => {
    if (isDemoMode) return;
    setNewRepo('');
    setNewAlias('');
    setNewBaseBranch('');
    setIsModalOpen(true);
  };

  const handleCloseModal = () => {
    setIsModalOpen(false);
    setNewRepo('');
    setNewAlias('');
    setNewBaseBranch('');
  };

  const handleAddRepoSubmit = () => {
    if (isDemoMode) return;
    if (handleAddRepo(newRepo, newAlias, newBaseBranch)) {
      setNewRepo('');
      setNewAlias('');
      setNewBaseBranch('');
      setIsModalOpen(false);
    }
  };

  const handleSelectRepo = (repoId: string) => {
    setSelectedRepoId(prevId => prevId === repoId ? null : repoId);
  };

  const selectedRepo = repos.find(r => r.id === selectedRepoId);

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <RepositoriesPageHeader
        selectedRepoName={selectedRepo?.alias || selectedRepo?.name}
        onAddRepository={handleOpenModal}
        showHiddenRepos={showHiddenRepos}
        onToggleShowHidden={handleToggleShowHidden}
        hiddenCount={hiddenCount}
        isReadOnly={isDemoMode}
      />

      {/* Mobile Layout */}
      <div className="flex-1 overflow-hidden lg:hidden">
        {selectedRepoId && selectedRepo ? (
          <div className="h-full bg-[#F8FAFC] flex flex-col">
            <div className="flex items-center gap-2 px-4 py-3 border-b border-slate-200 bg-white">
              <button
                onClick={() => setSelectedRepoId(null)}
                className="p-1.5 -ml-1.5 text-slate-500 hover:text-slate-700 hover:bg-slate-100 rounded transition-colors"
                title="Back to repositories"
              >
                <ArrowLeft className="w-5 h-5" />
              </button>
              <span className="font-medium text-slate-900 truncate">
                {selectedRepo.alias || selectedRepo.name}
              </span>
            </div>
            <div className="flex-1 min-h-0">
              <RepoActionContainer selectedRepo={selectedRepo} initialTab={navActiveTab} />
            </div>
          </div>
        ) : (
          <div className="h-full bg-white flex flex-col">
            <div className="flex-1 min-h-0 overflow-y-auto scrollbar-stealth">
              <RepositoryListContent
                repos={filteredRepos}
                loading={loading}
                error={error}
                indexingStatuses={indexingStatuses}
                selectedRepoId={selectedRepoId}
                onToggle={handleToggleRepo}
                onRemove={handleRemoveRepo}
                onStopIndexing={handleStopIndexing}
                onReindex={handleReindexRepo}
                onToggleStar={handleToggleStar}
                onToggleHidden={handleToggleHidden}
                onSelect={handleSelectRepo}
                onRetry={handleRetry}
                isReadOnly={isDemoMode}
              />
            </div>
            <RepositorySaveStatusFooter saveStatus={saveStatus} error={error} />
          </div>
        )}
      </div>

      {/* Desktop Layout */}
      <div className="flex-1 overflow-hidden hidden lg:block">
        <PanelGroup direction="horizontal">
          <Panel defaultSize={40} minSize={25}>
            <div className="h-full bg-white flex flex-col">
              <div className="flex-1 min-h-0 overflow-y-auto scrollbar-stealth">
                <RepositoryListContent
                  repos={filteredRepos}
                  loading={loading}
                  error={error}
                  indexingStatuses={indexingStatuses}
                  selectedRepoId={selectedRepoId}
                  onToggle={handleToggleRepo}
                  onRemove={handleRemoveRepo}
                  onStopIndexing={handleStopIndexing}
                  onReindex={handleReindexRepo}
                  onToggleStar={handleToggleStar}
                  onToggleHidden={handleToggleHidden}
                  onSelect={handleSelectRepo}
                  onRetry={handleRetry}
                  isReadOnly={isDemoMode}
                />
              </div>
              <RepositorySaveStatusFooter saveStatus={saveStatus} error={error} />
            </div>
          </Panel>

          <PanelResizeHandle className="w-2 bg-slate-100 hover:bg-teal-500 transition-colors flex items-center justify-center cursor-col-resize">
            <GripVertical size={12} className="text-gray-400" />
          </PanelResizeHandle>

          <Panel defaultSize={60} minSize={30}>
            <div className="h-full bg-[#F8FAFC] flex flex-col">
              <div className="flex-1 min-h-0">
                <RepoActionContainer selectedRepo={selectedRepo || null} initialTab={navActiveTab} />
              </div>
            </div>
          </Panel>
        </PanelGroup>
      </div>

      <AddRepositoryModal
        isOpen={isModalOpen}
        newRepo={newRepo}
        newAlias={newAlias}
        newBaseBranch={newBaseBranch}
        availableRepos={availableRepos}
        onRepoChange={setNewRepo}
        onAliasChange={setNewAlias}
        onBaseBranchChange={setNewBaseBranch}
        onAdd={handleAddRepoSubmit}
        onClose={handleCloseModal}
        isReadOnly={isDemoMode}
      />
    </div>
  );
};

export default RepositoriesPage;
