/**
 * Type definitions for context generation services.
 */

export interface ContextGenerationOptions {
  repoPath: string;
  filesToInclude?: string[];
  priorityFiles?: string[];  // Files to prioritize (include first) when truncating
  /** Token limit from model configuration - required, no default fallback */
  tokenLimit: number;
  correlationId?: string;
  includeFullDirectoryStructure?: boolean;
  compress?: boolean;
}

export interface ContextGenerationResult {
  context: string;
  totalFiles: number;
  totalCharacters: number;
  totalTokens: number;
  fileCharCounts: Record<string, number>;
  fileTokenCounts: Record<string, number>;
  includedFiles: string[];
  /** Files skipped due to security concerns (potential secrets) */
  skippedSecurityFiles?: SuspiciousFile[];
}

export interface SuspiciousFile {
  filePath: string;
  messages: string[];
}

export class SecurityException extends Error {
  public readonly suspiciousFiles: SuspiciousFile[];

  constructor(message: string, suspiciousFiles: SuspiciousFile[]) {
    super(message);
    this.name = 'SecurityException';
    this.suspiciousFiles = suspiciousFiles;
  }
}

export interface DroppedFile {
  path: string;
  tokens: number;
  reason: string;
}

export interface FileSelectionResult {
  selectedFiles: string[];
  droppedFiles: DroppedFile[];
  currentTokens: number;
  strategy: 'relevance-order' | 'size-order' | 'priority-then-size';
}

export interface GenerateOptimizedContextOptions {
  repoPath: string;
  initialFiles: string[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  baseConfig: any;
  tiktokenLimit: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  contextLogger: any;
  writeOutput: (output: string) => Promise<undefined>;
  noopClipboard: () => Promise<void>;
}
