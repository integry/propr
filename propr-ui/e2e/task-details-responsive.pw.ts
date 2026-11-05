import { expect, test, type Locator, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const taskId = 'task-responsive-2252';
const startedAt = Date.parse('2026-09-09T20:00:00.000Z');

const history = [
  {
    state: 'PENDING',
    timestamp: new Date(startedAt).toISOString(),
    promptPath: '/api/fixtures/task/prompt',
    logsPath: '/api/fixtures/task/logs',
    metadata: { model: 'gpt-5.6-sol' },
  },
  ...Array.from({ length: 32 }, (_, index) => ({
    state: 'CLAUDE_EXECUTION',
    timestamp: new Date(startedAt + (index + 1) * 60_000).toISOString(),
    metadata: {
      model: 'gpt-5.6-sol',
      description: index === 31
        ? 'Timeline final checkpoint'
        : `Implementation checkpoint ${index + 1}`,
    },
  })),
  {
    state: 'COMPLETED',
    timestamp: new Date(startedAt + 34 * 60_000).toISOString(),
    metadata: {
      model: 'gpt-5.6-sol',
      pr: { url: 'https://github.com/integry/propr/pull/2253', number: 2253 },
    },
  },
];

const todos = Array.from({ length: 24 }, (_, index) => ({
  id: `todo-${index + 1}`,
  content: index === 23 ? 'Final execution rail checkpoint' : `Responsive task step ${index + 1}`,
  status: 'completed',
}));

const events = Array.from({ length: 28 }, (_, index) => {
  const timestamp = new Date(startedAt + (index + 1) * 45_000).toISOString();
  return [
    {
      id: `thought-${index}`,
      type: 'thought',
      timestamp,
      content: index === 26
        ? `## Summary of Changes\n\nImplementation summary final marker.\n\n${'The implementation summary remains reachable inside its intended pane. '.repeat(40)}`
        : index === 27
          ? 'Implementation log final marker. The narrow workspace still exposes the final implementation reasoning.'
          : `Analysis entry ${index + 1}. ${'Measured responsive behavior remains readable. '.repeat(4)}`,
    },
    {
      id: `tool-use-${index}`,
      toolUseId: `tool-${index}`,
      type: 'tool_use',
      timestamp,
      toolName: 'Bash',
      input: {
        command: `printf 'raw output fixture ${index + 1}' && inspect /workspace/${'deep-directory/'.repeat(5)}file-${index + 1}.tsx`,
        file_path: `/workspace/${'deep-directory/'.repeat(5)}file-${index + 1}.tsx`,
      },
    },
    {
      id: `tool-result-${index}`,
      toolUseId: `tool-${index}`,
      type: 'tool_result',
      timestamp,
      result: index === 27
        ? `Raw output final marker\n${'bounded terminal output\n'.repeat(20)}`
        : `Raw output entry ${index + 1}\n${'terminal fixture line\n'.repeat(8)}`,
    },
  ];
}).flat();

const analysis = JSON.stringify({
  summary_of_changes: [
    '## Responsive workspace summary',
    ...Array.from({ length: 16 }, (_, index) => (
      `Summary paragraph ${index + 1}: ${'The task output remains available without widening the page. '.repeat(3)}`
    )),
  ].join('\n\n'),
  implementation_critique: 'The timeline and output panes need explicit, measurable scroll ownership.',
  implementation_critique_score: 9,
  prompt_improvements: 'Keep desktop actions visible while long sections move within their intended pane.',
  efficiency_notes: 'Use one reachable flow below the wide-pane breakpoint.',
  recommendations: Array.from({ length: 8 }, (_, index) => `Reachability recommendation ${index + 1}`),
  error_analysis: 'No section should be clipped by an ancestor with hidden overflow.',
});

async function stubTaskDetailsApis(page: Page, selectedIndex = 0, runCount = 50): Promise<void> {
  await page.route('**/api/**', async route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/api/auth/demo-mode') {
      await route.fulfill({ json: { demoMode: true } });
      return;
    }
    if (pathname === '/api/tasks') {
      await route.fulfill({ json: { tasks: Array.from({ length: runCount }, (_, index) => ({
        id: index === selectedIndex ? taskId : `responsive-run-${index}`,
        repository: 'integry/propr-responsive-workspace-fixture', repositoryOwner: 'integry', repositoryName: 'propr-responsive-workspace-fixture',
        issueNumber: 2252, title: `Followup: Responsive run ${index + 1}`, status: 'completed',
        createdAt: new Date(startedAt + index * 3600000).toISOString(),
      })), total: 1 } });
      return;
    }
    if (pathname === `/api/task/${taskId}/history`) {
      await route.fulfill({
        json: {
          history,
          taskInfo: {
            title: 'Desktop task details with long timeline and raw execution output',
            subtitle: 'Responsive geometry fixture',
            type: 'issue',
            number: 2252,
            issueNumber: 2252,
            repoOwner: 'integry',
            repoName: 'propr-responsive-workspace-fixture',
            modelName: 'gpt-5.6-sol',
          },
          usageMetricRecords: [],
        },
      });
      return;
    }
    if (pathname === `/api/task/${taskId}/analysis`) {
      await route.fulfill({ json: { analysis: { analysis } } });
      return;
    }
    if (pathname === `/api/task/${taskId}/live-details`) {
      await route.fulfill({ json: { events, todos, currentTask: null } });
      return;
    }
    if (pathname === '/api/notifications/unread-count') {
      await route.fulfill({ json: { unreadCount: 0 } });
      return;
    }
    if (pathname === '/api/notifications/preferences') {
      await route.fulfill({ json: { preferences: {}, quietHours: {}, badgeEnabled: false } });
      return;
    }
    // The task's PR is still open, so its follow-ups are offered.
    if (pathname === '/api/pull-requests/2253/scores') {
      await route.fulfill({ json: { repository: 'integry/propr-responsive-workspace-fixture', pr_number: 2253, outcome: null, merged_at: null, closed_at: null, scores: [] } });
      return;
    }
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'Unavailable in TaskDetails browser fixture' }),
    });
  });
}

