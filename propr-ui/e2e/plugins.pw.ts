import { expect, test } from '@playwright/test';
import { REFUSAL, DEFAULTS, installFixture, capture, step, badge, type State } from './plugins.fixture';

/**
 * The Plugins page end to end against a stateful plugin API fixture: the
 * example plugin is installed, connected, configured through the generated
 * settings form, limited to a repository and enabled; its managed items are
 * then shown in Skills & MCP servers; it is disabled and uninstalled entirely
 * from the page. An upgrade asking for more is approved from the detail page.
 * With PROPR_CAPTURE_PREVIEWS set it also captures the catalog and the detail
 * steps at desktop and phone widths.
 */

test('installs, connects, configures, enables, shows the managed items, disables and uninstalls the example plugin', async ({ page }) => {
  const state: State = { installed: false, enabled: false, token: false, oauth: false, repositories: null, refuseUninstall: true };
  await page.setViewportSize({ width: 1440, height: 900 });
  await installFixture(page, state);
  await page.goto('/plugins');

  await expect(page.getByRole('navigation').getByRole('link', { name: 'Plugins' })).toHaveAttribute('href', '/plugins');
  await expect(page.getByTestId('plugin-card')).toHaveCount(3);
  await capture(page, 'plugins-catalog-desktop');
  await page.getByLabel('Category').selectOption('messaging');
  await expect(page.getByTestId('plugin-card')).toHaveCount(1);
  await page.getByLabel('Category').selectOption('');
  await page.getByRole('link', { name: 'Example pack: open' }).click();

  const install = step(page, 'Install');
  await expect(install.getByRole('button', { name: 'Install' })).toBeDisabled();
  await expect(install.getByTestId('plugin-secret-acknowledgement')).toContainText('FIXTURE_TOKEN');
  await capture(page, 'plugins-install-step-desktop', install.getByText('Permissions it asks for'));
  await install.getByRole('checkbox', { name: /propr-fixture-mcp@1\.0\.0/ }).check();
  await install.getByRole('button', { name: 'Install' }).click();
  await expect(badge(page)).toHaveText('Needs connection');

  const enable = step(page, 'Enable');
  await expect(enable.getByRole('checkbox', { name: /Enabled/ })).toBeDisabled();
  await expect(enable.getByRole('status')).toContainText('Connection Example API token (example-token) is not set');
  await capture(page, 'plugins-connect-and-enable-blocked-desktop', step(page, 'Connect'));

  const token = step(page, 'Connect').getByTestId('plugin-connection').nth(1);
  await token.getByLabel('Example API token').fill('tok_preview_value');
  await token.getByRole('button', { name: 'Save' }).click();
  await expect(token).toContainText('Stored by administrator 1042');
  await expect(token.getByLabel('Replace Example API token')).toHaveValue('');

  // Configure: the form is generated from the manifest's settings schema and starts from the installed defaults.
  const configure = step(page, 'Configure');
  const settings = configure.getByRole('form', { name: 'Plugin settings' });
  await expect(settings.getByLabel('Greeting')).toHaveValue('hello');
  await expect(settings.getByLabel('Verbosity')).toHaveValue('normal');
  await expect(settings.getByLabel('Maximum items')).toHaveValue('10');
  await expect(settings.getByLabel('Include draft pull requests')).toHaveValue('false');

  // A required setting left empty blocks Enable, with the reason.
  await settings.getByLabel('Verbosity').selectOption('');
  await settings.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Settings saved.' })).toBeVisible();
  // Untouched settings keep their saved values, including the empty default list.
  expect(state.settings).toEqual({ greeting: 'hello', maxItems: 10, includeDrafts: false, labels: [] });
  await expect(enable.getByRole('checkbox', { name: /Enabled/ })).toBeDisabled();
  await expect(enable.getByRole('status')).toContainText('Required setting Verbosity (verbosity) is missing');
  await expect(configure.getByRole('status').first()).toHaveText('Set Verbosity to enable the plugin.');

  // Invalid input shows the error next to its field.
  const settingsForm = () => step(page, 'Configure').getByRole('form', { name: 'Plugin settings' });
  // Text the browser cannot read as a number shows an error instead of removing the saved value. The browser reports
  // it as an empty value, so it is typed key by key (fill refuses it), both over the saved number and into an emptied field.
  let settingsSaves = 0;
  page.on('request', request => { if (request.method() === 'PUT' && request.url().endsWith('/settings')) settingsSaves += 1; });
  const maxItemsError = () => settingsForm().locator('[data-setting="maxItems"]').getByTestId('plugin-setting-error');
  for (const [fills, typed] of [[['10'], '1e'], [['7', ''], '-']] as const) {
    for (const value of fills) await settingsForm().getByLabel('Maximum items').fill(value);
    await expect(maxItemsError()).toHaveCount(0);
    await settingsForm().getByLabel('Maximum items').press('ControlOrMeta+a');
    await settingsForm().getByLabel('Maximum items').pressSequentially(typed);
    expect(await settingsForm().getByLabel('Maximum items').evaluate(input => (input as HTMLInputElement).validity.badInput)).toBe(true);
    await settingsForm().getByRole('button', { name: 'Save settings' }).click();
    await expect(maxItemsError()).toHaveText('maxItems must be a number');
  }
  expect(settingsSaves).toBe(0);
  expect(state.settings).toEqual({ greeting: 'hello', maxItems: 10, includeDrafts: false, labels: [] });

  await settingsForm().getByLabel('Maximum items').fill('99');
  await settingsForm().getByRole('button', { name: 'Save settings' }).click();
  await expect(settingsForm().locator('[data-setting="maxItems"]').getByTestId('plugin-setting-error')).toHaveText('maxItems must be at most 50');
  await capture(page, 'plugins-settings-field-error-desktop', settingsForm());

  await settingsForm().getByLabel('Maximum items').fill('20');
  await settingsForm().getByLabel('Verbosity').selectOption('detailed');
  await settingsForm().getByLabel('Include draft pull requests').selectOption('true');
  await settingsForm().getByRole('button', { name: 'Add entry to Labels to watch' }).click();
  await settingsForm().getByLabel('Labels to watch: entry 1').fill(' bug ');
  await settingsForm().getByRole('button', { name: 'Add entry to Labels to watch' }).click();
  await settingsForm().getByLabel('Labels to watch: entry 2').fill('first\nsecond');
  await settingsForm().getByRole('button', { name: 'Add repository to Channel per repository' }).click();
  await settingsForm().getByLabel('Channel per repository: repository 1').fill('integry/propr');
  await settingsForm().getByLabel('Channel per repository: value for repository 1').fill('#propr');
  await settingsForm().getByRole('button', { name: 'Save settings' }).click();
  await expect(enable.getByRole('checkbox', { name: /Enabled/ })).toBeEnabled();
  expect(state.settings).toEqual({ greeting: 'hello', verbosity: 'detailed', maxItems: 20, includeDrafts: true, labels: [' bug ', 'first\nsecond'], channels: { 'integry/propr': '#propr' } });

  // The saved values round-trip through a fresh read.
  await page.reload();
  await expect(settingsForm().getByLabel('Verbosity')).toHaveValue('detailed');
  await expect(settingsForm().getByLabel('Maximum items')).toHaveValue('20');
  await expect(settingsForm().getByLabel('Include draft pull requests')).toHaveValue('true');
  await expect(settingsForm().getByLabel('Labels to watch: entry 1')).toHaveValue(' bug ');
  await expect(settingsForm().getByLabel('Labels to watch: entry 2')).toHaveValue('first\nsecond');
  await expect(settingsForm().getByLabel('Channel per repository: value for repository 1')).toHaveValue('#propr');
  await expect(step(page, 'Configure')).toHaveAttribute('data-done', 'true');

  await step(page, 'Configure').getByRole('checkbox', { name: 'integry/propr', exact: true }).check();
  await step(page, 'Configure').getByRole('button', { name: 'Save repositories' }).click();
  await expect(page.getByTestId('plugin-repository-limit')).toHaveText('Limited to integry/propr.');
  expect(state.repositories).toEqual(['integry/propr']);

  await step(page, 'Enable').getByRole('checkbox', { name: /Enabled/ }).check();
  await expect(badge(page)).toHaveText('Degraded'); // the OAuth account is still to sign in
  await expect(page.getByTestId('plugin-contributions')).toContainText('MCP server example-remote · Active');
  state.oauth = true;
  await page.reload();
  await expect(badge(page)).toHaveText('Enabled');
  await capture(page, 'plugins-enabled-desktop', step(page, 'Configure'));
  // The plugin's slash command is listed with what it does and where it works.
  await expect(page.getByTestId('plugin-command-example-notes')).toHaveText('Command /example-notes · Write release notes for the work so far · in pull request and issue comments · Active');
  await capture(page, 'plugins-what-it-added-commands-desktop', page.getByRole('heading', { name: 'What it added' }));

  // The managed items in Skills & MCP servers: badged, linked to the plugin, definition read-only.
  await page.getByTestId('plugin-contributions').getByRole('link', { name: 'Skills & MCP servers' }).first().click();
  const library = page.getByRole('region', { name: 'Skills & MCP servers' });
  const local = library.getByTestId('extension-server').filter({ hasText: 'example-local' });
  await expect(local.getByRole('link', { name: 'From plugin: Example pack' })).toHaveAttribute('href', '/plugins/example-pack');
  await expect(library.getByTestId('extension-skill').getByRole('link', { name: 'From plugin: Example pack' })).toBeVisible();
  await expect(local.getByRole('button', { name: 'Remove' })).toHaveCount(0);
  const own = library.getByTestId('extension-server').filter({ has: page.getByText('docs', { exact: true }) });
  await expect(own.getByRole('button', { name: 'Remove' })).toHaveCount(1);
  await expect(own.getByTestId('extension-managed-badge')).toHaveCount(0);
  await local.getByRole('button', { name: 'Edit limits' }).click();
  const managedForm = library.getByTestId('extension-server-form');
  await expect(managedForm.getByTestId('extension-managed-definition')).toContainText('propr-fixture-mcp');
  await expect(managedForm.getByTestId('extension-managed-definition')).toContainText('FIXTURE_TOKEN');
  await expect(managedForm.getByLabel('Package')).toHaveCount(0);
  await expect(managedForm.getByRole('checkbox', { name: /Apply automatically/ })).toBeEnabled();
  await capture(page, 'plugins-managed-item-library-desktop', managedForm);
  await managedForm.getByRole('button', { name: 'Cancel' }).click();
  await local.getByRole('link', { name: 'From plugin: Example pack' }).click();
  await expect(badge(page)).toHaveText('Enabled');

  await step(page, 'Enable').getByRole('checkbox', { name: /Enabled/ }).uncheck();
  await expect(badge(page)).toHaveText('Off');

  await page.getByRole('button', { name: 'Uninstall…' }).click();
  await expect(page.getByTestId('plugin-uninstall-confirm')).toContainText('Skill example-notes from Skills & MCP servers');
  await page.getByRole('button', { name: 'Uninstall Example pack' }).click();
  await expect(page.getByTestId('plugin-uninstall-error')).toHaveText(REFUSAL);
  await capture(page, 'plugins-uninstall-refused-desktop', page.getByTestId('plugin-contributions'));
  await page.getByRole('button', { name: 'Uninstall Example pack' }).click();
  await expect(badge(page)).toHaveText('Not installed');
});

