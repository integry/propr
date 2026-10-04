import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

const timestamp = '2026-09-13T12:00:00.000Z';
const media = ['Task queue', 'Goal workspace', 'Repository settings', 'Additional screen'].map((title, i) => ({
  title, description: 'Published interface evidence from the completed implementation.', type: 'image',
  url: `https://github.com/user-attachments/assets/preview-${i}`,
}));
const goal = {
  id: 'goal-1', owner: 'preview', repository: 'acme/web', title: 'Ship the visual preview experience', objective: 'Make published task and goal evidence easy to discover.',
  agent: { id: 'agent-1', alias: 'codex', type: 'codex' }, requestedModel: 'gpt-6-astra', effectiveModel: 'gpt-6-astra',
  launchStrategy: 'direct', desiredState: 'running', resultState: 'completed', taskState: 'completed',
  liveSummary: { currentTask: 'Implementation complete', todos: [], tokenUsage: { input_tokens: 12000, output_tokens: 3000 } },
  artifactStats: { issues: 1, openIssues: 0, pullRequests: 1, openPullRequests: 1 },
  createdAt: timestamp, updatedAt: timestamp, activeMs: 240000, elapsedMs: 240000,
};
const notification = {
  id: 'completed-1', deduplicationKey: 'completed-1', kind: 'pull_request', severity: 'info',
  target: { type: 'pull_request', repository: 'acme/web', prNumber: 42 },
  metadata: { completedImplementationTaskId: 'task-1' },
  title: 'Published previews are ready to review', body: 'PR #42 is ready for review.',
  actions: ['open_pr', 'dismiss'],
  action: { type: 'external_link', label: 'Open PR', href: 'https://github.com/acme/web/pull/42' },
  occurredAt: timestamp, createdAt: timestamp, readAt: null, dismissedAt: null,
};

async function fixture(page: Page) {
  let showMedia = false;
  let image: Buffer | undefined;
  let mediaState: 'ready' | 'empty' | 'error' = 'ready';
  const requests: string[] = [];
  const repositories = [
    { id: 'enabled', name: 'acme/web', enabled: true, visualPreview: { enabled: true, types: ['image'] } },
    { id: 'disabled', name: 'acme/legacy', enabled: true },
  ];
  await page.routeWebSocket('**/socket.io/**', socket => socket.close());
  await page.route('https://github.com/user-attachments/assets/**', route => image
    ? route.fulfill({ contentType: 'image/png', body: image }) : route.abort());
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    requests.push(path);
    if (path === '/api/repos/media' && mediaState === 'error') return route.fulfill({ status: 503, json: { error: 'Media unavailable' } });
    const previewMedia = showMedia ? media : undefined;
    const responses: Record<string, unknown> = {
      '/api/auth/demo-mode': { demoMode: false },
      '/api/auth/user': { id: 'preview-user', login: 'preview', username: 'preview', displayName: 'Preview workspace', email: null, avatarUrl: null, role: 'member', permissions: [], authorizationSource: 'local' },
      '/api/instance/catalog': { repositories, agents: [] },
      '/api/user/repo-preferences': { preferences: {} },
      '/api/repositories/indexing-status': { repositories: [] },
      '/api/repos/chat/messages': { messages: [] },
      '/api/repos/media': { previews: mediaState === 'empty' ? [] : media, nextOffset: null },
      '/api/tasks': { tasks: [{ id: 'task-1', repository: 'acme/web', repositoryOwner: 'acme', repositoryName: 'web', issueNumber: 41, prNumber: 42,
        title: 'New Issue: Surface published visual previews across the workspace', status: 'completed', createdAt: timestamp, processedAt: timestamp, completedAt: timestamp,
        modelName: 'gpt-6-astra', llmProvider: 'codex', previewMedia }], total: 1 },
      '/api/stats/repositories': { repositories: [{ repository: 'acme/web', total: 1 }] },
      '/api/goals': { goals: [{ ...goal, previewMedia }] },
      '/api/notifications': { notifications: [{ ...notification, previewMedia }, {
        ...notification, id: 'attention-1', deduplicationKey: 'attention-1', metadata: undefined,
        title: 'A separate PR needs attention', previewMedia,
      }], unreadCount: 2, nextCursor: null },
      '/api/notifications/unread-count': { unreadCount: 2 },
      '/api/notifications/config': { push: { configured: false, vapidPublicKey: null } },
      '/api/notifications/preferences': { preferences: {}, quietHours: { start: null, end: null, timezone: 'UTC' }, badgeEnabled: false },
    };
    return route.fulfill(path in responses ? { json: responses[path] } : { status: 503, json: { error: 'Optional API unavailable in preview fixture' } });
  });
  // Use a real rendered app screenshot as the published-image fixture; no invented artwork.
  await page.goto('/goals');
  await expect(page.getByRole('heading', { name: goal.title })).toBeVisible();
  image = await page.screenshot();
  showMedia = true;
  return { requests, state: (state: typeof mediaState) => { mediaState = state; }, disable: () => { showMedia = false; } };
}

