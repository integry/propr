import { area } from '../lib/world';
import { NOW, REPOS, minutesAgo } from './base';

/**
 * A week of Northwind pull requests on /tasks: one Ultrafix loop in flight,
 * reviews that scored, a fix with visual previews, a merge, a failure, and a
 * run that ran behind the restricted network.
 */

const MODELS = {
  claude: { provider: 'claude', model: 'claude-opus-5-5', tag: 'Claude Opus 5.5' },
  sonnet: { provider: 'claude', model: 'claude-sonnet-5-5', tag: 'Claude Sonnet 5.5' },
  codex: { provider: 'codex', model: 'gpt-6-astra', tag: 'GPT-6 Astra' },
  gemini: { provider: 'antigravity', model: 'antigravity-gemini-3.1-pro', tag: 'Gemini 3.1 Pro' },
} as const;
type ModelKey = keyof typeof MODELS;

interface Run {
  verb: 'Review' | 'Fix' | 'Ultrafix' | 'Follow-up' | 'Merge' | 'New Issue';
  subtitle?: string;
  status?: 'processing' | 'queued' | 'completed' | 'failed';
  minutes: number;
  took?: number;
  score?: number;
  commitHash?: string;
  failedReason?: string;
  planIssueStatus?: string;
  previewMedia?: Array<{ type: 'image' | 'video'; title: string; description?: string; url: string }>;
}

const repoParts = (repository: string) => {
  const [repositoryOwner, repositoryName] = repository.split('/');
  return { repository, repositoryOwner, repositoryName };
};

const pullRequest = (repository: string, prNumber: number, issueNumber: number, subject: string, modelKey: ModelKey, runs: Run[]) => {
  const model = MODELS[modelKey];
  return runs.map((run, index) => ({
    id: `${repository.split('/')[1]}-${prNumber}-run-${index}`, ...repoParts(repository),
    issueNumber: prNumber, prNumber, linkedIssueNumber: issueNumber,
    title: run.verb === 'New Issue' ? `New Issue: [${issueNumber} by ${model.tag}] ${subject}` : `${run.verb} PR #${prNumber}: [${issueNumber} by ${model.tag}] ${subject}`,
    subtitle: run.subtitle ?? null, status: run.status ?? 'completed',
    createdAt: minutesAgo(run.minutes), processedAt: minutesAgo(run.minutes),
    completedAt: run.status === 'processing' || run.status === 'queued' ? null : minutesAgo(run.minutes - (run.took ?? 5)),
    llmProvider: model.provider, model: model.model, score: run.score ?? null,
    previewMedia: run.previewMedia, planIssueStatus: run.planIssueStatus ?? null,
    commitHash: run.commitHash ?? null, failedReason: run.failedReason ?? null,
  }));
};

const media = (id: string, title: string, description?: string) => ({ type: 'image' as const, title, description, url: `/api/preview-media/pulls/northwind/courier-app/128/${id}` });

export const DELIVERY = { repository: REPOS.web, pr: 482, issue: 478, subject: 'Show delivery windows at checkout' };
export const PHOTOS = { repository: REPOS.mobile, pr: 128, issue: 121, subject: 'Queue proof-of-delivery photos while offline' };
export const SBOM = { repository: REPOS.infra, pr: 81, issue: 79, subject: 'Generate an SBOM for every release build' };

