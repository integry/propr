import { test, type BrowserContext, type Page } from '@playwright/test';
import { shot } from '../lib/shot';
import { installWorld } from '../lib/world';
import { NOW, base } from '../world/base';
import { CHECKOUT_GOAL, COURIER_GOAL, FULFILMENT_GOAL, PREVIEW_ASSET, goalPreviews, goals } from '../world/goals';

const USED_ON = ['/goals/', '/whats-new/0.9.0/'];

test.beforeEach(async ({ page }) => {
  await page.clock.install({ time: NOW });
});

const openGoal = async (page: Page, goal: { id: string; title: string }) => {
  await page.goto(`/goals/${goal.id}`);
  await page.getByRole('heading', { level: 1, name: goal.title }).waitFor();
};

/** The goal page's own header: title, state, strategy, model, elapsed time, repository and controls. */
const goalHeader = (page: Page, title: string) =>
  page.getByRole('heading', { level: 1, name: title }).locator('xpath=ancestor::header[1]');

test('goal queue', async ({ page }, info) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  const log = await installWorld(page, base, goals);
  await page.goto('/goals');
  const queue = page.getByRole('list', { name: 'Goal work queue' });
  await queue.getByRole('link').first().waitFor();
  await shot(page, queue, {
    id: 'goals-queue',
    alt: 'The Goals queue: five goals across four repositories with their status, current step, tokens, active time and output',
    usedOn: USED_ON,
    include: [page.getByTestId('goal-queue-columns')],
    padding: 0,
  }, info, log);
});

test('goal header', async ({ page }, info) => {
  const log = await installWorld(page, base, goals);
  await openGoal(page, CHECKOUT_GOAL);
  await shot(page, goalHeader(page, CHECKOUT_GOAL.title), {
    id: 'goals-header',
    alt: 'A running direct goal: Claude Opus 5.5, 37 minutes in, with Pause, Cancel and Open draft PR',
    usedOn: USED_ON,
    padding: 0,
  }, info, log);
});

test('goal checkpoint', async ({ page }, info) => {
  const log = await installWorld(page, base, goals);
  await openGoal(page, CHECKOUT_GOAL);
  const checkpoint = page.getByText(/^2 checkpoint commits/).locator('xpath=ancestor::section[1]');
  await shot(page, checkpoint, {
    id: 'goals-checkpoint',
    alt: 'Two checkpoint commits at a 15-minute target cadence, with the latest declaration: three files included, one held back',
    usedOn: USED_ON,
  }, info, log);
});

test('goal execution queue', async ({ page }, info) => {
  const log = await installWorld(page, base, goals);
  await openGoal(page, CHECKOUT_GOAL);
  await shot(page, page.getByRole('region', { name: 'Execution queue' }), {
    id: 'goals-execution-queue',
    alt: 'The goal execution queue: two steps done, refunds in progress, two queued',
    usedOn: USED_ON,
  }, info, log);
});

test('goal correction in the timeline', async ({ page }, info) => {
  const log = await installWorld(page, base, goals);
  await openGoal(page, CHECKOUT_GOAL);
  const message = page.getByTestId('goal-user-message');
  await shot(page, message, {
    id: 'goals-correction-timeline',
    alt: 'The goal timeline records the correction verbatim, followed by the agent acting on it',
    usedOn: USED_ON,
    include: [
      page.getByText('Swap card capture to the Payments SDK with idempotency keys').last(),
      page.getByText('Updated the 3-D Secure retry', { exact: false }),
    ],
    padding: 16,
  }, info, log);
});

test('goal correction box', async ({ page }, info) => {
  const log = await installWorld(page, base, goals);
  await openGoal(page, CHECKOUT_GOAL);
  const correction = page.getByRole('region', { name: 'Send a correction' });
  await correction.getByRole('textbox', { name: 'Correction or follow-up' })
    .fill('Leave partial captures for a follow-up PR; finish refunds and remove the legacy client.');
  await page.getByRole('heading', { name: 'Metrics' }).click();
  await shot(page, page.getByText('Model for next continuation'), {
    id: 'goals-correction-box',
    alt: 'A correction typed into the running goal, with the model for the next continuation',
    usedOn: USED_ON,
    include: [correction.getByRole('textbox'), correction.getByRole('button', { name: 'Send' })],
    padding: 14,
  }, info, log);
});

test('goal metrics', async ({ page }, info) => {
  const log = await installWorld(page, base, goals);
  await openGoal(page, CHECKOUT_GOAL);
  await shot(page, page.getByRole('region', { name: 'Metrics' }), {
    id: 'goals-metrics',
    alt: 'Goal metrics: 6.5M tokens, 37 minutes active, one open draft PR and the provider session',
    usedOn: USED_ON,
    include: [page.getByRole('region', { name: 'Quick actions' })],
    padding: 10,
  }, info, log);
});

test('goal question', async ({ page }, info) => {
  // Narrow enough that the card wraps its content instead of stretching across the console.
  await page.setViewportSize({ width: 960, height: 900 });
  const log = await installWorld(page, base, goals);
  await openGoal(page, COURIER_GOAL);
  await shot(page, page.getByTestId('goal-attention'), {
    padding: 0,
    id: 'goals-question',
    alt: 'A goal waiting on its operator: the agent asks whether offline photos upload over cellular, with suggested answers and Answer, Pause and Cancel',
    usedOn: USED_ON,
  }, info, log);
});

