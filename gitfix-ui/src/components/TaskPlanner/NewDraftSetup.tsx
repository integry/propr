import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  createDraft,
  uploadAttachment,
  getAgents,
  AgentConfig,
  Granularity
} from '../../api/gitfixApi';
import { getRepoConfig } from '../../api/gitfixApi';
import { getRepositoriesIndexingStatus, RepositoryIndexingStatus } from '../../api/repoIndexingApi';
import { getPlannerSettings, savePlannerSettings } from '../../hooks/usePlannerSettings';
import { resizeImage } from './imageUtils';
import { HeroPromptArea } from './HeroPromptArea';
import { TaskGranularitySection } from './TaskGranularitySection';
import { ContextSettingsSection } from './ContextSettingsSection';
import { ContextRepositoriesSection, IndexedRepository } from './ContextRepositoriesSection';

interface Repo {
  name: string;
  enabled: boolean;
  baseBranch?: string;
}

interface NewDraftSetupProps {
  onDraftCreated?: (draftId: string) => void;
}

export const NewDraftSetup: React.FC<NewDraftSetupProps> = ({ onDraftCreated }) => {
  const navigate = useNavigate();
  const savedSettings = getPlannerSettings();

  // Repository selection
  const [repos, setRepos] = useState<Repo[]>([]);
  const [selectedRepo, setSelectedRepo] = useState<string>('');
  const [reposLoading, setReposLoading] = useState(true);

  // Prompt and files (local state before draft creation)
  const [prompt, setPrompt] = useState('');
  const [localFiles, setLocalFiles] = useState<File[]>([]);
  const [isUploading, setIsUploading] = useState(false);

  // Settings (saved locally)
  const [granularity, setGranularity] = useState<Granularity>(savedSettings.lastGranularity);
  const [contextLevel, setContextLevel] = useState(savedSettings.lastContextLevel);
  const [compress, setCompress] = useState(false);

  // Context repositories
  const [availableRepos, setAvailableRepos] = useState<IndexedRepository[]>([]);

  // Agents for model selection
  const [agents, setAgents] = useState<AgentConfig[]>([]);
  const [generationModel, setGenerationModel] = useState<string | null>(null);

  // Error and loading states
  const [error, setError] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);

  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const autoResize = useCallback(() => {
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = 'auto';
      textarea.style.height = `${Math.max(textarea.scrollHeight, 300)}px`;
    }
  }, []);

  useEffect(() => { autoResize(); }, [prompt, autoResize]);

  // Load repositories
  useEffect(() => {
    const loadRepos = async () => {
      try {
        setReposLoading(true);
        const data = await getRepoConfig() as { repos_to_monitor?: unknown[] };
        const rawRepos = data.repos_to_monitor || [];
        const validRepos = rawRepos
          .filter((repo): repo is { name: string; enabled?: boolean; baseBranch?: string } =>
            typeof repo === 'object' && repo !== null && 'name' in repo && typeof (repo as { name: unknown }).name === 'string'
          )
          .map(repo => ({
            name: repo.name,
            enabled: repo.enabled !== false,
            baseBranch: repo.baseBranch
          }));
        const enabledRepos = validRepos.filter(r => r.enabled);
        setRepos(enabledRepos);

        // Set initial selected repo from saved settings or first available
        const lastRepo = savedSettings.lastRepository;
        if (lastRepo && enabledRepos.some(r => r.name === lastRepo)) {
          setSelectedRepo(lastRepo);
        } else if (enabledRepos.length > 0) {
          setSelectedRepo(enabledRepos[0].name);
        }
      } catch (err) {
        console.error('Failed to load repositories:', err);
        setError('Failed to load repositories');
      } finally {
        setReposLoading(false);
      }
    };
    loadRepos();
  }, [savedSettings.lastRepository]);

  // Load available context repositories
  useEffect(() => {
    const loadAvailableRepos = async () => {
      try {
        const data = await getRepositoriesIndexingStatus();
        const indexedRepos: IndexedRepository[] = (data.repositories || [])
          .filter((repo: RepositoryIndexingStatus) =>
            repo.indexing_status === 'completed' && repo.full_name !== selectedRepo
          )
          .map((repo: RepositoryIndexingStatus) => ({ full_name: repo.full_name, branch: repo.branch }));
        setAvailableRepos(indexedRepos);
      } catch (err) {
        console.error('Failed to load indexed repos:', err);
      }
    };
    if (selectedRepo) {
      loadAvailableRepos();
    }
  }, [selectedRepo]);

  // Load agents
  useEffect(() => {
    const loadAgents = async () => {
      try {
        const data = await getAgents();
        setAgents(data.agents || []);
      } catch (err) {
        console.error('Failed to load agents:', err);
      }
    };
    loadAgents();
  }, []);

  // Save settings when they change
  useEffect(() => {
    savePlannerSettings({ lastGranularity: granularity, lastContextLevel: contextLevel });
  }, [granularity, contextLevel]);

  useEffect(() => {
    if (selectedRepo) {
      savePlannerSettings({ lastRepository: selectedRepo });
    }
  }, [selectedRepo]);

  const handlePaste = async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of Array.from(items)) {
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        const blob = item.getAsFile();
        if (!blob) continue;
        const file = new File([blob], `pasted-image-${Date.now()}.png`, { type: blob.type });
        try {
          setIsUploading(true);
          const processedFile = await resizeImage(file);
          setLocalFiles(prev => [...prev, processedFile]);
        } catch (err) {
          setError('Failed to process pasted image');
          console.error('Paste error:', err);
        } finally {
          setIsUploading(false);
        }
        return;
      }
    }
  };

  const handleUpload = async (file: File) => {
    setIsUploading(true);
    try {
      const processedFile = file.type.startsWith('image/') ? await resizeImage(file) : file;
      setLocalFiles(prev => [...prev, processedFile]);
    } catch {
      setError('Failed to process file');
    } finally {
      setIsUploading(false);
    }
  };

  const handleRemoveFile = async (fileIndex: number) => {
    setLocalFiles(prev => prev.filter((_, i) => i !== fileIndex));
  };

  const handleContinue = async () => {
    if (!selectedRepo || !prompt.trim()) {
      setError('Please select a repository and enter a prompt');
      return;
    }

    setIsCreating(true);
    setError(null);

    try {
      // Create the draft
      const draft = await createDraft(selectedRepo, prompt.trim());

      // Upload any local files
      for (const file of localFiles) {
        try {
          await uploadAttachment(draft.draft_id, file);
        } catch (uploadErr) {
          console.error('Failed to upload attachment:', uploadErr);
        }
      }

      // Navigate to the studio page with the new draft
      if (onDraftCreated) {
        onDraftCreated(draft.draft_id);
      }
      navigate(`/studio/${draft.draft_id}`, { replace: true });
    } catch (err) {
      setError((err as Error).message || 'Failed to create draft');
      setIsCreating(false);
    }
  };

  // Convert local files to a format compatible with HeroPromptArea
  // HeroPromptArea expects PlannerAttachment[], but we use local files for new drafts
  const filesForDisplay = localFiles.map((file, index) => ({
    id: `local-${index}`,
    filename: file.name,
    content_type: file.type,
    size: file.size,
    created_at: new Date().toISOString(),
    _localFile: file // Store reference for display
  }));

  return (
    <div className="h-full flex flex-col">
      {/* Header with Repository Selection */}
      <div className="bg-gradient-to-r from-indigo-600 to-indigo-700 text-white rounded-t-xl px-6 py-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold">New Implementation Plan</h2>
            <p className="text-indigo-200 text-sm">Define your task and configure the context</p>
          </div>
          <div className="flex items-center gap-3">
            <label className="text-sm text-indigo-200">Repository:</label>
            {reposLoading ? (
              <div className="px-3 py-2 bg-white/20 rounded-lg text-sm">Loading...</div>
            ) : (
              <select
                value={selectedRepo}
                onChange={(e) => setSelectedRepo(e.target.value)}
                className="px-3 py-2 bg-white/20 border border-white/30 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-white/50"
                disabled={repos.length === 0}
              >
                {repos.length === 0 ? (
                  <option value="">No repositories configured</option>
                ) : (
                  repos.map(repo => (
                    <option key={repo.name} value={repo.name} className="text-gray-900">
                      {repo.baseBranch ? `${repo.name} (${repo.baseBranch})` : repo.name}
                    </option>
                  ))
                )}
              </select>
            )}
          </div>
        </div>
      </div>

      {/* Main Content - Split View */}
      <div className="flex-1 bg-white rounded-b-xl shadow-lg overflow-hidden">
        <div className="h-full flex">
          {/* Left Panel - Prompt (60%) */}
          <div className="w-[60%] h-full flex flex-col border-r border-gray-200">
            <div className="flex-1 overflow-auto p-6">
              <HeroPromptArea
                prompt={prompt}
                files={filesForDisplay}
                draftId=""
                isUploading={isUploading}
                textareaRef={textareaRef}
                onPromptChange={setPrompt}
                onInput={autoResize}
                onPaste={handlePaste}
                onUpload={handleUpload}
                onRemoveFile={async (fileId: string) => {
                  const index = parseInt(fileId.replace('local-', ''), 10);
                  if (!isNaN(index)) {
                    handleRemoveFile(index);
                  }
                }}
                minHeight="calc(100vh - 400px)"
              />
            </div>
          </div>

          {/* Right Panel - Settings (40%) */}
          <div className="w-[40%] h-full flex flex-col bg-gray-50">
            <div className="flex-1 overflow-auto p-5 space-y-5">
              {/* Settings Card */}
              <div className="bg-white rounded-xl border border-gray-200 p-5 space-y-5">
                {/* Task Granularity */}
                <TaskGranularitySection
                  granularity={granularity}
                  onGranularityChange={setGranularity}
                />

                <div className="border-t border-gray-200" />

                {/* Context Settings */}
                <ContextSettingsSection
                  contextLevel={contextLevel}
                  compress={compress}
                  onContextLevelChange={setContextLevel}
                  onCompressChange={setCompress}
                  agents={agents}
                  generationModel={generationModel}
                  onGenerationModelChange={setGenerationModel}
                />

                <div className="border-t border-gray-200" />

                {/* Context Repositories */}
                <ContextRepositoriesSection
                  repositories={[]}
                  availableRepos={availableRepos}
                  onAdd={() => {}}
                  onRemove={() => {}}
                />
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Sticky Footer */}
      <div className="sticky bottom-0 left-0 right-0 bg-white border-t border-gray-200 px-6 py-4 shadow-lg">
        {error && (
          <div className="mb-3 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
            {error}
          </div>
        )}
        <button
          onClick={handleContinue}
          disabled={isCreating || !selectedRepo || !prompt.trim() || reposLoading}
          className="w-full py-3 px-4 bg-indigo-600 text-white font-medium rounded-lg hover:bg-indigo-700 disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2"
        >
          {isCreating ? (
            <>
              <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
              Creating Plan...
            </>
          ) : (
            'Continue to Configure Context'
          )}
        </button>
      </div>
    </div>
  );
};

export default NewDraftSetup;
