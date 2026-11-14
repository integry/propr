import { expect, test, type BrowserContext, type Page, type Route } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { installSettingsFixture } from './settings-layout.fixture';

/**
 * Drives Connect of an OAuth MCP server against a synthetic provider: the
 * extension API, the provider's authorization page and ProPR's callback are
 * all served by routes, so the browser walks the real redirect sequence:
 * Settings → new tab → provider consent → callback result page → back to Settings.
 */
const instanceId = 'c63a25da-fd5e-4a46-8fe1-566136e12289';
const API_ORIGIN = 'https://propr-api.fixture.test';
const PROVIDER = 'https://auth.fixture.test';
const REDIRECT_URI = `${API_ORIGIN}/api/instance/extensions/v1/oauth/callback`;
const docs = { kind: 'https', name: 'linear', url: 'https://mcp.linear.fixture.test/mcp', enabled: true, tools: ['search_issues'], capability: 'read', authentication: 'oauth', repositories: [], agents: [], autoApply: true };
const library = { version: 1, instanceId, revision: 2, servers: [docs], skills: [], secrets: {}, skillBundles: [], createdAt: 1791907200000, updatedAt: 1791907200000, auditActor: '1' };

async function syntheticProvider(page: Page, context: BrowserContext) {
  const state = { connections: {} as Record<string, unknown>, issuedState: '', starts: 0, callbacks: [] as string[] };
  await page.route('**/api/instance/catalog', route => route.fulfill({ json: { agents: [], repositories: [] } }));
  const extensionApi = async (route: Route) => {
    const request = route.request(); const url = new URL(request.url());
    if (url.pathname.endsWith('/oauth/start')) {
      expect(request.headers()['x-propr-extensions']).toBe('1');
      expect(request.postDataJSON()).toEqual({ name: 'linear' });
      state.starts++; state.issuedState = `state-${state.starts}-${'x'.repeat(30)}`;
      const authorize = new URL(`${PROVIDER}/authorize`);
      for (const [key, value] of Object.entries({ response_type: 'code', client_id: `${API_ORIGIN}/api/instance/extensions/v1/oauth/client-metadata.json`, redirect_uri: REDIRECT_URI, code_challenge: 'c'.repeat(43), code_challenge_method: 'S256', state: state.issuedState, resource: docs.url, scope: 'issues:read' })) authorize.searchParams.set(key, value);
      return route.fulfill({ json: { authorizationUrl: authorize.toString() } });
    }
    if (url.pathname.endsWith('/oauth/callback')) {
      state.callbacks.push(url.search);
      const ok = url.searchParams.get('state') === state.issuedState && url.searchParams.get('code') === 'synthetic-code' && url.searchParams.get('iss') === PROVIDER;
      if (ok) state.connections.linear = { state: 'connected', connectedBy: '1', connectedAt: 1791910800000, scopes: ['issues:read'], registration: 'metadata_document' };
      return route.fulfill({ status: ok ? 200 : 400, contentType: 'text/html', body: `<!doctype html><title>${ok ? 'Connected' : 'Sign-in not completed'} · ProPR</title><main><h1>${ok ? 'Connected' : 'Sign-in not completed'}</h1><p>You can close this tab; the Settings tab refreshes when you return to it.</p></main>` });
    }
    return route.fulfill({ json: { instanceId, library, bundles: [], catalog: [], oauth: { redirectUri: REDIRECT_URI, clientMetadataUrl: `${API_ORIGIN}/api/instance/extensions/v1/oauth/client-metadata.json`, connections: { linear: { state: 'not_connected' }, ...state.connections } } } });
  };
  // The Settings page's own routes take precedence over context routes; the new tab only has the context's.
  await page.route('**/api/instance/extensions/v1**', extensionApi);
  await context.route(`${API_ORIGIN}/api/instance/extensions/v1/**`, extensionApi);
  // The provider's consent page: checks the request and sends the administrator back with a code.
  await context.route(`${PROVIDER}/**`, route => {
    const url = new URL(route.request().url());
    const valid = url.searchParams.get('code_challenge_method') === 'S256' && url.searchParams.get('resource') === docs.url && url.searchParams.get('redirect_uri') === REDIRECT_URI;
    const callback = `${REDIRECT_URI}?${new URLSearchParams({ code: 'synthetic-code', state: url.searchParams.get('state') ?? '', iss: PROVIDER })}`;
    return route.fulfill({ contentType: 'text/html', body: `<!doctype html><title>Synthetic provider</title><main><h1>Allow ProPR to access Linear?</h1>${valid ? `<a id="allow" href="${callback}">Allow</a>` : '<p>Invalid request</p>'}</main>` });
  });
  return state;
}

