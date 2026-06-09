import { PreviewResult, SmartFileSelection } from '../api/proprApi';

const WORD_OVERLAP_THRESHOLD = 0.5;

export const TIKTOKEN_TO_CLAUDE_RATIO = 1.36;
export const DEFAULT_MODEL_MAX_TOKENS = 200000;

const extractWords = (prompt: string) => (prompt.toLowerCase().match(/\b[\w'-]+\b/g) ?? []);

export function simulateContextLevel(
  originalData: PreviewResult,
  contextLevel: number,
  modelMaxTokens: number = DEFAULT_MODEL_MAX_TOKENS
): PreviewResult {
  const fileTokenCounts = originalData.fileTokenCounts;
  if (!fileTokenCounts || Object.keys(fileTokenCounts).length === 0) {
    return originalData;
  }

  const targetTokenLimit = Math.floor(modelMaxTokens * (contextLevel / 100) * 0.98);
  const targetTiktokenLimit = Math.floor(targetTokenLimit / TIKTOKEN_TO_CLAUDE_RATIO);

  const contextRepoFiles = originalData.smartSelection.filter(f => f.source === 'context-repo');
  const repoFiles = originalData.smartSelection.filter(f => f.source !== 'context-repo');

  const sortedFiles = [...repoFiles].sort((a, b) => {
    const scoreDiff = (b.score ?? 0) - (a.score ?? 0);
    if (scoreDiff !== 0) return scoreDiff;
    return (fileTokenCounts[a.path] ?? 0) - (fileTokenCounts[b.path] ?? 0);
  });

  const selectedFiles: SmartFileSelection[] = [];
  let currentTokens = 0;

  for (const file of sortedFiles) {
    const fileTokens = fileTokenCounts[file.path] ?? 0;
    if (currentTokens + fileTokens <= targetTiktokenLimit) {
      selectedFiles.push(file);
      currentTokens += fileTokens;
    }
  }

  const estimatedActualTokens = Math.ceil(currentTokens * TIKTOKEN_TO_CLAUDE_RATIO);
  const attachmentTokens = originalData.stats.attachmentTokens ?? 0;
  const totalTokens = estimatedActualTokens + attachmentTokens;

  const costEstimate = (totalTokens / 1_000_000) * 3 + (4000 / 1_000_000) * 15;

  return {
    ...originalData,
    smartSelection: [...selectedFiles, ...contextRepoFiles],
    stats: {
      ...originalData.stats,
      totalTokens,
      fileCount: selectedFiles.length,
      costEstimate,
      maxTokens: Math.ceil(targetTokenLimit * TIKTOKEN_TO_CLAUDE_RATIO)
    }
  };
}

export const isSignificantPromptChange = (prevPrompt: string, nextPrompt: string): boolean => {
  if (prevPrompt === nextPrompt) return false;

  const lengthDiff = Math.abs(prevPrompt.length - nextPrompt.length);
  const baseLength = Math.max(prevPrompt.length, 1);
  if (lengthDiff > 20 || (lengthDiff / baseLength) > 0.2) return true;

  const prevWords = new Set(extractWords(prevPrompt));
  const nextWords = new Set(extractWords(nextPrompt));

  if (!prevWords.size && !nextWords.size) return false;

  let overlap = 0;
  prevWords.forEach(word => { if (nextWords.has(word)) overlap += 1; });
  const overlapRatio = overlap / Math.max(prevWords.size, nextWords.size, 1);

  return overlapRatio < WORD_OVERLAP_THRESHOLD;
};
