import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { browserVoicePreferenceKey } from '../src/voice/voicePreferenceKey';

interface SmokeUser {
  id: string;
  login: string;
  username: string;
  displayName: string;
  email: string | null;
  avatarUrl: string | null;
  role: string;
  permissions: string[];
  authorizationSource: string;
}

const member: SmokeUser = {
  id: 'preview-user',
  login: 'preview',
  username: 'preview',
  displayName: 'Preview User',
  email: null,
  avatarUrl: null,
  role: 'member',
  permissions: [],
  authorizationSource: 'local',
};

const administrator: SmokeUser = { ...member, role: 'admin', permissions: ['instance.manage_settings'] };

/** Preview evidence is written only when a capture run asks for it. */
async function capturePreview(page: Page, name: string): Promise<void> {
  if (!process.env.PROPR_CAPTURE_PREVIEWS) return;
  const directory = path.resolve('../.propr/previews');
  await mkdir(directory, { recursive: true });
  await page.screenshot({ animations: 'disabled', path: path.join(directory, name) });
}

const timestamp = '2026-09-07T09:35:00.000Z';
const notificationPreferences = {
  preferences: Object.fromEntries([
    'plan',
    'task',
    'review',
    'pull_request',
    'indexing',
    'system_failure',
  ].map(kind => [kind, {
    inboxEnabled: true,
    pushEnabled: false,
    updatedAt: timestamp,
  }])),
  quietHours: { start: null, end: null, timezone: 'UTC' },
  badgeEnabled: true,
};

const voiceCapabilities = {
  mode: 'on_demand',
  serverAudio: false,
  persistentSession: false,
  rawAudioAccepted: false,
  transcriptStored: false,
} as const;

const briefing = {
  generatedAt: timestamp,
  scope: 'all',
  headline: 'Two tasks need your attention',
  speechText: 'Two tasks need your attention. Task 1 has failed checks. Task 2 is blocked.',
  counts: { running: 1, queued: 0, attention: 2, plans: 0, total: 2 },
  items: [
    {
      reference: 'task 1',
      position: 1,
      kind: 'task',
      id: 'task-1',
      title: 'Repair mobile voice coverage',
      repository: 'integry/propr',
      status: 'attention',
      summary: 'The mobile voice briefing checks need review.',
      href: '/tasks/task-1',
      requiresAttention: true,
      actions: ['open', 'stop', 'follow_up'],
      updatedAt: '2026-09-07T09:30:00.000Z',
    },
    {
      reference: 'task 2',
      position: 2,
      kind: 'task',
      id: 'task-2',
      title: 'Verify the text fallback',
      repository: 'integry/propr',
      status: 'blocked',
      summary: 'Browser speech APIs are unavailable in this smoke test.',
      href: '/tasks/task-2',
      requiresAttention: true,
      actions: ['open', 'stop', 'follow_up'],
      updatedAt: '2026-09-07T09:25:00.000Z',
    },
  ],
};

async function stubVoiceBriefingSmokeApis(
  page: Page,
  onVoiceRequest: (request: { method: string; pathname: string; scope: string | null }) => void,
  user: SmokeUser = member,
): Promise<void> {
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const { pathname } = url;

    // Match the authentication and notification stubs used by the PWA browser
    // smoke suite so this remains independent of a running backend. A signed-in
    // account is required because the voice opt-in is scoped to one.
    if (pathname === '/api/auth/demo-mode') {
      await route.fulfill({ json: { demoMode: false } });
      return;
    }
    if (pathname === '/api/auth/user') {
      await route.fulfill({ json: user });
      return;
    }
    if (pathname === '/api/notifications/unread-count') {
      await route.fulfill({ json: { unreadCount: 3 } });
      return;
    }
    if (pathname === '/api/notifications/preferences') {
      await route.fulfill({ json: notificationPreferences });
      return;
    }
    if (pathname === '/api/notifications') {
      await route.fulfill({
        json: { notifications: [], unreadCount: 3, nextCursor: null },
      });
      return;
    }
    if (pathname === '/api/voice/capabilities') {
      onVoiceRequest({ method: request.method(), pathname, scope: null });
      await route.fulfill({ json: voiceCapabilities });
      return;
    }
    if (pathname === '/api/voice/briefing') {
      onVoiceRequest({
        method: request.method(),
        pathname,
        scope: url.searchParams.get('scope'),
      });
      await route.fulfill({ json: briefing });
      return;
    }

    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'Unavailable in browser smoke test' }),
    });
  });
}

