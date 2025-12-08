import { simpleGit, SimpleGit } from 'simple-git';
import logger from '../../utils/logger.js';

export interface FileScore {
  path: string;
  score: number;
  reason: 'git-history';
}

const MAX_COMMITS_PER_KEYWORD = 50;
const RECENCY_DECAY_FACTOR = 0.95;

export async function mineGitHistory(repoPath: string, keywords: string[]): Promise<FileScore[]> {
  if (keywords.length === 0) {
    return [];
  }

  const git: SimpleGit = simpleGit(repoPath);
  const fileCounts: Record<string, { count: number; recentBoost: number }> = {};

  const mineKeyword = async (keyword: string): Promise<void> => {
    try {
      const logs = await git.raw([
        'log',
        '--no-merges',
        '--name-only',
        '--pretty=format:---COMMIT_BOUNDARY---',
        `--grep=${keyword}`,
        '-i',
        '-n', String(MAX_COMMITS_PER_KEYWORD)
      ]);

      if (!logs.trim()) {
        return;
      }

      const commits = logs.split('---COMMIT_BOUNDARY---').filter(c => c.trim());
      
      commits.forEach((commitBlock, commitIndex) => {
        const files = commitBlock.split('\n').filter(f => f.trim().length > 0);
        const recencyWeight = Math.pow(RECENCY_DECAY_FACTOR, commitIndex);
        
        files.forEach(f => {
          if (!fileCounts[f]) {
            fileCounts[f] = { count: 0, recentBoost: 0 };
          }
          fileCounts[f].count += 1;
          fileCounts[f].recentBoost = Math.max(fileCounts[f].recentBoost, recencyWeight);
        });
      });
    } catch (error) {
      logger.debug({ keyword, error: (error as Error).message }, 'Git mining failed for keyword');
    }
  };

  await Promise.all(keywords.map(mineKeyword));

  return Object.entries(fileCounts).map(([path, data]) => ({
    path,
    score: Math.round(data.count * 10 * (1 + data.recentBoost * 0.5)),
    reason: 'git-history' as const
  }));
}
