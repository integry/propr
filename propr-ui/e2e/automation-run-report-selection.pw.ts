import { expect, test, type Page } from '@playwright/test';
import { user } from './dashboard-sections.fixture';

/**
 * A reader's selection in a run report must survive the page's background
 * refreshes: the run's own reload while it is not terminal, and the
 * automation list's run-state reads beside it.
 */
const now = Date.parse('2026-11-17T09:00:00.000Z');

const definition = {
  id: 'def-report', ownerId: user.id, name: 'Dependency review', description: '',
  repositories: ['integry/propr'], prompt: 'Review dependencies.', attachments: [], agentAlias: 'codex-main',
  modelName: 'gpt-5.6-sol', capabilities: ['repository_read'], includePreviousReports: false, previousReportsLimit: 0,
  scheduleCron: null, scheduleTimezone: 'UTC', scheduleEnabled: false, nextRunAt: null, autonomyMode: 'preview',
  enabled: true, revision: 1, createdAt: now - 86_400_000, updatedAt: now - 86_400_000,
};
// A second automation whose latest run is still going, so the list reads run states every 5 seconds.
const busyDefinition = { ...definition, id: 'def-busy', name: 'Issue triage' };

const paragraphs = Array.from({ length: 40 }, (_, index) =>
  `Finding ${index + 1}: the **lodash** dependency in package ${index + 1} is outdated and should be upgraded before the release.`);
const report = `# Weekly findings\n\n${paragraphs.join('\n\n')}`;

const baseRun = {
  definitionId: definition.id, ownerId: user.id, trigger: 'manual', triggerSource: 'user:829273', idempotencyKey: null,
  autonomyMode: 'preview', definitionSnapshot: null, reportTaskId: 'task-report', actionTaskId: null, report,
  reportTruncated: false, actionSummary: null, skipReason: null, failureReason: null, approvedBy: null, operatorNote: null,
  deferredUntil: null, deferrals: 0, createdAt: now - 600_000, startedAt: now - 590_000, reportedAt: now - 300_000, updatedAt: now - 300_000,
};
const finished = { ...baseRun, id: 'run-finished', state: 'completed', finishedAt: now - 300_000 };
const needsReview = { ...baseRun, id: 'run-review', state: 'awaiting_approval', finishedAt: null };

async function fixture(page: Page) {
  const runReads = new Map<string, number>();
  await page.clock.install({ time: now });
  await page.routeWebSocket('**/socket.io/**', socket => socket.close());
  await page.route('**/api/**', route => {
    const { pathname } = new URL(route.request().url());
    const run = [finished, needsReview].find(candidate => pathname === `/api/automation-runs/${candidate.id}`);
    if (run) {
      runReads.set(run.id, (runReads.get(run.id) ?? 0) + 1);
      // A fresh copy every time, as the server answers.
      return route.fulfill({ json: { run: structuredClone(run) } });
    }
    const responses: Record<string, unknown> = {
      '/api/auth/demo-mode': { demoMode: false },
      '/api/auth/user': user,
      '/api/instance/catalog': {
        agents: [{ alias: 'codex-main', type: 'codex', enabled: true, supportedModels: ['gpt-5.6-sol'], defaultModel: 'gpt-5.6-sol' }],
        defaultAgentAlias: 'codex-main',
        repositories: [{ name: 'integry/propr', enabled: true }],
      },
      '/api/automation-definitions': { definitions: [definition, busyDefinition], total: 2, limit: 200, offset: 0 },
      [`/api/automation-definitions/${definition.id}`]: { definition },
      [`/api/automation-definitions/${definition.id}/runs`]: { runs: [needsReview, finished], total: 2, limit: 20, offset: 0 },
      [`/api/automation-definitions/${busyDefinition.id}/runs`]: { runs: [{ ...needsReview, id: 'run-busy', definitionId: busyDefinition.id, state: 'running' }], total: 1, limit: 1, offset: 0 },
      [`/api/automation-definitions/${definition.id}/capacity`]: { capacity: { status: 'ok', sessionPercent: 20, provider: 'codex' }, threshold: 90 },
      '/api/tasks': { tasks: [], total: 0 },
      '/api/notifications/unread-count': { unreadCount: 0 },
      '/api/notifications/preferences': { preferences: {}, quietHours: {}, badgeEnabled: false },
    };
    return route.fulfill(pathname in responses ? { json: responses[pathname] } : { status: 503, json: { error: 'Unavailable in report fixture' } });
  });
  return { reads: (id: string) => runReads.get(id) ?? 0 };
}

/** Selects the text of one report paragraph, as a reader dragging over it would. */
const selectParagraph = (page: Page, text: string) => page.getByTestId('agent-run-report').getByText(text).evaluate(element => {
  const range = document.createRange();
  range.selectNodeContents(element);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  (window as unknown as { selectedNode: Node }).selectedNode = element;
  return selection.toString();
});

const selectionState = (page: Page) => page.evaluate(() => {
  const selection = window.getSelection()!;
  const selected = (window as unknown as { selectedNode: Node }).selectedNode;
  return { text: selection.toString(), connected: selected.isConnected };
});

for (const [label, run, terminal] of [['a finished run', finished, true], ['a run waiting for approval', needsReview, false]] as const) {
  test(`keeps a selection and the scroll position in the report of ${label} across 35 seconds of background refreshes`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const server = await fixture(page);
    await page.goto(`/automations/${definition.id}/runs/${run.id}`);
    await expect(page.getByTestId('agent-run-report').getByText('Finding 1:', { exact: false })).toBeVisible();

    const pane = page.getByTestId('agent-runs-pane');
    await pane.evaluate(element => { element.scrollTop = 900; });
    const target = /^Finding 12: the/;
    const selected = await selectParagraph(page, 'Finding 12: the');
    expect(selected).toMatch(target);

    await page.clock.runFor(35_000);

    // A finished run is read once; a run waiting for approval keeps being read every 10 seconds.
    if (terminal) expect(server.reads(run.id)).toBe(1);
    else expect(server.reads(run.id)).toBeGreaterThanOrEqual(3);
    const after = await selectionState(page);
    expect(after.connected).toBe(true);
    expect(after.text).toBe(selected);
    expect(await pane.evaluate(element => element.scrollTop)).toBe(900);
  });
}
