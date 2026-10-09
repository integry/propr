import { area } from '../lib/world';
import { REPOS, minutesAgo, hoursAgo, daysAgo } from './base';

/**
 * Goals at Northwind: one direct goal mid-run with checkpoints, a correction and
 * a draft PR; one orchestrating goal driving issues; one waiting on a question;
 * one paused; one finished. Shapes follow `src/api/goals.ts` (Goal) and the
 * goal e2e specs.
 */

const goalCapabilities = [
  {
    agentId: 'claude', agentAlias: 'claude', agentType: 'claude', goalCapable: true,
    lifecycle: { launch: 'native-goal', resume: 'native-goal', runningInput: 'live-steer' },
    controls: { liveInput: true, inputAtBoundary: true, modelAtBoundary: true, pauseAtBoundary: true },
    models: ['claude-opus-5-5', 'claude-sonnet-5-5'], defaultModel: 'claude-opus-5-5', objectiveMaxCharacters: null,
  },
  {
    agentId: 'codex', agentAlias: 'codex', agentType: 'codex', goalCapable: true,
    lifecycle: { launch: 'native-goal', resume: 'native-goal', runningInput: 'live-steer' },
    controls: { liveInput: true, inputAtBoundary: true, modelAtBoundary: true, pauseAtBoundary: true },
    models: ['gpt-6-astra', 'gpt-5.6-sol'], defaultModel: 'gpt-6-astra', objectiveMaxCharacters: null,
  },
];

/** The catalog with the real field names (`name` for repositories) and current model ids. */
export const goalsCatalog = {
  agents: [
    { id: 'claude', kind: 'direct', alias: 'claude', type: 'claude', enabled: true, supportedModels: ['claude-opus-5-5', 'claude-sonnet-5-5'], defaultModel: 'claude-opus-5-5' },
    { id: 'codex', kind: 'direct', alias: 'codex', type: 'codex', enabled: true, supportedModels: ['gpt-6-astra', 'gpt-5.6-sol'], defaultModel: 'gpt-6-astra' },
  ],
  repositories: Object.values(REPOS).map(name => ({ name, enabled: true, baseBranch: 'main' })),
  defaultAgentAlias: 'claude',
};

const goalBase = {
  owner: 'maya-ortiz', attachments: [], baseBranch: 'main', worktreePath: null,
  maxParallelTasks: null, ultrafix: false, desiredState: 'running', resultState: null,
  failureReason: null, pausePending: false,
  control: { requestGeneration: 0, acknowledgedGeneration: 0, pending: false },
  conversationId: null, finalPr: null, checkpoint: null, artifacts: [], inputs: [],
  artifactStats: { issues: 0, openIssues: 0, pullRequests: 0, openPullRequests: 0 },
  taskState: 'claude_execution', pausedAt: null, completedAt: null, pausedMs: 0,
};

const checkoutTodos = [
  { id: 't1', content: 'Map every call to the legacy PaymentsClient', status: 'completed' },
  { id: 't2', content: 'Swap card capture to the Payments SDK with idempotency keys', status: 'completed' },
  { id: 't3', content: 'Move refunds and partial captures to the SDK', status: 'in_progress' },
  { id: 't4', content: 'Delete the legacy client and its feature flag', status: 'pending' },
  { id: 't5', content: 'Run checkout e2e against the sandbox and publish previews', status: 'pending' },
] as const;