test('shows what an upgrade asks for and approving it clears Needs approval', async ({ page }) => {
  const state: State = { installed: true, enabled: true, token: true, oauth: true, repositories: null, refuseUninstall: false, settings: { ...DEFAULTS }, upgrade: true };
  await page.setViewportSize({ width: 1440, height: 900 });
  await installFixture(page, state);
  await page.goto('/plugins/example-pack');
  await expect(badge(page)).toHaveText('Needs approval');
  const approval = page.getByTestId('plugin-approval');
  await expect(approval).toContainText('Version 0.2.0 needs your approval (approved: 0.1.0)');
  await expect(approval.getByTestId('plugin-approval-permissions')).toContainText('pull_requests.read: Read pull requests and their status');
  await expect(approval.getByTestId('plugin-approval-package')).toContainText('Version changes from 1.0.0 to 1.1.0');
  await expect(approval.getByTestId('plugin-approval-package')).toContainText('Secret variables added: FIXTURE_REGION');
  const approve = approval.getByRole('button', { name: 'Approve' });
  await expect(approve).toBeDisabled();
  await capture(page, 'plugins-needs-approval-desktop', approval);
  await approval.getByRole('checkbox', { name: /propr-fixture-mcp@1\.1\.0 receives the secret variables FIXTURE_TOKEN, FIXTURE_REGION/ }).check();
  await approve.click();
  await expect(badge(page)).toHaveText('Enabled');
  await expect(page.getByTestId('plugin-approval')).toHaveCount(0);
  expect(state.upgrade).toBe(false);
});

test('keeps the plugin steps usable on a phone', async ({ page }) => {
  const state: State = { installed: true, enabled: false, token: false, oauth: false, repositories: null, refuseUninstall: false };
  await page.setViewportSize({ width: 390, height: 844 });
  await installFixture(page, state);
  await page.goto('/plugins/example-pack');
  await expect(badge(page)).toHaveText('Needs connection');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await capture(page, 'plugins-detail-phone');
  await capture(page, 'plugins-enable-blocked-phone', step(page, 'Enable'));
});
