import { simpleGit } from 'simple-git';
import path from 'path';
import logger from '../../utils/logger.js';

export interface FileScore {
  path: string;
  score: number;
  reason: 'path-match';
}

// --- Scoring Constants ---

/** Basename exactly matches keyword (e.g., "brokers" matches "brokers.html") */
const EXACT_MATCH_SCORE = 100;

/** Basename contains keyword (e.g., "topbrokers" contains "broker") */
const BASENAME_CONTAINS_SCORE = 60;

/** Directory name exactly matches keyword (e.g., "/brokers/" in path) */
const DIR_EXACT_MATCH_SCORE = 50;

/** Path contains keyword anywhere (e.g., "broker" in "www/css/topbrokers.less") */
const PATH_CONTAINS_SCORE = 40;

/** Bonus for multiple keyword matches in the same file */
const MULTI_KEYWORD_BONUS = 15;

/** Bonus for files in UI-related directories */
const UI_DIR_BONUS = 10;

/** UI-related directory patterns */
const UI_DIRECTORIES = ['templates', 'components', 'views', 'pages', 'screens', 'css', 'styles', 'less', 'scss'];

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
  const keywordMatches: Record<string, Set<string>> = {};
  const lowerKeywords = keywords.map(k => k.toLowerCase());

  for (const filePath of allFiles) {
    const basename = path.basename(filePath);
    const basenameWithoutExt = path.basename(filePath, path.extname(filePath));
    const dirPath = path.dirname(filePath);
    const dirParts = dirPath.split('/').filter(p => p.length > 0);

    const lowerPath = filePath.toLowerCase();
    const lowerBasename = basename.toLowerCase();
    const lowerBasenameNoExt = basenameWithoutExt.toLowerCase();
    const lowerDirParts = dirParts.map(d => d.toLowerCase());

    let fileScore = 0;
    const matchedKeywords = new Set<string>();

    for (const keyword of lowerKeywords) {
      let keywordScore = 0;

      // 1. Exact basename match (highest priority)
      if (lowerBasenameNoExt === keyword || lowerBasename === keyword) {
        keywordScore = Math.max(keywordScore, EXACT_MATCH_SCORE);
        matchedKeywords.add(keyword);
      }
      // 2. Basename contains keyword
      else if (lowerBasename.includes(keyword) || lowerBasenameNoExt.includes(keyword)) {
        keywordScore = Math.max(keywordScore, BASENAME_CONTAINS_SCORE);
        matchedKeywords.add(keyword);
      }
      // 3. Directory name exactly matches keyword
      else if (lowerDirParts.includes(keyword)) {
        keywordScore = Math.max(keywordScore, DIR_EXACT_MATCH_SCORE);
        matchedKeywords.add(keyword);
      }
      // 4. Path contains keyword anywhere
      else if (lowerPath.includes(keyword)) {
        keywordScore = Math.max(keywordScore, PATH_CONTAINS_SCORE);
        matchedKeywords.add(keyword);
      }

      fileScore = Math.max(fileScore, keywordScore);
    }

    if (fileScore > 0) {
      // Bonus for multiple keyword matches
      if (matchedKeywords.size > 1) {
        fileScore += MULTI_KEYWORD_BONUS * (matchedKeywords.size - 1);
      }

      // Bonus for UI-related directories
      const isInUiDir = lowerDirParts.some(dir => UI_DIRECTORIES.includes(dir));
      if (isInUiDir) {
        fileScore += UI_DIR_BONUS;
      }

      fileScores[filePath] = fileScore;
      keywordMatches[filePath] = matchedKeywords;
    }
  }

  return Object.entries(fileScores)
    .map(([filePath, score]) => ({
      path: filePath,
      score: Math.min(score, 100), // Cap at 100
      reason: 'path-match' as const
    }))
    .sort((a, b) => b.score - a.score);
}
