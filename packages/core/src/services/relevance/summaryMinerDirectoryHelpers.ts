import path from 'path';

export interface DirectoryInfo {
  dirPath: string;
  childFiles: Array<{ path: string; summary: string }>;
  childDirs: Array<{ path: string; summary: string }>;
  newHash: string;
}

export interface DirectoryResult {
  dirPath: string;
  summary: string | null;
}

export function normalizeSummaryPath(pathValue: string): string {
  return pathValue
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\/home\/node\/workspace\//, '')
    .replace(/^\/workspace\//, '')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
}

export function resolveExpectedSummaryPath(pathValue: string, expectedPaths: string[]): string | null {
  const normalizedPath = normalizeSummaryPath(pathValue);
  const normalizedExpected = expectedPaths.map(expectedPath => ({
    original: expectedPath,
    normalized: normalizeSummaryPath(expectedPath)
  }));

  const exact = normalizedExpected.find(expected => expected.normalized === normalizedPath);
  if (exact) return exact.original;

  const suffixMatches = normalizedExpected.filter(expected =>
    normalizedPath.endsWith(`/${expected.normalized}`)
  );
  return suffixMatches.length === 1 ? suffixMatches[0].original : null;
}

export function groupDirectoriesByDepth(directories: string[]): Map<number, string[]> {
  const byDepth = new Map<number, string[]>();
  for (const dir of directories) {
    const depth = dir.split('/').length;
    const existing = byDepth.get(depth) || [];
    existing.push(dir);
    byDepth.set(depth, existing);
  }
  return byDepth;
}

export function extractDirectories(filePaths: string[]): string[] {
  const dirs = new Set<string>();
  for (const filePath of filePaths) {
    const parts = filePath.split('/');
    let currentPath = '';
    for (let i = 0; i < parts.length - 1; i++) {
      currentPath = currentPath ? `${currentPath}/${parts[i]}` : parts[i];
      dirs.add(currentPath);
    }
  }
  return Array.from(dirs);
}

export function extractRepositoryDirectories(filePaths: string[], fullName: string): string[] {
  const repositoryPrefix = `${fullName}/`;
  return extractDirectories(filePaths).filter(dirPath =>
    dirPath === fullName || dirPath.startsWith(repositoryPrefix)
  );
}

export function createDirectoryBatches(directories: DirectoryInfo[], maxBatchTokens: number, maxDirsPerBatch: number, charsPerTokenEstimate: number): DirectoryInfo[][] {
  const batches: DirectoryInfo[][] = [];
  let currentBatch: DirectoryInfo[] = [];
  let currentTokens = 0;

  for (const dir of directories) {
    const promptText = buildSingleDirectoryPromptText(dir);
    const estimatedTokens = Math.ceil(promptText.length / charsPerTokenEstimate);

    if (estimatedTokens > maxBatchTokens) {
      if (currentBatch.length > 0) {
        batches.push(currentBatch);
        currentBatch = [];
        currentTokens = 0;
      }
      batches.push([dir]);
      continue;
    }

    if ((currentTokens + estimatedTokens > maxBatchTokens || currentBatch.length >= maxDirsPerBatch) && currentBatch.length > 0) {
      batches.push(currentBatch);
      currentBatch = [];
      currentTokens = 0;
    }

    currentBatch.push(dir);
    currentTokens += estimatedTokens;
  }

  if (currentBatch.length > 0) {
    batches.push(currentBatch);
  }

  return batches;
}

export function buildSingleDirectoryPromptText(dir: DirectoryInfo): string {
  const filesSection = dir.childFiles.length > 0
    ? `Files:\n${dir.childFiles.map(f => `- ${path.basename(f.path)}: ${f.summary}`).join('\n')}`
    : '';
  const dirsSection = dir.childDirs.length > 0
    ? `Subdirectories:\n${dir.childDirs.map(d => `- ${path.basename(d.path)}/: ${d.summary}`).join('\n')}`
    : '';
  return `Directory: "${dir.dirPath}"\n${filesSection}\n${dirsSection}`;
}

export function buildBatchDirectoryPrompt(directories: DirectoryInfo[]): string {
  const directorySections = directories.map(dir => {
    const filesSection = dir.childFiles.length > 0
      ? `  Files:\n${dir.childFiles.map(f => `    - ${path.basename(f.path)}: ${f.summary}`).join('\n')}`
      : '';
    const dirsSection = dir.childDirs.length > 0
      ? `  Subdirectories:\n${dir.childDirs.map(d => `    - ${path.basename(d.path)}/: ${d.summary}`).join('\n')}`
      : '';
    return `--- DIRECTORY: ${dir.dirPath} ---
${filesSection}
${dirsSection}
--- END DIRECTORY ---`;
  }).join('\n\n');

  return `You are a code expert. Analyze the following directories and provide a summary for each.
For each directory, provide a brief (2-4 sentences) summary of what it contains and its role in the codebase.

Return ONLY valid JSON in this exact format:
{
  "summaries": [
    { "path": "full/directory/path", "summary": "This directory contains... It provides... It is responsible for..." }
  ]
}

Important:
- Include ALL directories listed below in your response
- Each summary should be 2-4 sentences with specific details
- Focus on the directory's purpose and how it fits into the system
- Return valid JSON only, no markdown or other formatting

DIRECTORIES:
${directorySections}`;
}

export function parseBatchDirectoryResponse(response: string, expectedPaths: string[]): DirectoryResult[] {
  const results: DirectoryResult[] = expectedPaths.map(p => ({ dirPath: p, summary: null }));

  try {
    const jsonPayload = extractDirectorySummaryJson(response);
    if (!jsonPayload) {
      const singleSummary = parseSingleDirectoryFallback(response, expectedPaths);
      if (singleSummary) results[0].summary = singleSummary;
      return results;
    }

    const parsed = JSON.parse(jsonPayload);
    const summaries = normalizeDirectorySummaryEntries(parsed);
    if (summaries.length === 0) return results;

    const summaryMap = new Map<string, string>();
    for (const s of summaries) {
      if (s.summary.trim().length > 0) {
        const expectedPath = s.path ? resolveExpectedSummaryPath(s.path, expectedPaths) : (expectedPaths.length === 1 ? expectedPaths[0] : null);
        if (expectedPath) summaryMap.set(expectedPath, cleanSummaryText(s.summary));
      }
    }

    for (const result of results) {
      const summary = summaryMap.get(result.dirPath);
      if (summary) result.summary = summary;
    }
  } catch {
    // Parse failed, return null summaries
  }

  return results;
}

function extractDirectorySummaryJson(response: string): string | null {
  const cleaned = cleanSummaryText(response);
  if (/^\s*[[{]/.test(cleaned)) return cleaned;

  const objectMatch = cleaned.match(/\{[\s\S]*(?:"summaries"|"directory_summaries"|"directories"|"results"|"summary")[\s\S]*\}/);
  if (objectMatch) return objectMatch[0];

  const arrayMatch = cleaned.match(/\[[\s\S]*"summary"[\s\S]*\]/);
  return arrayMatch ? arrayMatch[0] : null;
}

function normalizeDirectorySummaryEntries(parsed: unknown): Array<{ path?: string; summary: string }> {
  if (Array.isArray(parsed)) return parsed.flatMap(normalizeDirectorySummaryEntry);
  if (!parsed || typeof parsed !== 'object') return [];

  const record = parsed as Record<string, unknown>;
  const entries = record.summaries ?? record.directory_summaries ?? record.directories ?? record.results;
  if (Array.isArray(entries)) return entries.flatMap(normalizeDirectorySummaryEntry);

  return normalizeDirectorySummaryEntry(record);
}

function normalizeDirectorySummaryEntry(entry: unknown): Array<{ path?: string; summary: string }> {
  if (!entry || typeof entry !== 'object') return [];
  const record = entry as Record<string, unknown>;
  const summary = record.summary ?? record.description ?? record.content;
  if (typeof summary !== 'string') return [];
  const pathValue = record.path ?? record.dirPath ?? record.directory ?? record.dir;
  return [{
    path: typeof pathValue === 'string' ? pathValue : undefined,
    summary
  }];
}

function parseSingleDirectoryFallback(response: string, expectedPaths: string[]): string | null {
  if (expectedPaths.length !== 1) return null;
  const summary = cleanSummaryText(response);
  if (summary.length < 20) return null;
  if (/^\s*[[{]/.test(summary)) return null;
  return summary;
}

function cleanSummaryText(value: string): string {
  return value
    .trim()
    .replace(/^```(?:json|markdown|md|text)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}
