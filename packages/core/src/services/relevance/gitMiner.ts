import { simpleGit, SimpleGit } from 'simple-git';
import logger from '../../utils/logger.js';
import { runLightweightLLMAnalysis, RunLightweightLLMAnalysisOptions } from '../../claude/claudeService.js';

export interface FileScore {
  path: string;
  score: number;
  reason: 'git-history' | 'llm-semantic';
}

export interface CommitInfo {
  hash: string;
  subject: string;
  body: string;
  files: string[];
}

export interface SemanticMinerFile {
  path: string;
  score: number;
  reason: string;
}

export interface SemanticMinerResponse {
  files: SemanticMinerFile[];
}

export interface SemanticMiningOptions {
  worktreePath: string;
  githubToken: string;
  issueRef: {
    number: number;
    repoOwner: string;
    repoName: string;
  };
  correlationId?: string;
}

const MAX_COMMITS_PER_KEYWORD = 50;
const RECENCY_DECAY_FACTOR = 0.95;
const MAX_COMMIT_LOG_CHARS = 50000;
const INITIAL_COMMIT_LIMIT = 500;

export async function getCommitHistory(repoPath: string, limit: number = INITIAL_COMMIT_LIMIT): Promise<CommitInfo[]> {
  const git: SimpleGit = simpleGit(repoPath);
  const commits: CommitInfo[] = [];

  try {
    const logs = await git.raw([
      'log',
      '--no-merges',
      '--pretty=format:%h|%s|%b---END_BODY---',
      '--name-only',
      '-n', String(limit)
    ]);

    if (!logs.trim()) {
      return [];
    }

    const commitBlocks = logs.split('---END_BODY---');

    for (const block of commitBlocks) {
      const trimmed = block.trim();
      if (!trimmed) continue;

      const lines = trimmed.split('\n');
      if (lines.length === 0) continue;

      const headerLine = lines[0];
      const pipeIndex = headerLine.indexOf('|');
      if (pipeIndex === -1) continue;

      const hash = headerLine.substring(0, pipeIndex);
      const rest = headerLine.substring(pipeIndex + 1);
      const secondPipeIndex = rest.indexOf('|');

      let subject = rest;
      let body = '';
      if (secondPipeIndex !== -1) {
        subject = rest.substring(0, secondPipeIndex);
        body = rest.substring(secondPipeIndex + 1);
      }

      const files = lines.slice(1).filter(f => f.trim().length > 0 && !f.includes('|'));

      commits.push({
        hash: hash.trim(),
        subject: subject.trim(),
        body: body.trim(),
        files
      });
    }

    return commits;
  } catch (error) {
    logger.debug({ error: (error as Error).message }, 'Failed to get commit history');
    return [];
  }
}

export function formatCommitLog(commits: CommitInfo[], maxChars: number = MAX_COMMIT_LOG_CHARS): string {
  let result = '';
  
  for (const commit of commits) {
    const filesStr = commit.files.join(', ');
    const entry = `${commit.hash} | ${commit.subject} | Files: ${filesStr}\n`;
    
    if (result.length + entry.length > maxChars) {
      break;
    }
    
    result += entry;
  }
  
  return result;
}

function generateSemanticMinerPrompt(userRequest: string, commitLog: string): string {
  return `You are a code archaeology expert.
Analyze the commit history to find files relevant to the user's request.

<user_request>
${userRequest}
</user_request>

<commit_history>
${commitLog}
</commit_history>

TASK:
1. Identify files modified in commits that are semantically related to the user request.
2. Return a JSON object with a 'files' array.
3. Assign a score (0-100) based on how strong the evidence is.

OUTPUT FORMAT:
{
  "files": [
    { "path": "src/auth/Login.tsx", "score": 90, "reason": "Modified in commit 'fix login bug'" }
  ]
}

Respond ONLY with valid JSON.`;
}

function parseSemanticResponse(response: string): SemanticMinerResponse {
  try {
    const jsonMatch = response.match(/\{[\s\S]*"files"[\s\S]*\}/);
    if (!jsonMatch) {
      return { files: [] };
    }
    
    const parsed = JSON.parse(jsonMatch[0]) as SemanticMinerResponse;
    
    if (!parsed.files || !Array.isArray(parsed.files)) {
      return { files: [] };
    }
    
    return {
      files: parsed.files.filter(f => 
        typeof f.path === 'string' && 
        typeof f.score === 'number' &&
        f.path.trim().length > 0
      ).map(f => ({
        path: f.path.trim(),
        score: Math.min(100, Math.max(0, f.score)),
        reason: typeof f.reason === 'string' ? f.reason : 'semantic match'
      }))
    };
  } catch (error) {
    logger.debug({ error: (error as Error).message }, 'Failed to parse semantic miner response');
    return { files: [] };
  }
}

export async function mineGitHistoryWithLLM(
  repoPath: string,
  userPrompt: string,
  options: SemanticMiningOptions
): Promise<FileScore[]> {
  const correlatedLogger = options.correlationId 
    ? logger.withCorrelation(options.correlationId) 
    : logger;

  try {
    const commits = await getCommitHistory(repoPath);
    
    if (commits.length === 0) {
      correlatedLogger.debug('No commit history found, skipping semantic mining');
      return [];
    }

    const commitLog = formatCommitLog(commits);
    
    if (!commitLog.trim()) {
      correlatedLogger.debug('Empty commit log, skipping semantic mining');
      return [];
    }

    correlatedLogger.info(
      { commitCount: commits.length, logLength: commitLog.length },
      'Running semantic git mining with LLM'
    );

    const prompt = generateSemanticMinerPrompt(userPrompt, commitLog);

    const llmOptions: RunLightweightLLMAnalysisOptions = {
      prompt,
      model: 'haiku',
      correlationId: options.correlationId || 'semantic-mining',
      worktreePath: options.worktreePath,
      githubToken: options.githubToken,
      issueRef: options.issueRef
    };

    const response = await runLightweightLLMAnalysis(llmOptions);
    const parsed = parseSemanticResponse(response);

    correlatedLogger.info(
      { fileCount: parsed.files.length },
      'Semantic git mining completed'
    );

    return parsed.files.map(f => ({
      path: f.path,
      score: f.score,
      reason: 'llm-semantic' as const
    }));
  } catch (error) {
    correlatedLogger.warn(
      { error: (error as Error).message },
      'Semantic git mining failed, falling back to keyword mining'
    );
    return [];
  }
}

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