async function scrollRegionMetrics(locator: Locator) {
  return locator.evaluate(element => {
    const node = element as HTMLElement;
    return {
      clientHeight: node.clientHeight,
      scrollHeight: node.scrollHeight,
      overflowY: getComputedStyle(node).overflowY,
    };
  });
}

async function expectReachableWithin(target: Locator, owner: Locator): Promise<void> {
  await target.scrollIntoViewIfNeeded();
  const geometry = await Promise.all([target.boundingBox(), owner.boundingBox()]);
  const [targetBox, ownerBox] = geometry;
  expect(targetBox).not.toBeNull();
  expect(ownerBox).not.toBeNull();
  expect(targetBox!.y).toBeGreaterThanOrEqual(ownerBox!.y - 1);
  expect(targetBox!.y + targetBox!.height).toBeLessThanOrEqual(ownerBox!.y + ownerBox!.height + 1);
}

for (const viewport of [
  { width: 880, height: 620 },
  { width: 1024, height: 768 },
  { width: 1280, height: 820 },
]) {
  test(`keeps long TaskDetails sections reachable at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await stubTaskDetailsApis(page);
    const analysisRequests: string[] = [];
    page.on('request', request => { if (new URL(request.url()).pathname.endsWith('/analysis')) analysisRequests.push(request.url()); });
    await page.goto(`/tasks/${taskId}`);

    const taskDetails = page.getByTestId('task-details');
    const workspace = page.getByTestId('task-workspace-scroll');
    const timeline = page.getByTestId('task-timeline-scroll');
    const output = page.getByTestId('task-output-scroll');
    const summarySection = page.getByTestId('task-summary');
    await expect(taskDetails).toBeVisible();
    await expect(page.getByTestId('task-analysis')).toHaveCount(0);
    await expect(page.getByText('Implementation Review Details')).toHaveCount(0);
    await expect(page.locator('[title^="Score:"]')).toHaveCount(0);
    expect(analysisRequests).toEqual([]);
    await expect(page.getByTestId('run-timeline-run')).toHaveCount(50);
    expect(await workspace.evaluate(node => node.scrollTop)).toBe(0);
    const selectedHeader = page.locator('button[aria-current="true"]');
    const heading = workspace.getByTestId('timeline-run-count').locator('..');
    expect((await selectedHeader.boundingBox())!.y).toBeGreaterThanOrEqual((await heading.boundingBox())!.y + (await heading.boundingBox())!.height);
    if (process.env.PROPR_CAPTURE_PREVIEWS && viewport.width === 1280) {
      const directory = path.resolve('../.propr/previews');
      await mkdir(directory, { recursive: true });
      await page.screenshot({ animations: 'disabled', path: path.join(directory, 'task-details-without-analysis.png') });
    }
    // Scoped to the panel: the sidebar owns a 'Logs' navigation group button at
    // these widths, so an unscoped role query is ambiguous.
    await expect(taskDetails.getByRole('button', { name: 'Follow Up' })).toBeVisible();
    await expect(taskDetails.getByRole('button', { name: 'Prompt' })).toBeVisible();
    await expect(taskDetails.getByRole('button', { name: 'Logs' })).toBeVisible();

    const metrics = await scrollRegionMetrics(workspace);
    expect(metrics.overflowY).toBe('auto');
    expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight);
    for (const section of [timeline, output]) {
      const sectionMetrics = await scrollRegionMetrics(section);
      expect(sectionMetrics.overflowY).not.toMatch(/auto|scroll/);
      expect(sectionMetrics.scrollHeight).toBeLessThanOrEqual(sectionMetrics.clientHeight);
    }
    await expectReachableWithin(page.getByText('Timeline final checkpoint', { exact: true }).filter({ visible: true }), workspace);
    await expectReachableWithin(summarySection.getByText(/Implementation summary final marker/), workspace);
    await expectReachableWithin(output.getByText(/Implementation log final marker/), workspace);
    await expect(workspace.getByText('EXECUTION TRACE', { exact: true })).toBeVisible();

    await expect(taskDetails.getByRole('button', { name: 'Follow Up' })).toBeVisible();

    const executionSection = page.locator('#execution-event-log-section');
    const executionToggle = executionSection.getByRole('button');
    await expect(executionToggle).toHaveAccessibleName(/EXECUTION LOG/);
    await executionToggle.focus();
    await page.keyboard.press('Enter');
    await expect(executionToggle).toHaveAttribute('aria-expanded', 'true');
    await expect(executionSection).toContainText('TERMINAL OUTPUT');

    const terminalScroller = page.getByTestId('execution-log-scroll');
    const terminalMetrics = await scrollRegionMetrics(terminalScroller);
    expect(terminalMetrics.overflowY).toBe('auto');
    expect(terminalMetrics.scrollHeight).toBeGreaterThan(terminalMetrics.clientHeight);
    const executionBox = await executionSection.boundingBox();
    expect(executionBox).not.toBeNull();
    expect(executionBox!.height).toBeLessThan(viewport.height * 0.65);
    await expectReachableWithin(
      terminalScroller.getByText('Raw output final marker', { exact: true }),
      terminalScroller,
    );

    const pageWidth = await page.evaluate(() => ({
      viewport: window.innerWidth,
      document: document.documentElement.scrollWidth,
    }));
    expect(pageWidth.document).toBeLessThanOrEqual(pageWidth.viewport);
  });
}

for (const width of [390, 1280]) {
  for (const selectedIndex of [0, 44, 49]) {
    test(`initial selection preserves the overview for run ${selectedIndex + 1} visible at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 820 });
      await stubTaskDetailsApis(page, selectedIndex);
      await page.goto(`/tasks/${taskId}`);
      await expect(page.getByTestId('run-timeline-run')).toHaveCount(50);
      const owner = page.getByTestId(width < 640 ? 'task-details' : 'task-workspace-scroll');
      expect(await owner.evaluate(node => node.scrollTop)).toBe(0);
      if (width < 640) await expect(page.getByTestId('task-mobile-compact-bar')).not.toBeVisible();
      if (process.env.PROPR_CAPTURE_PREVIEWS) {
        await mkdir('../.propr/previews', { recursive: true });
        await page.screenshot({ animations: 'disabled', path: `../.propr/previews/task-initial-run-${selectedIndex + 1}-${width}.png` });
      }
    });
  }
}

