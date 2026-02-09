import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { createDraft, uploadAttachment, getAgents, AgentConfig, Granularity, getRepoConfig } from '../../api/gitfixApi';
import { getRepositoriesIndexingStatus, RepositoryIndexingStatus } from '../../api/repoIndexingApi';
import { getPlannerSettings, savePlannerSettings } from '../../hooks/usePlannerSettings';
import { resizeImage } from './imageUtils';
import { IndexedRepository } from './ContextRepositoriesSection';
import { ChevronDown, Paperclip, Loader2, Sparkles } from 'lucide-react';
import { ContextLevelSlider } from './ContextLevelSlider';
import { GranularityPills, AttachmentChip } from './ComposerControls';

interface Repo { name: string; enabled: boolean; baseBranch?: string; }
interface NewDraftSetupProps { onDraftCreated?: (draftId: string) => void; }

export const NewDraftSetup: React.FC<NewDraftSetupProps> = ({ onDraftCreated }) => {
  const navigate = useNavigate();
  const savedSettings = getPlannerSettings();
  const [repos, setRepos] = useState<Repo[]>([]);
  const [selectedRepo, setSelectedRepo] = useState<string>('');
  const [reposLoading, setReposLoading] = useState(true);
  const [prompt, setPrompt] = useState('');
  const [localFiles, setLocalFiles] = useState<File[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const [granularity, setGranularity] = useState<Granularity>(savedSettings.lastGranularity);
  const [contextLevel, setContextLevel] = useState(savedSettings.lastContextLevel);
  const [compress, setCompress] = useState(false);
  const [availableRepos, setAvailableRepos] = useState<IndexedRepository[]>([]);
  const [agents, setAgents] = useState<AgentConfig[]>([]);
  const [generationModel, setGenerationModel] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const autoResize = useCallback(() => {
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = 'auto';
      textarea.style.height = `${Math.max(textarea.scrollHeight, 200)}px`;
    }
  }, []);

  useEffect(() => { autoResize(); }, [prompt, autoResize]);

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
          .map(repo => ({ name: repo.name, enabled: repo.enabled !== false, baseBranch: repo.baseBranch }));
        const enabledRepos = validRepos.filter(r => r.enabled);
        setRepos(enabledRepos);
        const lastRepo = savedSettings.lastRepository;
        if (lastRepo && enabledRepos.some(r => r.name === lastRepo)) setSelectedRepo(lastRepo);
        else if (enabledRepos.length > 0) setSelectedRepo(enabledRepos[0].name);
      } catch (err) {
        console.error('Failed to load repositories:', err);
        setError('Failed to load repositories');
      } finally { setReposLoading(false); }
    };
    loadRepos();
  }, [savedSettings.lastRepository]);

  useEffect(() => {
    const loadAvailableRepos = async () => {
      try {
        const data = await getRepositoriesIndexingStatus();
        const indexedRepos: IndexedRepository[] = (data.repositories || [])
          .filter((repo: RepositoryIndexingStatus) => repo.indexing_status === 'completed' && repo.full_name !== selectedRepo)
          .map((repo: RepositoryIndexingStatus) => ({ full_name: repo.full_name, branch: repo.branch }));
        setAvailableRepos(indexedRepos);
      } catch (err) { console.error('Failed to load indexed repos:', err); }
    };
    if (selectedRepo) loadAvailableRepos();
  }, [selectedRepo]);

  useEffect(() => {
    const loadAgents = async () => {
      try { const data = await getAgents(); setAgents(data.agents || []); }
      catch (err) { console.error('Failed to load agents:', err); }
    };
    loadAgents();
  }, []);

  useEffect(() => { savePlannerSettings({ lastGranularity: granularity, lastContextLevel: contextLevel }); }, [granularity, contextLevel]);
  useEffect(() => { if (selectedRepo) savePlannerSettings({ lastRepository: selectedRepo }); }, [selectedRepo]);

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
        } catch (err) { setError('Failed to process pasted image'); console.error('Paste error:', err); }
        finally { setIsUploading(false); }
        return;
      }
    }
  };

  const handleUpload = async (file: File) => {
    setIsUploading(true);
    try {
      const processedFile = file.type.startsWith('image/') ? await resizeImage(file) : file;
      setLocalFiles(prev => [...prev, processedFile]);
    } catch { setError('Failed to process file'); }
    finally { setIsUploading(false); }
  };

  const handleFileInputChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) await handleUpload(file);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleRemoveFile = (fileIndex: number) => { setLocalFiles(prev => prev.filter((_, i) => i !== fileIndex)); };

  const handleContinue = async () => {
    if (!selectedRepo || !prompt.trim()) { setError('Please select a repository and enter a prompt'); return; }
    setIsCreating(true);
    setError(null);
    try {
      const draft = await createDraft(selectedRepo, prompt.trim());
      for (const file of localFiles) {
        try { await uploadAttachment(draft.draft_id, file); }
        catch (uploadErr) { console.error('Failed to upload attachment:', uploadErr); }
      }
      if (onDraftCreated) onDraftCreated(draft.draft_id);
      navigate(`/studio/${draft.draft_id}`, { replace: true });
    } catch (err) { setError((err as Error).message || 'Failed to create draft'); setIsCreating(false); }
  };

  const selectedFilesCount = availableRepos.length > 0 ? 100 : 0;
  const estimatedTokens = 42000;
  const estimatedCost = 0.79;

  return (
    <div className="h-full flex flex-col bg-white">
      <div className="flex-1 flex min-h-0">
        <div className="w-[65%] h-full flex flex-col border-r border-gray-100">
          <div className="px-6 py-3 border-b border-gray-100">
            <div className="flex items-center gap-2 text-sm">
              {reposLoading ? <span className="text-gray-400">Loading...</span> : (
                <>
                  <span className="font-medium text-gray-700">{selectedRepo || 'Select repository'}</span>
                  <span className="text-gray-400">&gt;</span>
                  <div className="relative inline-flex items-center">
                    <select value={selectedRepo} onChange={(e) => setSelectedRepo(e.target.value)}
                      className="appearance-none bg-transparent text-gray-600 hover:text-gray-900 focus:outline-none cursor-pointer pr-5"
                      disabled={repos.length === 0}>
                      {repos.length === 0 ? <option value="">No repositories</option> :
                        repos.map(repo => <option key={repo.name} value={repo.name}>{repo.baseBranch || 'main'}</option>)}
                    </select>
                    <ChevronDown className="w-3.5 h-3.5 text-gray-400 absolute right-0 pointer-events-none" />
                  </div>
                </>
              )}
            </div>
          </div>
          <div className="flex-1 flex flex-col p-6 min-h-0">
            <div className="flex-1 flex flex-col min-h-0">
              <div className="flex-1 min-h-0 flex flex-col" style={{ maxHeight: '80%' }}>
                <textarea ref={textareaRef} value={prompt} onChange={(e) => setPrompt(e.target.value)}
                  onInput={autoResize} onPaste={handlePaste}
                  placeholder="Describe the feature, bug fix, or improvement you want to implement..."
                  className="flex-1 w-full text-base text-gray-900 placeholder-gray-400 resize-none focus:outline-none leading-relaxed"
                  style={{ minHeight: '200px' }} />
              </div>
              <div className="mt-4 space-y-3">
                {localFiles.length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    {localFiles.map((file, index) => (
                      <AttachmentChip key={`file-${index}`} file={file} onRemove={() => handleRemoveFile(index)} />
                    ))}
                  </div>
                )}
                <div className="flex items-center">
                  <input type="file" ref={fileInputRef} onChange={handleFileInputChange} className="hidden" accept="image/*,.log,.txt,.json" />
                  <button onClick={() => fileInputRef.current?.click()} disabled={isUploading}
                    className="flex items-center gap-2 text-sm text-gray-500 hover:text-gray-700 transition-colors">
                    {isUploading ? <><Loader2 className="w-4 h-4 animate-spin" /><span>Uploading...</span></> :
                      <><Paperclip className="w-4 h-4" /><span>Attach</span></>}
                  </button>
                </div>
              </div>
            </div>
          </div>
          <div className="border-t border-gray-100 px-6 py-4 bg-white">
            {error && <div className="mb-3 p-2 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">{error}</div>}
            <div className="flex items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <span className="text-sm text-gray-500">Granularity:</span>
                <GranularityPills value={granularity} onChange={setGranularity} />
              </div>
              <button onClick={handleContinue} disabled={isCreating || !selectedRepo || !prompt.trim() || reposLoading}
                className="flex items-center gap-2 px-6 py-2.5 bg-indigo-600 text-white font-medium rounded-lg hover:bg-indigo-700 disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors">
                {isCreating ? <><div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" /><span>Creating...</span></> :
                  <><Sparkles className="w-4 h-4" /><span>Generate Plan</span></>}
              </button>
            </div>
          </div>
        </div>
        <div className="w-[35%] h-full flex flex-col bg-white">
          <div className="p-5 border-b border-gray-100">
            <ContextLevelSlider value={contextLevel} onChange={setContextLevel} compress={compress}
              onCompressChange={setCompress} agents={agents} generationModel={generationModel}
              onGenerationModelChange={setGenerationModel} />
          </div>
          <div className="flex-1 overflow-auto p-5">
            <div className="space-y-3">
              <h3 className="text-sm font-medium text-gray-700">Selected Files ({selectedFilesCount})</h3>
              <p className="text-sm text-gray-400 italic">
                {selectedFilesCount === 0 ? 'Enter a prompt to analyze relevant files' : 'Files will be selected after context analysis'}
              </p>
            </div>
          </div>
          <div className="border-t border-gray-100 px-5 py-4 bg-white">
            <div className="flex items-center justify-between text-sm">
              <div className="text-gray-500"><span className="font-medium text-gray-700">{(estimatedTokens / 1000).toFixed(0)}k</span> tokens</div>
              <div className="text-gray-600">Est: <span className="font-semibold text-gray-900">${estimatedCost.toFixed(2)}</span></div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default NewDraftSetup;
