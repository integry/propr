import { expect, test, type Locator, type Page } from '@playwright/test';

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
        ? `## Summary of Changes\n\nAnalysis summary final marker.\n\n${'The completed analysis remains reachable inside its intended pane. '.repeat(40)}`
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

async function stubTaskDetailsApis(page: Page): Promise<void> {
  await page.route('**/api/**', async route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/api/auth/demo-mode') {
      await route.fulfill({ json: { demoMode: true } });
      return;
    }
    if (pathname === `/api/task/${taskId}/history`) {
      await route.fulfill({
        json: {
          history,
          taskInfo: {
            title: 'Desktop task details with long timeline, analysis, and raw execution output',
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
    await page.goto(`/tasks/${taskId}`);

    const taskDetails = page.getByTestId('task-details');
    const workspace = page.getByTestId('task-workspace-scroll');
    const timeline = page.getByTestId('task-timeline-scroll');
    const output = page.getByTestId('task-output-scroll');
    const analysisSection = page.getByTestId('task-analysis');
    await expect(taskDetails).toBeVisible();
    // Scoped to the panel: the sidebar owns a 'Logs' navigation group button at
    // these widths, so an unscoped role query is ambiguous.
    await expect(taskDetails.getByRole('button', { name: 'Follow Up' })).toBeVisible();
    await expect(taskDetails.getByRole('button', { name: 'Prompt' })).toBeVisible();
    await expect(taskDetails.getByRole('button', { name: 'Logs' })).toBeVisible();

    if (viewport.width < 1024) {
      const metrics = await scrollRegionMetrics(workspace);
      expect(metrics.overflowY).toBe('auto');
      expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight);
      await expectReachableWithin(page.getByText('Timeline final checkpoint'), workspace);
      await expectReachableWithin(analysisSection.getByText(/Analysis summary final marker/), workspace);
      await expectReachableWithin(output.getByText(/Implementation log final marker/), workspace);
      await expect(workspace.getByText('IMPLEMENTATION', { exact: true })).toBeVisible();
    } else {
      const timelineMetrics = await scrollRegionMetrics(timeline);
      const outputMetrics = await scrollRegionMetrics(output);
      expect(timelineMetrics.overflowY).toBe('auto');
      expect(timelineMetrics.scrollHeight).toBeGreaterThan(timelineMetrics.clientHeight);
      expect(outputMetrics.overflowY).toBe('auto');
      expect(outputMetrics.scrollHeight).toBeGreaterThan(outputMetrics.clientHeight);
      await expectReachableWithin(page.getByText('Timeline final checkpoint'), timeline);
      await expectReachableWithin(analysisSection.getByText(/Analysis summary final marker/), output);
      await expectReachableWithin(output.getByText(/Implementation log final marker/), output);
    }

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
