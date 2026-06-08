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
    const jsonMatch = response.match(/\{[\s\S]*"summaries"[\s\S]*\}/);
    if (!jsonMatch) return results;

    const parsed = JSON.parse(jsonMatch[0]) as { summaries: Array<{ path: string; summary: string }> };
    if (!parsed.summaries || !Array.isArray(parsed.summaries)) return results;

    const summaryMap = new Map<string, string>();
    for (const s of parsed.summaries) {
      if (typeof s.path === 'string' && typeof s.summary === 'string' && s.summary.trim().length > 0) {
        summaryMap.set(s.path.trim(), s.summary.trim());
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
