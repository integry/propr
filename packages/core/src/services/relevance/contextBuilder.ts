import { db } from '../../db/connection.js';
import { MODEL_LIMITS, TIKTOKEN_TO_CLAUDE_RATIO } from '../../config/modelLimits.js';
import logger from '../../utils/logger.js';

// --- Types ---

export interface FileSummaryRow {
  path: string;
  branch: string;
  summary: string;
  commit_hash: string;
}

export interface DirectorySummaryRow {
  path: string;
  branch: string;
  summary: string;
  hash: string;
}

export interface ContextBuildOptions {
  /** Model to use for token budget calculation (ignored if tokenBudget provided) */
  modelId?: string;
  /** Explicit token budget (overrides modelId-based calculation) */
  tokenBudget?: number;
  /** Paths already flagged by git/path scoring for Tier 2 inclusion */
  priorityPaths?: string[];
  /** Custom correlation ID for logging */
  correlationId?: string;
  /** Repository full name (e.g., "owner/repo") to filter and strip from paths */
  repoName?: string;
}

export interface SmartContextResult {
  context: string;
  fileSummaryCount: number;
  dirSummaryCount: number;
  estimatedTokens: number;
  truncated: boolean;
}

// --- Constants ---

/** Default ratio of model token limit to use for summaries (when no explicit budget provided) */
const CONTEXT_BUDGET_RATIO = 0.95;

/** Chars per token estimate (conservative to avoid overflow) */
const CHARS_PER_TOKEN = 3;

// --- Internal Types for Context Building ---

interface ContextState {
  context: string;
  currentChars: number;
  includedFiles: number;
  includedDirs: number;
  truncated: boolean;
  includedPaths: Set<string>;
}

interface ContextBuildData {
  fileSummaries: FileSummaryRow[];
  dirSummaries: DirectorySummaryRow[];
  budgetChars: number;
  priorityPaths: string[];
}

// --- Tier Processing Functions ---

/**
 * Tier 1: Add top-level directory summaries
 */
function processTier1RootDirs(state: ContextState, data: ContextBuildData): void {
  const rootDirs = data.dirSummaries.filter(d => !d.path.includes('/'));
  for (const dir of rootDirs) {
    const entry = formatDirEntry(dir);
    if (state.currentChars + entry.length <= data.budgetChars) {
      state.context += entry;
      state.currentChars += entry.length;
      state.includedDirs++;
      state.includedPaths.add(dir.path);
    } else {
      state.truncated = true;
      break;
    }
  }
}

/**
 * Tier 2: Add priority paths and their siblings
 */
function processTier2PriorityPaths(state: ContextState, data: ContextBuildData): void {
  if (data.priorityPaths.length === 0 || state.currentChars >= data.budgetChars) {
    return;
  }

  const prioritySet = new Set(data.priorityPaths);
  const priorityDirs = getPriorityDirs(data.priorityPaths);

  addPriorityFiles(state, data, prioritySet);
  addSiblingFiles(state, data, priorityDirs);
  addPriorityDirectories(state, data, priorityDirs);
}

function getPriorityDirs(priorityPaths: string[]): Set<string> {
  const priorityDirs = new Set<string>();
  for (const filePath of priorityPaths) {
    const dir = getParentDir(filePath);
    if (dir) {
      priorityDirs.add(dir);
    }
  }
  return priorityDirs;
}

function addPriorityFiles(state: ContextState, data: ContextBuildData, prioritySet: Set<string>): void {
  for (const file of data.fileSummaries) {
    if (prioritySet.has(file.path) && !state.includedPaths.has(file.path)) {
      if (!tryAddFileEntry(state, data.budgetChars, file)) break;
    }
  }
}

function addSiblingFiles(state: ContextState, data: ContextBuildData, priorityDirs: Set<string>): void {
  for (const file of data.fileSummaries) {
    const fileDir = getParentDir(file.path);
    if (fileDir && priorityDirs.has(fileDir) && !state.includedPaths.has(file.path)) {
      if (!tryAddFileEntry(state, data.budgetChars, file)) break;
    }
  }
}

function addPriorityDirectories(state: ContextState, data: ContextBuildData, priorityDirs: Set<string>): void {
  for (const dir of data.dirSummaries) {
    if (priorityDirs.has(dir.path) && !state.includedPaths.has(dir.path)) {
      if (!tryAddDirEntry(state, data.budgetChars, dir)) break;
    }
  }
}

/**
 * Tier 3: Fill remaining budget with other summaries (breadth-first)
 */
function processTier3FillRemaining(state: ContextState, data: ContextBuildData): void {
  if (state.currentChars >= data.budgetChars) {
    return;
  }

  // Add remaining directories (shallowest first)
  const sortedDirs = [...data.dirSummaries]
    .filter(d => !state.includedPaths.has(d.path))
    .sort((a, b) => getDepth(a.path) - getDepth(b.path));

  for (const dir of sortedDirs) {
    if (!tryAddDirEntry(state, data.budgetChars, dir)) break;
  }

  // Add remaining files (shallowest first)
  const sortedFiles = [...data.fileSummaries]
    .filter(f => !state.includedPaths.has(f.path))
    .sort((a, b) => getDepth(a.path) - getDepth(b.path));

  for (const file of sortedFiles) {
    if (!tryAddFileEntry(state, data.budgetChars, file)) break;
  }
}