export const TASKS = [
  ...pullRequest(DELIVERY.repository, DELIVERY.pr, DELIVERY.issue, DELIVERY.subject, 'claude', [
    { verb: 'Ultrafix', subtitle: 'Ultrafix cycle 2: time-zone edge cases', status: 'processing', minutes: 2 },
    { verb: 'Review', subtitle: 'Found 1 issue', minutes: 14, took: 4, score: 7 },
    { verb: 'Fix', subtitle: 'Hide windows that close before the cart cutoff', minutes: 22, took: 6, commitHash: 'c41e9a07b2d5' },
    { verb: 'Review', subtitle: 'Found 3 issues', minutes: 35, took: 5, score: 5 },
    { verb: 'New Issue', subtitle: 'Delivery window picker in the checkout summary', minutes: 58, took: 17, commitHash: '7d2f0c18e6a3' },
  ]),
  ...pullRequest(REPOS.api, 311, 305, 'Retry payment webhooks that time out', 'codex', [
    { verb: 'Merge', subtitle: 'Merged after checks passed', minutes: 70, took: 1, planIssueStatus: 'merged' },
    { verb: 'Review', subtitle: 'No blocking findings', minutes: 84, took: 4, score: 9 },
    { verb: 'Fix', subtitle: 'Back off exponentially and cap retries at five', minutes: 96, took: 7, score: 8, commitHash: 'e90b3d4a1f62' },
    { verb: 'Review', subtitle: 'Found 2 issues', minutes: 118, took: 4, score: 6 },
  ]),
  ...pullRequest(PHOTOS.repository, PHOTOS.pr, PHOTOS.issue, PHOTOS.subject, 'codex', [
    { verb: 'Fix', subtitle: 'Show the pending-upload badge on the stop card', minutes: 105, took: 9, score: 8, commitHash: '3fa8c2d91e07',
      previewMedia: [
        media('stop-card', 'Stop card with two photos waiting to upload', 'The badge counts queued photos and clears when the courier is back online.'),
        media('settings', 'Upload settings on a phone'),
      ] },
    { verb: 'Review', subtitle: 'Found 1 issue', minutes: 130, took: 5, score: 7 },
  ]),
  ...pullRequest(REPOS.web, 476, 471, 'Show gift card balance on the account page', 'gemini', [
    { verb: 'Review', status: 'queued', minutes: 6 },
    { verb: 'New Issue', subtitle: 'Balance card with last-used date', minutes: 40, took: 12, commitHash: 'b73e5d0c9a14' },
  ]),
  ...pullRequest(SBOM.repository, SBOM.pr, SBOM.issue, SBOM.subject, 'claude', [
    { verb: 'New Issue', subtitle: 'Restricted network: denied 9 connections to 3 hosts', minutes: 150, took: 19, commitHash: '5c0d7e3b8f21' },
  ]),
  ...pullRequest(REPOS.api, 309, 302, 'Split invoice PDFs by warehouse', 'gemini', [
    { verb: 'Review', subtitle: 'Totals reconcile across split invoices', minutes: 190, took: 6, score: 8 },
    { verb: 'Follow-up', subtitle: 'Name each PDF after its warehouse code', minutes: 215, took: 5, commitHash: '0e6f4a2b7c93' },
  ]),
  ...pullRequest(REPOS.infra, 80, 76, 'Pin Terraform provider versions', 'sonnet', [
    { verb: 'Fix', status: 'failed', minutes: 240, took: 11, failedReason: 'terraform validate failed: provider "aws" version constraint' },
  ]),
  ...pullRequest(REPOS.mobile, 126, 119, 'Round route ETAs to the nearest five minutes', 'claude', [
    { verb: 'Merge', subtitle: 'Merged after checks passed', minutes: 300, took: 1, planIssueStatus: 'merged' },
    { verb: 'Review', subtitle: 'No blocking findings', minutes: 318, took: 3, score: 9 },
    { verb: 'New Issue', subtitle: 'ETA rounding with a five-minute floor', minutes: 330, took: 8, commitHash: 'a1d94c6e0b58' },
  ]),
];

const runId = (repository: string, pr: number, index: number) => `${repository.split('/')[1]}-${pr}-run-${index}`;
export const LIVE_RUN = runId(DELIVERY.repository, DELIVERY.pr, 0);
export const PHOTOS_RUN = runId(PHOTOS.repository, PHOTOS.pr, 0);
export const SBOM_RUN = runId(SBOM.repository, SBOM.pr, 0);

const taskInfo = (repository: string, pr: number, title: string, subtitle: string, modelName: string, type = 'pr') => {
  const [repoOwner, repoName] = repository.split('/');
  return { title, subtitle, type, number: pr, issueNumber: pr, repoOwner, repoName, modelName };
};

const liveHistory = [
  { state: 'PENDING', timestamp: minutesAgo(2), metadata: { model: 'claude-opus-5-5' } },
  ...['Read the review finding on DST transitions', 'Compute windows in the store’s time zone', 'Run the checkout test suite'].map((description, index) => ({
    state: 'CLAUDE_EXECUTION', timestamp: minutesAgo(2 - (index + 1) * 0.4),
    metadata: { model: 'claude-opus-5-5', description, ...(index === 2 && { tokenUsage: { input_tokens: 84_000, cache_read_input_tokens: 1_900_000, cache_creation_input_tokens: 310_000, output_tokens: 22_000 } }) },
  })),
];
const liveEvents = [
  { id: 't1', type: 'thought', timestamp: minutesAgo(1.4), content: 'The review flagged windows computed in UTC. Stores in Auckland show tomorrow’s slots after 11 am — converting with the store’s zone before filtering.' },
  { id: 'u1', toolUseId: 'u1', type: 'tool_use', timestamp: minutesAgo(1.1), toolName: 'Edit', input: { file_path: 'src/checkout/deliveryWindows.ts' } },
  { id: 'r1', toolUseId: 'u1', type: 'tool_result', timestamp: minutesAgo(1.0), result: 'Updated src/checkout/deliveryWindows.ts' },
  { id: 't2', type: 'thought', timestamp: minutesAgo(0.9), content: 'Windows now come from `toZonedTime(now, store.timeZone)`. Adding cases for the DST change on 25 October and for a cart cutoff that falls inside a window.' },
  { id: 'u2', toolUseId: 'u2', type: 'tool_use', timestamp: minutesAgo(0.6), toolName: 'Bash', input: { command: 'npm test -- checkout/deliveryWindows' } },
  { id: 'r2', toolUseId: 'u2', type: 'tool_result', timestamp: minutesAgo(0.4), result: 'PASS src/checkout/deliveryWindows.test.ts (14 tests)' },
  { id: 't3', type: 'thought', timestamp: minutesAgo(0.3), content: 'All 14 checkout tests pass, including the two new DST cases. Pushing the fix so the next review can score it.' },
];

