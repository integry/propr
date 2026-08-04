/**
 * Type definitions for context generation services.
 */

import type { Logger } from 'pino';
import type { pack } from 'repomix';

export type RepomixPackConfig = Parameters<typeof pack>[1];

export interface ContextGenerationOptions {
  repoPath: string;
  filesToInclude?: string[];
  priorityFiles?: string[];  // Files to prioritize (include first) when truncating
  /** Token limit from model configuration - required, no default fallback */
  tokenLimit: number;
  correlationId?: string;
  includeFullDirectoryStructure?: boolean;
  compress?: boolean;
  /** Model ID for token ratio calculation (tiktoken is accurate for OpenAI, needs adjustment for Claude/Gemini) */
  modelId?: string;
  /** Base temporary directory under which a service-owned Repomix directory is created. */
  temporaryRoot?: string;
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

export class ContextTokenLimitError extends Error {
  public readonly code = 'CONTEXT_TOKEN_LIMIT_EXCEEDED';
  /** Smallest attempted bundle, measured with Repomix's tiktoken tokenizer. */
  public readonly totalTokens: number;
  /** @deprecated Use requestedTokenLimit; retained for compatibility. */
  public readonly tokenLimit: number;
  /** Model-token limit supplied by the caller. */
  public readonly requestedTokenLimit: number;
  /** Internal tiktoken budget derived from the requested model-token limit. */
  public readonly tiktokenLimit: number;
  public readonly modelId?: string;

  constructor(totalTokens: number, requestedTokenLimit: number, tiktokenLimit: number, modelId?: string) {
    const modelDescription = modelId ? ` for ${modelId}` : '';
    super(
      `Repomix context cannot fit within the requested ${requestedTokenLimit}-token model budget${modelDescription} ` +
      `(internal tiktoken budget: ${tiktokenLimit}; smallest attempted bundle: ${totalTokens} tiktoken tokens)`,
    );
    this.name = 'ContextTokenLimitError';
    this.totalTokens = totalTokens;
    this.tokenLimit = requestedTokenLimit;
    this.requestedTokenLimit = requestedTokenLimit;
    this.tiktokenLimit = tiktokenLimit;
    this.modelId = modelId;
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
  baseConfig: RepomixPackConfig;
  tiktokenLimit: number;
  requestedTokenLimit: number;
  modelId?: string;
  contextLogger: Pick<Logger, 'info' | 'warn'>;
  onSuspiciousFiles?: (files: SuspiciousFile[]) => void;
}
