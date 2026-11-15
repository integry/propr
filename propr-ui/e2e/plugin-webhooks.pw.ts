import { expect, test, type Page } from '@playwright/test';
import { BASE, DEFAULTS, NOW, capture, installFixture, step, view, type State } from './plugins.fixture';

/**
 * Webhook URLs in the plugin's Connect step against the plugin API fixture:
 * one URL per declared webhook with Copy, the rejected-request count and
 * Regenerate behind a confirmation, at desktop and phone widths. With
 * PROPR_CAPTURE_PREVIEWS set it captures the Connect step.
 */

const KEYS = ['Q3b9xYw1t0P8mN2k5JhGfDsAaZxCvBnMlKjHgFdSaQw', 'n7Fq2Lr8Xc4Vb1Mz9Kp3Wd6Ys0Gh5Jt2Ue8Ri4Oa1Qs'];
const WEBHOOKS = [
  { name: 'events', description: 'Issue tracker updates', scheme: 'hmac-sha256' },
  { name: 'slack', description: 'Slack Events API: mentions of the bot', scheme: 'slack-v0' },
];

/** The example plugin with two webhooks verified with a signing secret, its webhook routes, and the key generation in use. */
async function withWebhooks(page: Page, state: State) {
  const current = { key: 0, rejected: { count: 3, lastAt: NOW - 42 * 60_000, lastReason: 'bad_signature' as string | null } };
  const endpoints = () => ({
    webhooks: WEBHOOKS.map(w => ({ ...w, path: `/api/plugins/${KEYS[current.key]}/hooks/${w.name}`, url: `https://propr.example.com/api/plugins/${KEYS[current.key]}/hooks/${w.name}` })),
    rejected: current.rejected, keyCreatedAt: NOW, keyCreatedBy: current.key ? '1042' : 'system',
  });
  const plugin = () => {
    const base = view(state);
    return {
      ...base,
      manifest: {
        ...base.manifest,
        connections: [...base.manifest.connections, { type: 'signing_secret', name: 'example-signing', label: 'Webhook signing secret', help: 'Copy the signing secret from the service\'s webhook settings.', helpUrl: 'https://example.com/docs/webhooks' }],
        contributes: { ...base.manifest.contributes, webhooks: WEBHOOKS },
      },
      connections: [...base.connections, { name: 'example-signing', type: 'signing_secret', label: 'Webhook signing secret', state: 'connected', required: false, setBy: '1042', setAt: NOW }],
    };
  };
  await page.route('**/api/instance/plugins/v1/example-pack**', async route => {
    const request = route.request();
    const { pathname } = new URL(request.url());
    if (pathname === `${BASE}/example-pack` && request.method() === 'GET') return route.fulfill({ json: { plugin: { ...plugin(), audit: [] } } });
    if (pathname === `${BASE}/example-pack/webhooks` && request.method() === 'GET') return route.fulfill({ json: endpoints() });
    if (pathname === `${BASE}/example-pack/webhooks/regenerate` && request.method() === 'POST') {
      if (request.headers()['x-propr-plugins'] !== '1') return route.fulfill({ status: 403, json: { error: 'Plugin changes require the preflight-protected JSON contract' } });
      current.key = 1; current.rejected = { count: 0, lastAt: null, lastReason: null };
      return route.fulfill({ json: endpoints() });
    }
    return route.fallback();
  });
  return current;
}

test('shows each webhook URL with Copy, the rejected count and Regenerate in the Connect step', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const state: State = { installed: true, enabled: true, token: true, oauth: true, repositories: ['integry/propr'], refuseUninstall: false, settings: { ...DEFAULTS } };
  await page.setViewportSize({ width: 1440, height: 900 });
  await installFixture(page, state);
  await withWebhooks(page, state);
  await page.goto('/plugins/example-pack');
  const connect = step(page, 'Connect');
  const webhooks = connect.getByRole('region', { name: 'Webhook URLs' });
  await expect(webhooks.getByTestId('plugin-webhook')).toHaveCount(2);
  const events = webhooks.getByRole('textbox', { name: 'URL of webhook events' });
  await expect(events).toHaveValue(`https://propr.example.com/api/plugins/${KEYS[0]}/hooks/events`);
  await expect(webhooks).toContainText('HMAC-SHA256 signature');
  await expect(webhooks).toContainText('Slack signing secret');
  await expect(webhooks).toContainText('3 unverified requests rejected');

  await webhooks.getByRole('button', { name: 'Copy URL of webhook slack' }).click();
  await expect(webhooks.getByRole('button', { name: 'Copy URL of webhook slack' })).toHaveText('Copied');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`https://propr.example.com/api/plugins/${KEYS[0]}/hooks/slack`);
  await capture(page, 'plugins-webhook-urls-desktop', connect.getByTestId('plugin-connection').last());

  await webhooks.getByRole('button', { name: 'Regenerate' }).click();
  await expect(webhooks.getByRole('group', { name: 'Confirm regenerate' })).toContainText('Every URL above stops working at once');
  await capture(page, 'plugins-webhook-urls-regenerate-confirm-desktop', webhooks);
  await webhooks.getByRole('button', { name: 'Regenerate URLs' }).click();
  await expect(events).toHaveValue(`https://propr.example.com/api/plugins/${KEYS[1]}/hooks/events`);
  await expect(webhooks.getByRole('status')).toContainText('the old URLs no longer work');
  await expect(webhooks).toContainText('No unverified requests.');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(events).toHaveValue(`https://propr.example.com/api/plugins/${KEYS[1]}/hooks/events`);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await capture(page, 'plugins-webhook-urls-phone', webhooks);
});
