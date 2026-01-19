import { GRANULARITY_INSTRUCTIONS, PLANNER_SYSTEM_PROMPT } from '../claude/prompts/plannerPrompts.js';

export type Granularity = 'single' | 'balanced' | 'granular';

export interface Base64Image {
  name: string;
  mimeType: string;
  base64Data: string;
}

interface BuildFullContextOptions {
  userRequest: string;
  repomixContext: string;
  granularity: Granularity;
  fileSummaries?: string;
  images?: Base64Image[];
}

export function buildFullContext(options: BuildFullContextOptions): string {
  const { userRequest, repomixContext, granularity, fileSummaries, images } = options;
  const granularitySpec = GRANULARITY_INSTRUCTIONS[granularity];
  const summariesSection = fileSummaries && fileSummaries.trim().length > 0
    ? `\n  <relevant-file-summaries>\n${fileSummaries}\n  </relevant-file-summaries>` : '';

  // Build images section if images are provided
  let imagesSection = '';
  if (images && images.length > 0) {
    const imageEntries = images.map(img =>
      `    <image name="${img.name}" type="${img.mimeType}"><![CDATA[data:${img.mimeType};base64,${img.base64Data}]]></image>`
    ).join('\n');
    imagesSection = `\n  <attachments>\n${imageEntries}\n  </attachments>`;
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<llm-context>
  <system-prompt><![CDATA[${PLANNER_SYSTEM_PROMPT}]]></system-prompt>
  <user-request><![CDATA[${userRequest}]]></user-request>${imagesSection}
  <granularity-spec><![CDATA[${granularitySpec}]]></granularity-spec>
  <repository-context>
${repomixContext}
  </repository-context>${summariesSection}
  <output-guidelines><![CDATA[Output ONLY a valid JSON array. No markdown, no explanations.]]></output-guidelines>
</llm-context>`;
}