test('Connect signs in to an OAuth MCP server in a new tab and the row shows Connected afterwards', async ({ page, context }) => {
  await installSettingsFixture(page);
  const provider = await syntheticProvider(page, context);
  await page.setViewportSize({ width: 1280, height: 1200 });
  await page.goto('/settings?tab=agent-extensions');
  const section = page.getByRole('region', { name: 'Skills & MCP servers', exact: true });
  const row = section.getByTestId('extension-server');
  const connection = row.getByTestId('extension-oauth-connection');
  await expect(row).toContainText('HTTPS endpoint · OAuth');
  await expect(connection).toHaveAttribute('data-state', 'not_connected');
  await expect(connection).toContainText('Runs skip this server until an administrator connects it.');

  const [tab] = await Promise.all([context.waitForEvent('page'), connection.getByRole('button', { name: 'Connect' }).click()]);
  await tab.waitForURL(`${PROVIDER}/authorize**`);
  expect(await tab.evaluate(() => window.opener)).toBeNull();
  await expect(section.getByRole('status')).toContainText('Finish signing in to linear in the new tab');
  await tab.getByRole('link', { name: 'Allow' }).click();
  await tab.waitForURL(`${REDIRECT_URI}**`);
  await expect(tab.getByRole('heading', { name: 'Connected' })).toBeVisible();
  expect(provider.callbacks).toHaveLength(1);
  await tab.close();

  // Returning to Settings refreshes the connection state without a reload.
  await page.bringToFront();
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(connection).toHaveAttribute('data-state', 'connected');
  await expect(connection).toContainText('by administrator 1');
  await expect(connection).toContainText('Granted scopes: issues:read');
  await expect(connection.getByRole('button', { name: 'Reconnect' })).toBeVisible();
  await expect(connection.getByRole('button', { name: 'Disconnect' })).toBeVisible();
  if (process.env.PROPR_PREVIEW_DIR) {
    await mkdir(process.env.PROPR_PREVIEW_DIR, { recursive: true });
    await section.screenshot({ path: path.join(process.env.PROPR_PREVIEW_DIR, 'oauth-server-connected.png') });
  }
});

test('the server form explains OAuth sign-in and shows the redirect URI to register', async ({ page, context }) => {
  await installSettingsFixture(page);
  await syntheticProvider(page, context);
  await page.setViewportSize({ width: 1280, height: 1700 });
  await page.goto('/settings?tab=agent-extensions');
  const section = page.getByRole('region', { name: 'Skills & MCP servers', exact: true });
  await section.getByTestId('extension-server').getByRole('button', { name: 'Edit' }).click();
  const form = section.getByTestId('extension-server-form');
  await expect(form.getByLabel('Authentication')).toHaveValue('oauth');
  const fields = form.getByTestId('extension-oauth-fields');
  await expect(fields).toContainText('Every run this server applies to acts with the access of the account that signs in');
  await expect(fields.getByTestId('extension-oauth-redirect-uri')).toHaveText(REDIRECT_URI);
  await fields.getByLabel(/^Client id/).fill('console-client');
  await expect(fields.getByLabel(/^Client secret/)).toBeVisible();
  if (process.env.PROPR_PREVIEW_DIR) await form.screenshot({ path: path.join(process.env.PROPR_PREVIEW_DIR, 'oauth-server-form.png') });
});
