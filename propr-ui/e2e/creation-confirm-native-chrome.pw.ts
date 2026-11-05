/** The shared creation (New Task) and run-confirmation shells stay below the desktop titlebar and leave its window controls usable. */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { user } from './dashboard-sections.fixture';
import { fixture as newTaskFixture } from './new-task.fixture';
import { capture, fixture as desktopFixture } from './task-list-desktop.fixture';
import { expectClearOfChrome, expectControlsDispatch, expectWorkspaceInert, inertRegions, installWindowActions, shells, strayPoints, type Shell } from './native-chrome.fixture';

const draft = 'Keep the creation dialog clear of the window controls.\nThis draft must survive the window controls and Escape.';
const note = 'Only touch the synthetic fixture repository.';
const now = Date.parse('2026-10-16T12:00:00Z');

const definition = {
  id: 'def-native', ownerId: user.id, name: 'Native chrome check', description: 'Synthetic automation for dialog geometry.',
  repositories: ['acme/billing'], prompt: 'Summarize new issues.', attachments: [], agentAlias: 'codex', modelName: 'gpt-6-astra',
  capabilities: ['repository_read'], includePreviousReports: false, previousReportsLimit: 0, scheduleCron: '0 * * * *', scheduleTimezone: 'UTC',
  scheduleEnabled: false, nextRunAt: null, autonomyMode: 'dry_run', enabled: true, revision: 1, createdAt: now - 86_400_000, updatedAt: now - 86_400_000,
};

const run = {
  id: 'run-native', definitionId: definition.id, ownerId: user.id, trigger: 'manual', triggerSource: 'user:preview', idempotencyKey: null,
  state: 'awaiting_approval', autonomyMode: 'dry_run', definitionSnapshot: null, reportTaskId: null, actionTaskId: null,
  report: 'Two new issues; neither is urgent.', reportTruncated: false, actionSummary: null, skipReason: null, failureReason: null,
  approvedBy: null, operatorNote: null, deferredUntil: null, deferrals: 0,
  createdAt: now - 600_000, startedAt: now - 590_000, reportedAt: now - 300_000, finishedAt: null, updatedAt: now - 300_000,
};

/** Synthetic shells and data. Every write is refused and recorded, so a test can prove none was sent. */
async function stubCreation(page: Page, shell: Shell) {
  if (shell.platform) await desktopFixture(page, shell.platform);
  await installWindowActions(page, shell);
  const requests = await newTaskFixture(page);
  return () => requests.filter(request => !request.startsWith('GET '));
}

async function stubConfirmation(page: Page, shell: Shell) {
  if (shell.platform) await desktopFixture(page, shell.platform);
  await installWindowActions(page, shell);
  const writes: string[] = [];
  await page.routeWebSocket('**/socket.io/**', socket => socket.close());
  await page.route('**/api/**', route => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (request.method() !== 'GET') {
      writes.push(`${request.method()} ${pathname}`);
      return route.fulfill({ status: 500, json: { error: 'No run decision may be sent by this test' } });
    }
    const responses: Record<string, unknown> = {
      '/api/auth/demo-mode': { demoMode: false },
      '/api/auth/user': user,
      '/api/instance/catalog': { agents: [{ alias: 'codex', type: 'codex', enabled: true, supportedModels: ['gpt-6-astra'], defaultModel: 'gpt-6-astra' }], defaultAgentAlias: 'codex', repositories: [{ name: 'acme/billing', enabled: true }] },
      '/api/automation-definitions': { definitions: [definition], total: 1, limit: 200, offset: 0 },
      [`/api/automation-definitions/${definition.id}`]: { definition },
      [`/api/automation-definitions/${definition.id}/runs`]: { runs: [run], total: 1, limit: 50, offset: 0 },
      [`/api/automation-definitions/${definition.id}/capacity`]: { capacity: { status: 'ok', sessionPercent: 20, provider: 'codex' }, threshold: 90 },
      [`/api/automation-runs/${run.id}`]: { run },
      '/api/tasks': { tasks: [], total: 0 },
      '/api/notifications/unread-count': { unreadCount: 0 },
      '/api/notifications/preferences': { preferences: {}, quietHours: {}, badgeEnabled: false },
    };
    return route.fulfill(pathname in responses ? { json: responses[pathname] } : { status: 503, json: { error: 'Unavailable in native chrome fixture' } });
  });
  return () => writes;
}

