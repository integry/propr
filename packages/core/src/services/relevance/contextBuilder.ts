import { db } from '../../db/connection.js';
import { MODEL_LIMITS, TIKTOKEN_TO_CLAUDE_RATIO } from '../../config/modelLimits.js';
import logger from '../../utils/logger.js';

// --- Types ---

export interface FileSummaryRow {
  path: string;
  summary: string;
  commit_hash: string;
}

export interface DirectorySummaryRow {
  path: string;
  summary: string;
  hash: string;
}

export interface ContextBuildOptions {
  /** Model to use for token budget calculation */
  modelId?: string;
  /** Paths already flagged by git/path scoring for Tier 2 inclusion */
  priorityPaths?: string[];
  /** Custom correlation ID for logging */
  correlationId?: string;
}

export interface SmartContextResult {
  context: string;
  fileSummaryCount: number;
  dirSummaryCount: number;
  estimatedTokens: number;
  truncated: boolean;
}

// --- Constants ---

/** Reserve 20% of token budget for user prompt and instructions */
const CONTEXT_BUDGET_RATIO = 0.80;

/** Chars per token estimate (conservative to avoid overflow) */
const CHARS_PER_TOKEN = 3;

// --- Main Export ---

/**
 * Builds a "Smart Context" string containing file and directory summaries,
 * respecting token budget constraints for the planning model.
 *
 * Algorithm:
 * 1. Tier 1: Always include top-level directory summaries
 * 2. Tier 2: Include summaries for priority paths (from git/path scoring) and siblings
 * 3. Tier 3: Fill remaining budget with other summaries (breadth-first from root)
 * 4. If budget exceeded, fallback to directory summaries only
 */