const egress = {
  mode: 'restricted', source: 'workflow', allow: ['registry.npmjs.org', 'github.com', '*.northwind.internal'], restrictedContainers: 1, fallbacks: [],
  allowedConnections: 186, deniedConnections: 9,
  deniedHosts: [{ host: 'telemetry.nextjs.org', count: 5 }, { host: 'api.segment.io', count: 3 }, { host: 'storybook.js.org', count: 1 }],
  omittedDeniedHosts: 0, omittedDeniedAttempts: 0,
};
const sbomHistory = [
  { state: 'PENDING', timestamp: minutesAgo(150), metadata: { model: 'claude-opus-5-5' } },
  { state: 'PROCESSING', timestamp: minutesAgo(149.9) },
  { state: 'CLAUDE_EXECUTION', timestamp: minutesAgo(149.5), reason: 'Agent execution started' },
  { state: 'CLAUDE_EXECUTION', timestamp: minutesAgo(132), reason: 'Restricted network: denied 9 connections to 3 hosts', metadata: { event: 'network.egress', networkEgress: egress } },
  { state: 'CLAUDE_EXECUTION', timestamp: minutesAgo(131.9), reason: 'claude agent execution completed' },
  { state: 'POST_PROCESSING', timestamp: minutesAgo(131.8) },
  { state: 'COMPLETED', timestamp: minutesAgo(131), metadata: { pr: { url: `https://github.com/${SBOM.repository}/pull/${SBOM.pr}`, number: SBOM.pr } } },
];

const photosHistory = [
  { state: 'PENDING', timestamp: minutesAgo(105), metadata: { model: 'gpt-6-astra' } },
  { state: 'CLAUDE_EXECUTION', timestamp: minutesAgo(104.8), metadata: { model: 'gpt-6-astra', description: 'Add the pending-upload badge' } },
  { state: 'COMPLETED', timestamp: minutesAgo(96), metadata: { model: 'gpt-6-astra', pr: { url: `https://github.com/${PHOTOS.repository}/pull/${PHOTOS.pr}`, number: PHOTOS.pr } } },
];

const runsOf = (repository: string, pr: number) => TASKS.filter(task => task.repository === repository && task.prNumber === pr);

const history = (id: string) => {
  const task = TASKS.find(candidate => candidate.id === id);
  if (!task) return undefined;
  const info = taskInfo(task.repository, task.prNumber, task.title, task.subtitle ?? '', task.model);
  if (id === LIVE_RUN) return { history: liveHistory, taskInfo: info, usageMetricRecords: [{ agent: 'claude', metricKey: 'weeklyAll', metricValue: 0.6 }] };
  if (id === SBOM_RUN) return { history: sbomHistory, taskInfo: { ...info, type: 'issue', number: SBOM.issue, issueNumber: SBOM.issue }, usageMetricRecords: [] };
  if (id === PHOTOS_RUN) return { history: photosHistory, taskInfo: info, previewMedia: task.previewMedia, usageMetricRecords: [] };
  const done = task.completedAt ?? minutesAgo(0);
  return {
    history: [
      { state: 'PENDING', timestamp: task.createdAt, metadata: { model: task.model } },
      { state: 'CLAUDE_EXECUTION', timestamp: task.processedAt, metadata: { model: task.model, description: task.subtitle ?? 'Work on the pull request' } },
      ...(task.status === 'completed' ? [{ state: 'COMPLETED', timestamp: done, metadata: { model: task.model } }] : []),
      ...(task.status === 'failed' ? [{ state: 'FAILED', timestamp: done, reason: task.failedReason }] : []),
    ],
    taskInfo: info, usageMetricRecords: [],
  };
};

