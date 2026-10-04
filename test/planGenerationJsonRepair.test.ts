import assert from 'node:assert/strict';
import { beforeEach, mock, test } from 'node:test';

// These tests cover parsing the model reply; file-based generation has its own tests.
process.env.PROPR_PLAN_GENERATION_MODE = 'response';

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

type RepairCall = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const repairCalls: RepairCall[] = [];
let repairResult: unknown[] | Error = [];
const runPlanFileAgent = mock.fn(async (options: RepairCall) => {
  repairCalls.push(options);
  if (repairResult instanceof Error) throw repairResult;
  return repairResult;
});
class PlanFileAgentUnavailableError extends Error {}
await mock.module('../packages/core/src/services/taskPlanning/planFileAgent.js', {
  namedExports: { runPlanFileAgent, PlanFileAgentUnavailableError },
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

const task = (title: string) => ({ title, body: `${title} body`, implementation: `${title} implementation` });
const generationRoutingSession = { name: 'planner-route' };
const repairRoutingSession = { name: 'default-code-route' };
const generate = () => callLLMForPlan({
  draftId: 'draft-1',
  runId: 'run-1',
  fullContext: 'Generate a plan',
  worktreePath: '/tmp/worktree',
  githubToken: 'token',
  repository: 'owner/repo',
  correlationId: 'plan-correlation',
  tokenLimit: 100_000,
  model: 'antigravity:antigravity-gemini-3.8-flash',
  repairModel: 'codex:gpt-5.3-codex',
  granularity: 'balanced',
  routingSession: generationRoutingSession as never,
  repairRoutingSession: repairRoutingSession as never,
});

beforeEach(() => {
  analysisResponses.length = 0;
  analysisCalls.length = 0;
  tokenValidationCalls.length = 0;
  repairCalls.length = 0;
  repairResult = [];
});

test('a malformed but whole plan is repaired in a workspace by the default coding agent', async () => {
  const planArray = `[{"title":"broken","body":"${'x'.repeat(38_000)}" "implementation":"missing comma"}]`;
  const malformedResponse = `Here is the plan:\n\`\`\`json\n${planArray}\n\`\`\``;
  analysisResponses.push(malformedResponse);
  repairResult = [task('Fixed plan')];

  const result = await generate();

  assert.deepEqual(result.plan, [task('Fixed plan')]);
  assert.equal(analysisCalls.length, 1, 'repair no longer re-sends the whole plan as a prompt');
  assert.equal(analysisCalls[0].model, 'antigravity:antigravity-gemini-3.8-flash');
  assert.equal(analysisCalls[0].routingSession, generationRoutingSession);
  assert.equal(repairCalls.length, 1);
  const repair = repairCalls[0];
  assert.equal(repair.purpose, 'repair');
  assert.equal(repair.model, 'codex:gpt-5.3-codex');
  assert.equal(repair.routingSession, repairRoutingSession);
  assert.equal(repair.executionType, 'plan-generation');
  // The workspace gets the array itself, without the prose and fences around it.
  assert.equal(repair.files['plan.json'], planArray);
  assert.equal(repair.files['original.txt'], planArray);
  assert.equal(repair.original, planArray);
  assert.match(repair.prompt, /node validate-plan\.mjs/);
  assert.match(repair.prompt, /Never reword, summarize/);
  assert.equal(repair.metadata.jsonRepair, true);
  assert.equal(repair.metadata.sourceModel, 'antigravity:antigravity-gemini-3.8-flash');
  assert.equal(repair.metadata.sourceResponseLength, malformedResponse.length);
  assert.equal(repair.correlationId, 'plan-correlation-repair');
});

test('a fragment of a plan is rejected instead of repaired into a partial plan', async () => {
  // The tail of a much longer answer, as when only the last message survived.
  analysisResponses.push('error\\": { \\"code\\": \\"GITHUB_FORBIDDEN\\" } }\n\nAfter editing, run the docs build."}]');

  await assert.rejects(generate(), (error: Error) => {
    assert.equal(error.name, 'PlanningFailedError');
    assert.match(error.message, /response was incomplete/);
    return true;
  });
  assert.equal(repairCalls.length, 0);
});

test('a plan that parses but has incomplete tasks is not saved', async () => {
  analysisResponses.push(JSON.stringify([task('Complete'), { content: 'raw text instead of a task' }]));

  await assert.rejects(generate(), /incomplete tasks \(2 lack a title, body or implementation\)/);
  assert.equal(repairCalls.length, 0);
});

test('a repair that cannot produce a valid plan fails the generation', async () => {
  analysisResponses.push('[{"title":"a","body":"b" "implementation":"c"}]');
  repairResult = new PlanningFailedError('Plan repair did not produce a valid plan: plan.json is not valid JSON');

  await assert.rejects(generate(), /Plan repair did not produce a valid plan/);
});

test('a valid plan is returned without repair', async () => {
  analysisResponses.push(JSON.stringify([task('One'), task('Two')]));

  const result = await generate();

  assert.deepEqual(result.plan, [task('One'), task('Two')]);
  assert.equal(repairCalls.length, 0);
});


test('brackets in strings cannot turn a truncated response into a repairable plan', async () => {
  analysisResponses.push('[{"title":"A","body":"b" "implementation":"Use [x] safely"}, {"title":"B","body":"unfinished');
  await assert.rejects(generate(), /response was incomplete/);
  assert.equal(repairCalls.length, 0);
});

test('a parseable first array cannot conceal trailing task content, even after a fence', async () => {
  const complete = JSON.stringify([task('A')]);
  for (const response of [
    `${complete}, {"title":"B","body":"unfinished`,
    `\`\`\`json\n${complete}\n\`\`\`\n, {"title":"B","body":"unfinished`,
  ]) {
    analysisResponses.push(response);
    await assert.rejects(generate(), /response was incomplete/);
  }
  assert.equal(repairCalls.length, 0);
});

test('repair receives all content containing brackets and literal Unicode escapes', async () => {
  const original = String.raw`[{"title":"A","body":"Match \\u0041" "implementation":"Use [x] safely"}, {"title":"B","body":"b","implementation":"c"}]`;
  analysisResponses.push(original);
  repairResult = JSON.parse(original.replace('" "implementation"', '", "implementation"'));
  await generate();
  assert.equal(repairCalls.length, 1);
  assert.equal(repairCalls[0].original, original);
  assert.equal(repairCalls[0].files['original.txt'], original);
  assert.equal(repairCalls[0].files['plan.json'], original);
});


test('an empty whole array retains the empty-plan diagnostic', async () => {
  analysisResponses.push('[]');
  await assert.rejects(generate(), /Generated plan is empty/);
  assert.equal(repairCalls.length, 0);
});

test('unescaped quotes around a closing bracket reach the repair agent with all content', async () => {
  const original = '[{"title":"A","body":"Use "]" here","implementation":"c"}]';
  analysisResponses.push(original);
  repairResult = [{ title: 'A', body: 'Use "]" here', implementation: 'c' }];

  const result = await generate();

  assert.deepEqual(result.plan, repairResult);
  assert.equal(repairCalls.length, 1);
  assert.equal(repairCalls[0].original, original);
  assert.equal(repairCalls[0].files['original.txt'], original);
  assert.equal(repairCalls[0].files['plan.json'], original);
});