export async function buildSummaryContext(options: ContextBuildOptions = {}): Promise<SmartContextResult> {
  const { modelId = 'default', priorityPaths = [], correlationId } = options;
  const correlatedLogger = correlationId ? logger.withCorrelation(correlationId) : logger;

  // Calculate token budget
  const maxModelTokens = MODEL_LIMITS[modelId] || MODEL_LIMITS['default'];
  const budgetTokens = Math.floor(maxModelTokens * CONTEXT_BUDGET_RATIO / TIKTOKEN_TO_CLAUDE_RATIO);
  const budgetChars = budgetTokens * CHARS_PER_TOKEN;

  correlatedLogger.debug({ modelId, budgetTokens, budgetChars }, 'Calculated context budget');

  // Load all summaries from database
  const fileSummaries = await db('file_summaries').select('path', 'summary', 'commit_hash') as FileSummaryRow[];
  const dirSummaries = await db('directory_summaries').select('path', 'summary', 'hash') as DirectorySummaryRow[];

  if (fileSummaries.length === 0 && dirSummaries.length === 0) {
    correlatedLogger.debug('No summaries found in database');
    return {
      context: '',
      fileSummaryCount: 0,
      dirSummaryCount: 0,
      estimatedTokens: 0,
      truncated: false
    };
  }

  // Build context using tiered approach
  let context = '';
  let currentChars = 0;
  let includedFiles = 0;
  let includedDirs = 0;
  let truncated = false;

  const includedPaths = new Set<string>();

  // --- Tier 1: Top-level directory summaries ---
  const rootDirs = dirSummaries.filter(d => !d.path.includes('/'));
  for (const dir of rootDirs) {
    const entry = formatDirEntry(dir);
    if (currentChars + entry.length <= budgetChars) {
      context += entry;
      currentChars += entry.length;
      includedDirs++;
      includedPaths.add(dir.path);
    } else {
      truncated = true;
      break;
    }
  }

  // --- Tier 2: Priority paths and their siblings ---
  if (priorityPaths.length > 0 && currentChars < budgetChars) {
    const prioritySet = new Set(priorityPaths);

    // Get directories containing priority files
    const priorityDirs = new Set<string>();
    for (const filePath of priorityPaths) {
      const dir = getParentDir(filePath);
      if (dir) {
        priorityDirs.add(dir);
      }
    }

    // Include priority files
    for (const file of fileSummaries) {
      if (prioritySet.has(file.path) && !includedPaths.has(file.path)) {
        const entry = formatFileEntry(file);
        if (currentChars + entry.length <= budgetChars) {
          context += entry;
          currentChars += entry.length;
          includedFiles++;
          includedPaths.add(file.path);
        } else {
          truncated = true;
          break;
        }
      }
    }

    // Include sibling files (files in same directory as priority files)
    for (const file of fileSummaries) {
      const fileDir = getParentDir(file.path);
      if (fileDir && priorityDirs.has(fileDir) && !includedPaths.has(file.path)) {
        const entry = formatFileEntry(file);
        if (currentChars + entry.length <= budgetChars) {
          context += entry;
          currentChars += entry.length;
          includedFiles++;
          includedPaths.add(file.path);
        } else {
          truncated = true;
          break;
        }
      }
    }

    // Include priority directories
    for (const dir of dirSummaries) {
      if (priorityDirs.has(dir.path) && !includedPaths.has(dir.path)) {
        const entry = formatDirEntry(dir);
        if (currentChars + entry.length <= budgetChars) {
          context += entry;
          currentChars += entry.length;
          includedDirs++;
          includedPaths.add(dir.path);
        } else {
          truncated = true;
          break;
        }
      }
    }
  }

  // --- Tier 3: Fill remaining budget (breadth-first from root) ---
  if (currentChars < budgetChars) {
    // Sort directories by depth (shallowest first)
    const sortedDirs = [...dirSummaries]
      .filter(d => !includedPaths.has(d.path))
      .sort((a, b) => getDepth(a.path) - getDepth(b.path));

    for (const dir of sortedDirs) {
      const entry = formatDirEntry(dir);
      if (currentChars + entry.length <= budgetChars) {
        context += entry;
        currentChars += entry.length;
        includedDirs++;
        includedPaths.add(dir.path);
      } else {
        truncated = true;
        break;
      }
    }

    // Then add remaining files (sorted by path for breadth-first effect)
    const sortedFiles = [...fileSummaries]
      .filter(f => !includedPaths.has(f.path))
      .sort((a, b) => getDepth(a.path) - getDepth(b.path));

    for (const file of sortedFiles) {
      const entry = formatFileEntry(file);
      if (currentChars + entry.length <= budgetChars) {
        context += entry;
        currentChars += entry.length;
        includedFiles++;
        includedPaths.add(file.path);
      } else {
        truncated = true;
        break;
      }
    }
  }

  const estimatedTokens = Math.ceil(currentChars / CHARS_PER_TOKEN);

  correlatedLogger.info({
    fileSummaryCount: includedFiles,
    dirSummaryCount: includedDirs,
    totalSummariesAvailable: fileSummaries.length + dirSummaries.length,
    estimatedTokens,
    truncated
  }, 'Built smart context');

  return {
    context: context.trim(),
    fileSummaryCount: includedFiles,
    dirSummaryCount: includedDirs,
    estimatedTokens,
    truncated
  };
}

/**
 * Loads all file summaries from the database.
 */
export async function loadFileSummaries(): Promise<FileSummaryRow[]> {
  return db('file_summaries').select('path', 'summary', 'commit_hash');
}

/**
 * Loads all directory summaries from the database.
 */
export async function loadDirectorySummaries(): Promise<DirectorySummaryRow[]> {
  return db('directory_summaries').select('path', 'summary', 'hash');
}

// --- Helper Functions ---

function formatFileEntry(file: FileSummaryRow): string {
  return `FILE ${file.path}: ${file.summary}\n`;
}

function formatDirEntry(dir: DirectorySummaryRow): string {
  return `DIR ${dir.path}/: ${dir.summary}\n`;
}

function getParentDir(filePath: string): string | null {
  const parts = filePath.split('/');
  if (parts.length <= 1) return null;
  return parts.slice(0, -1).join('/');
}

function getDepth(path: string): number {
  return path.split('/').length;
}
