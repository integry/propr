import { area, type ApiRequest } from '../lib/world';
import { NOW, REPOS, USER } from './base';

/**
 * Automations at Northwind: four saved prompts on different schedules and
 * autonomy modes, and a run history covering every trigger and the states a
 * run passes through. Shapes follow `src/api/agentDefinitionsApi.ts`
 * (timestamps in epoch ms) and e2e/automations.pw.ts.
 */

const now = NOW.getTime();
const min = (minutes: number) => now - minutes * 60_000;
const hrs = (hours: number) => min(hours * 60);
const days = (count: number) => hrs(count * 24);

const definitionBase = {
  ownerId: USER.id, attachments: [], scheduleTimezone: 'UTC', enabled: true, revision: 3,
  includePreviousReports: false, previousReportsLimit: 0,
};

export const DEPENDENCY_REVIEW = {
  ...definitionBase,
  id: 'auto-dependency-review', name: 'Weekly dependency review',
  description: 'Every Monday: which dependencies need attention, and why.',
  repositories: [REPOS.web, REPOS.api],
  prompt: 'Review the dependencies of each repository. Report packages with known vulnerabilities, major versions we are more than one release behind, and anything deprecated upstream. Group findings by repository and rank them by risk. Follow `dependency-policy.md` for what we pin and what we let float.',
  attachments: [
    { id: 'att-policy', originalName: 'dependency-policy.md', mimeType: 'text/markdown', size: 3_412, tokenEstimate: 860, type: 'text' },
  ],
  agentAlias: 'claude', modelName: 'claude-opus-5-5', capabilities: ['repository_read', 'web'],
  includePreviousReports: true, previousReportsLimit: 2,
  scheduleCron: '0 9 * * 1', scheduleEnabled: true, nextRunAt: Date.parse('2026-10-12T09:00:00Z'),
  autonomyMode: 'preview', createdAt: days(40), updatedAt: days(3),
};

export const BLOCKED_PRS = {
  ...definitionBase,
  id: 'auto-blocked-prs', name: 'Blocked pull requests',
  description: 'Daily digest of stalled pull requests.',
  repositories: [REPOS.web, REPOS.api, REPOS.mobile],
  prompt: 'Review open pull requests in these repositories and summarize which ones are blocked and why: failing checks, unanswered review comments, merge conflicts, or waiting on another PR. Compare with the previous report and call out what changed.',
  agentAlias: 'codex', modelName: 'gpt-6-astra', capabilities: ['repository_read', 'propr_mcp'],
  includePreviousReports: true, previousReportsLimit: 1,
  scheduleCron: '0 9 * * 1-5', scheduleEnabled: true, nextRunAt: Date.parse('2026-10-09T09:00:00Z'),
  autonomyMode: 'dry_run', createdAt: days(21), updatedAt: days(21),
};

export const ISSUE_TRIAGE = {
  ...definitionBase,
  id: 'auto-issue-triage', name: 'Afternoon issue triage',
  description: 'Label and summarize the day\'s new issues every weekday afternoon.',
  repositories: [REPOS.web, REPOS.mobile],
  prompt: 'Summarize issues opened since the last run. Flag likely duplicates, anything mentioning payments or data loss, and issues missing reproduction steps.',
  agentAlias: 'claude', modelName: 'claude-sonnet-5-5', capabilities: ['repository_read'],
  scheduleCron: '0 14 * * 1-5', scheduleEnabled: true, nextRunAt: Date.parse('2026-10-09T14:00:00Z'),
  autonomyMode: 'auto', createdAt: days(14), updatedAt: days(6),
};

export const COMPETITOR_SCAN = {
  ...definitionBase,
  id: 'auto-competitor-scan', name: 'Competitor scan',
  description: 'Pricing and feature changes at the outdoor retailers we track.',
  repositories: [],
  prompt: 'Check the pricing, shipping and returns pages of the retailers in `competitors.csv`. Report what changed since the last report.',
  attachments: [
    { id: 'att-competitors', originalName: 'competitors.csv', mimeType: 'text/csv', size: 1_140, tokenEstimate: 290, type: 'text' },
  ],
  agentAlias: 'claude', modelName: 'claude-opus-5-5', capabilities: ['web'],
  includePreviousReports: true, previousReportsLimit: 3,
  scheduleCron: null, scheduleEnabled: false, nextRunAt: null,
  autonomyMode: 'dry_run', createdAt: days(9), updatedAt: days(9),
};

export const DEFINITIONS = [DEPENDENCY_REVIEW, BLOCKED_PRS, ISSUE_TRIAGE, COMPETITOR_SCAN];

