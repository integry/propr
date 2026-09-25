import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

/**
 * The Logs sidebar group and the MCP Log page. These checks guard the
 * structure; with PROPR_CAPTURE_PREVIEWS set they also capture the sidebar
 * group and the page (populated and empty) at desktop and mobile widths.
 */

const NOW = Date.parse('2026-09-24T12:00:00.000Z');

const CLIENTS = [
  { clientId: 'client-claude', clientName: 'Claude Desktop' },
  { clientId: 'client-cursor', clientName: 'Cursor' },
];

const ROWS = Array.from({ length: 12 }, (_, index) => {
  const outcome = index === 2 ? 'denied' : index === 5 ? 'error' : 'success';
  const client = CLIENTS[index % CLIENTS.length];
  return {
    id: 100 - index,
    occurredAt: NOW - index * 90_000,
    ownerId: index % 3 === 0 ? '1042' : '2087',
    grantId: `grant-${index}`,
    clientId: client.clientId,
    clientName: client.clientName,
    membershipSource: 'local',
    kind: index % 4 === 3 ? 'resource' : 'tool',
    name: ['propr_list_tasks', 'propr_get_task', 'propr_create_plan', 'propr_repository_tree'][index % 4],
    repository: index % 2 === 0 ? 'integry/propr' : 'integry/propr-docs',
    scope: 'read',
    readOnly: true,
    status: outcome === 'success' ? 200 : outcome === 'denied' ? 403 : 500,
    outcome,
    errorCode: outcome === 'denied' ? 'FORBIDDEN_REPOSITORY' : outcome === 'error' ? 'INTERNAL_ERROR' : null,
    durationMs: 40 + index * 37,
    resultBytes: 512 + index * 733,
    operationId: null,
    protocolVersion: '2026-06-18',
    requestId: String(index),
  };
});

const STATS = {
  window: { since: NOW - 24 * 60 * 60 * 1000, until: NOW },
  total: 1284,
  outcomes: { success: 1249, denied: 27, error: 8 },
  topTools: [
    { name: 'propr_list_tasks', count: 604 },
    { name: 'propr_get_task', count: 311 },
    { name: 'propr_create_plan', count: 96 },
  ],
  topClients: [
    { clientId: 'client-claude', clientName: 'Claude Desktop', count: 902 },
    { clientId: 'client-cursor', clientName: 'Cursor', count: 382 },
  ],
  topRepositories: [{ repository: 'integry/propr', count: 1100 }],
  errorCodes: [{ errorCode: 'FORBIDDEN_REPOSITORY', count: 27 }],
  durationMs: { p50: 118, p95: 2460 },
};

/** The fixture honours the filters the page sends, the way the API does. */
function matchingRows(query: URLSearchParams): typeof ROWS {
  const fields: Array<[string, (row: typeof ROWS[number]) => string | null]> = [
    ['outcome', row => row.outcome],
    ['kind', row => row.kind],
    ['name', row => row.name],
    ['repository', row => row.repository],
    ['clientId', row => row.clientId],
    ['ownerId', row => row.ownerId],
  ];
  return ROWS.filter(row => fields.every(([key, read]) => !query.get(key) || query.get(key) === read(row)));
}

