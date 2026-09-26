import { expect, test } from '@playwright/test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveInstanceWebPushConfiguration } from '../../packages/api/services/instanceWebPushConfiguration';

const preferences = Object.fromEntries([
  'plan', 'task', 'review', 'pull_request', 'indexing', 'system_failure',
].map(kind => [kind, { inboxEnabled: true, pushEnabled: false, updatedAt: null }]));

for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
  test(`automatic browser notification availability at ${viewport.width}px`, async ({ page }) => {
    const dataDirectory = mkdtempSync(path.join(tmpdir(), 'propr-browser-push-'));
    try {
      // Real startup resolver, no VAPID environment variables or production data.
      const configuration = resolveInstanceWebPushConfiguration({ DATA_DIR: dataDirectory });
      expect(configuration.configured).toBe(true);
      if (!configuration.configured) return;
      const publicKey = configuration.publicKey;
      let available = true;
      let mutations = 0;
      await page.setViewportSize(viewport);
      // Browser/provider boundary only: render the actual Settings page, API
      // parsers and useBrowserPush hook without contacting a push provider.
      await page.addInitScript(({ publicKey }) => {
        localStorage.setItem('preview-permission-requests', '0');
        const registration = { pushManager: {
          getSubscription: async () => null,
          subscribe: async (options: { applicationServerKey: Uint8Array; userVisibleOnly: boolean }) => {
            const encoded = btoa(String.fromCharCode(...options.applicationServerKey))
              .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
            if (encoded !== publicKey || !options.userVisibleOnly) throw new Error('Incorrect subscription key');
            return {
              endpoint: 'https://fcm.googleapis.com/fcm/send/preview-subscription',
              expirationTime: null,
              getKey: (name: string) => name === 'auth'
                ? new Uint8Array(16).buffer
                : Uint8Array.from(atob(publicKey.replace(/-/g, '+').replace(/_/g, '/')), character => character.charCodeAt(0)).buffer,
            };
          },
        } };
        Object.defineProperty(navigator, 'serviceWorker', { value: {
          getRegistration: async () => registration,
          register: async () => registration,
          addEventListener: () => undefined,
        } });
        Object.defineProperty(window, 'PushManager', { value: class {} });
        Object.defineProperty(Notification, 'permission', { get: () => 'default' });
        Notification.requestPermission = async () => {
          localStorage.setItem('preview-permission-requests', String(Number(localStorage.getItem('preview-permission-requests')) + 1));
          return 'granted';
        };
      }, { publicKey });
      await page.routeWebSocket('**/socket.io/**', socket => socket.close());
      await page.route('**/api/**', async route => {
        const pathname = new URL(route.request().url()).pathname;
        if (route.request().method() !== 'GET') mutations++;
        if (pathname === '/api/notifications/push-subscriptions' && route.request().method() === 'POST') {
          return route.fulfill({ json: { subscription: {
            id: 'preview-subscription', endpoint: route.request().postDataJSON().endpoint,
            expiresAt: null, revokedAt: null,
            createdAt: '2026-09-13T00:00:00.000Z', updatedAt: '2026-09-13T00:00:00.000Z',
          } } });
        }
        const responses: Record<string, unknown> = {
          '/api/auth/demo-mode': { demoMode: false },
          '/api/auth/user': {
            id: 'preview-user', login: 'preview', username: 'preview', displayName: 'Preview User',
            email: null, avatarUrl: null, role: 'admin', permissions: ['instance.manage_settings'], authorizationSource: 'local',
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
          '/api/notifications/config': { push: { configured: available, vapidPublicKey: available ? publicKey : null } },
          '/api/notifications/unread-count': { unreadCount: 0 },
          '/api/notifications/preferences': {
            preferences, quietHours: { start: null, end: null, timezone: 'UTC' }, badgeEnabled: true,
          },
          '/api/notifications/push-subscriptions': { subscriptions: [] },
        };
        if (pathname in responses) return route.fulfill({ json: responses[pathname] });
        return route.fulfill({ status: 503, json: { error: 'Unavailable in notification settings fixture' } });
      });
      await page.goto('/settings?tab=notifications');
      await expect(page.getByRole('button', { name: 'Enable on this browser' })).toBeEnabled();
      for (const category of ['Plans', 'Tasks', 'Reviews', 'Pull requests', 'Indexing', 'System failures']) {
        await expect(page.getByLabel(`Push notifications for ${category}`, { exact: true })).not.toBeChecked();
      }
      expect(mutations).toBe(0);
      await expect(page.getByText(/VAPID/)).toHaveCount(0);
      const capture = async (state: string) => {
        if (!process.env.PROPR_CAPTURE_PREVIEWS) return;
        const directory = path.resolve('../.propr/previews');
        mkdirSync(directory, { recursive: true });
        await page.screenshot({ animations: 'disabled', fullPage: true,
          path: path.join(directory, `web-push-${state}-${viewport.width}.png`) });
      };
      await capture('ready');
      expect(await page.evaluate(() => localStorage.getItem('preview-permission-requests'))).toBe('0');
      await page.getByRole('button', { name: 'Enable on this browser' }).click();
      await expect(page.getByText('This browser is subscribed.')).toBeVisible();
      expect(await page.evaluate(() => localStorage.getItem('preview-permission-requests'))).toBe('1');
      expect(mutations).toBe(1);
      for (const category of ['Plans', 'Tasks', 'Reviews', 'Pull requests', 'Indexing', 'System failures']) {
        await expect(page.getByLabel(`Push notifications for ${category}`, { exact: true })).not.toBeChecked();
      }
      available = false;
      await page.reload();
      await expect(page.getByText(/Browser notifications are unavailable for this ProPR instance/)).toBeVisible();
      await expect(page.getByRole('button', { name: 'Enable on this browser' })).toHaveCount(0);
      await expect(page.getByText(/VAPID/)).toHaveCount(0);
      expect(mutations).toBe(1);
      await capture('unavailable');
    } finally { rmSync(dataDirectory, { recursive: true, force: true }); }
  });
}
