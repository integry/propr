import { simpleGit } from 'simple-git';
import path from 'path';
import logger from '../../utils/logger.js';

export interface FileReference {
  /** The original reference string from the prompt (e.g., "@tab-top.html") */
  original: string;
  /** The resolved full path in the repo, or null if not found */
  resolvedPath: string | null;
  /** Whether the reference was successfully resolved */
  resolved: boolean;
}

export interface ParseResult {
  /** File references found and resolved */
  references: FileReference[];
  /** The prompt with @references removed (cleaned for keyword extraction) */
  cleanedPrompt: string;
}

/**
 * Regex to match @file references in prompts.
 * Supports:
 * - @filename.ext (e.g., @tab-top.html)
 * - @path/to/file.ext (e.g., @www/templates/tab-top.html)
 * - @partial/path (e.g., @templates/tab-top.html)
 *
 * Does not match:
 * - Email addresses (word@domain)
 * - @mentions without file extensions or paths
 */
const FILE_REFERENCE_REGEX = /@([\w./-]+\.[\w]+|[\w/-]+\/[\w./-]+)/g;

/**
 * Parses a prompt for @file references and resolves them to actual paths in the repo.
 */
export async function parseFileReferences(
  prompt: string,
  repoPath: string,
  options: { correlationId?: string } = {}
): Promise<ParseResult> {
  const { correlationId } = options;
  const correlatedLogger = correlationId ? logger.withCorrelation(correlationId) : logger;

  const references: FileReference[] = [];
  const matches = prompt.matchAll(FILE_REFERENCE_REGEX);

  // Get all files in the repo for matching
  const git = simpleGit(repoPath);
  let allFiles: string[] = [];

  try {
    const result = await git.raw(['ls-files']);
    allFiles = result.split('\n').filter(f => f.trim().length > 0);
  } catch (error) {
    correlatedLogger.warn({ repoPath, error: (error as Error).message }, 'Failed to list files for reference parsing');
    return { references: [], cleanedPrompt: prompt };
  }

  // Create lookup structures for efficient matching
  const fileSet = new Set(allFiles);
  const basenameMap = new Map<string, string[]>();

  for (const filePath of allFiles) {
    const basename = path.basename(filePath).toLowerCase();
    if (!basenameMap.has(basename)) {
      basenameMap.set(basename, []);
    }
    basenameMap.get(basename)!.push(filePath);
  }

  for (const match of matches) {
    const refString = match[1];
    const resolvedPath = resolveFileReference(refString, allFiles, fileSet, basenameMap);

    references.push({
      original: `@${refString}`,
      resolvedPath,
      resolved: resolvedPath !== null
    });
  }

  // Remove @references from prompt for cleaner keyword extraction
  const cleanedPrompt = prompt.replace(FILE_REFERENCE_REGEX, '').replace(/\s+/g, ' ').trim();

  if (references.length > 0) {
    correlatedLogger.info({
      totalReferences: references.length,
      resolved: references.filter(r => r.resolved).length,
      unresolved: references.filter(r => !r.resolved).map(r => r.original)
    }, 'Parsed file references from prompt');
  }

  return { references, cleanedPrompt };
}

/**
 * Resolves a file reference string to an actual path in the repo.
 * Tries multiple matching strategies:
 * 1. Exact path match
 * 2. Suffix match (e.g., "templates/tab-top.html" matches "www/templates/tab-top.html")
 * 3. Basename match (e.g., "tab-top.html" matches any file with that name)
 */
function resolveFileReference(
  reference: string,
  allFiles: string[],
  fileSet: Set<string>,
  basenameMap: Map<string, string[]>
): string | null {
  const lowerRef = reference.toLowerCase();

  // 1. Exact path match
  if (fileSet.has(reference)) {
    return reference;
  }

  // Case-insensitive exact match
  const exactMatch = allFiles.find(f => f.toLowerCase() === lowerRef);
  if (exactMatch) {
    return exactMatch;
  }

  // 2. Suffix match (reference is the end of the path)
  const suffixMatches = allFiles.filter(f =>
    f.toLowerCase().endsWith('/' + lowerRef) || f.toLowerCase() === lowerRef
  );
  if (suffixMatches.length === 1) {
    return suffixMatches[0];
  }
  if (suffixMatches.length > 1) {
    // Prefer shorter paths (more specific match)
    return suffixMatches.sort((a, b) => a.length - b.length)[0];
  }

  // 3. Basename match
  const basename = path.basename(reference).toLowerCase();
  const basenameMatches = basenameMap.get(basename);
  if (basenameMatches) {
    if (basenameMatches.length === 1) {
      return basenameMatches[0];
    }
    // Multiple matches - try to narrow down by directory hints in reference
    const refParts = reference.toLowerCase().split('/');
    if (refParts.length > 1) {
      // Has directory component, try to match
      const dirHint = refParts[refParts.length - 2];
      const dirMatches = basenameMatches.filter(f => f.toLowerCase().includes(dirHint));
      if (dirMatches.length === 1) {
        return dirMatches[0];
      }
      if (dirMatches.length > 1) {
        return dirMatches.sort((a, b) => a.length - b.length)[0];
      }
    }
    // Return first match if we can't narrow down
    return basenameMatches[0];
  }

  // 4. Partial path match anywhere in the file path
  const partialMatches = allFiles.filter(f => f.toLowerCase().includes(lowerRef));
  if (partialMatches.length === 1) {
    return partialMatches[0];
  }
  if (partialMatches.length > 1) {
    // Prefer shorter paths
    return partialMatches.sort((a, b) => a.length - b.length)[0];
  }

  return null;
}

/**
 * Extracts resolved file paths from parse result.
 */
export function getResolvedPaths(result: ParseResult): string[] {
  return result.references
    .filter(r => r.resolved && r.resolvedPath !== null)
    .map(r => r.resolvedPath!);
}
