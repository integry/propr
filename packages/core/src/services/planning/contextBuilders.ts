/**
 * Context building utilities for the planning service.
 */

import { GRANULARITY_INSTRUCTIONS, PLANNER_SYSTEM_PROMPT } from '../../claude/prompts/plannerPrompts.js';
import { MODEL_INFO_MAP } from '../../config/modelDefinitions.js';
import type { Granularity, Base64Image, SmartFileSelection } from './planningTypes.js';

interface BuildFullContextOptions {
  userRequest: string;
  repomixContext: string;
  granularity: Granularity;
  fileSummaries?: string;
  /** Smart context with directory and file summaries (tiered by relevance) */
  smartSummaries?: string;
  images?: Base64Image[];
  /** Context from additional repositories (marked as example/reference only) */
  additionalContext?: string;
}

/**
 * Get a final reminder string based on granularity to reinforce task count constraints
 */
function getGranularityReminder(granularity: Granularity): string {
  switch (granularity) {
    case 'single':
      return `FINAL REMINDER — SINGLE TASK MODE:
⚠️ You MUST return a JSON array with EXACTLY 1 element.
⚠️ Do NOT create multiple tasks. Combine everything into ONE comprehensive task.
⚠️ Array length must equal 1. This is mandatory.`;
    case 'balanced':
      return `REMINDER: Aim for 2-4 tasks total. Group related changes together.`;
    case 'granular':
      return `REMINDER: Create fine-grained tasks (5+ if needed). Each task should be small and focused.`;
  }
}

/**
 * Build the full context XML document for plan generation.
 */
export function buildFullContext(options: BuildFullContextOptions): string {
  const { userRequest, repomixContext, granularity, fileSummaries, smartSummaries, images, additionalContext } = options;
  const granularitySpec = GRANULARITY_INSTRUCTIONS[granularity];
  const granularityReminder = getGranularityReminder(granularity);
  const summariesSection = fileSummaries && fileSummaries.trim().length > 0
    ? `\n  <relevant-file-summaries>\n${fileSummaries}\n  </relevant-file-summaries>` : '';

  // Build smart summaries section (directory structure and file summaries)
  const smartSummariesSection = smartSummaries && smartSummaries.trim().length > 0
    ? `\n  <codebase-overview>\n${smartSummaries}\n  </codebase-overview>` : '';

  // Build images section if images are provided
  let imagesSection = '';
  if (images && images.length > 0) {
    const imageEntries = images.map(img =>
      `    <image name="${img.name}" type="${img.mimeType}"><![CDATA[data:${img.mimeType};base64,${img.base64Data}]]></image>`
    ).join('\n');
    imagesSection = `\n  <attachments>\n${imageEntries}\n  </attachments>`;
  }

  // Build additional context section if provided (from context repositories)
  let additionalContextSection = '';
  if (additionalContext && additionalContext.trim().length > 0) {
    additionalContextSection = `
  <example-context>
<![CDATA[
=== REFERENCE MATERIAL ONLY - DO NOT IMPLEMENT IN THESE LOCATIONS ===
The following content is provided as examples and documentation reference.
Do NOT create or modify files based on paths shown here.
All implementation must be done in the target repository only.

${additionalContext}

=== END REFERENCE MATERIAL ===
]]>
  </example-context>`;
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<llm-context>
  <system-prompt><![CDATA[${PLANNER_SYSTEM_PROMPT}]]></system-prompt>
  <user-request><![CDATA[${userRequest}]]></user-request>${imagesSection}
  <granularity-spec><![CDATA[${granularitySpec}]]></granularity-spec>${smartSummariesSection}
  <repository-context>
${repomixContext}
  </repository-context>${summariesSection}${additionalContextSection}
  <output-guidelines><![CDATA[Output ONLY a valid JSON array. No markdown, no explanations.]]></output-guidelines>
  <granularity-reminder><![CDATA[${granularityReminder}]]></granularity-reminder>
</llm-context>`;
}

/**
 * Build smart file selection list from manual and auto-detected files.
 */
export function buildSmartSelection(
  manualFiles: string[],
  autoFilePaths: string[],
  includedFilesSet: Set<string>,
  fileScores: Record<string, number>
): SmartFileSelection[] {
  const manualSet = new Set(manualFiles);
  const autoSet = new Set(autoFilePaths);

  const result: SmartFileSelection[] = [
    // Manual files that are included
    ...manualFiles.filter(p => includedFilesSet.has(p)).map(p => ({
      path: p,
      reason: 'Explicitly included',
      source: 'manual' as const,
      score: fileScores[p] ?? 100  // Manual files get 100 if no score
    })),
    // Auto-detected files that are included (excluding manual)
    ...autoFilePaths.filter(p => includedFilesSet.has(p) && !manualSet.has(p)).map(p => ({
      path: p,
      reason: 'Auto-detected',
      source: 'auto' as const,
      score: fileScores[p] ?? 0
    })),
    // Files that were included in context but not in manual or auto lists
    // This handles compress mode or fallback scenarios where all files are included
    ...Array.from(includedFilesSet)
      .filter(p => !manualSet.has(p) && !autoSet.has(p))
      .map(p => ({
        path: p,
        reason: 'Included for context',
        source: 'auto' as const,
        score: fileScores[p] ?? 0
      }))
  ];

  // Sort by score descending so most relevant files appear first
  return result.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
}

/**
 * Get model display info from model ID
 */
export function getModelDisplayInfo(generationModel: string | undefined): { modelName?: string; modelMaxContextTokens?: number } {
  if (!generationModel) return {};
  const effectiveModelId = generationModel.includes(':') ? generationModel.split(':')[1] : generationModel;
  const modelInfo = MODEL_INFO_MAP[effectiveModelId];
  if (!modelInfo) return {};
  return { modelName: modelInfo.name, modelMaxContextTokens: modelInfo.maxTokens };
}
