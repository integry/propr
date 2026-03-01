/**
 * File selection utilities for context generation.
 */

import type { FileSelectionResult, DroppedFile } from './types.js';

export function selectFilesWithinLimit(
  fileTokenCounts: Record<string, number>,
  effectiveLimit: number,
  filesToInclude?: string[],
  priorityFiles?: string[]
): FileSelectionResult {
  const selectedFiles: string[] = [];
  const droppedFiles: DroppedFile[] = [];
  let currentTokens = 0;

  if (filesToInclude && filesToInclude.length > 0) {
    for (const filePath of filesToInclude) {
      const tokens = fileTokenCounts[filePath];
      if (tokens === undefined) {
        droppedFiles.push({ path: filePath, tokens: 0, reason: 'not found in token counts' });
        continue;
      }
      if (currentTokens + tokens > effectiveLimit) {
        droppedFiles.push({ path: filePath, tokens, reason: `exceeds limit (would be ${currentTokens + tokens} > ${effectiveLimit})` });
        continue;
      }
      selectedFiles.push(filePath);
      currentTokens += tokens;
    }
    return { selectedFiles, droppedFiles, currentTokens, strategy: 'relevance-order' };
  }

  // When no specific files requested, include all files but prioritize certain ones
  const prioritySet = new Set(priorityFiles || []);
  const allFiles = Object.entries(fileTokenCounts);

  // Sort: priority files first (by their original order), then remaining files by size
  const priorityFilesWithTokens = (priorityFiles || [])
    .filter(p => fileTokenCounts[p] !== undefined)
    .map(p => [p, fileTokenCounts[p]] as [string, number]);

  const nonPriorityFiles = allFiles
    .filter(([path]) => !prioritySet.has(path))
    .sort((a, b) => a[1] - b[1]); // Sort by size (smallest first)

  const sortedFiles = [...priorityFilesWithTokens, ...nonPriorityFiles];

  for (const [filePath, tokens] of sortedFiles) {
    if (currentTokens + tokens > effectiveLimit) {
      droppedFiles.push({ path: filePath, tokens, reason: `exceeds limit (would be ${currentTokens + tokens} > ${effectiveLimit})` });
      continue;
    }
    selectedFiles.push(filePath);
    currentTokens += tokens;
  }
  return { selectedFiles, droppedFiles, currentTokens, strategy: priorityFiles?.length ? 'priority-then-size' : 'size-order' };
}
