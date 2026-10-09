import { area, type ApiRequest } from '../lib/world';
import { AGENTS, REPOS, daysAgo, hoursAgo, minutesAgo } from './base';

/**
 * Planner Studio and the Plans list for Northwind Labs. One plan in review
 * (checkout redesign, with chat and history), one mid-execution (order
 * exports), one still in Define, plus a list of older plans.
 */

const task = (id: string, title: string, context: string, requirements: string[], acceptance: string[], issue?: number, repository: string = REPOS.web) => ({
  id, title, implementation: '',
  body: `## Context\n${context}\n\n## Requirements\n${requirements.map((line, n) => `${n + 1}. ${line}`).join('\n')}\n\n## Acceptance criteria\n${acceptance.map(line => `- ${line}`).join('\n')}`,
  ...(issue ? { issue_number: issue, issue_url: `https://github.com/${repository}/issues/${issue}` } : {}),
});

/** The plan in review: a one-page checkout split into three steps. */
export const CHECKOUT_PLAN = [
  task('co-1', 'Checkout step state machine and route guards',
    'The three new steps share one state machine so Back, refresh and deep links land on the right step.',
    ['Add `src/checkout/checkoutMachine.ts` with `address → shipping → payment → review` states.', 'Guard `/checkout/:step` routes so a shopper cannot skip an incomplete step.', 'Persist progress in `sessionStorage` and restore it on reload.'],
    ['Refreshing on Shipping keeps the entered address.', 'Opening `/checkout/payment` with no address redirects to Address.']),
  task('co-2', 'Address step with saved addresses and postcode lookup',
    'Returning shoppers pick a saved address; new ones get postcode lookup from the existing `orders-api` endpoint.',
    ['Add `src/checkout/steps/AddressStep.tsx` listing saved addresses first.', 'Call `GET /v2/addresses/lookup?postcode=` with a 300 ms debounce.', 'Validate with the shared `addressSchema` from `@northwind/contracts`.'],
    ['A saved address can be chosen in one click.', 'Invalid postcodes show an inline error without clearing the form.']),
  task('co-3', 'Shipping step with live delivery-slot pricing',
    'Delivery prices depend on the slot, so the step shows the price next to each option before the shopper commits.',
    ['Add `src/checkout/steps/ShippingStep.tsx`.', 'Fetch slots from `GET /v2/delivery-slots` and refresh when the address changes.', 'Show the order total with the selected slot in the sticky summary.'],
    ['The total updates as soon as a slot is selected.', 'Sold-out slots are shown disabled with the next free time.']),
  task('co-4', 'Payment and review step with a single submit',
    'Payment and the final review merge into one step so the shopper confirms what they pay for on the same screen.',
    ['Add `src/checkout/steps/PaymentStep.tsx` reusing `CardForm`.', 'Disable submit while the payment intent is pending; retry once on `409`.', 'Emit `checkout_completed` with the step durations.'],
    ['Double-clicking Place order creates one order.', 'A declined card keeps the shopper on Payment with the reason shown.']),
  task('co-5', 'Checkout funnel analytics and Playwright coverage',
    'The redesign ships behind `checkout_v2`; the funnel numbers decide when it becomes the default.',
    ['Track step views and drop-offs in `src/analytics/checkoutFunnel.ts`.', 'Add `e2e/checkout-v2.spec.ts` covering the happy path and a declined card.'],
    ['The funnel dashboard shows each step\'s drop-off for `checkout_v2`.', 'The e2e suite passes in CI on both flags.']),
];

/** The first generated plan: separate payment and review steps, no analytics task (five tasks). */
const CHECKOUT_PLAN_V1 = [CHECKOUT_PLAN[0], CHECKOUT_PLAN[1], CHECKOUT_PLAN[2],
  task('co-4', 'Payment step', 'Collect card details before the final review.', ['Add `src/checkout/steps/PaymentStep.tsx`.'], ['The card is validated before Review.']),
  task('co-5', 'Review step with order summary', 'Shoppers confirm the order on a separate page before it is placed.', ['Add `src/checkout/steps/ReviewStep.tsx`.'], ['Place order creates the order.'])];

