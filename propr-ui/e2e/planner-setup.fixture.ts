import { expect, type Page } from '@playwright/test';
import { fixture } from './planner-studio.fixture';

// Shared by the planner setup layout specs: a successful branch lookup and context preview, so no header error is in
// play, and a record of every write the page makes.
export const repository = 'integry/propr';
export const prompt = 'Keep the planner scope estimate inside medium-width layouts.';
const preview = {
  success: true, warnings: [],
  stats: { totalTokens: 312_000, costEstimate: 1.2, contextLength: 900_000, fileCount: 2, modelMaxContextTokens: 1_000_000 },
  smartSelection: [
    { path: 'packages/core/src/services/planning/previewService.ts', reason: 'Matched prompt keywords', source: 'auto', score: 92 },
    { path: 'propr-ui/src/components/TaskPlanner/ContextLevelSlider.tsx', reason: 'Matched prompt keywords', source: 'auto', score: 88 },
  ],
};

export async function routeSetup(page: Page) {
  await fixture(page);
  await page.route(`**/api/github/repos/${repository}/branches`, route => route.fulfill({ json: { defaultBranch: 'main', branches: ['main'] } }));
  await page.route('**/api/planner/preview', route => route.fulfill({ json: preview }));
  const writes: string[] = [];
  page.on('request', request => {
    const path = new URL(request.url()).pathname;
    // The context preview is a read the planner POSTs; anything else that is not a GET would be a write.
    if (request.method() === 'GET' || !path.startsWith('/api/') || path === '/api/planner/preview') return;
    // An existing draft autosaves its typed prompt, and only that: resizing and the slider must add nothing.
    const body = request.postDataJSON() as Record<string, unknown> | null;
    if (request.method() === 'PUT' && path === '/api/planner/drafts/plan-setup' && body?.initial_prompt === prompt && Object.keys(body).every(key => ['initial_prompt', 'name'].includes(key))) return;
    writes.push(`${request.method()} ${path} ${request.postData()}`);
  });
  return writes;
}

// Typing into a new plan creates its draft a second later, turning it into an edit, so the new plan keeps an empty
// prompt (and sends nothing at all), while the existing draft carries an edited, not yet generated prompt through every step.
export const modes = [
  { name: 'new', path: '/studio/new', level: 50, estimate: '≤490k tokens · ~1-2m scan', typed: '' },
  { name: 'edit', path: '/studio/plan-setup', level: 100, estimate: '≤980k tokens · ~3-5m scan', typed: prompt },
];
export const viewports = [
  { width: 320, height: 640 }, { width: 390, height: 844 }, { width: 768, height: 900 }, { width: 842, height: 680 },
  { width: 880, height: 620 }, { width: 1280, height: 800 }, { width: 1390, height: 864 },
];

/** Opens the setup canvas with its preview and model metadata resolved, at the given root text size. */
export async function openSetup(page: Page, mode: typeof modes[number], scale = 100) {
  await page.setViewportSize(viewports[2]);
  await page.goto(mode.path);
  await expect(page.getByTestId('context-scope-estimate')).toHaveText(mode.estimate);
  // The footer is measured with the model name it really shows, not the loading placeholder it starts with.
  await expect(page.getByTestId('planner-model-selector')).toHaveText('Claude Opus 5.5 (Default)');
  if (scale !== 100) await page.addStyleTag({ content: `html { font-size: ${scale}% !important; }` });
  if (mode.typed) await page.getByPlaceholder(/Describe the feature/).fill(mode.typed);
}
