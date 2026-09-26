import assert from 'node:assert/strict';
import { beforeEach, mock, test } from 'node:test';

type AnalysisCall = {
  prompt: string;
  model: string;
  metadata?: Record<string, unknown>;
  routingSession?: unknown;
};

const analysisResponses: string[] = [];
const analysisCalls: AnalysisCall[] = [];
const tokenValidationCalls: Array<{ prompt: string; model?: string }> = [];

const runLightweightLLMAnalysis = mock.fn(async (options: AnalysisCall) => {
  analysisCalls.push(options);
  const response = analysisResponses.shift();
  if (response === undefined) throw new Error('Unexpected analysis call');
  return response;
});

await mock.module('../packages/core/src/claude/claudeService.js', {
  namedExports: { runLightweightLLMAnalysis },
});

const correlatedLogger = {
  info: mock.fn(),
  warn: mock.fn(),
  error: mock.fn(),
};
await mock.module('../packages/core/src/utils/logger.js', {
  defaultExport: {
    ...correlatedLogger,
    withCorrelation: mock.fn(() => correlatedLogger),
  },
});

await mock.module('../packages/core/src/utils/llmEstimation.js', {
  namedExports: {
    estimateLlmDuration: mock.fn(async () => ({
      estimatedDurationMs: 1,
      isHistoricalEstimate: false,
      sampleCount: 0,
      avgMsPerToken: 0,
    })),
  },
});

class PlanningFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlanningFailedError';
  }
}

await mock.module('../packages/core/src/services/planning/index.js', {
  namedExports: {
    updateTraceForRun: mock.fn(async () => undefined),
    validatePromptTokens: mock.fn(async (prompt: string, _limit: number, _logger: unknown, model?: string) => {
      tokenValidationCalls.push({ prompt, model });
      return { valid: true, tokenCount: Math.ceil(prompt.length / 4), source: 'tiktoken' as const };
    }),
    CLAUDE_CODE_OVERHEAD: 5_000,
    PlanningFailedError,
    getModelHardLimit: mock.fn(() => 200_000),
    getRawInputCharLimit: mock.fn((model?: string) => model?.startsWith('codex:') ? 100_000 : null),
  },
});

const { callLLMForPlan } = await import('../packages/core/src/services/taskPlanning/llmCalling.js');

beforeEach(() => {
  analysisResponses.length = 0;
  analysisCalls.length = 0;
  tokenValidationCalls.length = 0;
});

test('large malformed plans are repaired immediately by the default coding model', async () => {
  const malformedResponse = `[{"title":"broken","body":"${'x'.repeat(38_000)}" "implementation":"missing comma"}]`;
  const repairedResponse = JSON.stringify([{
    title: 'Fixed plan',
    body: 'The repaired body',
    implementation: 'The repaired implementation',
  }]);
  analysisResponses.push(malformedResponse, repairedResponse);

  const generationRoutingSession = { name: 'planner-route' };
  const repairRoutingSession = { name: 'default-code-route' };
  const result = await callLLMForPlan({
    draftId: 'draft-1',
    runId: 'run-1',
    fullContext: 'Generate a plan',
    worktreePath: '/tmp/worktree',
    githubToken: 'token',
    repository: 'owner/repo',
    correlationId: 'plan-correlation',
    tokenLimit: 100_000,
    model: 'antigravity:gemini-3.8-flash-high',
    repairModel: 'codex:gpt-5.3-codex',
    granularity: 'balanced',
    routingSession: generationRoutingSession as never,
    repairRoutingSession: repairRoutingSession as never,
  });

  assert.equal(malformedResponse.length > 20_000, true);
  assert.deepEqual(result.plan, JSON.parse(repairedResponse));
  assert.equal(analysisCalls.length, 2);
  assert.equal(analysisCalls[0].model, 'antigravity:gemini-3.8-flash-high');
  assert.equal(analysisCalls[0].routingSession, generationRoutingSession);
  assert.equal(analysisCalls[1].model, 'codex:gpt-5.3-codex');
  assert.equal(analysisCalls[1].routingSession, repairRoutingSession);
  assert.match(analysisCalls[1].prompt, /Broken JSON:/);
  assert.match(analysisCalls[1].prompt, /missing comma/);
  assert.equal(analysisCalls[1].metadata?.jsonRepair, true);
  assert.equal(analysisCalls[1].metadata?.sourceModel, 'antigravity:gemini-3.8-flash-high');
  assert.equal(analysisCalls[1].metadata?.sourceResponseLength, malformedResponse.length);
  assert.equal(tokenValidationCalls.length, 2);
  assert.equal(tokenValidationCalls[1].model, 'codex:gpt-5.3-codex');
});