const CHECKOUT_CHAT = [
  { id: 'm1', role: 'user', timestamp: hoursAgo(3), content: 'Merge payment and the final review into one step. Shoppers drop off on the extra review page.' },
  { id: 'm2', role: 'assistant', timestamp: hoursAgo(3), content: 'Merged them: step 4 is now Payment and review, with the order summary next to the card form and a single Place order button. I also made submit idempotent so a double click creates one order.' },
  { id: 'm3', role: 'user', timestamp: hoursAgo(2), content: 'Ship it behind a flag and add a way to compare the funnel.' },
  { id: 'm4', role: 'assistant', timestamp: hoursAgo(2), content: 'Added step 5: funnel analytics for checkout_v2 plus Playwright coverage on both flags. Steps 1–4 are unchanged.' },
];

const exportTitles = [
  'Streaming CSV writer for large order exports',
  'Export job queue with progress events',
  'Exports page with filters and download links',
  'Signed download URLs that expire after 24 hours',
  'Scheduled weekly export to the finance bucket',
  'Docs: exporting orders',
];
const EXPORT_PLAN = exportTitles.map((title, index) => task(`ex-${index + 1}`, title,
  'Finance needs every order of a quarter in one file without timing out the API.',
  ['Implement as described in the plan.'], ['Covered by tests.'], 201 + index, REPOS.api));
const exportStatus = ['merged', 'merged', 'merged', 'processing', 'pending', 'pending'];
const EXPORT_ISSUES = EXPORT_PLAN.map((step, index) => ({
  id: index + 1, draft_id: 'plan-exports', repository: REPOS.api, issue_number: step.issue_number, pr_number: index < 4 ? 207 + index : null,
  status: exportStatus[index], agent_alias: index === 2 ? 'codex' : 'claude', model_name: index === 2 ? 'gpt-6-astra' : 'claude-opus-5-5',
  followup_count: index === 1 ? 1 : 0, task_id: index === 3 ? 'task-orders-204' : null, created_at: hoursAgo(9), updated_at: minutesAgo(20 + index * 30),
}));

const execution = { baseBranch: 'main', useEpic: false, autoMerge: true, runUltrafix: true, ultrafixGoal: 8, ultrafixMaxCycles: 5 };

const contextFiles = [
  'src/checkout/CheckoutPage.tsx', 'src/checkout/useCheckout.ts', 'src/checkout/CardForm.tsx', 'src/api/ordersClient.ts',
  'src/analytics/track.ts', 'src/routes.tsx', 'src/components/OrderSummary.tsx', 'e2e/checkout.spec.ts',
];
const deliveryFiles = [
  ['src/sync/uploadQueue.ts', 'Matched prompt keywords: upload, queue'], ['src/screens/ProofOfDelivery.tsx', 'Matched prompt keywords: proof-of-delivery'],
  ['src/camera/capturePhoto.ts', 'Imported by ProofOfDelivery.tsx'], ['src/net/connectivity.ts', 'Matched prompt keywords: connection, offline'],
  ['src/storage/photoStore.ts', 'Imported by uploadQueue.ts'], ['src/stops/nextStop.ts', 'Matched prompt keywords: next stop'],
  ['src/api/deliveriesClient.ts', 'Imported by uploadQueue.ts'], ['docs/offline-mode.md', 'Documents offline behaviour'],
];
const deliveryPreview = {
  success: true, warnings: [],
  stats: { totalTokens: 94_380, costEstimate: 0.3, contextLength: 380_000, fileCount: deliveryFiles.length, modelMaxContextTokens: 1_000_000, modelName: 'claude-opus-5-5' },
  smartSelection: deliveryFiles.map(([path, reason], index) => ({ path, reason, source: 'auto', score: 97 - index * 6 })),
  fileTokenCounts: Object.fromEntries(deliveryFiles.map(([path], index) => [path, 18_000 - index * 1_900])),
};

