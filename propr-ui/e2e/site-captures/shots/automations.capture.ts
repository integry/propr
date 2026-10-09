import { test, type Locator, type Page } from '@playwright/test';
import { shot } from '../lib/shot';
import { installWorld } from '../lib/world';
import { NOW, base } from '../world/base';
import { DEPENDENCY_REVIEW, DEPENDENCY_RUNS, ISSUE_TRIAGE, TRIAGE_DEFERRED, automations } from '../world/automations';

const USED_ON = ['/automations/', '/whats-new/0.9.0/'];

test.beforeEach(async ({ page }) => {
  await page.clock.install({ time: NOW });
});

const editor = async (page: Page) => {
  await page.goto(`/automations/${DEPENDENCY_REVIEW.id}`);
  const form = page.getByTestId('agent-editor');
  await form.getByLabel('Name').waitFor();
  return form;
};

/** One labelled row of the automation form: the innermost block holding both its label and its control. */
const formRow = (form: Locator, label: string, control: (page: Page) => Locator) =>
  form.locator('div').filter({ has: form.page().getByText(label, { exact: true }) }).filter({ has: control(form.page()) }).last();

const openRun = async (page: Page, definitionId: string, runId: string) => {
  await page.goto(`/automations/${definitionId}/runs/${runId}`);
  await page.getByTestId('agent-run-detail').waitFor();
};

test('automation list', async ({ page }, info) => {
  const log = await installWorld(page, base, automations);
  await page.goto('/automations');
  const list = page.getByRole('list', { name: 'Automations' });
  await list.getByTestId('agent-row').first().waitFor();
  await shot(page, list, {
    id: 'automations-list',
    alt: 'Four automations with their coding agent, schedule and last run: one awaiting approval, one deferred',
    usedOn: USED_ON,
    padding: 0,
  }, info, log);
});

test('automation schedule', async ({ page }, info) => {
  const log = await installWorld(page, base, automations);
  const form = await editor(page);
  await shot(page, formRow(form, 'Schedule', p => p.getByRole('radiogroup', { name: 'Schedule' })), {
    id: 'automations-schedule',
    alt: 'A UTC cron schedule with presets for hourly, daily, weekdays and Mondays, and a preview of the next run',
    usedOn: USED_ON,
    padding: 0,
  }, info, log);
});

test('automation prompt and memory', async ({ page }, info) => {
  const log = await installWorld(page, base, automations);
  const form = await editor(page);
  const prompt = formRow(form, 'Prompt', p => p.getByTestId('agent-attachment-dropzone'));
  const previous = formRow(form, 'Previous reports', p => p.getByRole('checkbox', { name: /previous run reports/i }));
  await shot(page, prompt, {
    id: 'automations-prompt',
    alt: 'The automation prompt with an attached dependency policy, and the last two reports fed back into the next run',
    usedOn: USED_ON,
    include: [previous],
    padding: 0,
  }, info, log);
});

test('automation capabilities', async ({ page }, info) => {
  const log = await installWorld(page, base, automations);
  const form = await editor(page);
  await shot(page, formRow(form, 'Capabilities', p => p.getByRole('switch', { name: /Read repositories/ })), {
    id: 'automations-capabilities',
    alt: 'Per-automation capabilities: read repositories and web access on, ProPR tools off',
    usedOn: USED_ON,
    padding: 0,
  }, info, log);
});

test('automation autonomy', async ({ page }, info) => {
  const log = await installWorld(page, base, automations);
  const form = await editor(page);
  await shot(page, formRow(form, 'Autonomy', p => p.getByRole('radiogroup', { name: 'Autonomy' })), {
    id: 'automations-autonomy',
    alt: 'Autonomy set to Preview & approve: the acting step waits for approval before it uses ProPR tools',
    usedOn: USED_ON,
    padding: 0,
  }, info, log);
});

test('automation run history', async ({ page }, info) => {
  const log = await installWorld(page, base, automations);
  await page.goto(`/automations/${DEPENDENCY_REVIEW.id}/runs`);
  const history = page.getByTestId('agent-run-history');
  const rows = history.getByTestId('agent-run-row');
  await rows.first().waitFor();
  // Report previews load on hover or focus; focus each row that has a report, then park focus elsewhere.
  for (let index = 0; index < await rows.count(); index += 1) await rows.nth(index).focus();
  await page.getByRole('heading', { name: DEPENDENCY_REVIEW.name }).first().click();
  await history.getByText('First review', { exact: false }).waitFor();
  await shot(page, history, {
    id: 'automations-run-history',
    alt: 'Run history for one automation: runs started by schedule, MCP, the CLI from GitHub Actions, the HTTP API and Run now',
    usedOn: USED_ON,
    padding: 0,
  }, info, log);
});

test('automation awaiting approval', async ({ page }, info) => {
  const log = await installWorld(page, base, automations);
  await openRun(page, DEPENDENCY_REVIEW.id, DEPENDENCY_RUNS[0].id);
  const approval = page.getByTestId('agent-run-approval');
  await approval.getByLabel('Note for the acting agent (optional)').fill('Only fix lodash.');
  await page.getByRole('heading', { name: 'Report' }).click();
  await shot(page, approval, {
    id: 'automations-approval',
    alt: 'A preview-mode run awaiting approval, with the note "Only fix lodash." for the acting agent',
    usedOn: USED_ON,
  }, info, log);
});

test('automation report', async ({ page }, info) => {
  const log = await installWorld(page, base, automations);
  await openRun(page, DEPENDENCY_REVIEW.id, DEPENDENCY_RUNS[0].id);
  await shot(page, page.getByRole('region', { name: 'Report' }), {
    id: 'automations-report',
    alt: 'The Markdown report from the weekly dependency review: three packages need attention, two on watch',
    usedOn: USED_ON,
  }, info, log);
});

test('automation acting result', async ({ page }, info) => {
  const log = await installWorld(page, base, automations);
  await openRun(page, DEPENDENCY_REVIEW.id, DEPENDENCY_RUNS[1].id);
  await shot(page, page.getByRole('region', { name: 'What the acting agent did' }), {
    id: 'automations-acting-result',
    alt: 'What the acting agent did after approval: one task for lodash, exactly as the note asked, after checking for duplicates',
    usedOn: USED_ON,
  }, info, log);
});

test('automation deferred by the cost gate', async ({ page }, info) => {
  const log = await installWorld(page, base, automations);
  await openRun(page, ISSUE_TRIAGE.id, TRIAGE_DEFERRED.id);
  const reason = page.getByTestId('agent-run-reason');
  await shot(page, page.getByTestId('agent-run-state'), {
    id: 'automations-deferred',
    alt: 'A scheduled run deferred because the agent\'s session usage is above the 90% pause threshold',
    usedOn: USED_ON,
    include: [page.getByRole('alert').filter({ has: reason }), page.getByRole('button', { name: 'Cancel run' })],
    padding: 8,
  }, info, log);
});
