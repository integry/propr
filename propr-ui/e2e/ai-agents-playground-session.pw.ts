import { expect, test, type Page } from '@playwright/test';

// Run in both engines with `npm run test:browser -- e2e/ai-agents-playground-session.pw.ts
// --browser=chromium` and `--browser=webkit`. Provider replies are stubbed.

const user = {
  id: 'playground-session-admin',
  login: 'playground-session-admin',
  username: 'playground-session-admin',
  displayName: 'Playground Session Admin',
  email: null,
  avatarUrl: null,
  role: 'admin',
  permissions: ['instance.manage_agents'],
  authorizationSource: 'local',
};

const agents = [{
  id: 'claude-playground',
  type: 'claude',
  alias: 'Claude Code',
  enabled: true,
  dockerImage: 'propr/agent:latest',
  configPath: '/agents/claude-playground',
  defaultModel: 'claude-opus-5-5',
  supportedModels: ['claude-opus-5-5', 'claude-sonnet-5-5'],
}];

const replyLabels: Record<string, string> = { 'claude-opus-5-5': 'Opus', 'claude-sonnet-5-5': 'Sonnet' };

const desktop = { width: 1280, height: 800 };
const viewports = [
  { name: 'desktop', size: desktop, other: { width: 390, height: 844 } },
  { name: '390px', size: { width: 390, height: 844 }, other: desktop },
  { name: '320px', size: { width: 320, height: 720 }, other: desktop },
];

interface ChatRequest {
  queries: Array<{ agentId: string; model?: string }>;
  prompt: string;
  context: string;
}

async function stubApis(page: Page) {
  const chatRequests: ChatRequest[] = [];
  let releaseDelayed!: () => void;
  const delayed = new Promise<void>(resolve => { releaseDelayed = resolve; });

  await page.route('**/api/**', async route => {
    const pathname = new URL(route.request().url()).pathname;
    const responses: Record<string, unknown> = {
      '/api/auth/demo-mode': { demoMode: false },
      '/api/auth/user': user,
      '/api/config/agents': { agents },
      '/api/config/synthetic-agents': { synthetic_agents: [] },
      '/api/config/agent-tank/status': { available: false },
      '/api/notifications/unread-count': { unreadCount: 0 },
      '/api/notifications': { notifications: [], unreadCount: 0, nextCursor: null },
    };
    if (pathname in responses) return route.fulfill({ json: responses[pathname] });
    if (/^\/api\/agents\/[^/]+\/health$/.test(pathname)) {
      return route.fulfill({ json: { agentId: pathname.split('/')[3], status: 'ready', model: 'claude-opus-5-5' } });
    }
    return route.fulfill({ status: 503, json: { error: 'Unavailable in Playground session test' } });
  });
  await page.route('**/api/agents/chat', async route => {
    const request = route.request().postDataJSON() as ChatRequest;
    chatRequests.push(request);
    const delayedReply = request.prompt === 'Delayed question';
    if (delayedReply) await delayed;
    await route.fulfill({
      json: {
        results: request.queries.map(query => ({
          agentId: query.agentId,
          agentAlias: 'Claude Code',
          model: query.model,
          response: `${delayedReply ? 'Delayed' : 'Earlier'} answer from ${replyLabels[query.model!]}`,
          durationMs: 12,
        })),
      },
    });
  });
  return { chatRequests, releaseDelayed };
}

const visibleInput = (page: Page) => page.getByPlaceholder('Type a message to test...').filter({ visible: true });
const visibleTranscript = (page: Page) => page.getByTestId('ai-agents-playground-transcript').filter({ visible: true });

async function useViewport(page: Page, size: { width: number; height: number }) {
  await page.setViewportSize(size);
  if (size.width >= 768) {
    await expect(page.getByRole('heading', { name: 'Agent Configuration' })).toBeVisible();
  } else {
    await expect(page.getByRole('button', { name: 'Configuration', exact: true })).toBeVisible();
  }
  await expect(visibleInput(page)).toHaveCount(1);
}

async function toggleMobileTabs(page: Page) {
  if (page.viewportSize()!.width >= 768) return;
  await page.getByRole('button', { name: 'Configuration', exact: true }).click();
  await expect(visibleInput(page)).toHaveCount(0);
  await expect(page.getByTestId('ai-agents-mobile-configuration-scroll')).toBeVisible();
  await page.getByRole('button', { name: 'Playground', exact: true }).click();
  await expect(visibleInput(page)).toHaveCount(1);
}

