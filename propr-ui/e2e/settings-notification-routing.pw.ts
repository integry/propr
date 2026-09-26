import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const notificationPreferences = Object.fromEntries([
  'plan', 'task', 'review', 'pull_request', 'indexing', 'system_failure',
].map(kind => [kind, { inboxEnabled: true, pushEnabled: false, updatedAt: null }]));

async function installDesktopSettingsFixture(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const profile = {
      id: 'notification-preview',
      name: 'Preview workspace',
      baseUrl: window.location.origin,
      kind: 'local' as const,
    };
    const settings = {
      scope: 'account-instance-device' as const,
      capability: { supported: true, platform: 'darwin' as const, permission: 'unknown' as const },
      preferences: {
        enabled: false,
        taskStarted: true,
        taskCompleted: true,
        taskFailed: true,
        taskNeedsAttention: true,
      },
    };
    const noop = async () => undefined;
    window.__PROPR_DESKTOP__ = {
      isDesktop: true,
      platform: 'macos',
      app: { onDeepLink: () => () => undefined },
      profiles: {
        list: async () => [profile],
        save: noop,
        remove: noop,
        getActiveId: async () => profile.id,
        setActiveId: noop,
      },
      discovery: { supported: false, discover: async () => [] },
      authentication: { authenticate: noop },
      externalBrowser: { open: noop },
      localSetup: { supported: false, setup: async () => profile },
      connection: {
        probe: async () => ({
          status: 'ready',
          version: '0.8.15',
          profileId: profile.id,
          transportScope: 'abcdefghijklmnopqrstuv',
        }),
      },
      notifications: {
        get: async () => settings,
        update: async (_scope, change) => ({
          ...settings,
          preferences: { ...settings.preferences, ...change },
        }),
        test: async () => ({ status: 'failed' as const }),
        publish: async () => ({ accepted: false }),
        clear: noop,
        onSettingsChanged: () => () => undefined,
        onNavigate: () => () => undefined,
      },
    };
  });

  await page.routeWebSocket('**/socket.io/**', socket => socket.close());
  await page.route('**/api/**', async route => {
    const pathname = new URL(route.request().url()).pathname;
    const responses: Record<string, unknown> = {
      '/api/auth/demo-mode': { demoMode: false },
      '/api/auth/user': {
        id: 'preview-user', login: 'preview', username: 'preview', displayName: 'Preview User',
        email: null, avatarUrl: null, role: 'admin', permissions: ['instance.manage_settings'],
        authorizationSource: 'local',
      },
      '/api/config/settings': {},
      '/api/config/followup-keywords': { followup_keywords: [] },
      '/api/config/followup-ignore-keywords': { followup_ignore_keywords: [] },
      '/api/config/pr-label': { pr_label: 'propr' },
      '/api/config/primary-processing-labels': { primary_processing_labels: ['AI'] },
      '/api/config/agents': { agents: [] },
      '/api/config/summarization': { enabled: false, agent_alias: '', fallback_agent_alias: '' },
      '/api/config/agent-tank': { enabled: false, url: 'http://0.0.0.0:3456' },
      '/api/instance/catalog': { agents: [], repositories: [] },
      '/api/notifications/config': { push: { configured: false, vapidPublicKey: null } },
      '/api/notifications/unread-count': { unreadCount: 0 },
      '/api/notifications/preferences': {
        preferences: notificationPreferences,
        quietHours: { start: null, end: null, timezone: 'UTC' },
        badgeEnabled: true,
      },
    };
    if (pathname in responses) return route.fulfill({ json: responses[pathname] });
    return route.fulfill({ status: 503, json: { error: 'Unavailable in notification settings fixture' } });
  });
}

test('routes desktop notification settings into the native controls', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 820 });
  await installDesktopSettingsFixture(page);
  await page.goto('/settings?tab=notifications');

  await expect(page.getByRole('tab', { name: /Notifications/ })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('heading', { name: 'Desktop notifications' })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: 'Enable desktop notifications on this device' })).not.toBeChecked();

  await page.getByRole('tab', { name: /Automation/ }).click();
  await expect(page).toHaveURL(/\/settings\?tab=automation$/);
  await page.evaluate(() => {
    history.pushState({}, '', '/settings?tab=notifications');
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  await expect(page.getByRole('heading', { name: 'Desktop notifications' })).toBeVisible();

  if (process.env.PROPR_CAPTURE_PREVIEWS) {
    const directory = path.resolve('../.propr/previews');
    await mkdir(directory, { recursive: true });
    await page.getByRole('checkbox', { name: 'Enable desktop notifications on this device' }).click();
    await page.getByRole('button', { name: 'Send test notification' }).click();
    await expect(page.getByText(/macOS rejected the test notification/)).toBeVisible();
    await page.screenshot({ animations: 'disabled', path: path.join(directory, 'desktop-notification-settings.png') });
  }
});
