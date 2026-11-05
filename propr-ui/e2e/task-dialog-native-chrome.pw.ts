/** Follow-up (inline) and diff (portaled) dialogs stay below the desktop titlebar and leave its window controls usable. */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { ago, capture, fixture } from './task-list-desktop.fixture';
import { expectClearOfChrome, expectControlsDispatch, expectWorkspaceInert, inertRegions, installWindowActions, shells, strayPoints, type Shell } from './native-chrome.fixture';

const taskId = 'issue-3183-run-0';
const draft = 'Please keep the dialog clear of the window controls.\nThis draft must survive a resize.';

async function stubTask(page: Page, shell: Shell, posts: string[]) {
  await fixture(page, shell.platform);
  await installWindowActions(page, shell);
  await page.route(`**/api/task/${taskId}/history`, route => route.fulfill({ json: {
    history: [
      { state: 'PENDING', timestamp: ago(60) },
      { state: 'CLAUDE_EXECUTION', timestamp: ago(59) },
      { state: 'COMPLETED', timestamp: ago(51) },
    ],
    taskInfo: { title: 'Keep follow-up and diff dialogs clear of native window controls', type: 'issue', number: 3183, issueNumber: 3183, repoOwner: 'integry', repoName: 'propr',
      followupTarget: { taskId, repository: 'integry/propr', kind: 'issue', number: 3183 } },
  } }));
  await page.route(`**/api/task/${taskId}/live-details`, route => route.fulfill({ json: { events: [], todos: [], currentTask: null } }));
  await page.route(`**/api/task/${taskId}/file-changes`, route => route.fulfill({ json: {
    taskId, lastUpdated: ago(51),
    files: [{ path: 'propr-ui/src/components/TaskDetails/DiffViewer.tsx', linesAdded: 3, linesRemoved: 3, status: 'modified', diff: '@@ -1,3 +1,3 @@\n-<div className="fixed inset-0">\n+<div className="app-modal-layer fixed inset-0">' }],
  } }));
  await page.route(`**/api/tasks/${taskId}/followup`, route => {
    posts.push(route.request().postDataJSON().body);
    return route.fulfill({ status: 500, json: { error: 'No follow-up may be posted by this test' } });
  });
}

async function openFollowup(page: Page): Promise<Locator> {
  const direct = page.locator('button[title^="Follow Up"]').filter({ visible: true });
  const more = page.getByRole('button', { name: /more actions/i }).filter({ visible: true });
  await expect(direct.or(more).first()).toBeVisible();
  if (await direct.count()) await direct.first().click();
  else {
    await more.first().click();
    await page.getByRole('menuitem', { name: /Follow Up/ }).click();
  }
  const dialog = page.getByRole('dialog', { name: 'Follow Up on Task' });
  await expect(dialog).toBeVisible();
  return dialog;
}

/** The task workspace behind the dialog is inert, and keyboard focus never reaches it. */
const expectTaskInert = (page: Page, dialog: Locator) => expectWorkspaceInert(page, dialog,
  [page.getByRole('heading', { name: 'Keep follow-up and diff dialogs clear of native window controls' }), page.getByRole('navigation')]);

/** A preview of the open dialog, with the pointer resting on its backdrop rather than hovering a window control. */
async function preview(page: Page, name: string) {
  await page.mouse.move(4, page.viewportSize()!.height - 8);
  await capture(page, name);
}

const sizes = [{ width: 880, height: 620 }, { width: 1280, height: 820 }];