async function expectUsableLayout(page: Page) {
  const dimensions = await page.evaluate(() => ({
    viewportWidth: window.innerWidth,
    documentWidth: document.documentElement.scrollWidth,
  }));
  expect(dimensions.documentWidth).toBeLessThanOrEqual(dimensions.viewportWidth);
  for (const action of [
    page.getByRole('button', { name: 'Send message' }).filter({ visible: true }),
    page.getByTitle('Clear History').filter({ visible: true }),
    page.getByRole('combobox', { name: 'Search and add models to compare' }).filter({ visible: true }),
  ]) {
    await expect(action).toBeVisible();
    // WebKit lays out sub-pixel edges, so allow one pixel of rounding.
    const box = (await action.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(-1);
    expect(box.y).toBeGreaterThanOrEqual(-1);
    expect(box.x + box.width).toBeLessThanOrEqual(dimensions.viewportWidth + 1);
    expect(box.y + box.height).toBeLessThanOrEqual(page.viewportSize()!.height + 1);
  }
}

async function expectSelectedModels(page: Page) {
  for (const name of ['Claude Code: Claude Opus 5.5', 'Claude Code: Claude Sonnet 5.5']) {
    await expect(page.getByRole('button', { name, exact: true }).filter({ visible: true }))
      .toHaveAttribute('aria-pressed', 'true');
  }
}

for (const viewport of viewports) {
  test(`${viewport.name} Playground keeps its draft, transcript and pending reply across layout changes`, async ({ page }) => {
    const { chatRequests, releaseDelayed } = await stubApis(page);
    await page.setViewportSize(viewport.size);
    await page.goto('/ai-agents');
    await useViewport(page, viewport.size);

    await expect(page.getByRole('button', { name: 'Claude Code: Claude Opus 5.5', exact: true }).filter({ visible: true }))
      .toHaveAttribute('aria-pressed', 'true');
    const search = page.getByRole('combobox', { name: 'Search and add models to compare' }).filter({ visible: true });
    await search.click();
    await search.fill('Sonnet');
    await page.getByRole('option', { name: /Claude Sonnet 5\.5/ }).filter({ visible: true }).click();
    await page.keyboard.press('Escape');
    await expectSelectedModels(page);

    // An existing transcript.
    await visibleInput(page).fill('Earlier question');
    await visibleInput(page).press('Enter');
    await expect(visibleTranscript(page).getByText('Earlier answer from Sonnet')).toHaveCount(1);
    await expectUsableLayout(page);

    // An unsent draft survives the breakpoint and the mobile tabs.
    await visibleInput(page).fill('Unsent draft');
    await toggleMobileTabs(page);
    await expect(visibleInput(page)).toHaveValue('Unsent draft');
    if (process.env.PROPR_CAPTURE_PREVIEWS && viewport.name === '390px') {
      await page.screenshot({ path: '../.propr/previews/playground-draft-after-mobile-tabs.png' });
    }
    await useViewport(page, viewport.other);
    await expect(visibleInput(page)).toHaveValue('Unsent draft');
    await toggleMobileTabs(page);
    await expect(visibleInput(page)).toHaveValue('Unsent draft');
    await expectUsableLayout(page);
    await useViewport(page, viewport.size);
    await expect(visibleInput(page)).toHaveValue('Unsent draft');
    if (process.env.PROPR_CAPTURE_PREVIEWS && viewport.name === 'desktop') {
      await page.screenshot({ path: '../.propr/previews/playground-draft-after-breakpoint.png' });
    }
    await expect(visibleTranscript(page).getByText('Earlier question')).toHaveCount(1);

    // A pending reply survives the same changes and is shown exactly once.
    await visibleInput(page).fill('Delayed question');
    await visibleInput(page).press('Enter');
    await expect(visibleTranscript(page).getByText('Thinking...')).toBeVisible();
    await useViewport(page, viewport.other);
    await expect(visibleTranscript(page).getByText('Thinking...')).toBeVisible();
    if (page.viewportSize()!.width < 768) {
      await page.getByRole('button', { name: 'Configuration', exact: true }).click();
      releaseDelayed();
      await page.getByRole('button', { name: 'Playground', exact: true }).click();
    } else {
      releaseDelayed();
    }
    await useViewport(page, viewport.size);
    await toggleMobileTabs(page);
    const transcript = visibleTranscript(page);
    await expect(transcript.getByText('Delayed answer from Opus')).toHaveCount(1);
    await expect(transcript.getByText('Delayed answer from Sonnet')).toHaveCount(1);
    await expect(transcript.getByText('Delayed question')).toHaveCount(1);
    await expect(transcript.getByText('Earlier question')).toHaveCount(1);
    await expect(transcript.getByText('Thinking...')).toHaveCount(0);
    await expectSelectedModels(page);
    await expectUsableLayout(page);

    // One normal chat POST per sent message, carrying the retained context.
    expect(chatRequests.map(request => request.prompt)).toEqual(['Earlier question', 'Delayed question']);
    expect(chatRequests[1]).toEqual({
      queries: [
        { agentId: 'claude-playground', model: 'claude-opus-5-5' },
        { agentId: 'claude-playground', model: 'claude-sonnet-5-5' },
      ],
      prompt: 'Delayed question',
      context: 'User: Earlier question\nAssistant: (Previous response hidden)',
    });

    // Clearing is still intentional and shared by every layout.
    await page.getByTitle('Clear History').filter({ visible: true }).click();
    await expect(visibleTranscript(page).getByText('Delayed question')).toHaveCount(0);
    await useViewport(page, viewport.other);
    await expect(visibleTranscript(page).getByText('Test your agents by sending messages.', { exact: false })).toBeVisible();
    await expect(visibleTranscript(page).getByText('Earlier question')).toHaveCount(0);
    await expectSelectedModels(page);
    expect(chatRequests).toHaveLength(2);
  });
}
