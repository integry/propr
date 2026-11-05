import { useRef, useState } from 'react';
import { fetchPrompt as apiFetchPrompt } from '../../api/proprApi';
import { PromptData } from './types';

export const usePromptData = () => {
  const [selectedPrompt, setSelectedPrompt] = useState<PromptData | null>(null);
  const [loadingPrompt, setLoadingPrompt] = useState<boolean>(false);
  // Only the latest request may open the viewer; closing it abandons any request still pending.
  const requestRef = useRef(0);

  const fetchPrompt = async (promptPath: string) => {
    const request = ++requestRef.current;
    const isCurrent = () => request === requestRef.current;
    try {
      setLoadingPrompt(true);
      const promptData = await apiFetchPrompt(promptPath);
      if (!isCurrent()) return;

      try {
        const parsed = JSON.parse(promptData);
        setSelectedPrompt(parsed);
      } catch {
        setSelectedPrompt({ prompt: promptData });
      }
    } catch (err) {
      if (!isCurrent()) return;
      console.error('Error fetching prompt:', err);
      setSelectedPrompt({ error: 'Failed to load prompt content.' });
    } finally {
      if (isCurrent()) setLoadingPrompt(false);
    }
  };

  const closePrompt = () => {
    requestRef.current++;
    setSelectedPrompt(null);
    setLoadingPrompt(false);
  };

  return { selectedPrompt, loadingPrompt, fetchPrompt, closePrompt };
};