const liveDetails = (id: string) => ({ events: id === LIVE_RUN ? liveEvents : [], todos: [], currentTask: null });
const fileChanges = (id: string) => ({
  taskId: id, lastUpdated: minutesAgo(0.5),
  files: id === LIVE_RUN
    ? [
      { path: 'src/checkout/deliveryWindows.ts', linesAdded: 18, linesRemoved: 6, status: 'modified', diff: '@@ -12,6 +12,18 @@\n-const today = startOfDay(new Date());\n+const today = startOfDay(toZonedTime(now, store.timeZone));' },
      { path: 'src/checkout/deliveryWindows.test.ts', linesAdded: 31, linesRemoved: 0, status: 'modified', diff: '' },
    ]
    : [],
});

const CATALOG_AGENTS = [
  { id: 'claude', kind: 'direct', alias: 'claude', type: 'claude', enabled: true, supportedModels: ['claude-opus-5-5', 'claude-sonnet-5-5'], defaultModel: 'claude-opus-5-5' },
  { id: 'codex', kind: 'direct', alias: 'codex', type: 'codex', enabled: true, supportedModels: ['gpt-6-astra', 'gpt-5.5'], defaultModel: 'gpt-6-astra' },
  { id: 'antigravity', kind: 'direct', alias: 'antigravity', type: 'antigravity', enabled: true, supportedModels: ['antigravity-gemini-3.1-pro'], defaultModel: 'antigravity-gemini-3.1-pro' },
];
const ALIASES: Record<string, string> = { [REPOS.web]: 'Storefront', [REPOS.api]: 'Orders API', [REPOS.mobile]: 'Courier app', [REPOS.infra]: 'Platform infra' };

export const tasks = area('tasks', {
  // The operational catalog as the new-task dialog reads it (repositories by `name`).
  '/api/instance/catalog': {
    agents: CATALOG_AGENTS, defaultAgentAlias: 'claude',
    repositories: Object.values(REPOS).map(name => ({ name, enabled: true, alias: ALIASES[name], baseBranch: 'main' })),
  },
  '/api/config/repos': { success: true, repos_to_monitor: Object.values(REPOS).map(name => ({ id: name.split('/')[1], name, alias: ALIASES[name], enabled: true })) },
  '/api/repositories/indexing-status': { repositories: [] },
  '/api/repos/chat/messages': { messages: [] },
  '/api/repos/todos/categories': { categories: [] },
  '/api/repos/todos': { todos: [] },
  '/api/user/repo-preferences': { preferences: {} },
  '/api/stats/active-work': { counts: { tasks: 2, plans: 0, goals: 0, total: 2 } },
  '/api/config/agent-tank/usage': { enabled: false, agents: {} },
  'GET /api/tasks': { tasks: TASKS, total: 8, totalRuns: TASKS.length },
  '/api/stats/tasks': { summary: { total: 19, completed: 14, failed: 1, active: 1, waiting: 1 }, dailyCounts: [], statusDistribution: [], avgProcessingTime: [] },
  '/api/stats/repositories': {
    repositories: Object.values(REPOS).map(repository => {
      const runs = TASKS.filter(task => task.repository === repository);
      return { repository, total: runs.length, completed: runs.filter(run => run.status === 'completed').length, failed: runs.filter(run => run.status === 'failed').length, inProgress: runs.filter(run => run.status === 'processing').length, successRate: 90 };
    }),
  },
}, [
  [/^\/api\/task\/[^/]+\/history$/, request => history(request.path.split('/')[3])],
  [/^\/api\/task\/[^/]+\/live-details$/, request => liveDetails(request.path.split('/')[3])],
  [/^\/api\/task\/[^/]+\/file-changes$/, request => fileChanges(request.path.split('/')[3])],
  [/^\/api\/pull-requests\/\d+\/scores$/, request => {
    const prNumber = Number(request.path.split('/')[3]);
    const repository = request.query.get('repository') ?? '';
    const runs = TASKS.filter(task => task.prNumber === prNumber && task.repository === repository);
    const merged = runs.find(task => task.planIssueStatus === 'merged');
    return {
      repository, pr_number: prNumber, outcome: merged ? 'merged' : null, merged_at: merged?.completedAt ?? null, closed_at: null,
      scores: runs.filter(task => task.score !== null).reverse().map((task, index) => ({
        cycle_number: index + 1, source: 'review', score: task.score, goal: 8, blocker_count: task.score! < 7 ? 2 : 0, suggestion_count: 1,
        reviewer_agent: 'claude', reviewer_model: 'claude-opus-5-5', implementer_model: task.model, head_sha: task.commitHash, task_id: task.id, created_at: task.createdAt,
      })),
    };
  }],
]);

export { NOW, runsOf };
