import { expect, test, type Page } from '@playwright/test';
import { INSTANCE_PERMISSIONS } from '@propr/shared';

// Reads the API refuses for the read-only demo viewer (packages/api/demoViewerRoutes.ts).
// Each would log "Failed to load resource: … status of 403" in the demo's console.
const DEMO_REFUSED_READS = [
  '/api/config/agent-tank',
  '/api/config/agent-tank/status',
  '/api/config/agent-tank/history',
  '/api/config/agent-tank/detect',
  '/api/instance/extensions/v1',
  '/api/instance/extensions/v1/history',
  '/api/agent-runtime/packages',
  '/api/config/visual-preview-auth',
  '/api/config/preview-storage',
];

const demoUser = {
  id: 'propr-demo', login: 'propr-demo', username: 'propr-demo', displayName: 'propr-demo',
  email: null, avatarUrl: null, role: 'member', permissions: [...INSTANCE_PERMISSIONS], authorizationSource: 'demo',
};

async function demoInstance(page: Page) {
  const requested: string[] = [];
  const consoleErrors: string[] = [];
  page.on('console', message => {
    if (message.type() === 'error' && /status of 4\d\d/.test(message.text())) consoleErrors.push(`${message.text()} ${message.location().url}`);
  });
  await page.route('**/api/**', route => {
    const pathname = new URL(route.request().url()).pathname;
    if (DEMO_REFUSED_READS.includes(pathname)) {
      requested.push(pathname);
      // What the demo API answers (refuseDemoViewer).
      return route.fulfill({ status: 403, json: { error: 'Forbidden', code: 'DEMO_MODE_LIVE_DATA_UNAVAILABLE', message: 'This view reads live installation state, which the read-only demo does not expose.' } });
    }
    const responses: Record<string, unknown> = {
      '/api/auth/demo-mode': { demoMode: true },
      '/api/auth/user': demoUser,
      '/api/config/agent-tank/usage': { enabled: false, agents: {} },
      '/api/tasks': { tasks: [], total: 0 },
      '/api/notifications/unread-count': { unreadCount: 0 },
      '/api/status': { status: 'ok' },
    };
    // Everything else is out of scope here; a 5xx keeps it out of the 4xx check below.
    return pathname in responses
      ? route.fulfill({ json: responses[pathname] })
      : route.fulfill({ status: 503, json: { error: 'Unavailable in the demo-mode fixture' } });
  });
  return { requested, consoleErrors };
}

for (const [name, url] of [
  ['Dashboard', '/'],
  ['Analytics', '/analytics'],
  ['Coding agents', '/ai-agents'],
  ['LLM Log', '/llm-logs'],
  ['Settings', '/settings'],
  ['New automation', '/automations/new'],
] as const) {
  test(`demo mode: ${name} requests no administrator-only read and logs no 4xx`, async ({ page }) => {
    const { requested, consoleErrors } = await demoInstance(page);
    await page.goto(url);
    await expect(page.getByText(/demo/i).first()).toBeVisible();
    // Let mount effects and their first reads settle.
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(500);
    expect(requested).toEqual([]);
    expect(consoleErrors).toEqual([]);
  });
}
