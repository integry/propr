import { expect, test, type Page, type Route } from '@playwright/test';

const delays = {
  demoMode: { total: 180, server: 60 },
  currentUser: { total: 220, server: 80 },
  routeChunk: { total: 160, server: 0 },
  usefulData: { total: 240, server: 100 },
} as const;

const user = {
  id: 'startup-user',
  login: 'operator',
  username: 'operator',
  displayName: 'Operator',
  email: null,
  avatarUrl: null,
  role: 'admin',
  permissions: ['instance.manage_settings'],
  authorizationSource: 'local',
};

const task = {
  id: 'startup-task',
  repository: 'integry/propr',
  issueNumber: 2409,
  title: 'Authenticated startup useful row',
  status: 'pending',
  createdAt: '2026-09-14T00:00:00.000Z',
  llmProvider: 'openai',
  model: 'gpt-5.6-sol',
};

type CriticalStage = 'demoMode' | 'currentUser' | 'routeChunk' | 'usefulData';
type StageTiming = { starts: number[]; ends: number[] };

const wait = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));

const installDesktopHarness = async (page: Page): Promise<void> => {
  await page.addInitScript(() => {
    const profile = {
      id: 'startup-profile',
      name: 'Startup instance',
      kind: 'remote' as const,
      baseUrl: 'http://127.0.0.1:4173',
    };
    window.__PROPR_DESKTOP__ = {
      isDesktop: true,
      platform: 'linux',
      app: { onDeepLink: () => () => undefined },
      profiles: {
        list: async () => [profile],
        getActiveId: async () => profile.id,
        setActiveId: async () => undefined,
        save: async () => undefined,
        remove: async () => undefined,
      },
      connection: { probe: async () => ({ status: 'ready' }) },
      authentication: { authenticate: async () => undefined },
      discovery: { supported: false, discover: async () => [] },
      localSetup: { supported: false, setup: async () => profile },
      externalBrowser: { open: async () => undefined },
    };
  });
};

const runningItem = {
  id: 'task:startup-task',
  taskId: task.id,
  repository: task.repository,
  issueNumber: task.issueNumber,
  prNumber: null,
  title: task.title,
  state: 'claude_execution',
  phase: 'Implementing',
  progressLine: null,
  createdAt: task.createdAt,
  updatedAt: task.createdAt,
};

const fallbackResponses: Record<string, unknown> = {
  '/api/instance/catalog': { agents: [], repositories: [] },
  '/api/tasks': { tasks: [task], total: 1 },
  '/api/dashboard/summary': { repository: 'all', needsAttention: 0, running: 1, queued: 0, completedRecently: 0, recentWindowHours: 24 },
  '/api/dashboard/attention': { repository: 'all', items: [], counts: { blocked: 0, decisions: 0, total: 0 } },
  '/api/dashboard/outcomes': { repository: 'all', limit: 50, items: [] },
  '/api/stats/dashboard': {
    period: '7d', repository: 'all', completed: 0, successRate: null, recordedSpend: null,
    dailyCompleted: [], previous: { completed: 0, successRate: null, recordedSpend: null },
  },
  '/api/notifications/unread-count': { unreadCount: 0 },
  '/api/notifications/preferences': { preferences: {}, quietHours: {}, badgeEnabled: false },
  '/api/notifications/config': { enabled: false },
  '/api/queue/stats': { active: 0, waiting: 0, completed: 0, failed: 0 },
  '/api/stats/generating-plans': { count: 0 },
  '/api/stats/repositories': { repositories: [] },
  '/api/stats/tasks': {
    dailyCounts: [], statusDistribution: [], avgProcessingTime: [],
    summary: { total: 1, completed: 0, failed: 0 },
  },
  '/api/stats/overview': {
    tasks: { completed: 0, planned: 1, pr_iterations_avg: 0, merged_prs: 0, total_followups: 0 },
    usage: { total_tokens: 0, total_cost_usd: 0, models: {} },
    system: { repos_indexed: 0 },
  },
  '/api/planner/drafts': { drafts: [] },
  '/api/status': { status: 'ok' },
};

