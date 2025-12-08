import glob from 'fast-glob';
import path from 'path';
import levenshtein from 'fast-levenshtein';
import { PlanItem } from '../claude/prompts/plannerPrompts.js';
import logger from '../utils/logger.js';

const MAX_FILE_COUNT = 50000;

export interface PathValidationOptions {
  correlationId?: string;
}

export class PathValidationService {
  static async validateAndRepair(
    repoPath: string,
    plan: PlanItem[],
    options: PathValidationOptions = {}
  ): Promise<PlanItem[]> {
    const correlatedLogger = options.correlationId
      ? logger.withCorrelation(options.correlationId)
      : logger;

    const allFiles = await glob('**/*', {
      cwd: repoPath,
      dot: true,
      ignore: ['.git/**', 'node_modules/**', '**/node_modules/**'],
      onlyFiles: true,
    });

    if (allFiles.length > MAX_FILE_COUNT) {
      correlatedLogger.warn(
        { fileCount: allFiles.length, max: MAX_FILE_COUNT },
        'Repository too large for path validation, skipping fuzzy matching'
      );
      return plan;
    }

    const fileSet = new Set(allFiles);

    correlatedLogger.info(
      { fileCount: allFiles.length },
      'Indexed repository files for path validation'
    );

    for (const item of plan) {
      if (!item.files || item.files.length === 0) continue;

      const correctedFiles: string[] = [];

      for (const filePath of item.files) {
        const normalizedPath = filePath.startsWith('/') ? filePath.slice(1) : filePath;

        if (fileSet.has(normalizedPath)) {
          correctedFiles.push(normalizedPath);
          continue;
        }

        if (item.type === 'new') {
          correctedFiles.push(normalizedPath);
          continue;
        }

        const bestMatch = this.findBestMatch(normalizedPath, allFiles);

        if (bestMatch) {
          correlatedLogger.info(
            { original: filePath, corrected: bestMatch },
            'Auto-corrected file path'
          );
          correctedFiles.push(bestMatch);
          item.body += `\n\n*(Note: Auto-corrected file path from '${filePath}' to '${bestMatch}')*`;
        } else {
          correctedFiles.push(normalizedPath);
          item.body += `\n\n*(Warning: File '${filePath}' not found in repository)*`;
          correlatedLogger.warn({ filePath }, 'File not found in repository');
        }
      }

      item.files = correctedFiles;
    }

    return plan;
  }

  private static findBestMatch(target: string, candidates: string[]): string | null {
    const ext = path.extname(target);
    const sameExtCandidates = ext
      ? candidates.filter((c) => path.extname(c) === ext)
      : candidates;

    let bestDist = Infinity;
    let bestCandidate: string | null = null;

    const pool = sameExtCandidates.length > 0 ? sameExtCandidates : candidates;

    for (const candidate of pool) {
      const dist = levenshtein.get(target, candidate);

      if (dist < bestDist) {
        bestDist = dist;
        bestCandidate = candidate;
      }
    }

    const maxAllowed = Math.max(3, Math.floor(target.length * 0.2));
    if (bestDist <= maxAllowed) {
      return bestCandidate;
    }

    return null;
  }
}