const lastPreview = {
  success: true, warnings: [],
  stats: { totalTokens: 186_240, costEstimate: 0.6, contextLength: 720_000, fileCount: contextFiles.length, modelMaxContextTokens: 1_000_000 },
  smartSelection: contextFiles.map((path, index) => ({ path, reason: 'Matched prompt keywords', source: 'auto', score: 96 - index * 5 })),
};

export const DRAFTS: Record<string, Record<string, unknown>> = {
  'plan-checkout': {
    draft_id: 'plan-checkout', repository: REPOS.web, name: 'Split checkout into address, shipping and payment steps',
    initial_prompt: 'Split the one-page checkout into address, shipping and payment steps. Keep the order summary visible on every step.',
    status: 'review', plan_json: CHECKOUT_PLAN, chat_history: CHECKOUT_CHAT,
    context_config: { baseBranch: 'main', contextLevel: 60, granularity: 'granular', lastPreview }, created_at: hoursAgo(4), updated_at: hoursAgo(2),
  },
  'plan-exports': {
    draft_id: 'plan-exports', repository: REPOS.api, name: 'Quarterly order exports for finance',
    initial_prompt: 'Let finance export every order of a quarter as CSV without timing out the API.',
    status: 'executed', plan_json: EXPORT_PLAN, context_config: execution, created_at: hoursAgo(10), updated_at: minutesAgo(20),
  },
  'plan-define': {
    draft_id: 'plan-define', repository: REPOS.mobile, name: 'Offline proof-of-delivery photos',
    initial_prompt: 'Couriers lose signal in basements. Queue proof-of-delivery photos offline and upload them when the connection returns, without blocking the next stop.',
    status: 'draft', plan_json: [], context_config: { baseBranch: 'main', contextLevel: 60, granularity: 'granular' }, created_at: minutesAgo(5), updated_at: minutesAgo(1),
  },
};

// Generation underway on the courier draft: relevance and context done, the planner model writing the plan.
const runningFor = (estimatedDuration: number, elapsedSeconds: number) => ({ estimatedDuration, startedAt: new Date(Date.parse(minutesAgo(0)) - elapsedSeconds * 1_000).toISOString() });
DRAFTS['plan-generating'] = {
  ...DRAFTS['plan-define'], draft_id: 'plan-generating', status: 'generating',
  context_config: { baseBranch: 'main', contextLevel: 60, granularity: 'granular', lastPreview: deliveryPreview },
  generation_trace: { runId: 'run-courier', steps: [
    { name: 'relevance', status: 'completed', data: runningFor(60_000, 52) },
    { name: 'context', status: 'completed', data: { ...runningFor(30_000, 38), includedFiles: deliveryFiles.map(([path]) => path), tokenCount: 94_380 } },
    { name: 'llm', status: 'in_progress', data: runningFor(150_000, 31) },
  ] },
};

const summary = (total: number, merged: number, processing: number) => ({ total, pending: total - merged - processing, processing, merged, closed: 0 });
const LIST = [
  { draft_id: 'plan-exports', name: 'Quarterly order exports for finance', repository: REPOS.api, status: 'executed', updated_at: minutesAgo(20), issue_summary: summary(6, 3, 1) },
  { draft_id: 'plan-checkout', name: 'Split checkout into address, shipping and payment steps', repository: REPOS.web, status: 'review', updated_at: hoursAgo(2), issue_summary: null },
  { draft_id: 'plan-define', name: 'Offline proof-of-delivery photos', repository: REPOS.mobile, status: 'draft', updated_at: minutesAgo(1), issue_summary: null },
  { draft_id: 'plan-terraform', name: 'Move staging to the shared Terraform modules', repository: REPOS.infra, status: 'generating', updated_at: minutesAgo(2), issue_summary: null },
  { draft_id: 'plan-epic', name: 'Courier app: route re-ordering and ETA sharing', repository: REPOS.mobile, status: 'pr_created', updated_at: hoursAgo(6), issue_summary: summary(4, 2, 1) },
  { draft_id: 'plan-search', name: 'Typo-tolerant product search', repository: REPOS.web, status: 'executed', updated_at: daysAgo(2), issue_summary: summary(3, 3, 0) },
].map(draft => ({ initial_prompt: draft.name, created_at: daysAgo(3), ...draft }));