/** Direct goal, mid-run: the one most shots open. */
export const CHECKOUT_GOAL = {
  ...goalBase,
  id: 'goal-checkout-sdk', repository: REPOS.web,
  title: 'Move checkout to the Payments SDK',
  objective: 'Replace the legacy PaymentsClient in checkout with the Payments SDK: card capture, refunds and partial captures. Keep the public checkout API unchanged, cover the new paths with tests, and remove the legacy client when nothing calls it.',
  launchStrategy: 'direct', initialPrompt: '/goal Move checkout to the Payments SDK. Keep the public checkout API unchanged and remove the legacy client when nothing calls it.',
  branchName: 'goal/checkout-payments-sdk',
  agent: { id: 'claude', alias: 'claude', type: 'claude' },
  requestedModel: 'claude-opus-5-5', effectiveModel: 'claude-opus-5-5',
  taskId: 'task-goal-checkout', sessionId: 'c7f2a9e4-1b3d-4e8a-9f60-2d5b8c1e7a43',
  finalPr: { number: 418, url: 'https://github.com/northwind/storefront-web/pull/418' },
  checkpoint: {
    intervalMinutes: 15, count: 2, lastAt: minutesAgo(9), lastCommitSha: '4e1c9a7', error: null, pending: false,
    latest: {
      kind: 'agent', state: 'completed', commitSha: '4e1c9a7',
      message: 'feat(checkout): capture cards through the Payments SDK',
      include: ['src/checkout/capture.ts', 'src/checkout/payments.ts', 'src/checkout/__tests__/capture.test.ts'],
      exclude: ['src/checkout/refunds.ts'],
      summary: 'Card capture runs on the SDK with idempotency keys; refunds are next.',
      error: null, createdAt: minutesAgo(10), completedAt: minutesAgo(9),
    },
  },
  inputs: [{
    id: 'in-1', message: 'Keep the 3-D Secure retry on the existing modal; design is not ready for the new one.',
    attachmentCount: 0, state: 'delivered', createdAt: minutesAgo(21), deliveredAt: minutesAgo(21),
  }],
  artifactStats: { issues: 0, openIssues: 0, pullRequests: 1, openPullRequests: 1 },
  liveSummary: {
    currentTask: 'Move refunds and partial captures to the SDK', todos: checkoutTodos,
    tokenUsage: { input_tokens: 3_412_000, output_tokens: 186_400, cache_read_input_tokens: 2_910_000 }, nativeGoal: null,
  },
  createdAt: minutesAgo(38), updatedAt: minutesAgo(1), startedAt: minutesAgo(37),
  elapsedMs: 37 * 60_000, activeMs: 37 * 60_000,
};

const fulfilmentTodos = [
  { id: 'f1', content: 'File issues for the fulfilment service split', status: 'completed' },
  { id: 'f2', content: 'Implement #612 extract the fulfilment queue consumer', status: 'completed' },
  { id: 'f3', content: 'Monitor #613 and #614 in parallel', status: 'in_progress' },
  { id: 'f4', content: 'Assemble the epic PR and run Ultrafix', status: 'pending' },
] as const;

/** Orchestrating goal: the agent files and drives issues through ProPR. */
export const FULFILMENT_GOAL = {
  ...goalBase,
  id: 'goal-fulfilment-service', repository: REPOS.api,
  title: 'Split fulfilment into its own service',
  objective: 'Extract order fulfilment from orders-api into a fulfilment service with its own queue consumer and database schema, behind the existing order events.',
  launchStrategy: 'orchestrate', initialPrompt: '/goal Split fulfilment into its own service',
  branchName: 'goal/fulfilment-service',
  agent: { id: 'codex', alias: 'codex', type: 'codex' },
  requestedModel: 'gpt-6-astra', effectiveModel: 'gpt-6-astra', maxParallelTasks: 3, ultrafix: true,
  taskId: 'task-goal-fulfilment', sessionId: '5b0e3c71-8a24-4f19-b6d2-0c9e7f4a2d18',
  artifacts: [
    { type: 'issue', number: 612, url: 'https://github.com/northwind/orders-api/issues/612' },
    { type: 'issue', number: 613, url: 'https://github.com/northwind/orders-api/issues/613' },
    { type: 'issue', number: 614, url: 'https://github.com/northwind/orders-api/issues/614' },
    { type: 'pull_request', number: 615, url: 'https://github.com/northwind/orders-api/pull/615' },
    { type: 'pull_request', number: 617, url: 'https://github.com/northwind/orders-api/pull/617' },
  ],
  artifactStats: { issues: 3, openIssues: 2, pullRequests: 2, openPullRequests: 1 },
  liveSummary: {
    currentTask: 'Monitoring #613 and #614', todos: fulfilmentTodos,
    tokenUsage: { input_tokens: 5_820_000, output_tokens: 241_000 }, nativeGoal: null,
  },
  createdAt: hoursAgo(2.2), updatedAt: minutesAgo(2), startedAt: hoursAgo(2.2),
  elapsedMs: 132 * 60_000, activeMs: 132 * 60_000,
};

export const QUESTION_BLOCKER = {
  id: 'blocker-courier-1', goalId: 'goal-courier-offline', repository: REPOS.mobile, taskId: 'task-goal-courier',
  attempt: { generation: 1, claim: 'claim-1', sessionId: 'thread-courier', turnId: 'turn-9' },
  category: 'question', provider: 'codex',
  summary: 'Should offline proof-of-delivery photos upload over cellular, or wait for Wi-Fi?',
  questions: [{
    id: 'upload', header: 'Upload policy', question: 'Should offline proof-of-delivery photos upload over cellular, or wait for Wi-Fi?',
    options: ['Upload over cellular', 'Wait for Wi-Fi', 'Cellular under 2 MB only'], confidential: false,
  }],
  detection: { kind: 'provider_event', source: 'codex_app_server:item/tool/requestUserInput' },
  firstObservedAt: minutesAgo(6), lastObservedAt: minutesAgo(6), status: 'open',
  actionable: true, responseActions: ['send_input', 'pause', 'cancel'],
  responseHint: 'Send goal input to answer; ProPR delivers it as the reply to this question.',
};

