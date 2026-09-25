import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

/**
 * The review context budget slider: keyboard-accessible, saved through the
 * normal settings save, reloaded as the saved percentage. With
 * PROPR_CAPTURE_PREVIEWS set it also captures the control.
 */

const agents = [
  {
    id: 'claude', type: 'claude', alias: 'claude', enabled: true, dockerImage: 'propr/agent:latest', configPath: '~/.claude',
    supportedModels: ['claude-opus-5-5', 'claude-sonnet-4-6'], defaultModel: 'claude-opus-5-5',
  },
  {
    id: 'codex', type: 'codex', alias: 'codex', enabled: true, dockerImage: 'propr/agent:latest', configPath: '~/.codex',
    supportedModels: ['gpt-6-astra'], defaultModel: 'gpt-6-astra',
  },
];

async function installFixture(page: Page, initial: Record<string, unknown>): Promise<Array<Record<string, unknown>>> {
  const saved: Array<Record<string, unknown>> = [];
  let settings: Record<string, unknown> = {
    worker_concurrency: 2,
    auto_followup_score_threshold: 4,
    auto_resolve_merge_conflicts: false,
    ultrafix_rating_goal: 7,
    ultrafix_max_cycles: 5,
    ultrafix_pause_seconds: 60,
    default_agent_alias: 'claude',
    model_reasoning_level: '',
    planner_context_model: '',
    planner_generation_model: '',
    pr_review_model: 'claude:claude-opus-5-5',
    analysis_model_fast: '',
    pr_review_context_enabled: true,
    pr_review_context_model: '',
    github_user_whitelist: [],
    ...initial,
  };
  await page.routeWebSocket('**/socket.io/**', socket => socket.close());
  await page.route('**/api/**', async route => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (pathname === '/api/config/settings' && request.method() === 'POST') {
      const body = request.postDataJSON() as { settings?: Record<string, unknown> } & Record<string, unknown>;
      const update = body.settings ?? body;
      saved.push(update);
      settings = { ...settings, ...update };
      return route.fulfill({ json: { success: true } });
    }
    const responses: Record<string, unknown> = {
      '/api/auth/demo-mode': { demoMode: false },
      '/api/auth/user': {
        id: 'preview-user', login: 'preview', username: 'preview', displayName: 'Preview User',
        email: null, avatarUrl: null, role: 'admin', permissions: ['instance.manage_settings'],
        authorizationSource: 'local',
      },
      '/api/config/settings': settings,
      '/api/config/followup-keywords': { followup_keywords: [] },
      '/api/config/followup-ignore-keywords': { followup_ignore_keywords: [] },
      '/api/config/pr-label': { pr_label: 'propr' },
      '/api/config/primary-processing-labels': { primary_processing_labels: ['AI'] },
      '/api/config/agents': { agents },
      '/api/config/summarization': { enabled: false, agent_alias: '', fallback_agent_alias: '' },
      '/api/config/agent-tank': { enabled: false, url: 'http://0.0.0.0:3456' },
      '/api/config/agent-tank/status': { available: false },
      '/api/instance/catalog': {
        agents: agents.map(agent => ({ id: agent.id, kind: 'direct', alias: agent.alias, enabled: true, supportedModels: agent.supportedModels })),
        repositories: [],
      },
      '/api/notifications/config': { push: { configured: false, vapidPublicKey: null } },
      '/api/notifications/unread-count': { unreadCount: 0 },
    };
    if (pathname in responses) return route.fulfill({ json: responses[pathname] });
    return route.fulfill({ status: 503, json: { error: 'Unavailable in review context budget fixture' } });
  });
  return saved;
}

async function capture(page: Page, name: string): Promise<void> {
  if (!process.env.PROPR_CAPTURE_PREVIEWS) return;
  const directory = path.resolve('../.propr/previews');
  await mkdir(directory, { recursive: true });
  const field = page.getByRole('slider', { name: 'Review context budget' }).locator('xpath=ancestor::div[contains(@class, "max-w-2xl")][1]');
  await field.scrollIntoViewIfNeeded();
  const box = await field.boundingBox();
  if (!box) throw new Error('Review context budget field is not visible');
  const top = Math.max(0, box.y - 120);
  await page.screenshot({
    animations: 'disabled',
    path: path.join(directory, `${name}.png`),
    clip: { x: Math.max(0, box.x - 24), y: top, width: box.width + 48, height: box.y - top + box.height + 24 },
  });
}

test('adjusts the review context budget with the keyboard and saves the percentage', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const saved = await installFixture(page, { pr_review_max_context_tokens: 0 });
  await page.goto('/settings?tab=models');

  const slider = page.getByRole('slider', { name: 'Review context budget' });
  await expect(slider).toHaveValue('100');
  await expect(page.getByTestId('review-context-budget-allowance')).toContainText('≈ 948K input tokens for claude - Claude Opus 5.5');
  await expect(page.getByRole('spinbutton')).toHaveCount(0);
  await page.getByText('Allowance by reviewer model').click();
  await capture(page, 'review-context-budget-slider');

  await slider.focus();
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await expect(slider).toHaveValue('80');
  await expect(page.locator('output#pr_review_context_budget_output')).toHaveText('80%');
  await expect(page.getByTestId('review-context-budget-allowance')).toContainText('≈ 758K input tokens');
  await expect.poll(() => saved.at(-1)?.pr_review_context_budget_percent).toBe(80);
  expect(saved.every(update => update.pr_review_max_context_tokens === 0)).toBe(true);

  await page.reload();
  await expect(page.getByRole('slider', { name: 'Review context budget' })).toHaveValue('80');
});

test('explains and explicitly removes a retained legacy token cap', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const saved = await installFixture(page, { pr_review_max_context_tokens: 120000 });
  await page.goto('/settings?tab=models');

  await expect(page.getByRole('note')).toContainText('A legacy absolute cap of 120,000 tokens is still in effect.');
  await expect(page.getByTestId('review-context-budget-allowance')).toContainText('limited by the legacy cap');
  await capture(page, 'review-context-budget-legacy-cap');

  await page.getByRole('button', { name: 'Remove legacy cap' }).click();
  await expect.poll(() => saved.at(-1)?.pr_review_max_context_tokens).toBe(0);
  await expect(page.getByRole('note')).toHaveCount(0);
});