const REVISIONS = [
  { revision_id: 31, draft_revision: 3, status_before: 'review', status_after: 'review', cause: 'refinement', currentCause: 'refinement', nameBefore: null, nameAfter: null, replaced_at: hoursAgo(2), issue_count: 4, titles: CHECKOUT_PLAN.slice(0, 4).map(step => step.title) },
  { revision_id: 30, draft_revision: 2, status_before: 'review', status_after: 'review', cause: 'refinement', currentCause: 'refinement', nameBefore: null, nameAfter: null, replaced_at: hoursAgo(3), issue_count: 5, titles: CHECKOUT_PLAN_V1.map(step => step.title) },
  { revision_id: 29, draft_revision: 1, status_before: 'generating', status_after: 'review', cause: 'generation', currentCause: 'refinement', nameBefore: null, nameAfter: null, replaced_at: hoursAgo(4), issue_count: 0, titles: [] },
];

function draftRoute(request: ApiRequest) {
  const [, id, suffix = ''] = request.path.match(/^\/api\/planner\/drafts\/([^/]+)(\/.*)?$/)!;
  const draft = DRAFTS[id];
  if (!draft) return undefined;
  if (!suffix) return draft;
  if (suffix === '/issues') return id === 'plan-exports' ? EXPORT_ISSUES : [];
  if (suffix === '/execution-queue') return { queue: null };
  if (suffix === '/repository-info') return { defaultBranch: 'main', branches: ['main', 'release/2026-10'] };
  if (suffix === '/revisions') return { revisions: REVISIONS };
  const revision = suffix.match(/^\/revisions\/(\d+)$/);
  if (revision) {
    const found = REVISIONS.find(entry => entry.revision_id === Number(revision[1]))!;
    return { ...found, plan: found.revision_id === 30 ? CHECKOUT_PLAN_V1 : CHECKOUT_PLAN.slice(0, 4) };
  }
  return undefined;
}

export const plans = area('plans', {
  '/api/instance/catalog': {
    agents: AGENTS.map(agent => ({ id: agent.id, kind: 'direct', type: agent.type, alias: agent.alias, enabled: true, supportedModels: agent.supportedModels, defaultModel: agent.defaultModel })),
    repositories: Object.values(REPOS).map(name => ({ name, enabled: true, baseBranch: 'main' })),
    defaultAgentAlias: 'claude',
  },
  'GET /api/planner/drafts': { drafts: LIST, total: LIST.length, page: 1, limit: 20, hasMore: false },
  '/api/planner/drafts/repositories': { repositories: [{ repo: REPOS.web, count: 2 }, { repo: REPOS.api, count: 1 }, { repo: REPOS.mobile, count: 2 }, { repo: REPOS.infra, count: 1 }], total: 6 },
  '/api/repositories/indexing-status': { repositories: [] },
  '/api/user/repo-preferences': { preferences: {} },
  '/api/stats/active-work': { counts: { tasks: 2, plans: 1, goals: 1, total: 4 } },
  '/api/stats/generating-plans': { count: 1 },
  'POST /api/planner/preview': deliveryPreview,
}, [[/^\/api\/planner\/drafts\/[^/]+/, draftRoute]]);