const enlarge = (page: Page) => page.addStyleTag({ content: 'html { font-size: 150% !important; }' });

/** The target is reachable: scrolled into view if the dialog scrolls, and it owns every sampled point. */
async function expectReachable(target: Locator) {
  await target.scrollIntoViewIfNeeded();
  await expect(target).toBeInViewport();
  expect(await strayPoints(target)).toEqual([]);
}

/** A preview of the open dialog for one representative shell, with the pointer resting on the backdrop. */
async function preview(page: Page, name: string) {
  if (!/linux-restored 880x620 default|linux-maximized 1280x820 enlarged/.test(test.info().title)) return;
  await page.mouse.move(4, page.viewportSize()!.height - 8);
  await capture(page, `${name}-${test.info().title.split(':')[0].replace(/ /g, '-')}`);
}

const focusedName = (page: Page) => page.evaluate(() => document.activeElement?.textContent?.trim() ?? null);

/**
 * Opens the New Task dialog, checks its boundary, keeps the draft through the window controls, Tab and a declined
 * discard, then closes it through Cancel. Nothing is submitted.
 */
async function exerciseCreation(page: Page, shell: Shell, open: () => Promise<void>) {
  const writes = await stubCreation(page, shell);
  await page.goto('/tasks');
  if (test.info().title.includes('enlarged')) await enlarge(page);
  await expect(page.getByRole('heading', { name: 'Tasks' }).first()).toBeVisible();
  const baseline = await inertRegions(page);

  await open();
  const dialog = page.getByRole('dialog', { name: 'New task' });
  await expect(dialog).toBeVisible();
  const close = dialog.getByRole('button', { name: 'Close task creation' });
  // The creation shell keeps its existing 40px close control.
  await expectClearOfChrome(page, dialog, close, shell, 40);
  const prompt = dialog.getByLabel('Prompt', { exact: true });
  await expect(prompt).toBeFocused();
  await prompt.fill(draft);
  if (shell.platform === 'linux') {
    await expectControlsDispatch(page, dialog);
    await expect(prompt).toHaveValue(draft);
  }
  await prompt.focus();
  await expectWorkspaceInert(page, dialog, [page.getByRole('navigation'), page.getByRole('heading', { name: 'Tasks' })]);
  await expect(prompt).toHaveValue(draft);
  await preview(page, 'native-new-task');

  // Escape asks before discarding the draft; declining keeps the dialog and the draft.
  await prompt.focus();
  page.once('dialog', prompt => void prompt.dismiss());
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  await expect(prompt).toHaveValue(draft);

  const cancel = dialog.getByRole('button', { name: 'Cancel', exact: true });
  await expectReachable(cancel);
  page.once('dialog', prompt => void prompt.accept());
  await cancel.click();
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(/\/tasks$/);
  expect(baseline).toEqual(expect.arrayContaining(await inertRegions(page)));
  if (shell.platform === 'linux') expect(await page.getByRole('group', { name: 'Window controls' }).evaluate(element => element.matches('[inert], [inert] *'))).toBe(false);
  expect(writes()).toEqual([]);
}

/**
 * Opens both run confirmations and leaves each without acting: Approve through Cancel, Cancel run through Escape.
 * Focus returns to the button that opened each, the background is live again and no decision is sent.
 */