test('keeps Voice Briefings off until opt-in, then usable on a narrow mobile viewport', async ({ page }) => {
  const voiceRequests: Array<{ method: string; pathname: string; scope: string | null }> = [];

  await page.setViewportSize({ width: 320, height: 720 });
  await page.addInitScript(() => {
    // Headless environments differ in which partial speech globals they expose.
    // Remove all of them so this exercises the supported visual-only fallback.
    for (const property of [
      'speechSynthesis',
      'SpeechSynthesisUtterance',
      'SpeechRecognition',
      'webkitSpeechRecognition',
    ]) {
      Object.defineProperty(window, property, {
        configurable: true,
        value: undefined,
        writable: true,
      });
    }
  });
  await stubVoiceBriefingSmokeApis(page, request => voiceRequests.push(request));
  await page.goto('/inbox');

  const mobileNavigation = page.getByRole('navigation', { name: 'Primary navigation' });
  const launcher = page.getByRole('button', { name: 'Voice briefing' });
  await expect(mobileNavigation).toBeVisible();
  // Experimental and off by default: no entry point and no voice traffic at all.
  await expect(launcher).toBeHidden();
  expect(voiceRequests).toEqual([]);
  await capturePreview(page, 'mobile-inbox-voice-disabled.png');

  await page.goto('/settings');
  const optIn = page.getByRole('checkbox', { name: 'Enable voice briefings' });
  await expect(optIn).not.toBeChecked();
  await capturePreview(page, 'mobile-settings-voice-off.png');
  await optIn.check();
  // The launcher appears for the opt-in itself, without reloading the page.
  await expect(launcher).toBeVisible();
  expect(voiceRequests).toEqual([]);
  expect(await page.evaluate(
    key => localStorage.getItem(key),
    browserVoicePreferenceKey(new URL(page.url()).origin, member.id),
  )).toBe('true');

  await capturePreview(page, 'mobile-settings-voice-on.png');

  await page.goto('/inbox');
  await expect(mobileNavigation).toBeVisible();
  await expect(launcher).toBeVisible();

  const placement = await page.evaluate(() => {
    const launcherElement = document.querySelector<HTMLElement>('[aria-label="Voice briefing"]');
    const navigationElement = document.querySelector<HTMLElement>('nav[aria-label="Primary navigation"]');
    if (!launcherElement || !navigationElement) throw new Error('Mobile controls did not render');
    const launcherRect = launcherElement.getBoundingClientRect();
    const navigationRect = navigationElement.getBoundingClientRect();
    return {
      launcher: {
        top: launcherRect.top,
        right: launcherRect.right,
        bottom: launcherRect.bottom,
        left: launcherRect.left,
      },
      navigationTop: navigationRect.top,
      viewport: { width: window.innerWidth, height: window.innerHeight },
    };
  });
  expect(placement.launcher.left).toBeGreaterThanOrEqual(0);
  expect(placement.launcher.top).toBeGreaterThanOrEqual(0);
  expect(placement.launcher.right).toBeLessThanOrEqual(placement.viewport.width);
  expect(placement.launcher.bottom).toBeLessThanOrEqual(placement.navigationTop);
  expect(placement.launcher.bottom).toBeLessThanOrEqual(placement.viewport.height);

  expect(voiceRequests).toEqual([]);
  await launcher.click();

  const dialog = page.getByRole('dialog', { name: 'Voice briefing' });
  await expect(dialog).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Before you use voice recognition' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Listen' })).toBeDisabled();
  await expect(page.getByText(/Voice commands aren’t supported/)).toBeVisible();
  await expect(page.getByText(/Spoken playback isn’t supported/)).toBeVisible();
  expect(voiceRequests).toEqual([]);

  await page.getByRole('button', { name: 'I understand' }).click();
  await expect(page.getByRole('heading', { name: 'Before you use voice recognition' })).toBeHidden();
  expect(voiceRequests).toEqual([]);

  await page.getByRole('button', { name: 'Catch me up' }).click();
  await expect.poll(() => voiceRequests).toEqual([
    { method: 'GET', pathname: '/api/voice/briefing', scope: 'all' },
  ]);
  await expect(page.getByRole('heading', { name: briefing.headline })).toBeVisible();

  const briefingItems = page.getByRole('list', { name: 'Briefing items' });
  await expect(briefingItems).toBeVisible();
  await expect(briefingItems).toHaveJSProperty('tagName', 'OL');
  await expect(briefingItems.getByRole('listitem')).toHaveCount(2);
  await expect(briefingItems.getByText(/^t1$/i)).toBeVisible();
  await expect(briefingItems.getByText(/^t2$/i)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Repeat' })).toBeDisabled();

  const dialogBox = await dialog.boundingBox();
  if (!dialogBox) throw new Error('Voice Briefing dialog does not have a layout box');
  expect(dialogBox.x).toBeGreaterThanOrEqual(0);
  expect(dialogBox.y).toBeGreaterThanOrEqual(0);
  expect(dialogBox.x + dialogBox.width).toBeLessThanOrEqual(placement.viewport.width);
  expect(dialogBox.y + dialogBox.height).toBeLessThanOrEqual(placement.viewport.height);

  const pageWidth = await page.evaluate(() => ({
    viewport: window.innerWidth,
    document: document.documentElement.scrollWidth,
  }));
  expect(pageWidth.document).toBeLessThanOrEqual(pageWidth.viewport);

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(launcher).toBeFocused();

  const dashboardLink = mobileNavigation.getByRole('link', { name: 'Dashboard' });
  await expect(dashboardLink).toBeVisible();
  await dashboardLink.click();
  await expect(page).toHaveURL(/\/$/);

  await page.goto('/settings');
  await expect(page.getByRole('checkbox', { name: 'Enable voice briefings' })).toBeChecked();
  await page.getByRole('checkbox', { name: 'Enable voice briefings' }).uncheck();
  await expect(launcher).toBeHidden();
  await page.goto('/inbox');
  await expect(mobileNavigation).toBeVisible();
  await expect(launcher).toBeHidden();
});

test('shows the administrator opt-in under Integrations', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 820 });
  await stubVoiceBriefingSmokeApis(page, () => undefined, administrator);
  await page.goto('/settings?tab=integrations');

  const optIn = page.getByRole('checkbox', { name: 'Enable voice briefings' });
  await expect(page.getByRole('heading', { name: 'Voice briefings · Experimental' })).toBeVisible();
  await expect(optIn).not.toBeChecked();
  await expect(page.getByRole('button', { name: 'Voice briefing' })).toBeHidden();

  await optIn.check();
  await expect(page.getByRole('button', { name: 'Voice briefing' })).toBeVisible();
  await capturePreview(page, 'desktop-settings-voice-on.png');
});