const runBase = {
  ownerId: USER.id, idempotencyKey: null, definitionSnapshot: null, reportTaskId: null, actionTaskId: null,
  report: null, reportTruncated: false, actionSummary: null, skipReason: null, failureReason: null,
  approvedBy: null, operatorNote: null, deferredUntil: null, deferrals: 0,
};

const reportFor = (headline: string) => `${headline}

### Needs attention

| Package | Repository | Now | Latest | Why |
| --- | --- | --- | --- | --- |
| \`lodash\` | storefront-web | 4.17.20 | 4.17.21 | Prototype pollution (CVE-2021-23337) in \`template\` |
| \`pg\` | orders-api | 8.7.3 | 8.13.1 | Pool leak on aborted queries, fixed in 8.11 |
| \`@northwind/ui-kit\` | storefront-web | 3.2.0 | 4.0.1 | One major behind; 3.x is out of support in December |

### On watch

- \`date-fns\` 2.x → 4.x: deprecations only, nothing breaks yet.
- \`express\` 4.21 → 5.1: follow the migration guide before 4.x support ends.

### Since last week

\`axios\` was upgraded in orders-api (#604), so it drops off the list.`;
const DEPENDENCY_REPORT = reportFor('**3 packages need attention** across storefront-web and orders-api; 2 more on watch.');

/** One run in each state the site talks about, newest first. */
export const DEPENDENCY_RUNS = [
  {
    ...runBase, id: 'run-dep-awaiting', definitionId: DEPENDENCY_REVIEW.id, trigger: 'schedule', triggerSource: 'cron 0 9 * * 1',
    state: 'awaiting_approval', autonomyMode: 'preview', reportTaskId: 'task-dep-report', report: DEPENDENCY_REPORT,
    definitionSnapshot: DEPENDENCY_REVIEW,
    createdAt: hrs(5.5), startedAt: hrs(5.5), reportedAt: hrs(5.2), finishedAt: null, updatedAt: hrs(5.2),
  },
  {
    ...runBase, id: 'run-dep-mcp', definitionId: DEPENDENCY_REVIEW.id, trigger: 'mcp', triggerSource: 'Claude Desktop',
    state: 'completed', autonomyMode: 'preview', reportTaskId: 'task-dep-mcp', actionTaskId: 'task-dep-act',
    report: reportFor('**3 packages need attention**: lodash CVE, pg pool leak, ui-kit one major behind.'), approvedBy: USER.login, operatorNote: 'Only fix lodash.',
    actionSummary: 'Approved with the note **"Only fix lodash."**\n\n- Created task **Upgrade lodash to 4.17.21 in storefront-web** ([#1932](https://github.com/northwind/storefront-web/issues/1932)) — started on Claude Opus 5.5.\n- Left \`pg\` and \`@northwind/ui-kit\` as report items, as instructed.\n- Checked existing tasks and TODOs first: no duplicates.',
    createdAt: days(3), startedAt: days(3), reportedAt: days(3) + 18 * 60_000, finishedAt: days(3) + 31 * 60_000, updatedAt: days(3) + 31 * 60_000,
  },
  {
    ...runBase, id: 'run-dep-deferred', definitionId: DEPENDENCY_REVIEW.id, trigger: 'schedule', triggerSource: 'cron 0 9 * * 1',
    state: 'skipped', autonomyMode: 'preview', deferrals: 6,
    skipReason: 'Session subscription usage for claude is at 96% (pause threshold 90%), and the run was already deferred 6 times, so it was skipped.',
    createdAt: days(10), startedAt: null, reportedAt: null, finishedAt: days(10) + 5 * 3_600_000, updatedAt: days(10) + 5 * 3_600_000,
  },
  {
    ...runBase, id: 'run-dep-cli', definitionId: DEPENDENCY_REVIEW.id, trigger: 'cli', triggerSource: 'github-actions',
    idempotencyKey: '11873450219', state: 'rejected', autonomyMode: 'preview', reportTaskId: 'task-dep-cli', report: reportFor('**2 packages need attention**: axios advisory in orders-api, pg pool leak.'),
    createdAt: days(14), startedAt: days(14), reportedAt: days(14) + 16 * 60_000, finishedAt: days(14) + 40 * 60_000, updatedAt: days(14) + 40 * 60_000,
  },
  {
    ...runBase, id: 'run-dep-api', definitionId: DEPENDENCY_REVIEW.id, trigger: 'api', triggerSource: 'webhook-relay',
    state: 'completed', autonomyMode: 'dry_run', reportTaskId: 'task-dep-api', report: reportFor('**2 packages need attention**; express 5 migration added to the watch list.'),
    createdAt: days(17), startedAt: days(17), reportedAt: days(17) + 14 * 60_000, finishedAt: days(17) + 14 * 60_000, updatedAt: days(17) + 14 * 60_000,
  },
  {
    ...runBase, id: 'run-dep-manual', definitionId: DEPENDENCY_REVIEW.id, trigger: 'manual', triggerSource: `user:${USER.login}`,
    state: 'completed', autonomyMode: 'dry_run', reportTaskId: 'task-dep-manual', report: reportFor('First review: **4 packages need attention** across storefront-web and orders-api.'),
    createdAt: days(21), startedAt: days(21), reportedAt: days(21) + 12 * 60_000, finishedAt: days(21) + 12 * 60_000, updatedAt: days(21) + 12 * 60_000,
  },
];

