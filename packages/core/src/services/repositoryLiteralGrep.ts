/**
 * Streamed `git grep` aggregation for literal repository search.
 */

import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { DISABLED_GIT_HOOKS_PATH } from '../git/hooklessGit.js';
import type { RepositoryLineMatch } from './repositoryRetrievalTypes.js';

const MAX_LINE_MATCH_TEXT_LENGTH = 500;

export interface GrepFileMatch {
  path: string;
  matchCount: number;
  lineMatches: RepositoryLineMatch[];
  /** The scan stopped inside this file, so `matchCount` is a lower bound. */
  countTruncated?: boolean;
}

/**
 * Hard budget for one literal search. A short query in a large repository can
 * match millions of lines, so `git grep` output is streamed and aggregated
 * (complete counts, bounded previews) and the scan stops once either bound is
 * reached, reporting `scanTruncated`. A file the scan stopped inside keeps its
 * partial count flagged as `countTruncated`.
 */
export const MAX_GREP_MATCHED_FILES = 10_000;
const MAX_GREP_OUTPUT_BYTES = 64 * 1024 * 1024;

/**
 * Incrementally parses `git grep -n -z <commit>` output. Each record looks
 * like `<commit>:<path>\0<line>\0<text>\n`. The path and line number are read
 * up to their NUL delimiters before the text is read up to its newline, so
 * paths containing ':' or newlines stay intact. Only complete records are
 * consumed; a partial record waits for the next chunk.
 */
export class GrepAggregator {
  private readonly files = new Map<string, GrepFileMatch>();
  private buffer = '';
  private readonly commitPrefix: string;
  /** Path of the last parsed record, retained or not; git grep emits each file's matches contiguously. */
  private lastPath: string | null = null;
  /** Set once a new file would exceed `maxFiles`; later records are ignored. */
  full = false;

  constructor(
    commit: string,
    private readonly maxLineMatchesPerFile: number,
    private readonly maxFiles = Number.POSITIVE_INFINITY,
    private readonly include: (filePath: string) => boolean = () => true,
  ) {
    this.commitPrefix = `${commit}:`;
  }

  push(chunk: string): void {
    this.buffer += chunk;
    this.drain(false);
  }

  /**
   * Consumes any buffered record and returns the aggregated files. When the
   * scan was stopped early, the file its last record belonged to may have had
   * more matches, so a retained entry for it is flagged `countTruncated`.
   * Every earlier file was followed by another file's record and is complete.
   */
  finish(scanTruncated = false): GrepFileMatch[] {
    this.drain(true);
    const last = scanTruncated && this.lastPath !== null ? this.files.get(this.lastPath) : undefined;
    if (last) last.countTruncated = true;
    return Array.from(this.files.values());
  }

  private drain(final: boolean): void {
    const output = this.buffer;
    let position = 0;
    while (position < output.length && !this.full) {
      const firstNul = output.indexOf('\0', position);
      const secondNul = firstNul === -1 ? -1 : output.indexOf('\0', firstNul + 1);
      if (secondNul === -1) break;
      const newline = output.indexOf('\n', secondNul + 1);
      if (newline === -1 && !final) break;
      const textEnd = newline === -1 ? output.length : newline;

      let filePath = output.slice(position, firstNul);
      const lineNumber = Number.parseInt(output.slice(firstNul + 1, secondNul), 10);
      const text = output.slice(secondNul + 1, textEnd);
      position = textEnd + 1;

      if (filePath.startsWith(this.commitPrefix)) filePath = filePath.slice(this.commitPrefix.length);
      this.lastPath = filePath;
      if (!filePath || !Number.isFinite(lineNumber) || !this.include(filePath)) continue;
      this.record(filePath, lineNumber, text);
    }
    this.buffer = this.full ? '' : output.slice(Math.min(position, output.length));
  }

  private record(filePath: string, lineNumber: number, text: string): void {
    let entry = this.files.get(filePath);
    if (!entry) {
      if (this.files.size >= this.maxFiles) {
        this.full = true;
        return;
      }
      entry = { path: filePath, matchCount: 0, lineMatches: [] };
      this.files.set(filePath, entry);
    }
    entry.matchCount += 1;
    if (entry.lineMatches.length < this.maxLineMatchesPerFile) {
      entry.lineMatches.push({
        lineNumber,
        text: text.length > MAX_LINE_MATCH_TEXT_LENGTH ? `${text.slice(0, MAX_LINE_MATCH_TEXT_LENGTH)}…` : text,
      });
    }
  }
}

/** Parses complete `git grep -n -z <commit>` output; see {@link GrepAggregator}. */
export function parseGitGrepOutput(output: string, commit: string, maxLineMatchesPerFile: number): GrepFileMatch[] {
  const aggregator = new GrepAggregator(commit, maxLineMatchesPerFile);
  aggregator.push(output);
  return aggregator.finish();
}

/**
 * Streams `git <args>` into the aggregator, stopping the process once the
 * output budget or the aggregator's file budget is exhausted. Exit code 1 is
 * `git grep`'s "no matches".
 */
export function streamGitGrep(
  repoPath: string,
  args: string[],
  aggregator: GrepAggregator,
  maxOutputBytes = MAX_GREP_OUTPUT_BYTES,
): Promise<{ scanTruncated: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-c', `core.hooksPath=${DISABLED_GIT_HOOKS_PATH}`, ...args], { cwd: repoPath, stdio: ['ignore', 'pipe', 'pipe'] });
    const decoder = new StringDecoder('utf8');
    let bytes = 0;
    let scanTruncated = false;
    let stderr = '';
    const stop = () => {
      if (scanTruncated) return;
      scanTruncated = true;
      child.kill();
    };
    child.stdout.on('data', (chunk: Buffer) => {
      if (scanTruncated) return;
      bytes += chunk.length;
      aggregator.push(decoder.write(chunk));
      if (aggregator.full || bytes >= maxOutputBytes) stop();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 4096) stderr += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', code => {
      if (scanTruncated || code === 0 || code === 1) {
        if (!scanTruncated) aggregator.push(decoder.end());
        resolve({ scanTruncated });
        return;
      }
      reject(new Error(stderr.trim() || `git grep exited with code ${code}`));
    });
  });
}
