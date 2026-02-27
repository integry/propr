import { useState } from 'react';
import { fetchPrompt as apiFetchPrompt } from '../../api/proprApi';
import { PromptData } from './types';

export const usePromptData = () => {
  const [selectedPrompt, setSelectedPrompt] = useState<PromptData | null>(null);
  const [loadingPrompt, setLoadingPrompt] = useState<boolean>(false);

  const fetchPrompt = async (promptPath: string) => {
    try {
      setLoadingPrompt(true);
      const promptData = await apiFetchPrompt(promptPath);
      
      try {
        const parsed = JSON.parse(promptData);
        setSelectedPrompt(parsed);
      } catch {
        setSelectedPrompt({ prompt: promptData });
      }
    } catch (err) {
      console.error('Error fetching prompt:', err);
      setSelectedPrompt({ error: 'Failed to load prompt content.' });
    } finally {
      setLoadingPrompt(false);
    }
  };

  return { selectedPrompt, setSelectedPrompt, loadingPrompt, fetchPrompt };
};