/** A deferred run on the triage automation, for the cost-gate shot. */
export const TRIAGE_DEFERRED = {
  ...runBase, id: 'run-triage-deferred', definitionId: ISSUE_TRIAGE.id, trigger: 'schedule', triggerSource: 'cron 0 14 * * 1-5',
  state: 'deferred', autonomyMode: 'auto', deferrals: 1, deferredUntil: Date.parse('2026-10-08T16:05:00Z'),
  skipReason: 'Session subscription usage for claude is at 93% (pause threshold 90%), so the run was deferred until 2026-10-08 16:05 UTC.',
  createdAt: min(30), startedAt: null, reportedAt: null, finishedAt: null, updatedAt: min(30),
};

const lastRuns: Record<string, unknown[]> = {
  [DEPENDENCY_REVIEW.id]: [DEPENDENCY_RUNS[0]],
  [BLOCKED_PRS.id]: [{ ...runBase, id: 'run-blocked-1', definitionId: BLOCKED_PRS.id, trigger: 'schedule', triggerSource: null, state: 'completed', autonomyMode: 'dry_run', reportTaskId: 't', createdAt: hrs(5.5), startedAt: hrs(5.5), reportedAt: hrs(5.3), finishedAt: hrs(5.3), updatedAt: hrs(5.3) }],
  [ISSUE_TRIAGE.id]: [TRIAGE_DEFERRED],
  [COMPETITOR_SCAN.id]: [],
};

const runsPage = (runs: unknown[], request: ApiRequest) => {
  const limit = Number(request.query.get('limit') ?? 20);
  const offset = Number(request.query.get('offset') ?? 0);
  return { runs: runs.slice(offset, offset + limit), total: runs.length, limit, offset, nextOffset: null };
};

export const automationsCatalog = {
  agents: [
    { id: 'claude', kind: 'direct', alias: 'claude', type: 'claude', enabled: true, supportedModels: ['claude-opus-5-5', 'claude-sonnet-5-5'], defaultModel: 'claude-opus-5-5' },
    { id: 'codex', kind: 'direct', alias: 'codex', type: 'codex', enabled: true, supportedModels: ['gpt-6-astra', 'gpt-5.6-sol'], defaultModel: 'gpt-6-astra' },
  ],
  repositories: Object.values(REPOS).map(name => ({ name, enabled: true, baseBranch: 'main' })),
  defaultAgentAlias: 'claude',
};

const allRuns = [...DEPENDENCY_RUNS, TRIAGE_DEFERRED];

export const automations = area('automations', {
  '/api/instance/catalog': automationsCatalog,
  'GET /api/agent-definitions': { definitions: DEFINITIONS, total: DEFINITIONS.length, limit: 200, offset: 0 },
}, [
  [/^\/api\/agent-definitions\/[^/]+\/capacity$/, () => ({ capacity: { status: 'ok', sessionPercent: 34, weeklyPercent: 51, provider: 'claude' }, threshold: 90 })],
  [/^\/api\/agent-definitions\/[^/]+\/runs$/, request => {
    const id = decodeURIComponent(request.path.split('/')[3]);
    if (id === DEPENDENCY_REVIEW.id && Number(request.query.get('limit')) !== 1) return runsPage(DEPENDENCY_RUNS, request);
    return runsPage(lastRuns[id] ?? [], request);
  }],
  [/^\/api\/agent-definitions\/[^/]+$/, request => {
    const definition = DEFINITIONS.find(candidate => candidate.id === decodeURIComponent(request.path.split('/').pop()!));
    return definition ? { definition } : undefined;
  }],
  [/^\/api\/agent-runs\/[^/]+$/, request => {
    const run = allRuns.find(candidate => candidate.id === decodeURIComponent(request.path.split('/').pop()!));
    return run ? { run } : undefined;
  }],
]);
