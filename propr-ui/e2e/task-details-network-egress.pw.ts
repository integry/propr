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

// Enforced mode refused Antigravity, the pool failed over to Claude behind the proxy, and the worker's proxy refused one allowed host.
const mixedNetworkEgress = {
  mode: 'restricted', source: 'instance_enforced', allow: [], restrictedContainers: 1, fallbacks: [],
  refusals: [{ agentType: 'antigravity', reason: 'Antigravity CLI has not been verified to send its Google sign-in and API traffic through HTTPS_PROXY.' }],
  allowedConnections: 41, deniedConnections: 0, deniedHosts: [], omittedDeniedHosts: 0, omittedDeniedAttempts: 0,
  failedConnections: 2, failedHosts: [{ host: 'registry.npmjs.org', count: 2 }],
};

async function fixture(page: Page, egress: object = networkEgress, reason = 'Restricted network: denied 9 connections to 3 hosts') {
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
          { state: 'CLAUDE_EXECUTION', timestamp: at(21), reason, metadata: { event: 'network.egress', networkEgress: egress } },
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

for (const width of [390, 1440]) {
  test(`a refusal followed by a proxied run is labelled by its outcome, with failed upstream connections, at ${width}px`, async ({ page }) => {
    await fixture(page, mixedNetworkEgress, 'Restricted network: no connections denied; 2 allowed connections failed');
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/tasks/${taskId}`);
    const network = page.getByTestId('network-egress').first();
    await network.scrollIntoViewIfNeeded();
    await expect(page.getByText('Restricted Network', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('Restricted Network: Agent Refused')).toHaveCount(0);
    await expect(network).toContainText('antigravity refused (restricted mode is enforced)');
    await expect(network).toContainText('2 allowed connections failed upstream: registry.npmjs.org × 2');
    if (process.env.PROPR_CAPTURE_PREVIEWS) {
      await mkdir('../.propr/previews', { recursive: true });
      await page.screenshot({ animations: 'disabled', path: `../.propr/previews/task-network-egress-outcome-${width}.png` });
    }
  });
}
