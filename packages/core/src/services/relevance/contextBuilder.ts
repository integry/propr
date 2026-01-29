import { db } from '../../db/connection.js';

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

// --- Database Loaders ---

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