test('orchestrating goal artifacts', async ({ page }, info) => {
  const log = await installWorld(page, base, goals);
  await openGoal(page, FULFILMENT_GOAL);
  await shot(page, goalHeader(page, FULFILMENT_GOAL.title), {
    id: 'goals-orchestrate-header',
    alt: 'An orchestrating goal: ProPR orchestrated on GPT-6 Astra, two hours in on northwind/orders-api',
    usedOn: USED_ON,
    padding: 0,
  }, info, log);
  await shot(page, page.getByRole('region', { name: 'Related artifacts' }), {
    id: 'goals-orchestrate-artifacts',
    alt: 'The issues and pull requests an orchestrating goal created through ProPR',
    usedOn: USED_ON,
  }, info, log);
});

test('goal visual previews', async ({ page, context }, info) => {
  await servePreviewImages(context);
  const log = await installWorld(page, base, goals, goalPreviews);
  await openGoal(page, CHECKOUT_GOAL);
  const previews = page.getByRole('region', { name: 'Visual previews' });
  await previews.getByRole('img').first().waitFor();
  await shot(page, previews.locator('figure').first(), {
    id: 'goals-visual-previews',
    alt: 'Visual previews published on the goal\'s draft PR, shown in the goal console',
    usedOn: USED_ON,
    include: [previews.getByRole('heading', { name: 'Visual previews' })],
  }, info, log);
});

test('new goal options', async ({ page }, info) => {
  const log = await installWorld(page, base, goals);
  await page.goto('/goals?new=1');
  const dialog = page.getByRole('dialog', { name: 'Start a goal' });
  await dialog.getByLabel('Prompt', { exact: true })
    .fill('Move checkout to the Payments SDK. Keep the public checkout API unchanged and remove the legacy client when nothing calls it.');
  await dialog.locator('summary').click();
  await dialog.getByLabel('Agent orchestrates through ProPR').check();
  await dialog.getByLabel('Maximum parallel tasks').fill('3');
  await dialog.getByRole('heading', { name: 'Start a goal' }).click();
  await shot(page, dialog, {
    padding: 0,
    id: 'goals-new-goal',
    alt: 'Start a goal: the objective, the repository, and advanced options for agent, model, parallel tasks and the Direct or Orchestrate strategy',
    usedOn: USED_ON,
  }, info, log);
});

/** Renders a small Northwind checkout screen and serves it as the PR's preview images. */
async function servePreviewImages(context: BrowserContext): Promise<void> {
  const render = async (width: number, height: number) => {
    const canvas = await context.newPage();
    await canvas.setViewportSize({ width, height });
    await canvas.setContent(checkoutHtml(width < 600));
    const png = await canvas.screenshot();
    await canvas.close();
    return png;
  };
  const desktop = await render(1280, 560);
  const mobile = await render(390, 720);
  await context.route(PREVIEW_ASSET('checkout-desktop'), route => route.fulfill({ contentType: 'image/png', body: desktop }));
  await context.route(PREVIEW_ASSET('checkout-mobile'), route => route.fulfill({ contentType: 'image/png', body: mobile }));
}

const checkoutHtml = (narrow: boolean) => `<!doctype html><style>
  body{margin:0;font:15px/1.45 system-ui,sans-serif;color:#1f2933;background:#f6f4ef}
  header{background:#1d3b36;color:#fff;padding:16px 28px;font-weight:700;letter-spacing:.02em}
  main{display:${narrow ? 'block' : 'grid'};grid-template-columns:1.4fr 1fr;gap:28px;padding:28px}
  .card{background:#fff;border-radius:12px;padding:22px;box-shadow:0 1px 3px rgba(0,0,0,.08);margin-bottom:18px}
  h2{margin:0 0 14px;font-size:18px} label{display:block;font-size:12px;color:#52606d;margin:12px 0 4px}
  .input{border:1px solid #cbd2d9;border-radius:8px;padding:11px 12px;background:#fff;color:#3e4c59}
  .row{display:flex;gap:12px}.row>div{flex:1}
  .pay{margin-top:18px;background:#2f7d6d;color:#fff;border-radius:8px;padding:13px;text-align:center;font-weight:600}
  .line{display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid #eef0f2}
  .total{font-weight:700;border:0;padding-top:12px} .steps{color:#52606d;font-size:13px;margin-bottom:16px}
</style><header>Northwind Outfitters</header><main>
<div><div class="steps">Cart › Shipping › <b>Payment</b> › Review</div><div class="card"><h2>Payment</h2>
<label>Card number</label><div class="input">4242 4242 4242 4242</div>
<div class="row"><div><label>Expiry</label><div class="input">09 / 28</div></div><div><label>CVC</label><div class="input">•••</div></div></div>
<label>Name on card</label><div class="input">Jordan Lee</div><div class="pay">Pay $184.00</div></div></div>
<div class="card"><h2>Order summary</h2><div class="line"><span>Trail runner 2, size 10</span><span>$139.00</span></div>
<div class="line"><span>Merino socks ×2</span><span>$32.00</span></div><div class="line"><span>Shipping</span><span>$13.00</span></div>
<div class="line total"><span>Total</span><span>$184.00</span></div></div></main>`;