const videoUrl = 'https://github.com/user-attachments/assets/walkthrough';

/**
 * A short WebM recorded from a screenshot of the running app, encoded by Chromium itself so the
 * fixture is real, playable media rather than invented artwork or a checked-in binary.
 */
async function recordClip(page: Page) {
  const frame = `data:image/png;base64,${(await page.screenshot()).toString('base64')}`;
  const bytes = await page.evaluate(async source => {
    const poster = new Image();
    poster.src = source;
    await poster.decode();
    const canvas = document.createElement('canvas');
    canvas.width = 960;
    canvas.height = 540;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('2D canvas unavailable');
    const scale = Math.min(canvas.width / poster.width, canvas.height / poster.height);
    const [width, height] = [poster.width * scale, poster.height * scale];
    const draw = (progress: number) => {
      context.fillStyle = '#020617';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(poster, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height);
      context.fillStyle = '#38bdf8';
      context.fillRect(0, canvas.height - 10, canvas.width * progress, 10);
    };
    draw(0);
    const recorder = new MediaRecorder(canvas.captureStream(25), { mimeType: 'video/webm' });
    const chunks: Blob[] = [];
    recorder.ondataavailable = event => chunks.push(event.data);
    recorder.start();
    for (let index = 1; index <= 25; index += 1) {
      draw(index / 25);
      await new Promise(resolve => setTimeout(resolve, 40));
    }
    await new Promise(resolve => { recorder.onstop = () => resolve(null); recorder.stop(); });
    return [...new Uint8Array(await new Blob(chunks).arrayBuffer())];
  }, frame);
  return Buffer.from(bytes);
}

async function capture(page: Page, name: string) {
  if (!process.env.PROPR_CAPTURE_PREVIEWS) return;
  await mkdir('../.propr/previews', { recursive: true });
  await page.screenshot({ animations: 'disabled', path: `../.propr/previews/${name}.png` });
}