for (const runCount of [2, 50]) {
  test(`desktop keeps a ${runCount}-run timeline reachable beside a long trace`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 820 });
    await stubTaskDetailsApis(page, 0, runCount);
    await page.route(`**/api/task/${taskId}/live-details`, route => route.fulfill({ json: { events, todos: [], currentTask: null } }));
    await page.route(`**/api/task/${taskId}/history`, route => route.fulfill({ json: {
      history: history.slice(0, 1),
      taskInfo: { title: 'Pinned timeline beside a long execution trace', type: 'issue', number: 2252,
        issueNumber: 2252, repoOwner: 'integry', repoName: 'propr-responsive-workspace-fixture' },
    } }));
    await page.goto(`/tasks/${taskId}`);
    const timeline = page.getByTestId('task-timeline-scroll');
    const owner = page.getByTestId('task-workspace-scroll');
    await expect(page.getByTestId('run-timeline-run')).toHaveCount(runCount);
    await expect(timeline).toHaveCSS('position', runCount === 2 ? 'sticky' : 'static');
    const result = page.getByTestId('task-result-pane');
    await expect(result).toHaveCSS('border-left-style', 'solid');
    expect(await result.evaluate(node => parseFloat(getComputedStyle(node).borderLeftWidth))).toBeGreaterThan(0);
    expect((await result.boundingBox())!.height).toBeGreaterThanOrEqual((await timeline.boundingBox())!.height);
    const height = (await timeline.boundingBox())!.height;
    const port = (await owner.boundingBox())!;
    expect(runCount === 2 ? height < port.height : height > port.height).toBe(true);
    if (runCount === 2) {
      await owner.evaluate(node => { node.scrollTop = 500; });
      await expect.poll(async () => Math.round((await timeline.boundingBox())!.y)).toBe(Math.round(port.y));
    } else {
      await page.getByTestId('run-timeline-run').last().scrollIntoViewIfNeeded();
    }
    await expect(page.getByTestId('run-timeline-run').last().getByRole('button').first()).toBeInViewport();
    expect(await timeline.evaluate(node => getComputedStyle(node).overflowY)).not.toMatch(/auto|scroll/);
    if (process.env.PROPR_CAPTURE_PREVIEWS && runCount === 2) {
      await mkdir('../.propr/previews', { recursive: true });
      await page.screenshot({ animations: 'disabled', path: '../.propr/previews/task-sticky-timeline-desktop.png' });
    }
    await page.getByTestId('run-timeline-run').first().scrollIntoViewIfNeeded();
    await expect(page.getByTestId('run-timeline-run').first().getByRole('button').first()).toBeInViewport();
  });
}

