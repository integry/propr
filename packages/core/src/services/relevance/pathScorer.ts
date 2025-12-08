import { simpleGit } from 'simple-git';
import path from 'path';
import logger from '../../utils/logger.js';

export interface FileScore {
  path: string;
  score: number;
  reason: 'path-match';
}

const EXACT_MATCH_SCORE = 100;
const PARTIAL_MATCH_SCORE = 50;
const BASENAME_CONTAINS_SCORE = 30;

export async function scorePaths(repoPath: string, keywords: string[]): Promise<FileScore[]> {
  if (keywords.length === 0) {
    return [];
  }

  const git = simpleGit(repoPath);
  let allFiles: string[];
  
  try {
    const result = await git.raw(['ls-files']);
    allFiles = result.split('\n').filter(f => f.trim().length > 0);
  } catch (error) {
    logger.warn({ repoPath, error: (error as Error).message }, 'Failed to list files from git');
    return [];
  }

  const fileScores: Record<string, number> = {};
  const lowerKeywords = keywords.map(k => k.toLowerCase());

  for (const filePath of allFiles) {
    const basename = path.basename(filePath);
    const basenameWithoutExt = path.basename(filePath, path.extname(filePath));
    const lowerPath = filePath.toLowerCase();
    const lowerBasename = basename.toLowerCase();
    const lowerBasenameNoExt = basenameWithoutExt.toLowerCase();

    for (const keyword of lowerKeywords) {
      const lowerKeyword = keyword.toLowerCase();
      
      if (lowerBasenameNoExt === lowerKeyword || lowerBasename === lowerKeyword) {
        fileScores[filePath] = Math.max(fileScores[filePath] || 0, EXACT_MATCH_SCORE);
      } else if (lowerPath.includes(lowerKeyword)) {
        fileScores[filePath] = Math.max(fileScores[filePath] || 0, PARTIAL_MATCH_SCORE);
      } else if (lowerBasename.includes(lowerKeyword)) {
        fileScores[filePath] = Math.max(fileScores[filePath] || 0, BASENAME_CONTAINS_SCORE);
      }
    }
  }

  return Object.entries(fileScores).map(([filePath, score]) => ({
    path: filePath,
    score,
    reason: 'path-match' as const
  }));
}