/** Waiting on the operator: the agent asked a question. */
export const COURIER_GOAL = {
  ...goalBase,
  id: 'goal-courier-offline', repository: REPOS.mobile,
  title: 'Offline proof of delivery for couriers',
  objective: 'Let couriers capture proof-of-delivery photos and signatures with no signal, queue them on the device, and sync when connectivity returns.',
  launchStrategy: 'direct', initialPrompt: '/goal Offline proof of delivery for couriers',
  branchName: 'goal/offline-pod',
  agent: { id: 'codex', alias: 'codex', type: 'codex' },
  requestedModel: 'gpt-6-astra', effectiveModel: 'gpt-6-astra',
  taskId: 'task-goal-courier', sessionId: '9d41f2b7-3e6c-4a05-8c1e-7b2f0a9d6e34',
  attention: { waitingForOperator: true, reason: 'provider_question', blockers: [QUESTION_BLOCKER] },
  liveSummary: {
    currentTask: 'Waiting for an answer',
    todos: [
      { id: 'c1', content: 'Queue captures in the on-device outbox', status: 'completed' },
      { id: 'c2', content: 'Choose the upload policy', status: 'in_progress' },
      { id: 'c3', content: 'Sync and retry with backoff', status: 'pending' },
    ],
    tokenUsage: { input_tokens: 1_204_000, output_tokens: 61_300 }, nativeGoal: null,
  },
  createdAt: minutesAgo(52), updatedAt: minutesAgo(6), startedAt: minutesAgo(51),
  elapsedMs: 51 * 60_000, activeMs: 45 * 60_000,
};

export const PAUSED_GOAL = {
  ...goalBase,
  id: 'goal-search-ranking', repository: REPOS.web,
  title: 'Rank search results by in-stock availability',
  objective: 'Boost in-stock products in storefront search without changing the relevance model.',
  launchStrategy: 'direct', initialPrompt: '/goal Rank search results by in-stock availability',
  branchName: 'goal/search-in-stock',
  agent: { id: 'claude', alias: 'claude', type: 'claude' },
  requestedModel: 'claude-sonnet-5-5', effectiveModel: 'claude-sonnet-5-5',
  desiredState: 'paused', pausedAt: hoursAgo(3), taskState: 'paused',
  taskId: 'task-goal-search', sessionId: '2a7c5e90-4b18-4d3f-a6e1-8f0c9b2d5a71',
  checkpoint: { intervalMinutes: 15, count: 1, lastAt: hoursAgo(3), lastCommitSha: 'b28d0f3', error: null, pending: false, latest: null },
  finalPr: { number: 409, url: 'https://github.com/northwind/storefront-web/pull/409' },
  artifactStats: { issues: 0, openIssues: 0, pullRequests: 1, openPullRequests: 1 },
  liveSummary: { currentTask: null, todos: [], tokenUsage: { input_tokens: 812_000, output_tokens: 40_200 }, nativeGoal: null },
  createdAt: hoursAgo(4), updatedAt: hoursAgo(3), startedAt: hoursAgo(4),
  elapsedMs: 4 * 3_600_000, activeMs: 52 * 60_000, pausedMs: 3 * 3_600_000 + 8 * 60_000,
};

export const DONE_GOAL = {
  ...goalBase,
  id: 'goal-terraform-modules', repository: REPOS.infra,
  title: 'Pin Terraform providers across modules',
  objective: 'Pin every Terraform provider to a minor version and add a CI check that rejects unpinned providers.',
  launchStrategy: 'direct', initialPrompt: '/goal Pin Terraform providers across modules',
  branchName: 'goal/pin-providers',
  agent: { id: 'claude', alias: 'claude', type: 'claude' },
  requestedModel: 'claude-opus-5-5', effectiveModel: 'claude-opus-5-5',
  desiredState: 'running', resultState: 'completed', taskState: 'completed',
  taskId: 'task-goal-terraform', sessionId: 'e83b1d46-0f2a-4c97-b5e8-3a6d9c0f1b27',
  finalPr: { number: 88, url: 'https://github.com/northwind/platform-infra/pull/88' },
  artifactStats: { issues: 0, openIssues: 0, pullRequests: 1, openPullRequests: 0 },
  liveSummary: { currentTask: null, todos: [], tokenUsage: { input_tokens: 1_640_000, output_tokens: 72_800 }, nativeGoal: null },
  createdAt: daysAgo(1.2), updatedAt: daysAgo(1), startedAt: daysAgo(1.2), completedAt: daysAgo(1),
  elapsedMs: 41 * 60_000, activeMs: 41 * 60_000,
};

