import { useState, useRef, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { getRepoConfig, createDraft, uploadAttachment } from '../api/proprApi';
import { getInitialSelectedRepo, Repo } from '../components/Dashboard/index';
import { getRepositoriesIndexingStatus, RepositoryIndexingStatus } from '../api/repoIndexingApi';
import { getUserRepoPreferences, UserRepoPreferences } from '../api/userRepoPreferencesApi';
import { resizeImage } from '../components/TaskPlanner/imageUtils';

export interface UseNewPlanFormReturn {
  repos: Repo[];
  selectedRepo: string;
  setSelectedRepo: (repo: string) => void;
  prompt: string;
  setPrompt: (prompt: string) => void;
  isCreating: boolean;
  formError: string | null;
  selectedFiles: File[];
  isPastingImage: boolean;
  isFormExpanded: boolean;
  setIsFormExpanded: (expanded: boolean) => void;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  handleStartPlanning: () => Promise<void>;
  handleFileSelect: (e: React.ChangeEvent<HTMLInputElement>) => void;
  handleRemoveFile: (index: number) => void;
  handlePaste: (e: React.ClipboardEvent<HTMLTextAreaElement>) => Promise<void>;
  toggleFormExpanded: () => void;
}

export function useNewPlanForm(): UseNewPlanFormReturn {
  const navigate = useNavigate();
  const [repos, setRepos] = useState<Repo[]>([]);
  const [selectedRepo, setSelectedRepo] = useState<string>('');
  const [prompt, setPrompt] = useState<string>('');
  const [isCreating, setIsCreating] = useState<boolean>(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [isPastingImage, setIsPastingImage] = useState<boolean>(false);
  const [isFormExpanded, setIsFormExpanded] = useState<boolean>(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Load repositories for NewPlanForm
  useEffect(() => {
    const loadRepos = async () => {
      try {
        const [repoData, userPrefs, indexingData] = await Promise.all([
          getRepoConfig() as Promise<{ repos_to_monitor?: Array<{ name: string; enabled?: boolean; baseBranch?: string }> }>,
          getUserRepoPreferences().catch(() => ({} as UserRepoPreferences)),
          getRepositoriesIndexingStatus().catch(() => ({ repositories: [] as RepositoryIndexingStatus[] }))
        ]);
        const indexingMap = new Map<string, RepositoryIndexingStatus>();
        for (const status of indexingData.repositories || []) {
          indexingMap.set(status.full_name, status);
        }
        const enabledRepos: Repo[] = (repoData.repos_to_monitor || [])
          .filter((r): r is { name: string; enabled?: boolean; baseBranch?: string } =>
            typeof r === 'object' && r !== null && 'name' in r && typeof (r as { name: unknown }).name === 'string'
          )
          .filter(r => r.enabled !== false)
          .map(r => {
            const prefs = userPrefs[r.name];
            const indexingStatus = indexingMap.get(r.name);
            return {
              name: r.name,
              enabled: true,
              baseBranch: r.baseBranch,
              starred: prefs?.starred || false,
              iconPath: indexingStatus?.icon_path || null
            };
          });
        setRepos(enabledRepos);
        setSelectedRepo(getInitialSelectedRepo(enabledRepos));
      } catch (err) {
        console.error('Failed to load repositories:', err);
      }
    };
    loadRepos();
  }, []);

  const handleStartPlanning = useCallback(async () => {
    if (!selectedRepo || !prompt.trim()) return;

    setIsCreating(true);
    setFormError(null);
    try {
      const draft = await createDraft(selectedRepo, prompt.trim());

      // Upload any selected files to the draft
      for (const file of selectedFiles) {
        try {
          await uploadAttachment(draft.draft_id, file);
        } catch (uploadErr) {
          console.error('Failed to upload attachment:', uploadErr);
        }
      }

      navigate(`/studio/${draft.draft_id}`);
    } catch (err) {
      setFormError((err as Error).message || 'Failed to create draft');
    } finally {
      setIsCreating(false);
    }
  }, [selectedRepo, prompt, selectedFiles, navigate]);

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files && files.length > 0) {
      setSelectedFiles(prev => [...prev, ...Array.from(files)]);
    }
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  }, []);

  const handleRemoveFile = useCallback((index: number) => {
    setSelectedFiles(prev => prev.filter((_, i) => i !== index));
  }, []);

  const handlePaste = useCallback(async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
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
        setFormError(null);
        try {
          const processedFile = await resizeImage(file);
          setSelectedFiles(prev => [...prev, processedFile]);
        } catch (err) {
          setFormError('Failed to process pasted image');
          console.error('Paste error:', err);
        } finally {
          setIsPastingImage(false);
        }
        return;
      }
    }
  }, []);

  const toggleFormExpanded = useCallback(() => {
    setIsFormExpanded(prev => !prev);
  }, []);

  return {
    repos,
    selectedRepo,
    setSelectedRepo,
    prompt,
    setPrompt,
    isCreating,
    formError,
    selectedFiles,
    isPastingImage,
    isFormExpanded,
    setIsFormExpanded,
    fileInputRef,
    handleStartPlanning,
    handleFileSelect,
    handleRemoveFile,
    handlePaste,
    toggleFormExpanded,
  };
}
