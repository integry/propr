import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { AGENT_DEFAULTS, AGENT_MODELS } from '@propr/shared';

const codex = {
  id: 'codex-config', type: 'codex', alias: 'codex', enabled: true, dockerImage: 'propr/agent:bundle-b7815cf34f5c-476c91',
  configPath: AGENT_DEFAULTS.codex.configPath, supportedModels: AGENT_MODELS.codex.slice(0, 3).map(model => model.id),
  defaultModel: AGENT_MODELS.codex[0].id, cliVersionType: 'specific', cliVersion: '0.170.0', cliVersionResolved: '0.170.0',
};
const claude = {
  id: 'claude-config', type: 'claude', alias: 'claude', enabled: true, dockerImage: codex.dockerImage,
  configPath: AGENT_DEFAULTS.claude.configPath, supportedModels: AGENT_MODELS.claude.slice(0, 2).map(model => model.id),
  defaultModel: AGENT_MODELS.claude[0].id, cliVersionType: 'default',
};
const states = (codexState: Record<string, unknown>) => [
  { agentId: 'claude-config', alias: 'claude', type: 'claude', configuredVersion: '2.1.330', effectiveVersion: '2.1.330', status: 'ready' },
  { agentId: 'codex-config', alias: 'codex', type: 'codex', configuredVersion: '0.170.0', ...codexState },
];
const pending = states({ effectiveVersion: '0.171.0', status: 'preparing' });
const ready = states({ effectiveVersion: '0.170.0', status: 'ready' });

async function capture(page: Page, name: string) {
  if (!process.env.PROPR_CAPTURE_PREVIEWS) return;
  await mkdir('../.propr/previews', { recursive: true });
  await page.screenshot({ animations: 'disabled', path: `../.propr/previews/${name}.png` });
}

async function agentsFixture(page: Page, current: { states: unknown[] }) {
  await page.routeWebSocket('**/socket.io/**', socket => socket.close());
  await page.route('**/api/**', async route => {
    const pathname = new URL(route.request().url()).pathname;
    const responses: Record<string, unknown> = {
      '/api/auth/demo-mode': { demoMode: false },
      '/api/auth/user': {
        id: 'cli-fixture', login: 'cli-fixture', username: 'cli-fixture', displayName: 'CLI Fixture', email: null, avatarUrl: null,
        role: 'admin', permissions: ['instance.manage_agents'], authorizationSource: 'local',
      },
      '/api/config/agents': { agents: [claude, codex], cliVersionStates: current.states },
      '/api/config/synthetic-agents': { synthetic_agents: [] },
      '/api/config/agent-tank/status': { available: false },
      '/api/notifications/unread-count': { unreadCount: 0 },
      '/api/notifications': { notifications: [], unreadCount: 0, nextCursor: null },
    };
    if (/\/api\/agents\/[^/]+\/health$/.test(pathname)) return route.fulfill({ json: { agentId: pathname.split('/')[3], status: 'ready', model: 'fixture-model' } });
    if (pathname in responses) return route.fulfill({ json: responses[pathname] });
    return route.fulfill({ status: 503, json: { error: 'Unavailable in CLI version fixture' } });
  });
}

test('AI Agents shows a pending CLI version until the worker has prepared it', async ({ page }) => {
  const current = { states: pending };
  await page.clock.install();
  await agentsFixture(page, current);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/ai-agents');
  const configuration = page.getByTestId('ai-agents-configuration-pane');
  const status = configuration.getByTestId('agent-cli-version-status');
  await expect(status).toHaveCount(1);
  await expect(status).toContainText('Preparing the agent image for CLI 0.170.0');
  await expect(status).toContainText('Runs use CLI 0.171.0 until it is ready.');
  await capture(page, 'agent-cli-version-preparing-1440');

  current.states = ready;
  await page.clock.fastForward(11_000);
  await expect(status).toContainText('CLI 0.170.0 is now in effect.');
  await capture(page, 'agent-cli-version-ready-1440');
});

const taskId = 'task-cli-version-3750';
const at = (minute: number, second = 0) => `2026-11-20T18:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}.000Z`;

for (const width of [390, 1440]) {
  test(`task details shows the CLI version a run used at ${width}px`, async ({ page }) => {
    await page.routeWebSocket('**/socket.io/**', socket => socket.close());
    await page.route('**/api/**', async route => {
      const path = new URL(route.request().url()).pathname;
      const responses: Record<string, unknown> = {
        '/api/auth/demo-mode': { demoMode: true },
        [`/api/task/${taskId}/history`]: {
          history: [
            { state: 'PENDING', timestamp: at(10, 30), metadata: { model: 'gpt-6.1-sol' } },
            { state: 'PROCESSING', timestamp: at(10, 34) },
            { state: 'CLAUDE_EXECUTION', timestamp: at(10, 42), reason: 'Agent execution started' },
            {
              state: 'CLAUDE_EXECUTION', timestamp: at(10, 43), reason: 'Agent codex ran codex CLI 0.171.0; configured 0.170.0 was still being prepared',
              metadata: { event: 'agent.runtime', agentRuntime: { agentAlias: 'codex', agentType: 'codex', cliVersion: '0.171.0', image: 'propr/runtime-agent:6161a4bc69e523f7', configuredCliVersion: '0.170.0' } },
            },
            { state: 'CLAUDE_EXECUTION', timestamp: at(12, 20), reason: 'codex agent execution completed' },
            { state: 'POST_PROCESSING', timestamp: at(12, 24) },
            { state: 'COMPLETED', timestamp: at(12, 46) },
          ],
          taskInfo: { title: 'Pin Codex CLI while a regression is fixed', type: 'issue', number: 3750, issueNumber: 3750, repoOwner: 'acme', repoName: 'web', modelName: 'gpt-6.1-sol' },
          usageMetricRecords: [],
        },
        [`/api/task/${taskId}/live-details`]: { events: [], todos: [], currentTask: null },
        '/api/notifications/unread-count': { unreadCount: 0 },
        '/api/notifications/preferences': { preferences: {}, quietHours: {}, badgeEnabled: false },
      };
      return route.fulfill(path in responses ? { json: responses[path] } : { status: 503, json: { error: 'Unavailable in CLI version fixture' } });
    });
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/tasks/${taskId}`);
    await expect(page.getByText('Implementing Changes').first()).toBeVisible();
    const detail = page.getByTestId('agent-runtime-detail').first();
    if (!await detail.isVisible()) {
      await page.getByRole('button', { name: /Implementing Changes/ }).first().click();
    }
    await detail.scrollIntoViewIfNeeded();
    await expect(detail).toContainText('codex · codex CLI 0.171.0 (configured 0.170.0 was still being prepared)');
    await expect(page.getByText('Agent CLI', { exact: true })).toHaveCount(0);
    await capture(page, `task-agent-cli-version-${width}`);
  });
}