// The dashboard's first useful read is its running-work section; the tasks
// page's is the task list itself.
const scenarios = [
  {
    name: 'dashboard', path: '/', chunk: 'Dashboard', listLimit: null,
    usefulPath: '/api/dashboard/active',
    usefulBody: {
      repository: 'all', running: [runningItem], queued: [],
      queue: { queuedCount: 0, reason: null }, counts: { running: 1, queued: 0 },
    },
  },
  {
    name: 'tasks', path: '/tasks', chunk: 'TasksPage', listLimit: 100,
    usefulPath: '/api/tasks',
    usefulBody: { tasks: [task], total: 1 },
  },
] as const;

for (const runtime of ['web', 'desktop'] as const) {
  for (const scenario of scenarios) {
  test(`${runtime} ${scenario.name} deduplicates only same-scope startup reads`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    if (runtime === 'desktop') await installDesktopHarness(page);

    const epoch = performance.now();
    const timing: Record<CriticalStage, StageTiming> = {
      demoMode: { starts: [], ends: [] },
      currentUser: { starts: [], ends: [] },
      routeChunk: { starts: [], ends: [] },
      usefulData: { starts: [], ends: [] },
    };
    const apiRequests: string[] = [];
    const record = async (stage: CriticalStage, route: Route, body?: unknown): Promise<void> => {
      timing[stage].starts.push(performance.now() - epoch);
      await wait(delays[stage].total);
      if (body === undefined) await route.continue();
      else {
        await route.fulfill({
          json: body,
          headers: { 'Server-Timing': `fixture;dur=${delays[stage].server}` },
        });
      }
      timing[stage].ends.push(performance.now() - epoch);
    };

    await page.route(`**/assets/${scenario.chunk}-*.js`, route => record('routeChunk', route));
    await page.route('**/api/**', async route => {
      const url = new URL(route.request().url());
      apiRequests.push(`${url.pathname}${url.search}`);
      if (url.pathname === '/api/auth/demo-mode') return record('demoMode', route, { demoMode: false });
      if (url.pathname === '/api/auth/user') return record('currentUser', route, user);
      if (url.pathname === scenario.usefulPath) return record('usefulData', route, scenario.usefulBody);
      return route.fulfill({ json: fallbackResponses[url.pathname] ?? {} });
    });

    await page.goto(scenario.path);
    await expect(
      scenario.name === 'dashboard'
        ? page.getByTestId('happening-now-section').getByText(task.title)
        : page.getByRole('table').getByText(task.title),
    ).toBeVisible();
    const firstUsefulRenderMs = performance.now() - epoch;
    const browserResources = await page.evaluate(() => (
      performance.getEntriesByType('resource') as PerformanceResourceTiming[]
    ).filter(entry => entry.name.includes('/api/') || entry.name.includes('/assets/TasksPage-'))
      .map(entry => ({
        path: `${new URL(entry.name).pathname}${new URL(entry.name).search}`,
        responseWaitMs: Math.max(0, entry.responseStart - entry.requestStart),
        transferMs: Math.max(0, entry.responseEnd - entry.responseStart),
        declaredServerMs: entry.serverTiming.find(item => item.name === 'fixture')?.duration ?? null,
      })));

    expect(timing.demoMode.starts).toHaveLength(1);
    expect(timing.currentUser.starts).toHaveLength(1);
    expect(timing.routeChunk.starts).toHaveLength(1);
    expect(timing.currentUser.starts[0]).toBeLessThan(timing.demoMode.ends[0]);
    expect(timing.routeChunk.starts[0]).toBeLessThan(timing.demoMode.ends[0]);
    expect(timing.routeChunk.starts[0]).toBeLessThan(timing.currentUser.ends[0]);

    const firstUsefulDataStart = Math.min(...timing.usefulData.starts);
    expect(firstUsefulDataStart).toBeGreaterThanOrEqual(timing.demoMode.ends[0]);
    expect(firstUsefulDataStart).toBeGreaterThanOrEqual(timing.currentUser.ends[0]);
    expect(firstUsefulDataStart).toBeGreaterThanOrEqual(timing.routeChunk.ends[0]);
    expect(apiRequests.filter(request => request === '/api/auth/demo-mode')).toHaveLength(1);
    expect(apiRequests.filter(request => request.startsWith('/api/auth/user'))).toHaveLength(1);
    const taskRequests = apiRequests.filter(request => request.startsWith('/api/tasks?'));
    const taskRequestParams = taskRequests.map(request => ({
      request,
      params: new URL(request, 'https://startup.propr.invalid').searchParams,
    }));
    const catalogRequests = apiRequests.filter(request => request === '/api/instance/catalog');
    const statusRequests = apiRequests.filter(request => request === '/api/status');
    const taskConsumers = {
      list: scenario.listLimit === null
        ? []
        : taskRequestParams.filter(({ params }) => params.get('limit') === String(scenario.listLimit))
          .map(({ request }) => request),
      headerReview: taskRequestParams.filter(({ params }) => params.get('limit') === '30'
        && params.get('forReview') === 'true' && params.get('excludeMerged') === 'true')
        .map(({ request }) => request),
      readinessExistence: taskRequestParams.filter(({ params }) => params.get('limit') === '1')
        .map(({ request }) => request),
    };
    expect(catalogRequests).toHaveLength(1);
    expect(statusRequests).toHaveLength(1);
    // The dashboard reads its own endpoints, so only the header review and the
    // readiness existence probe remain on /api/tasks there.
    expect(taskRequests).toHaveLength(scenario.listLimit === null ? 2 : 3);
    expect(taskConsumers.list).toHaveLength(scenario.listLimit === null ? 0 : 1);
    expect(taskConsumers.headerReview).toHaveLength(1);
    expect(taskConsumers.readinessExistence).toHaveLength(1);

    const serialInjectedWaitMs = Object.values(delays).reduce((total, stage) => total + stage.total, 0);
    const overlappedInjectedWaitMs = Math.max(
      delays.demoMode.total,
      delays.currentUser.total,
      delays.routeChunk.total,
    ) + delays.usefulData.total;
    const lastUsefulDataEnd = Math.max(...timing.usefulData.ends);
    const authenticatedShellReadyMs = Math.max(
      timing.demoMode.ends[0],
      timing.currentUser.ends[0],
      timing.routeChunk.ends[0],
    );
    const baselineDuplicateReads = scenario.name === 'dashboard'
      ? { instanceCatalog: 3, systemStatus: 2, readinessExistence: 2 }
      : { instanceCatalog: 2, systemStatus: 2, readinessExistence: 1 };
    const removedStartupReads = (baselineDuplicateReads.instanceCatalog - catalogRequests.length)
      + (baselineDuplicateReads.systemStatus - statusRequests.length)
      + (baselineDuplicateReads.readinessExistence - taskConsumers.readinessExistence.length);
    const measurement = {
      runtime,
      route: scenario.name,
      conditions: delays,
      requestCountBeforeUsefulRender: apiRequests.length,
      baselineRequestCountBeforeUsefulRender: apiRequests.length + removedStartupReads,
      removedStartupReads,
      baselineDuplicateReads,
      sameScopeRequestCounts: {
        instanceCatalog: catalogRequests.length,
        systemStatus: statusRequests.length,
      },
      taskRequestConsumers: {
        list: taskConsumers.list,
        headerReview: taskConsumers.headerReview,
        readinessExistence: taskConsumers.readinessExistence,
      },
      criticalRequestCounts: {
        demoMode: timing.demoMode.starts.length,
        currentUser: timing.currentUser.starts.length,
        routeChunk: timing.routeChunk.starts.length,
        usefulData: timing.usefulData.starts.length,
      },
      criticalStageTimingMs: timing,
      browserResourceTimingMs: browserResources,
      injectedCriticalPath: {
        beforeSerialMs: serialInjectedWaitMs,
        afterOverlappedMs: overlappedInjectedWaitMs,
        savedMs: serialInjectedWaitMs - overlappedInjectedWaitMs,
      },
      firstUsefulRenderMs,
      authenticatedShellToUsefulDataRequestMs: Math.max(0, firstUsefulDataStart - authenticatedShellReadyMs),
      renderAfterLastUsefulDataMs: Math.max(0, firstUsefulRenderMs - lastUsefulDataEnd),
      limitations: [
        'Playwright API delays represent response wait; declared Server-Timing separates the fixture server share.',
        'The static chunk delay occurs before route.continue(), so Chromium resource TTFB excludes that harness wait.',
        'Wall time includes local Chromium, bundle parsing, React work, and test routing overhead.',
        'Task list, header review, and readiness existence are recorded as separate contracts and are not deduplicated with each other.',
      ],
    };
    console.log(`STARTUP_MEASUREMENT ${JSON.stringify(measurement)}`);
    await testInfo.attach(`${runtime}-${scenario.name}-startup-measurement.json`, {
      body: JSON.stringify(measurement, null, 2),
      contentType: 'application/json',
    });
  });
  }
}
