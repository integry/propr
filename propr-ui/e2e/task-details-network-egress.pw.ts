import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

const taskId = 'task-network-egress-2743';
const at = (minute: number, second = 0) => `2026-10-06T21:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}.000Z`;

const networkEgress = {
  mode: 'restricted', source: 'workflow', allow: ['registry.npmjs.org', '*.internal.example.com'], restrictedContainers: 1, fallbacks: [],
  allowedConnections: 214, deniedConnections: 9,
  deniedHosts: [{ host: 'telemetry.example.net', count: 5 }, { host: 'paste.example.org', count: 3 }, { host: 'cdn.jsdelivr.net', count: 1 }],
  omittedDeniedHosts: 0, omittedDeniedAttempts: 0,
};

async function fixture(page: Page) {
  await page.routeWebSocket('**/socket.io/**', socket => socket.close());
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    const responses: Record<string, unknown> = {
      '/api/auth/demo-mode': { demoMode: true },
      [`/api/task/${taskId}/history`]: {
        history: [
          { state: 'PENDING', timestamp: at(3), metadata: { model: 'claude-opus-5-5' } },
          { state: 'PROCESSING', timestamp: at(3, 4) },
          { state: 'CLAUDE_EXECUTION', timestamp: at(4), reason: 'Agent execution started' },
          { state: 'CLAUDE_EXECUTION', timestamp: at(21), reason: 'Restricted network: denied 9 connections to 3 hosts', metadata: { event: 'network.egress', networkEgress } },
          { state: 'CLAUDE_EXECUTION', timestamp: at(21, 2), reason: 'claude agent execution completed' },
          { state: 'POST_PROCESSING', timestamp: at(21, 5) },
          { state: 'COMPLETED', timestamp: at(22) },
        ],
        taskInfo: { title: 'Restricted network egress for agent containers', type: 'issue', number: 2743, issueNumber: 2743, repoOwner: 'acme', repoName: 'web', modelName: 'claude-opus-5-5' },
        usageMetricRecords: [],
      },
      [`/api/task/${taskId}/live-details`]: { events: [], todos: [], currentTask: null },
      '/api/notifications/unread-count': { unreadCount: 0 },
      '/api/notifications/preferences': { preferences: {}, quietHours: {}, badgeEnabled: false },
    };
    return route.fulfill(path in responses ? { json: responses[path] } : { status: 503, json: { error: 'Unavailable in network egress fixture' } });
  });
}

for (const width of [390, 1440]) {
  test(`task details shows the run's network mode and denied hosts at ${width}px`, async ({ page }) => {
    await fixture(page);
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/tasks/${taskId}`);
    const network = page.getByTestId('network-egress').first();
    await network.scrollIntoViewIfNeeded();
    await expect(network).toContainText('Network: restricted · .propr/workflow.yml');
    await expect(network).toContainText('telemetry.example.net × 5');
    await expect(network).toContainText('cdn.jsdelivr.net × 1');
    if (process.env.PROPR_CAPTURE_PREVIEWS) {
      await mkdir('../.propr/previews', { recursive: true });
      await page.screenshot({ animations: 'disabled', path: `../.propr/previews/task-network-egress-${width}.png` });
    }
  });
}
