/** The `/tasks` ledger and details pane data for `task-list-desktop.pw.ts`. */
import type { Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

export const now = Date.parse('2026-10-01T12:00:00Z');
export const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
const preview = (name: string, type: 'image' | 'video' = 'image') => ({ type, title: name, url: `https://github.com/user-attachments/assets/${name}` });

interface FixtureRun { title: string; subtitle?: string | null; status?: string; minutes: number; took?: number; score?: number | null; previewMedia?: ReturnType<typeof preview>[]; planIssueStatus?: string; commitHash?: string | null; failedReason?: string | null }

// Runs of nine pull requests, written the way the backend titles them: workflow verb, repeated
// PR number and model tag in front of what the work is about, plus legacy "Update" follow-ups.
const pullRequest = (prNumber: number, issueNumber: number, runs: FixtureRun[]) => runs.map((run, index) => ({
  id: `pr-${prNumber}-run-${index}`, repository: 'integry/propr', repositoryOwner: 'integry', repositoryName: 'propr',
  issueNumber: prNumber, prNumber, linkedIssueNumber: issueNumber,
  title: run.title, subtitle: run.subtitle ?? null, status: run.status ?? 'completed',
  createdAt: ago(run.minutes), processedAt: ago(run.minutes),
  completedAt: run.status === 'processing' ? null : new Date(Date.parse(ago(run.minutes)) + (run.took ?? 5) * 60_000).toISOString(),
  llmProvider: 'codex', model: 'gpt-6-astra', score: run.score ?? null,
  previewMedia: run.previewMedia, planIssueStatus: run.planIssueStatus ?? null,
  commitHash: run.commitHash ?? null, failedReason: run.failedReason ?? null,
}));
export const tag = (issue: number) => `[${issue} by GPT-6 Astra]`;
export const tasks = [
  ...pullRequest(2664, 2659, [
    { title: `Ultrafix PR #2664: ${tag(2659)} Stop work when an issue or PR withdraws intent`, subtitle: 'Ultrafix cycle 3 (linting)', status: 'processing', minutes: 1 },
    { title: 'Followup: Update', subtitle: 'Update', minutes: 13, took: 1, score: 5 },
    { title: `Ultrafix PR #2664: ${tag(2659)} Stop work when an issue or PR withdraws intent`, subtitle: 'Restrict issue-level withdrawal labels to actual intent withdrawal', minutes: 19, score: 6 },
    { title: `Ultrafix PR #2664: ${tag(2659)} Stop work when an issue or PR withdraws intent`, subtitle: 'Replace `cancelled_issue_closed` error code with human-readable UI text', minutes: 24, took: 4 },
    { title: 'Followup: Update 1', subtitle: 'Applied regex escape patch', minutes: 30, commitHash: '4be17c09d2f3' },
    { title: `Review PR #2664: ${tag(2659)} Stop work when an issue or PR withdraws intent`, subtitle: 'Found 2 issues', minutes: 39, took: 3, score: 6 },
    { title: 'Followup: Update 2', subtitle: 'Fixed seedCommit test', minutes: 48, commitHash: 'a81d3f56e0c2' },
    { title: `Review PR #2664: ${tag(2659)} Stop work when an issue or PR withdraws intent`, subtitle: 'Initial review', minutes: 57, took: 4, score: 4 },
  ]),
  ...pullRequest(2661, 2658, [
    { title: `Review PR #2661: ${tag(2658)} Give implementation runs and direct goals a read-only GitHub token`, subtitle: 'No blocking findings; token scope verified', minutes: 50, took: 8, score: 8 },
    ...Array.from({ length: 6 }, (_, index) => ({
      title: `Follow-up PR #2661: ${tag(2658)} Give implementation runs and direct goals a read-only GitHub token`,
      subtitle: ['Fix seedCommit test failure by updating repoBranching', 'Resolve AntigravityAgent git access conflicts', 'Update repoBranching.ts for read-only tokens', null, 'Tighten token scope checks', null][index],
      minutes: 60 + index * 30, score: index < 3 ? 8 : null,
      // Two runs recorded no summary: one pushed a commit, the other changed nothing.
      commitHash: index === 5 ? null : `9f3c2${index}e81a4d`,
    })),
  ]),
  ...pullRequest(2663, 2660, [
    { title: `Fix PR #2663: ${tag(2660)} Repo-owned workflow file with lifecycle hooks (.propr/workflow.yml)`, subtitle: 'Include validation reports in PR follow-up completion comments', minutes: 51, took: 6, score: 9, previewMedia: [preview('workflow-desktop'), preview('workflow-mobile')] },
    { title: `Review PR #2663: ${tag(2660)} Repo-owned workflow file with lifecycle hooks (.propr/workflow.yml)`, subtitle: 'Multi-model review with Opus and Astra', minutes: 60 },
    { title: `Fix PR #2663: ${tag(2660)} Repo-owned workflow file with lifecycle hooks (.propr/workflow.yml)`, subtitle: 'Address review findings F1 and F2', minutes: 120, score: 9, previewMedia: [preview('findings-desktop'), preview('findings-mobile')] },
    { title: `Review PR #2663: ${tag(2660)} Repo-owned workflow file with lifecycle hooks (.propr/workflow.yml)`, minutes: 125, took: 3 },
  ]),
  ...pullRequest(2662, 2657, [
    { title: `Merge PR #2662: ${tag(2657)} Create a self-hosted GitHub App in one command (propr github-app create)`, minutes: 62, took: 2, score: 8, planIssueStatus: 'merged' },
    { title: 'Followup: Update', minutes: 120, took: 1 },
    { title: `Ultrafix PR #2662: ${tag(2657)} Create a self-hosted GitHub App in one command (propr github-app create)`, subtitle: 'Fix GitHub App creation callback handling and review findings F1-F3', minutes: 130, took: 8, score: 8, previewMedia: [preview('callback-walkthrough', 'video')] },
  ]),
  ...pullRequest(2656, 2652, [
    { title: `Review PR #2656: ${tag(2652)} Show provider rate-limit resets in the usage panel`, status: 'queued', minutes: 140 },
    { title: `Fix PR #2656: ${tag(2652)} Show provider rate-limit resets in the usage panel`, subtitle: 'Format reset times in the viewer’s time zone', minutes: 150, took: 4, score: 8 },
  ]),
  ...pullRequest(2654, 2650, [
    { title: `Follow-up PR #2654: ${tag(2650)} Retry webhook deliveries that time out`, subtitle: 'Back off exponentially and cap retries at five', minutes: 165, took: 7, score: 9 },
    { title: `Review PR #2654: ${tag(2650)} Retry webhook deliveries that time out`, minutes: 190, took: 3 },
  ]),
  ...pullRequest(2653, 2649, [{ title: `Fix PR #2653: ${tag(2649)} Keep goal drafts when the session expires`, status: 'failed', minutes: 205, took: 11, failedReason: 'Unit tests failed: draftStore.test.ts' }]),
  ...pullRequest(2651, 2648, [
    { title: `Merge PR #2651: ${tag(2648)} Cache repository indexes between runs`, minutes: 220, took: 2, score: 9, planIssueStatus: 'merged' },
    { title: `Ultrafix PR #2651: ${tag(2648)} Cache repository indexes between runs`, subtitle: 'Invalidate the cache when the default branch moves', minutes: 235, took: 9, score: 8 },
    { title: `Review PR #2651: ${tag(2648)} Cache repository indexes between runs`, minutes: 250, took: 4 },
  ]),
  ...pullRequest(2647, 2645, [{ title: `Review PR #2647: ${tag(2645)} Add keyboard shortcuts to the plan editor`, subtitle: 'Shortcuts do not clash with browser defaults', minutes: 270, took: 5, score: 8 }]),
  {
    id: 'long-title', repository: 'integry/desktop-workspaces', repositoryOwner: 'integry', repositoryName: 'desktop-workspaces', issueNumber: 86,
    title: `New Issue: ${tag(86)} Support configuration/desktop/workspaces/a-very-long-unbroken-configuration-filename.json in the task history`,
    status: 'failed', createdAt: ago(300), processedAt: ago(300), completedAt: ago(262),
    llmProvider: 'claude', model: 'a-long-model-identifier-for-desktop-layout-verification', critiqueScore: 4,
  },
];

// What the details pane shows for the newest run of PR #2664.
export const selectedRun = 'pr-2664-run-0';
const tokenUsage = { input_tokens: 100_000, cache_read_input_tokens: 3_000_000, cache_creation_input_tokens: 800_000, output_tokens: 30_000 };
export const detailsHistory = [
  { state: 'PENDING', timestamp: ago(1), metadata: { model: 'gpt-6-astra' } },
  ...['Read the withdrawal handlers', 'Restrict withdrawal labels to intent', 'Run the lint suite'].map((description, index) => ({
    // The last step records the run's consumption, which the context strip reports after the runtime.
    state: 'CLAUDE_EXECUTION', timestamp: ago(1 - (index + 1) * 0.2), metadata: { model: 'gpt-6-astra', description, ...(index === 2 && { tokenUsage }) },
  })),
];
export const detailsEvents = [
  { id: 'thought-1', type: 'thought', timestamp: ago(0.8), content: 'Linting flagged the withdrawal handler; tightening the label check before rerunning.' },
  { id: 'tool-1', toolUseId: 'tool-1', type: 'tool_use', timestamp: ago(0.6), toolName: 'Bash', input: { command: 'npm run lint -w propr-ui' } },
  { id: 'result-1', toolUseId: 'tool-1', type: 'tool_result', timestamp: ago(0.5), result: 'eslint . --max-warnings 0\n✔ no problems' },
];

// An earlier run of PR #2664 (Run 3, a review), for moving back through the task's timeline.
export const historicalRun = 'pr-2664-run-5';
export const historicalHistory = [
  { state: 'PENDING', timestamp: ago(39), metadata: { model: 'gpt-6-astra' } },
  { state: 'CLAUDE_EXECUTION', timestamp: ago(38.8), metadata: { model: 'gpt-6-astra', description: 'Review the withdrawal handlers' } },
  { state: 'COMPLETED', timestamp: ago(36), metadata: { model: 'gpt-6-astra', tokenUsage: { input_tokens: 420_000, output_tokens: 12_000 } } },
];
export const historicalEvents = [
  { id: 'review-thought-1', type: 'thought', timestamp: ago(38), content: 'The label check also matches unrelated labels; flagging it as a finding.' },
  { id: 'review-tool-1', toolUseId: 'review-tool-1', type: 'tool_use', timestamp: ago(37.5), toolName: 'Bash', input: { command: 'grep -rn withdraw src/jobs' } },
  { id: 'review-result-1', toolUseId: 'review-tool-1', type: 'tool_result', timestamp: ago(37.4), result: 'src/jobs/withdrawalHandlers.ts:14: if (label.includes(\'withdraw\'))' },
];

export async function fixture(page: Page, platform?: 'macos' | 'linux') {
  await page.clock.install({ time: now });
  if (platform) await page.addInitScript(platform => {
    const profile = { id: 'layout-fixture', name: 'Preview workspace', kind: 'remote' as const, baseUrl: 'https://fixture.example.test' };
    window.__PROPR_DESKTOP__ = {
      isDesktop: true, platform,
      app: { onDeepLink: () => () => undefined },
      profiles: { list: async () => [profile], getActiveId: async () => profile.id, setActiveId: async () => undefined, save: async () => undefined, remove: async () => undefined },
      connection: { probe: async () => ({ status: 'ready' }) },
      authentication: { authenticate: async () => undefined },
      discovery: { supported: false, discover: async () => [] },
      localSetup: { supported: false, setup: async () => profile },
      externalBrowser: { open: async () => undefined },
    };
  }, platform);
  await page.route('**/api/**', route => {
    const pathname = new URL(route.request().url()).pathname;
    const responses: Record<string, unknown> = {
      '/api/auth/demo-mode': { demoMode: true },
      // Paged by task: 10 tasks (32 runs) of 1,842.
      '/api/tasks': { tasks, total: 1842, totalRuns: 14769 },
      '/api/instance/catalog': { agents: [{ id: 'fixture', name: 'Fixture agent', defaultModel: 'gpt-6-astra' }], repositories: [{ name: 'integry/propr' }] },
      '/api/queue/stats': { active: 1, waiting: 1, completed: 3, failed: 1 },
      '/api/stats/generating-plans': { count: 0 },
      '/api/stats/tasks': { summary: { total: 7, completed: 3, failed: 1, active: 1, waiting: 1 }, dailyCounts: [], statusDistribution: [], avgProcessingTime: [] },
      '/api/stats/overview': { usage: { total_cost_usd: 0, total_tokens: 0, models: {} }, tasks: { completed: 3, planned: 7, pr_iterations_avg: 1, merged_prs: 1, total_followups: 5 }, system: { repos_indexed: 2 } },
      '/api/stats/repositories': { repositories: [{ repository: 'integry/propr', total: 14768, completed: 3, failed: 1, inProgress: 1, successRate: 43 }, { repository: 'integry/desktop-workspaces', total: 1, completed: 0, failed: 1, inProgress: 0, successRate: 0 }] },
      '/api/notifications/unread-count': { unreadCount: 0 },
      '/api/notifications/preferences': { preferences: {}, quietHours: {}, badgeEnabled: false },
      [`/api/task/${selectedRun}/history`]: {
        history: detailsHistory,
        taskInfo: {
          title: `Ultrafix PR #2664: ${tag(2659)} Stop work when an issue or PR withdraws intent`, subtitle: 'Ultrafix cycle 3 (linting)',
          type: 'pr', number: 2664, issueNumber: 2664, repoOwner: 'integry', repoName: 'propr', modelName: 'gpt-6-astra',
        },
        usageMetricRecords: [{ agent: 'codex', metricKey: 'weeklyAll', metricValue: 0.4 }],
      },
      [`/api/task/${selectedRun}/live-details`]: { events: detailsEvents, todos: [], currentTask: null },
      [`/api/task/${selectedRun}/file-changes`]: {
        taskId: selectedRun, lastUpdated: ago(0.5),
        files: [{ path: 'src/jobs/withdrawalLabels.ts', linesAdded: 12, linesRemoved: 4, status: 'modified', diff: '@@ -1,4 +1,12 @@\n-export const WITHDRAW = true;\n+export const WITHDRAW = isIntentLabel(label);' }],
      },
      [`/api/task/${historicalRun}/history`]: {
        history: historicalHistory,
        taskInfo: {
          title: `Review PR #2664: ${tag(2659)} Stop work when an issue or PR withdraws intent`, subtitle: 'Found 2 issues',
          type: 'pr', number: 2664, issueNumber: 2664, repoOwner: 'integry', repoName: 'propr', modelName: 'gpt-6-astra',
        },
        usageMetricRecords: [{ agent: 'codex', metricKey: 'weeklyAll', metricValue: 0.1 }],
      },
      [`/api/task/${historicalRun}/live-details`]: { events: historicalEvents, todos: [], currentTask: null },
      [`/api/task/${historicalRun}/file-changes`]: {
        taskId: historicalRun, lastUpdated: ago(36),
        files: [{ path: 'src/jobs/withdrawalHandlers.ts', linesAdded: 3, linesRemoved: 1, status: 'modified', diff: '@@ -14,1 +14,3 @@\n-if (label.includes(\'withdraw\'))\n+if (isWithdrawalLabel(label))' }],
      },
    };
    return pathname in responses ? route.fulfill({ json: responses[pathname] }) : route.fulfill({ status: 503, json: { error: 'Unavailable in privacy-safe layout fixture' } });
  });
}

export const capture = async (page: Page, name: string) => {
  if (!process.env.PROPR_CAPTURE_PREVIEWS) return;
  const directory = path.resolve('../.propr/previews');
  await mkdir(directory, { recursive: true });
  await page.screenshot({ animations: 'disabled', path: path.join(directory, `${name}.png`) });
};
