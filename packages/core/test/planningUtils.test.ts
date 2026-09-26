import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

const findRelevantFiles = mock.fn(async (_worktreePath: string, _prompt: string, options: { branch?: string }) => {
  void options;
  return { files: [{ path: 'src/example.ts', score: 90, reason: 'test' }] };
});

await mock.module('../src/services/relevanceService.js', {
  namedExports: { findRelevantFiles },
});

await mock.module('../src/agents/AgentRegistry.js', {
  namedExports: {
    AgentRegistry: class {
      static getInstance() {
        return {};
      }
    },
    getAgentRegistry: () => ({
      ensureInitialized: async () => {},
      getDefaultAgent: () => ({ config: { defaultModel: 'test-model' } }),
      getAgentByAlias: () => undefined,
    }),
  },
});

await mock.module('../src/services/relevance/fileReferenceParser.js', {
  namedExports: {
    parseFileReferences: async () => ({ cleanedPrompt: 'find the example file', references: [] }),
    getResolvedPaths: () => [],
  },
});

await mock.module('../src/utils/logger.js', {
  defaultExport: {
    info: () => {},
    warn: () => {},
    error: () => {},
    withCorrelation: () => ({ info: () => {}, warn: () => {}, error: () => {} }),
  },
});

const { findFilesForPlan } = await import('../src/services/planning/planningUtils.js');

test('passes the configured branch to relevance scoring', async () => {
  await findFilesForPlan({
    draftId: 'draft-1',
    worktreePath: '/tmp/worktree',
    draft: { initial_prompt: 'find the example file', repository: 'owner/repo' },
    manualFiles: [],
    autoFiles: [],
    branch: 'main',
  });

  assert.equal(findRelevantFiles.mock.calls[0]?.arguments[2]?.branch, 'main');
});