// --- Entry Addition Helpers ---

function tryAddFileEntry(state: ContextState, budgetChars: number, file: FileSummaryRow): boolean {
  const entry = formatFileEntry(file);
  if (state.currentChars + entry.length <= budgetChars) {
    state.context += entry;
    state.currentChars += entry.length;
    state.includedFiles++;
    state.includedPaths.add(file.path);
    return true;
  }
  state.truncated = true;
  return false;
}

function tryAddDirEntry(state: ContextState, budgetChars: number, dir: DirectorySummaryRow): boolean {
  const entry = formatDirEntry(dir);
  if (state.currentChars + entry.length <= budgetChars) {
    state.context += entry;
    state.currentChars += entry.length;
    state.includedDirs++;
    state.includedPaths.add(dir.path);
    return true;
  }
  state.truncated = true;
  return false;
}

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
  const { modelId = 'default', tokenBudget, priorityPaths = [], correlationId, repoName } = options;
  const correlatedLogger = correlationId ? logger.withCorrelation(correlationId) : logger;

  // Calculate token budget - use explicit budget if provided, otherwise calculate from model limits
  let budgetTokens: number;
  if (tokenBudget !== undefined) {
    budgetTokens = tokenBudget;
  } else {
    const maxModelTokens = MODEL_LIMITS[modelId] || MODEL_LIMITS['default'];
    budgetTokens = Math.floor(maxModelTokens * CONTEXT_BUDGET_RATIO / TIKTOKEN_TO_CLAUDE_RATIO);
  }
  const budgetChars = budgetTokens * CHARS_PER_TOKEN;

  correlatedLogger.debug({ modelId, tokenBudget, budgetTokens, budgetChars, repoName }, 'Calculated context budget');

  // Load summaries from database - filter by repo if specified
  let fileSummaries: FileSummaryRow[];
  let dirSummaries: DirectorySummaryRow[];

  if (repoName) {
    const repoPrefix = `${repoName}/`;
    // Filter to only this repo and strip the prefix from paths
    const rawFiles = await db('file_summaries')
      .where('path', 'like', `${repoName}/%`)
      .select('path', 'summary', 'commit_hash') as FileSummaryRow[];
    fileSummaries = rawFiles.map(f => ({
      ...f,
      path: f.path.startsWith(repoPrefix) ? f.path.slice(repoPrefix.length) : f.path
    }));

    const rawDirs = await db('directory_summaries')
      .where('path', 'like', `${repoName}/%`)
      .select('path', 'summary', 'hash') as DirectorySummaryRow[];
    dirSummaries = rawDirs.map(d => ({
      ...d,
      path: d.path.startsWith(repoPrefix) ? d.path.slice(repoPrefix.length) : d.path
    }));
  } else {
    // Load all summaries (legacy behavior)
    fileSummaries = await db('file_summaries').select('path', 'summary', 'commit_hash') as FileSummaryRow[];
    dirSummaries = await db('directory_summaries').select('path', 'summary', 'hash') as DirectorySummaryRow[];
  }

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

  // Initialize state and data for context building
  const state: ContextState = {
    context: '',
    currentChars: 0,
    includedFiles: 0,
    includedDirs: 0,
    truncated: false,
    includedPaths: new Set<string>()
  };

  const data: ContextBuildData = {
    fileSummaries,
    dirSummaries,
    budgetChars,
    priorityPaths
  };

  // Process tiers
  processTier1RootDirs(state, data);
  processTier2PriorityPaths(state, data);
  processTier3FillRemaining(state, data);

  const estimatedTokens = Math.ceil(state.currentChars / CHARS_PER_TOKEN);

  correlatedLogger.info({
    fileSummaryCount: state.includedFiles,
    dirSummaryCount: state.includedDirs,
    totalSummariesAvailable: fileSummaries.length + dirSummaries.length,
    estimatedTokens,
    truncated: state.truncated
  }, 'Built smart context');

  return {
    context: state.context.trim(),
    fileSummaryCount: state.includedFiles,
    dirSummaryCount: state.includedDirs,
    estimatedTokens,
    truncated: state.truncated
  };
}

/**
 * Loads all file summaries from the database.
 */
export async function loadFileSummaries(): Promise<FileSummaryRow[]> {
  return db('file_summaries').select('path', 'branch', 'summary', 'commit_hash');
}

/**
 * Loads all directory summaries from the database.
 */
export async function loadDirectorySummaries(): Promise<DirectorySummaryRow[]> {
  return db('directory_summaries').select('path', 'branch', 'summary', 'hash');
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