for (const mode of ['embedded', 'desktop', 'phone'] as const) {
  test(`${mode} run navigation reveals run 45 after the details scroller remounts`, async ({ page }) => {
    await page.setViewportSize({ width: mode === 'phone' ? 390 : 1584, height: 820 });
    await stubTaskDetailsApis(page, 49);
    await page.route('**/api/task/responsive-run-*/history', route => route.fulfill({ json: {
      history, taskInfo: { title: 'Selected historical run', type: 'issue', number: 2252,
        repoOwner: 'integry', repoName: 'propr-responsive-workspace-fixture' },
    } }));
    await page.goto(mode === 'embedded' ? `/tasks?task=${taskId}` : `/tasks/${taskId}`);
    const pane = mode === 'embedded' ? page.getByTestId('task-split-details') : page;
    await expect(pane.getByTestId('run-timeline-run')).toHaveCount(50);
    const owner = pane.getByTestId(mode === 'phone' ? 'task-details' : 'task-workspace-scroll');
    expect(await owner.evaluate(node => node.scrollTop)).toBe(0);
    for (const index of [44, 43]) {
      await pane.getByTestId('run-timeline-run').nth(index).getByRole('button').first().click();
      const selected = pane.locator('[aria-current="true"]');
      await expect(selected).toContainText(`Run ${index + 1}`);
      await expect.poll(async () => {
        const header = await selected.boundingBox();
        const viewport = await owner.boundingBox();
        return !!header && !!viewport && header.y >= viewport.y && header.y + header.height <= viewport.y + viewport.height;
      }).toBe(true);
      expect(await owner.evaluate(node => node.scrollTop)).toBeGreaterThan(0);
      if (process.env.PROPR_CAPTURE_PREVIEWS && index === 44 && mode === 'embedded') {
        await mkdir('../.propr/previews', { recursive: true });
        await page.screenshot({ animations: 'disabled', path: '../.propr/previews/embedded-run-45.png' });
      }
    }
  });

}

test('phone compact steps distinguish hidden details from ordinary labels', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await stubTaskDetailsApis(page, 0, 2);
  await page.route(`**/api/task/${taskId}/history`, route => route.fulfill({ json: {
    history: [
      { state: 'PENDING', timestamp: new Date(startedAt).toISOString() },
      { state: 'FAILED', timestamp: new Date(startedAt + 60000).toISOString(), metadata: { terminalReason: 'timed_out' } },
    ],
    taskInfo: { title: 'Review task changes', type: 'issue', number: 2252,
      repoOwner: 'integry', repoName: 'propr-responsive-workspace-fixture' },
  } }));
  await page.goto(`/tasks/${taskId}`);
  const steps = page.getByRole('list', { name: 'Run steps' });
  await expect(steps.getByLabel('Additional step details')).toHaveCount(1);
  await expect(steps.getByLabel('Additional step details')).toBeVisible();
  await expect(steps.getByTestId('task-terminal-reason')).toBeHidden();
  await steps.getByRole('button').filter({ has: page.getByLabel('Additional step details') }).click();
  await expect(steps.getByTestId('task-terminal-reason')).toBeVisible();
  if (process.env.PROPR_CAPTURE_PREVIEWS) {
    await mkdir('../.propr/previews', { recursive: true });
    await page.screenshot({ animations: 'disabled', path: '../.propr/previews/compact-step-details.png' });
  }
});