export const GOALS = [CHECKOUT_GOAL, COURIER_GOAL, FULFILMENT_GOAL, PAUSED_GOAL, DONE_GOAL];

const at = (minutes: number) => minutesAgo(minutes);
const checkpointJson = JSON.stringify({
  checkpointReady: true,
  message: 'feat(checkout): capture cards through the Payments SDK',
  include: CHECKOUT_GOAL.checkpoint.latest.include,
  exclude: CHECKOUT_GOAL.checkpoint.latest.exclude,
  summary: CHECKOUT_GOAL.checkpoint.latest.summary,
});

/** The direct goal's provider stream, interleaved with the operator's correction by the UI. */
const checkoutEvents = [
  { id: 'e1', type: 'thought', content: 'Found 14 call sites of `PaymentsClient` across checkout, refunds and the admin refund tool. Starting with card capture, the busiest path.', timestamp: at(35) },
  { id: 'e2', type: 'thought', content: 'Card capture now calls `payments.charges.create` with an idempotency key derived from the cart id. Updated the capture tests for the SDK error types.', timestamp: at(24) },
  { id: 'e3', type: 'thought', content: 'Updated the 3-D Secure retry to stay on the existing `ChallengeModal`: the SDK `requires_action` status now opens it, and the retry test covers both outcomes.', timestamp: at(20) },
  { id: 'e4', type: 'thought', content: `Card capture is stable and covered. Requesting a checkpoint.\n\`\`\`json\n${checkpointJson}\n\`\`\``, timestamp: at(10) },
  { id: 'e5', type: 'thought', content: 'Moving refunds next: `refundOrder` and `capturePartial` still go through the legacy client.', timestamp: at(8) },
];

const goalDetail = (goal: { id: string }) => ({ goal });

export const goals = area('goals', {
  '/api/instance/catalog': goalsCatalog,
  '/api/goals/capabilities': { agents: goalCapabilities },
  'GET /api/goals': { goals: GOALS },
  '/api/task/task-goal-checkout/live-details': {
    events: checkoutEvents, todos: checkoutTodos, currentTask: CHECKOUT_GOAL.liveSummary.currentTask,
    tokenUsage: CHECKOUT_GOAL.liveSummary.tokenUsage,
  },
  '/api/task/task-goal-fulfilment/live-details': {
    events: [
      { id: 'o1', type: 'thought', content: 'Filed #612, #613 and #614 for the split. #612 merged; starting #613 and #614 in parallel.', timestamp: minutesAgo(40) },
    ],
    todos: fulfilmentTodos, currentTask: FULFILMENT_GOAL.liveSummary.currentTask, tokenUsage: FULFILMENT_GOAL.liveSummary.tokenUsage,
  },
  '/api/task/task-goal-courier/live-details': {
    events: [
      { id: 'q1', type: 'thought', content: 'Captures now queue in the on-device outbox and survive app restarts.', timestamp: minutesAgo(12) },
    ],
    todos: COURIER_GOAL.liveSummary.todos, currentTask: COURIER_GOAL.liveSummary.currentTask, tokenUsage: COURIER_GOAL.liveSummary.tokenUsage,
  },
}, [
  [/^\/api\/goals\/[^/]+\/previews$/, () => ({ previews: [] })],
  [/^\/api\/goals\/[^/]+$/, request => {
    const id = decodeURIComponent(request.path.split('/').pop()!);
    const goal = GOALS.find(candidate => candidate.id === id);
    return goal ? goalDetail(goal) : undefined;
  }],
  [/^\/api\/task\/[^/]+\/live-details$/, () => ({ events: [], todos: [], currentTask: null })],
]);

/** GitHub-hosted previews for the checkout goal's draft PR; images are served by the shot. */
export const PREVIEW_ASSET = (name: string) => `https://github.com/user-attachments/assets/northwind-${name}`;
export const goalPreviews = area('goal-previews', {
  [`/api/goals/${CHECKOUT_GOAL.id}/previews`]: {
    previews: [
      { type: 'image', title: 'Checkout payment step on the Payments SDK', description: 'Card capture with the SDK, desktop width.', url: PREVIEW_ASSET('checkout-desktop') },
      { type: 'image', title: 'Payment step at 390px', description: 'The same step on a phone.', url: PREVIEW_ASSET('checkout-mobile') },
    ],
  },
});
