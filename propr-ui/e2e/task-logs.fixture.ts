/** A completed task with a long output log and a follow-up destination, as the Logs and Follow Up dialogs read it. */
import { expect, type Locator, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { ago, fixture as taskFixture } from './task-list-desktop.fixture';

export const taskId = 'issue-3243-run-0';
const sessionId = 'session-issue-3243-run-0';
// The files a run writes, named as production names them. The conversation file's name is
// wider than the phone's 360px file header in Inter (436px at 600 16px) and in the fallback
// sans-serif fonts (404px in Arial-metric fonts such as Liberation Sans, up to 494px in
// DejaVu Sans), so it wraps whether or not the web font has loaded. The output file's name
// only wraps in Inter (375px); in Arial-metric fallbacks it fits on one line (346px).
export const outputName = 'issue-28-2026-10-17T21-15-00-788Z-output.txt';
export const conversationName = 'issue-28-2026-10-17T21-15-00-788Z-conversation.json';
// A long output with six matches, the last a few lines from its end.
export const outputLines = Array.from({ length: 400 }, (_, line) => line % 79 === 0 && line > 0 || line === 396
  ? `[INFO] step ${line}: acceptance check passed for the changed files` : `[INFO] step ${line}: running npm test --workspace propr-ui -- --reporter=dot`);

export async function stubTask(page: Page, posts: string[]) {
  await taskFixture(page);
  await page.route(`**/api/task/${taskId}/history`, route => route.fulfill({ json: {
    history: [
      { state: 'PENDING', timestamp: ago(60) },
      { state: 'CLAUDE_EXECUTION', timestamp: ago(59) },
      { state: 'COMPLETED', timestamp: ago(51), logsPath: `/api/execution/${sessionId}/logs` },
    ],
    taskInfo: { title: 'Keep mobile dialog controls visible', type: 'issue', number: 3243, issueNumber: 3243, repoOwner: 'integry', repoName: 'propr',
      followupTarget: { taskId, repository: 'integry/propr', kind: 'issue', number: 3243 } },
  } }));
  await page.route(`**/api/task/${taskId}/live-details`, route => route.fulfill({ json: { events: [], todos: [], currentTask: null } }));
  await page.route(`**/api/execution/${sessionId}/logs`, route => route.fulfill({ json: {
    sessionId, files: { conversation: `/var/log/propr/${conversationName}`, output: `/var/log/propr/${outputName}` },
  } }));
  await page.route(`**/api/execution/${sessionId}/logs/output`, route => route.fulfill({ contentType: 'text/plain', body: outputLines.join('\n') }));
  await page.route(`**/api/execution/${sessionId}/logs/conversation`, route => route.fulfill({ contentType: 'text/plain', body: JSON.stringify({ message: 'acceptance' }) }));
  // The comment posts but its dispatch fails: the dialog shows the receipt instead of closing.
  await page.route(`**/api/tasks/${taskId}/followup`, route => {
    posts.push(route.request().postDataJSON().body);
    return route.fulfill({ status: 202, json: { success: false, state: 'failed', posted: true, commentId: 4243001, sourceTaskId: taskId, message: 'Comment posted, but the command failed before submission.' } });
  });
}

/** Fails the app's Google Fonts requests, so the page renders in the fallback font as when offline. */
export async function blockWebFonts(page: Page) {
  await page.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, route => route.abort('internetdisconnected'));
}

// Real Inter (OFL-1.1, provenance in e2e/fonts/README.md), served in place of Google Fonts.
export const INTER_URL = 'https://fonts.gstatic.com/s/inter/e2e-fixture/inter-var-latin.woff2';
const INTER_CSS = `@font-face { font-family: 'Inter'; font-weight: 400 700; font-display: swap; src: url(${INTER_URL}) format('woff2');
  unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD; }`;

/**
 * Serves the app's Google Fonts stylesheet and a local copy of Inter instead, so the font
 * arrives with or without network access. With `held`, the font file waits until `release`
 * is called, as a slow network delivers it after the page is already in use. `requested`
 * lists the font files the page asked for.
 */
export async function serveInter(page: Page, { held = false } = {}) {
  const body = readFileSync(new URL('./fonts/inter-var-latin.woff2', import.meta.url));
  let release = () => {};
  const released = held ? new Promise<void>(resolve => { release = resolve; }) : null;
  const requested: string[] = [];
  await page.route(/^https:\/\/fonts\.googleapis\.com\//, route => route.fulfill({ contentType: 'text/css', body: INTER_CSS }));
  await page.route(/^https:\/\/fonts\.gstatic\.com\//, async route => {
    requested.push(route.request().url());
    await released;
    await route.fulfill({ contentType: 'font/woff2', headers: { 'access-control-allow-origin': '*' }, body }).catch(() => {});
  });
  return { requested, release: () => release() };
}

/** The load status of each Inter face the page knows, without waiting for any of them. */
export const interStatus = (page: Page) => page.evaluate(() =>
  [...document.fonts].filter(font => font.family.replace(/["']/g, '') === 'Inter').map(font => font.status));

/**
 * Whether text set in the app's font stack is drawn in Inter now, judged by its width against the
 * fallback alone. While a swap-period font is still downloading WebKit reports its face as `error`
 * and Chromium as `loading`; either way the fallback is what is drawn.
 */
export const drawsInter = (page: Page) => page.evaluate(() => {
  const width = (family: string) => {
    const sample = document.createElement('span');
    sample.style.cssText = `position: fixed; visibility: hidden; white-space: pre; font: 600 16px ${family}`;
    sample.textContent = 'Keep the caret line in view';
    document.body.append(sample);
    const { width: drawn } = sample.getBoundingClientRect();
    sample.remove();
    return drawn;
  };
  return Math.abs(width("'Inter', sans-serif") - width('sans-serif')) > 1;
});

/** Whether the page renders its 600-weight text in the Inter web font rather than a fallback. */
export const interLoaded = (page: Page) => page.evaluate(async () => {
  await document.fonts.ready;
  return [...document.fonts].some(font => font.family.replace(/["']/g, '') === 'Inter' && font.status === 'loaded');
});

/** Opens a task header action, directly or from the phone's action sheet; returns the control focus returns to. */
const moreActions = (page: Page) => page.getByRole('button', { name: /more (task )?actions/i }).filter({ visible: true });

/** Waits for the loaded task page, whose own viewport listeners are then in place. */
export const taskShown = (page: Page) => expect(moreActions(page).first()).toBeVisible();

export async function openTaskAction(page: Page, title: string, label: string): Promise<Locator> {
  const direct = page.locator(`button[title^="${title}"]`).filter({ visible: true });
  const more = moreActions(page);
  await expect(direct.or(more).first()).toBeVisible();
  if (await direct.count()) { await direct.first().click(); return direct.first(); }
  await more.first().click();
  await page.getByRole('menuitem', { name: label, exact: true }).click();
  return more.first();
}

/** The full-screen layer a task dialog is framed in. */
export const layerOf = (dialog: Locator) => dialog.locator('xpath=ancestor::div[contains(@class, "app-modal-layer")]');