async function exerciseConfirmation(page: Page, shell: Shell) {
  const writes = await stubConfirmation(page, shell);
  await page.goto(`/automations/${definition.id}/runs/${run.id}`);
  if (test.info().title.includes('enlarged')) await enlarge(page);
  const detail = page.getByTestId('agent-run-detail');
  await expect(detail).toBeVisible();
  const baseline = await inertRegions(page);
  await detail.getByLabel('Note for the acting agent (optional)').fill(note);

  const approve = detail.getByRole('button', { name: 'Approve and act' });
  await approve.click();
  const approval = page.getByRole('dialog', { name: 'Approve and act?' });
  await expect(approval).toBeVisible();
  const cancel = approval.getByRole('button', { name: 'Cancel', exact: true });
  await expect(cancel).toBeFocused();
  await expectClearOfChrome(page, approval, cancel, shell, 0);
  await expectReachable(approval.getByRole('button', { name: 'Approve and act' }));
  if (shell.platform === 'linux') await expectControlsDispatch(page, approval);
  await preview(page, 'native-approve-confirmation');
  await cancel.focus();
  await expectWorkspaceInert(page, approval, [detail, page.getByRole('navigation')]);
  await expectReachable(cancel);
  await cancel.click();
  await expect(approval).toHaveCount(0);
  await expect(approve).toBeFocused();
  await expect(detail.getByLabel('Note for the acting agent (optional)')).toHaveValue(note);
  expect(baseline).toEqual(expect.arrayContaining(await inertRegions(page)));

  const cancelRun = detail.getByRole('button', { name: 'Cancel run' });
  await cancelRun.click();
  const cancellation = page.getByRole('dialog', { name: 'Cancel this run?' });
  await expect(cancellation).toBeVisible();
  const keep = cancellation.getByRole('button', { name: 'Keep run' });
  expect(await focusedName(page)).toBe('Keep run');
  await expectClearOfChrome(page, cancellation, keep, shell, 0);
  await page.keyboard.press('Escape');
  await expect(cancellation).toHaveCount(0);
  await expect(cancelRun).toBeFocused();
  expect(baseline).toEqual(expect.arrayContaining(await inertRegions(page)));
  expect(writes()).toEqual([]);
}

const sizes = [{ width: 880, height: 620 }, { width: 1280, height: 820 }];

for (const shell of shells) {
  for (const size of sizes) {
    for (const text of ['default', 'enlarged'] as const) {
      const label = `${shell.name} ${size.width}x${size.height} ${text} text`;
      test.describe(label, () => {
        test.beforeEach(({ page }) => page.setViewportSize(size));

        test(`${label}: New Task keeps clear of the native titlebar`, async ({ page }) => {
          await exerciseCreation(page, shell, () => page.getByRole('button', { name: 'New Task', exact: true }).first().click());
        });

        test(`${label}: run confirmations keep clear of the native titlebar`, async ({ page }) => {
          await exerciseConfirmation(page, shell);
        });
      });
    }
  }
}

for (const size of [{ width: 320, height: 640 }, { width: 390, height: 844 }, { width: 390, height: 380 }]) {
  for (const text of ['default', 'enlarged'] as const) {
    const label = `web ${size.width}x${size.height} ${text} text`;
    test.describe(label, () => {
      test.beforeEach(({ page }) => page.setViewportSize(size));

      test(`${label}: New Task reserves no titlebar and stays reachable`, async ({ page }) => {
        await exerciseCreation(page, {}, async () => {
          // On phones, creation starts from the bottom bar's Create sheet.
          await page.getByRole('navigation', { name: 'Primary navigation', exact: true }).getByRole('button', { name: 'Create', exact: true }).click();
          await page.getByRole('dialog', { name: 'Create' }).getByRole('link', { name: 'New Task', exact: true }).click();
        });
      });

      test(`${label}: run confirmations reserve no titlebar and stay reachable`, async ({ page }) => {
        await exerciseConfirmation(page, {});
      });
    });
  }
}
