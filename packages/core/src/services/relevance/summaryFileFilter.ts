import fs from 'fs';
import path from 'path';
import { simpleGit } from 'simple-git';
import type { Logger } from 'pino';
export const MAX_SUMMARIZABLE_FILE_SIZE_BYTES = 100 * 1024;
const TEXT_SAMPLE_BYTES = 8192;
const MAX_REPLACEMENT_CHAR_RATIO = 0.05;

export interface GitFileInfo {
  path: string;
  blobHash: string;
}

const EXCLUDED_PATHS = [
  'node_modules/',
  'vendor/',
  'dist/',
  'build/',
  '.git/',
  '__pycache__/',
  '.next/',
  '.nuxt/',
  'coverage/',
  '.cache/',
  'target/',
  'bin/',
  'obj/'
];

export function shouldProcessFilePath(filePath: string): boolean {
  for (const excluded of EXCLUDED_PATHS) {
    if (filePath.includes(excluded)) {
      return false;
    }
  }

  return true;
}

export function isSummarizableFileSize(sizeBytes: number): boolean {
  return sizeBytes <= MAX_SUMMARIZABLE_FILE_SIZE_BYTES;
}

export function isTextLikeBuffer(buffer: Buffer): boolean {
  if (buffer.includes(0)) return false;

  const decoded = buffer.toString('utf8');
  if (decoded.length === 0) return true;

  const replacementChars = decoded.match(/\uFFFD/g)?.length || 0;
  return replacementChars / decoded.length <= MAX_REPLACEMENT_CHAR_RATIO;
}

export function isProcessableFile(repoPath: string, filePath: string): boolean {
  if (!shouldProcessFilePath(filePath)) return false;

  try {
    const absolutePath = path.join(repoPath, filePath);
    const stats = fs.statSync(absolutePath);
    if (!stats.isFile() || !isSummarizableFileSize(stats.size)) {
      return false;
    }

    const fd = fs.openSync(absolutePath, 'r');
    try {
      const sampleSize = Math.min(stats.size, TEXT_SAMPLE_BYTES);
      const sample = Buffer.alloc(sampleSize);
      fs.readSync(fd, sample, 0, sampleSize, 0);
      return isTextLikeBuffer(sample);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

export async function scanGitFiles(repoPath: string, log: Logger): Promise<GitFileInfo[]> {
  const git = simpleGit(repoPath);

  try {
    const output = await git.raw(['-c', 'safe.directory=*', 'ls-files', '--stage']);

    if (!output.trim()) {
      return [];
    }

    const files: GitFileInfo[] = [];

    for (const line of output.split('\n')) {
      if (!line.trim()) continue;

      const match = line.match(/^\d+\s+([a-f0-9]+)\s+\d+\t(.+)$/);
      if (!match) continue;

      const [, blobHash, filePath] = match;

      files.push({
        path: filePath,
        blobHash
      });
    }

    return files;
  } catch (error) {
    log.error({ error: (error as Error).message }, 'Failed to scan git files');
    return [];
  }
}

export async function scanProcessableGitFiles(repoPath: string, log: Logger): Promise<GitFileInfo[]> {
  const gitFiles = await scanGitFiles(repoPath, log);
  return gitFiles.filter(file => isProcessableFile(repoPath, file.path));
}
