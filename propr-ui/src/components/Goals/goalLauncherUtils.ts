import type React from 'react';
import { resizeImage } from '../TaskPlanner/imageUtils';

export const buttonClass = 'inline-flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50';
const maxGoalAttachmentsPerPrompt = 10;

export async function addGoalFiles(
  current: File[],
  incoming: File[],
  setFiles: React.Dispatch<React.SetStateAction<File[]>>,
  setError: React.Dispatch<React.SetStateAction<string | null>>,
) {
  if (current.length + incoming.length > maxGoalAttachmentsPerPrompt) {
    setError(`Attach up to ${maxGoalAttachmentsPerPrompt} files to each prompt.`);
    return;
  }
  setFiles([...current, ...await Promise.all(incoming.map(resizeImage))]);
}
