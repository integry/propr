/** The narrative's only dependency on the core LLM surface. */
import { randomUUID } from 'node:crypto';
import { loadSummarizationSettings, resolveConfiguredModel, runLightweightLLMAnalysis } from '@propr/core';
import type { NarrativeModel } from './dashboardNarrative.js';

export const dashboardNarrativeModel: NarrativeModel = async () => {
  const settings = await loadSummarizationSettings();
  const configured = settings.agent_alias?.trim();
  // Never call resolveConfiguredModel with an empty value: it selects the default.
  if (!configured) return null;
  const model = await resolveConfiguredModel(configured);
  return {
    id: model,
    generate: (prompt, repository) => {
      const [repoOwner, repoName] = repository === 'all' ? ['', ''] : repository.split('/');
      return runLightweightLLMAnalysis({
        prompt, model, correlationId: randomUUID(), worktreePath: process.cwd(), githubToken: '',
        issueRef: { repoOwner, repoName, number: 0 },
        executionType: 'summarization', metadata: { source: 'dashboard-narrative', repository },
        timeoutMs: 30_000,
      });
    },
  };
};