for (const width of [390, 1440]) {
  test(`completion-derived PR Inbox preview at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const api = await fixture(page);
    await page.goto('/inbox');
    const completion = page.getByRole('article').filter({ hasText: notification.title });
    const unrelated = page.getByRole('article').filter({ hasText: 'A separate PR needs attention' });
    await expect(completion.getByRole('img', { name: 'Task queue', exact: true })).toBeVisible();
    await expect(completion.locator('img')).toHaveCount(1);
    await expect(unrelated.locator('img')).toHaveCount(0);
    // The card opens the implementation task; the PR chip opens GitHub separately.
    const taskLink = completion.getByRole('link', { name: notification.title, exact: true });
    await expect(taskLink).toHaveAttribute('href', '/tasks/task-1');
    await expect(taskLink).not.toHaveAttribute('target', '_blank');
    const prLink = completion.getByRole('link', { name: 'PR #42 on GitHub', exact: true });
    await expect(prLink).toHaveAttribute('href', notification.action.href);
    await expect(prLink).toHaveAttribute('target', '_blank');
    await expect(completion.getByRole('button')).toHaveCount(1);
    await expect(completion.getByRole('button', { name: `Dismiss ${notification.title}` })).toBeEnabled();
    await expect(page.getByRole('article')).toHaveCount(2);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await capture(page, `completion-inbox-${width}`);
    api.disable();
    await page.reload();
    await expect(completion).toBeVisible();
    await expect(page.locator('[aria-label="Published visual previews"]')).toHaveCount(0);
  });

  test(`published media is responsive across rows, Inbox and repository tabs at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const api = await fixture(page);
    await page.goto('/tasks');
    // The task ledger announces evidence as a count: thumbnails in dense rows load as empty boxes.
    await expect(page.locator('[data-testid="preview-count"]:visible')).toHaveText('4 previews');
    await expect(page.locator('[aria-label="Published visual previews"]:visible')).toHaveCount(0);
    await capture(page, `preview-task-rows-${width}`);
    await page.goto('/goals');
    await expect(page.getByRole('img', { name: 'Task queue', exact: true })).toBeVisible();
    await expect(page.locator('[aria-label="Published visual previews"]:visible img')).toHaveCount(3);
    expect(api.requests.some(request => /\/goals\/.+\/previews/.test(request))).toBe(false);
    await capture(page, `preview-goal-rows-${width}`);
    await page.goto('/inbox');
    await expect(page.getByRole('img', { name: 'Task queue', exact: true })).toBeVisible();
    await expect(page.locator('[aria-label="Published visual previews"]:visible img')).toHaveCount(1);
    await capture(page, `preview-inbox-${width}`);
    await page.goto('/repositories');
    await page.getByRole('button', { name: 'Select acme/web', exact: true }).click();
    await page.getByRole('button', { name: 'Media', exact: true }).click();
    const panel = page.getByRole('region', { name: 'Published media for acme/web', exact: true });
    await expect(panel.getByAltText('Task queue')).toBeVisible();
    await expect(panel.locator('figure')).toHaveCount(4);
    expect(await panel.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await capture(page, `preview-repository-media-${width}`);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    // Switching to a legacy repository must remove both the tab and gallery immediately.
    if (width < 1024) await page.getByTitle('Back to repositories').click();
    await page.getByRole('button', { name: 'Select acme/legacy', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Media', exact: true })).toHaveCount(0);
    await expect(panel).toHaveCount(0);
  });

  test(`repository media opens in an in-app lightbox at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await fixture(page);
    // Record the walkthrough clip from the running app itself, so the video fixture is real media.
    const clip = await recordClip(page);
    const previews = [...media, { title: 'Walkthrough', description: 'Recorded run of the completed implementation.', type: 'video', url: videoUrl }];
    await page.route(videoUrl, route => route.fulfill({ contentType: 'video/webm', body: clip }));
    await page.route('**/api/repos/media*', route => route.fulfill({ json: { previews, nextOffset: null } }));

    await page.goto('/repositories');
    await page.getByRole('button', { name: 'Select acme/web', exact: true }).click();
    await page.getByRole('button', { name: 'Media', exact: true }).click();
    const tile = page.getByRole('button', { name: 'Open preview: Task queue', exact: true });
    await expect(tile).toBeVisible();
    await expect(page.getByRole('link', { name: /Open preview/ })).toHaveCount(0);
    await tile.click();
    // The media stays in the app: no second tab, no navigation away from the repository view.
    expect(page.context().pages()).toHaveLength(1);
    const dialog = page.getByRole('dialog', { name: 'Task queue', exact: true });
    await expect(dialog).toHaveAttribute('aria-modal', 'true');
    await expect(dialog.getByRole('img', { name: 'Task queue', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Close preview', exact: true })).toBeFocused();
    expect(await page.evaluate(() => getComputedStyle(document.body).overflow)).toBe('hidden');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await capture(page, `media-lightbox-image-${width}`);

    // Zooming to the cap disables the control the keyboard is standing on; focus has to stay in the dialog.
    const zoomIn = page.getByRole('button', { name: 'Zoom in', exact: true });
    await page.keyboard.press('Shift+Tab');
    await expect(zoomIn).toBeFocused();
    for (let press = 0; press < 4; press += 1) await page.keyboard.press('Enter');
    await expect(zoomIn).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Close preview', exact: true })).toBeFocused();
    await page.getByRole('button', { name: /Reset zoom/ }).click();

    // Arrow keys and the next control walk the collection, which mixes images and videos.
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('dialog', { name: 'Goal workspace', exact: true })).toBeVisible();
    for (let step = 0; step < 2; step += 1) await page.getByRole('button', { name: 'Next preview', exact: true }).click();
    // The last image before the video: ArrowRight from a focused zoom control removes that control, and
    // focus must not fall to the body or Escape and the arrow keys would stop reaching the dialog.
    await expect(page.getByRole('dialog', { name: 'Additional screen', exact: true })).toBeVisible();
    await zoomIn.focus();
    await expect(zoomIn).toBeFocused();
    await page.keyboard.press('ArrowRight');
    const player = page.getByRole('dialog', { name: 'Walkthrough', exact: true }).locator('video');
    await expect(player).toBeVisible();
    await expect(zoomIn).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Close preview', exact: true })).toBeFocused();
    await player.evaluate((video: HTMLVideoElement) => video.play());
    await expect.poll(() => player.evaluate((video: HTMLVideoElement) => video.currentTime)).toBeGreaterThan(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await capture(page, `media-lightbox-video-${width}`);

    // Escape closes the overlay, unlocks the page and hands focus back to the tile that opened it.
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(tile).toBeFocused();
    expect(await page.evaluate(() => getComputedStyle(document.body).overflow)).not.toBe('hidden');
    const videoTile = page.getByRole('button', { name: 'Open preview: Walkthrough', exact: true });
    await videoTile.scrollIntoViewIfNeeded();
    await expect(videoTile).toBeVisible();
    await capture(page, `media-grid-${width}`);
  });
}

test('repository gallery exposes empty and failure states in the browser', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const api = await fixture(page);
  api.state('empty');
  await page.goto('/repositories');
  await page.getByRole('button', { name: 'Select acme/web', exact: true }).click();
  await page.getByRole('button', { name: 'Media', exact: true }).click();
  await expect(page.getByText('No published previews yet')).toBeVisible();
  api.state('error');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Media', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Some media is unavailable');
  api.state('ready');
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(page.getByAltText('Task queue')).toBeVisible();
});