async function installFixture(page: Page, { empty = false } = {}): Promise<void> {
  await page.routeWebSocket('**/socket.io/**', socket => socket.close());
  await page.route('**/api/**', async route => {
    const { pathname, searchParams } = new URL(route.request().url());
    const rows = empty ? [] : matchingRows(searchParams);
    const responses: Record<string, unknown> = {
      '/api/auth/demo-mode': { demoMode: false },
      '/api/auth/user': {
        id: '1042', login: 'preview', username: 'preview', displayName: 'Preview Operator',
        email: null, avatarUrl: null, role: 'admin',
        permissions: ['instance.manage_settings', 'instance.manage_members', 'instance.manage_agents'],
        authorizationSource: 'local',
      },
      '/api/admin/mcp/logs': {
        data: rows,
        pagination: {
          page: 1, limit: 50, offset: 0,
          total: rows.length ? 128 : 0, totalPages: rows.length ? 3 : 0,
          hasNextPage: rows.length > 0, hasPreviousPage: false,
        },
        filters: {},
      },
      '/api/admin/mcp/logs/stats': {
        data: empty
          ? { ...STATS, total: 0, outcomes: { success: 0, denied: 0, error: 0 }, topTools: [], topClients: [], durationMs: { p50: null, p95: null } }
          : STATS,
      },
      '/api/notifications/unread-count': { unreadCount: 0 },
      '/api/notifications/config': { push: { configured: false, vapidPublicKey: null } },
    };
    if (pathname in responses) return route.fulfill({ json: responses[pathname] });
    return route.fulfill({ status: 503, json: { error: 'Unavailable in the MCP log fixture' } });
  });
}

async function capture(page: Page, name: string): Promise<void> {
  if (!process.env.PROPR_CAPTURE_PREVIEWS) return;
  const directory = path.resolve('../.propr/previews');
  await mkdir(directory, { recursive: true });
  await page.screenshot({ animations: 'disabled', path: path.join(directory, `${name}.png`) });
}

test('groups the log destinations in the sidebar and lists MCP requests', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await installFixture(page);
  await page.goto('/mcp-logs');

  // The group is open because the current page is one of its children, and it
  // holds both log destinations.
  const group = page.getByRole('navigation').getByRole('button', { name: 'Logs' });
  await expect(group).toHaveAttribute('aria-expanded', 'true');
  const panel = page.locator(`#${await group.getAttribute('aria-controls')}`);
  await expect(panel.getByRole('link', { name: 'LLM Log' })).toHaveAttribute('href', '/llm-logs');
  await expect(panel.getByRole('link', { name: 'MCP Log' })).toHaveAttribute('href', '/mcp-logs');

  // The window summary and the newest-first table.
  const summary = page.getByRole('group', { name: 'MCP access summary' });
  await expect(summary.getByText('1,284')).toBeVisible();
  await expect(summary.getByText('2.5s')).toBeVisible();
  const table = page.getByRole('table');
  await expect(table.getByText('Denied').first()).toBeVisible();
  // The error code has its own column at this width, not just the compact
  // secondary line the narrow layout falls back to.
  await expect(table.getByRole('cell', { name: 'FORBIDDEN_REPOSITORY', exact: true })).toBeVisible();
  await capture(page, 'mcp-log-desktop');

  // Filters compose into the URL so the view can be shared.
  await page.getByLabel('Outcome').selectOption('denied');
  await expect(page).toHaveURL(/outcome=denied/);
  await expect(table.getByRole('row')).toHaveCount(2); // header + the one denied request
  await capture(page, 'mcp-log-desktop-filtered');

  await group.click();
  await expect(group).toHaveAttribute('aria-expanded', 'false');
  await expect(panel.getByRole('link', { name: 'MCP Log' })).toBeHidden();
});

test('renders a legible empty state', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await installFixture(page, { empty: true });
  await page.goto('/mcp-logs');

  await expect(page.getByText(/No MCP requests recorded in this window/)).toBeVisible();
  await capture(page, 'mcp-log-empty');
});

test('keeps the log usable on a phone', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 780 });
  await installFixture(page);
  await page.goto('/mcp-logs');

  await expect(page.getByRole('table')).toBeVisible();
  // No identifier is truncated by a horizontal scroll: the secondary columns
  // are dropped instead.
  const overflow = await page.evaluate(() => {
    const element = document.scrollingElement!;
    return element.scrollWidth - element.clientWidth;
  });
  expect(overflow).toBeLessThanOrEqual(1);
  await capture(page, 'mcp-log-mobile');
});