for (const shell of shells) {
  for (const size of sizes) {
    for (const text of ['default', 'enlarged'] as const) {
      const label = `${shell.name} ${size.width}x${size.height} ${text} text`;
      test(`${label}: follow-up and diff dialogs keep clear of the native titlebar`, async ({ page }) => {
        const posts: string[] = [];
        await page.setViewportSize(size);
        await stubTask(page, shell, posts);
        await page.goto(`/tasks/${taskId}`);
        if (text === 'enlarged') await page.addStyleTag({ content: 'html { font-size: 150% !important; }' });
        await expect(page.getByRole('heading', { name: 'Keep follow-up and diff dialogs clear of native window controls' }).first()).toBeVisible();
        const baseline = await inertRegions(page);

        // Inline follow-up dialog, rendered inside the desktop root.
        const followup = await openFollowup(page);
        const followupClose = followup.getByRole('button', { name: 'Close follow-up dialog' });
        await expectClearOfChrome(page, followup, followupClose, shell);
        const textarea = followup.getByRole('textbox', { name: 'Comment' });
        await textarea.fill(draft);
        if (shell.platform === 'linux') await expectControlsDispatch(page, followup);
        await textarea.focus();
        await expectTaskInert(page, followup);
        // An OS resize keeps the unsent draft and the layout.
        await page.setViewportSize(size.width === 880 ? { width: 1280, height: 820 } : { width: 880, height: 620 });
        await expect(textarea).toHaveValue(draft);
        await expectClearOfChrome(page, followup, followupClose, shell);
        await page.setViewportSize(size);
        await expect(textarea).toHaveValue(draft);
        if (shell.name === 'linux-restored' && size.width === 880 && text === 'default') await preview(page, 'native-followup-dialog-linux-880x620');
        await followupClose.click();
        await expect(followup).toHaveCount(0);
        expect(posts).toEqual([]);
        expect(baseline).toEqual(expect.arrayContaining(await inertRegions(page)));

        // Portaled diff dialog, rendered on <body> outside the desktop root.
        await page.getByText('DiffViewer.tsx', { exact: true }).first().click();
        const diff = page.getByRole('dialog', { name: 'DiffViewer.tsx' });
        const diffClose = diff.getByRole('button', { name: 'Close diff view' });
        await expectClearOfChrome(page, diff, diffClose, shell);
        await expect(diff).toContainText('app-modal-layer');
        if (shell.platform === 'linux') {
          // Restored, the portaled layer also keeps inside the frame's left/bottom allowance.
          const inset = shell.expanded ? 0 : 3;
          const layer = await diff.evaluate(element => {
            const box = element.parentElement!.getBoundingClientRect();
            return { left: box.left, bottom: window.innerHeight - box.bottom };
          });
          expect(layer).toEqual({ left: inset, bottom: inset });
          await expectControlsDispatch(page, diff);
        }
        await diffClose.focus();
        await expectTaskInert(page, diff);
        if (shell.name === 'linux-restored' && size.width === 880 && text === 'default') await preview(page, 'native-diff-dialog-linux-880x620');
        if (shell.name === 'linux-maximized' && size.width === 1280 && text === 'enlarged') await preview(page, 'native-diff-dialog-linux-maximized-1280x820-enlarged');
        await page.keyboard.press('Escape');
        await expect(diff).toHaveCount(0);
        expect(baseline).toEqual(expect.arrayContaining(await inertRegions(page)));
        expect(posts).toEqual([]);
      });
    }
  }
}

for (const size of [{ width: 320, height: 640 }, { width: 390, height: 844 }, { width: 390, height: 380 }]) {
  for (const text of ['default', 'enlarged'] as const) {
    test(`web ${size.width}x${size.height} ${text} text: dialogs reserve no titlebar and stay reachable`, async ({ page }) => {
      const posts: string[] = [];
      await page.setViewportSize(size);
      await stubTask(page, {}, posts);
      await page.goto(`/tasks/${taskId}`);
      if (text === 'enlarged') await page.addStyleTag({ content: 'html { font-size: 150% !important; }' });
      await expect(page.getByRole('heading', { name: 'Keep follow-up and diff dialogs clear of native window controls' }).first()).toBeVisible();
      const baseline = await inertRegions(page);

      const followup = await openFollowup(page);
      await expectClearOfChrome(page, followup, followup.getByRole('button', { name: 'Close follow-up dialog' }), {});
      const textarea = followup.getByRole('textbox', { name: 'Comment' });
      await textarea.fill(draft);
      const cancel = followup.getByRole('button', { name: 'Cancel' });
      const post = followup.getByRole('button', { name: 'Post Comment' });
      for (const target of [textarea, cancel, post]) {
        await target.scrollIntoViewIfNeeded();
        await expect(target).toBeInViewport();
      }
      expect(await strayPoints(cancel)).toEqual([]);
      await cancel.click();
      await expect(followup).toHaveCount(0);
      expect(posts).toEqual([]);

      await page.getByText('DiffViewer.tsx', { exact: true }).first().click();
      const diff = page.getByRole('dialog', { name: 'DiffViewer.tsx' });
      await expectClearOfChrome(page, diff, diff.getByRole('button', { name: 'Close diff view' }), {});
      await diff.getByRole('button', { name: 'Close diff view' }).click();
      await expect(diff).toHaveCount(0);
      expect(baseline).toEqual(expect.arrayContaining(await inertRegions(page)));
    });
  }
}
