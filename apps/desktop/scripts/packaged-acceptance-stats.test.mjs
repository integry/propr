import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { describe, it } from 'node:test';

const readSource = relativePath => readFileSync(
  fileURLToPath(new URL(relativePath, import.meta.url)),
  'utf8',
);

const runnerSource = readSource('./run-packaged-acceptance.mjs');
const taskStatsApiSource = readSource('../../../propr-ui/src/api/taskStatsApi.ts');
const dashboardApiSource = readSource('../../../propr-ui/src/api/dashboardApi.ts');
const analyticsPageSource = readSource('../../../propr-ui/src/pages/AnalyticsPage.tsx');
const taskStatsChartSource = readSource('../../../propr-ui/src/components/TaskStatsChart.tsx');
const taskStatusBreakdownSource = readSource('../../../propr-ui/src/components/taskStatusBreakdown.ts');
const topModelsSource = readSource('../../../propr-ui/src/components/TopModels.tsx');
const repositoryBreakdownSource = readSource('../../../propr-ui/src/components/RepositoryBreakdown.tsx');
const repositoryReportSource = readSource('../../../propr-ui/src/components/RepositoryReport.tsx');
const headerStatsSource = readSource('../../../propr-ui/src/hooks/useHeaderStats.ts');
const headerStatsHelpersSource = readSource('../../../propr-ui/src/hooks/useHeaderStatsHelpers.ts');
const needsAttentionSource = readSource('../../../propr-ui/src/components/Dashboard/NeedsAttentionPanel.tsx');
const happeningNowSource = readSource('../../../propr-ui/src/components/Dashboard/HappeningNowSection.tsx');
const completedSource = readSource('../../../propr-ui/src/components/Dashboard/CompletedFeed.tsx');
const historicalStatsSource = readSource('../../../propr-ui/src/components/Dashboard/HistoricalStatsPanel.tsx');

const fixturePayload = pathname => {
  const route = `if (requestUrl.pathname === '${pathname}')`;
  const routeStart = runnerSource.indexOf(route);
  assert.notEqual(routeStart, -1, `${pathname} exact route is missing`);
  const responseStart = runnerSource.indexOf('return json(response, 200, ', routeStart);
  assert.notEqual(responseStart, -1, `${pathname} response is missing`);
  const valueStart = responseStart + 'return json(response, 200, '.length;
  const valueEnd = runnerSource.indexOf(');', valueStart);
  assert.notEqual(valueEnd, -1, `${pathname} response terminator is missing`);
  const value = runInNewContext(`(${runnerSource.slice(valueStart, valueEnd)})`);
  return JSON.parse(JSON.stringify(value));
};

const interfaceFields = (name, source = taskStatsApiSource) => {
  const match = source.match(new RegExp(`export interface ${name}(?: extends ([A-Za-z0-9_]+))? \\{([\\s\\S]*?)\\n\\}`));
  assert.ok(match, `${name} interface is missing`);
  const own = [...match[2].matchAll(/^\s{2}([A-Za-z_][A-Za-z0-9_]*):/gm)].map(field => field[1]);
  return match[1] ? [...interfaceFields(match[1], source), ...own] : own;
};

/** Field presence, not declaration order: an inherited field can sit anywhere. */
const assertSameFields = (payload, name, source) => assert.deepEqual(
  Object.keys(payload).sort(),
  interfaceFields(name, source).sort(),
  `${name} fields differ from the fixture`,
);

describe('packaged acceptance stats fixtures', () => {
  it('returns the paginated draft shape consumed by the dashboard header', () => {
    const payload = fixturePayload('/api/planner/drafts');
    const draftsRoute = runnerSource.indexOf("requestUrl.pathname === '/api/planner/drafts'");
    const genericApiFallback = runnerSource.indexOf("request.url?.startsWith('/api/')");

    assert.deepEqual(payload, { drafts: [], total: 0, page: 1, limit: 20, hasMore: false });
    assert.ok(draftsRoute < genericApiFallback);
    assert.match(
      headerStatsSource,
      /getDrafts\(\{\s*limit:\s*20,\s*excludeStatuses:\s*'merged'\s*\}\)/
    );
    assert.match(headerStatsSource, /buildRunningItems\(\s*draftsSnapshotRef\.current,/);
    assert.match(headerStatsSource, /setActivePlans\(filterActivePlans\(response\.drafts\)\)/);
    assert.match(
      headerStatsHelpersSource,
      /export function filterActivePlans\([\s\S]*?return drafts\s*\.filter/
    );
    assert.ok(Array.isArray(payload.drafts));
  });

  it('dispatches exact stats pathnames before the unchanged generic fallback', () => {
    const generatingPlans = runnerSource.indexOf("requestUrl.pathname === '/api/stats/generating-plans'");
    const tasks = runnerSource.indexOf("requestUrl.pathname === '/api/stats/tasks'");
    const overview = runnerSource.indexOf("requestUrl.pathname === '/api/stats/overview'");
    const repositories = runnerSource.indexOf("requestUrl.pathname === '/api/stats/repositories'");
    const genericFallback = runnerSource.indexOf("request.url?.startsWith('/api/stats/')");

    assert.ok(generatingPlans < tasks && tasks < overview && overview < repositories);
    assert.ok(repositories < genericFallback);
    assert.deepEqual(fixturePayload('/api/stats/generating-plans'), { count: 0 });
  });

  it('matches TaskStatsResponse and the fields synchronously mapped by Analytics and TaskStatsChart', () => {
    const payload = fixturePayload('/api/stats/tasks');

    assert.deepEqual(Object.keys(payload), interfaceFields('TaskStatsResponse'));
    assert.deepEqual(payload, {
      dailyCounts: [],
      statusDistribution: [
        { status: 'completed', count: 12 },
        { status: 'failed', count: 0 },
      ],
      avgProcessingTime: [],
      summary: { total: 12, completed: 12, failed: 0 },
    });
    // These stats moved off the dashboard onto /analytics, which maps
    // dailyCounts itself and hands the rest to TaskStatsChart.
    assert.match(analyticsPageSource, /\(taskStats\?\.dailyCounts \?\? \[\]\)\.map/);
    for (const field of ['total', 'completed', 'failed']) {
      assert.match(taskStatsChartSource, new RegExp(`stats\\.summary\\.${field}`));
    }
    for (const field of ['dailyCounts', 'avgProcessingTime']) {
      assert.match(taskStatsChartSource, new RegExp(`stats\\.${field}\\.map`));
      assert.ok(Array.isArray(payload[field]), `${field} must be synchronously mappable`);
    }
    // statusDistribution is merged into display groups by buildStatusBreakdown,
    // which iterates the array synchronously instead of mapping it inline.
    assert.match(taskStatsChartSource, /buildStatusBreakdown\(stats\.statusDistribution\)/);
    assert.match(
      taskStatusBreakdownSource,
      /export function buildStatusBreakdown\(distribution: StatusDistribution\[\]\)[\s\S]*?for \(const item of distribution\)/
    );
    assert.ok(Array.isArray(payload.statusDistribution), 'statusDistribution must be synchronously iterable');
    assert.equal(payload.summary.total, 12);
    assert.equal(payload.summary.completed, 12);
    assert.equal(payload.summary.failed, 0);
  });

  it('matches StatsOverviewResponse and RepositoryStatsResponse consumer contracts', () => {
    const overview = fixturePayload('/api/stats/overview');
    const repositories = fixturePayload('/api/stats/repositories');

    assert.deepEqual(Object.keys(overview), interfaceFields('StatsOverviewResponse'));
    assert.deepEqual(Object.keys(overview.tasks), interfaceFields('StatsOverviewTasks'));
    assert.deepEqual(Object.keys(overview.usage), interfaceFields('StatsOverviewUsage'));
    assert.deepEqual(Object.keys(overview.system), interfaceFields('StatsOverviewSystem'));
    assert.deepEqual(overview, {
      tasks: {
        completed: 12,
        planned: 0,
        pr_iterations_avg: 0,
        merged_prs: 0,
        total_followups: 0,
      },
      usage: { total_tokens: 0, total_cost_usd: 0, models: {} },
      system: { repos_indexed: 0 },
    });
    assert.deepEqual(Object.keys(repositories), interfaceFields('RepositoryStatsResponse'));
    assert.deepEqual(repositories, { repositories: [] });
    assert.match(topModelsSource, /Object\.keys\(metrics\.usage\.models\)/);
    assert.match(topModelsSource, /Object\.entries\(metrics\.usage\.models\)/);
    assert.match(repositoryReportSource, /metrics\.usage\.total_cost_usd\.toFixed/);
    assert.equal(typeof overview.usage.models, 'object');
    assert.equal(Array.isArray(overview.usage.models), false);
    assert.match(repositoryBreakdownSource, /setRepositories\(data\.repositories \|\| \[\]\)/);
    assert.ok(Array.isArray(repositories.repositories));
  });

  it('matches the dashboard section responses the renderer indexes into', () => {
    const summary = fixturePayload('/api/dashboard/summary');
    const attention = fixturePayload('/api/dashboard/attention');
    const active = fixturePayload('/api/dashboard/active');
    const outcomes = fixturePayload('/api/dashboard/outcomes');
    const stats = fixturePayload('/api/stats/dashboard');

    assertSameFields(summary, 'DashboardSummaryResponse', dashboardApiSource);
    assertSameFields(attention, 'DashboardAttentionResponse', dashboardApiSource);
    assertSameFields(active, 'DashboardActiveResponse', dashboardApiSource);
    assertSameFields(outcomes, 'DashboardOutcomesResponse', dashboardApiSource);
    assertSameFields(stats, 'DashboardStatsResponse', dashboardApiSource);
    assertSameFields(stats.previous, 'DashboardStatsTotals', dashboardApiSource);
    assertSameFields(active.queue, 'DashboardQueueSummary', dashboardApiSource);

    // Sections read these nested objects without guarding them, so a fixture
    // that omits one throws during render instead of showing an empty section.
    assert.match(happeningNowSource, /data\?\.counts\.running/);
    assert.match(happeningNowSource, /data\.queue\.queuedCount/);
    assert.match(happeningNowSource, /data\.queue\.reason/);
    assert.match(historicalStatsSource, /<DailyCompletionsChart data=\{data\.dailyCompleted\} \/>/);
    assert.equal(typeof active.counts.running, 'number');
    assert.equal(typeof active.queue.queuedCount, 'number');
    assert.equal(typeof stats.previous.completed, 'number');
    assert.ok(Array.isArray(stats.dailyCompleted));

    // The remaining sections map their rows, which have to arrive as arrays.
    assert.match(needsAttentionSource, /data\?\.items \?\? \[\]/);
    assert.match(completedSource, /data\?\.items \?\? \[\]/);
    for (const rows of [attention.items, active.running, active.queued, outcomes.items]) {
      assert.ok(Array.isArray(rows), 'dashboard rows must be synchronously iterable');
    }
  });

  it('dispatches the dashboard pathnames before the generic fallbacks', () => {
    const genericStatsFallback = runnerSource.indexOf("request.url?.startsWith('/api/stats/')");
    const genericApiFallback = runnerSource.indexOf("request.url?.startsWith('/api/')");

    for (const pathname of ['/api/dashboard/summary', '/api/dashboard/attention',
      '/api/dashboard/active', '/api/dashboard/outcomes']) {
      const route = runnerSource.indexOf(`requestUrl.pathname === '${pathname}'`);
      assert.notEqual(route, -1, `${pathname} exact route is missing`);
      assert.ok(route < genericApiFallback, `${pathname} must precede the generic API fallback`);
    }
    const dashboardStats = runnerSource.indexOf("requestUrl.pathname === '/api/stats/dashboard'");
    assert.notEqual(dashboardStats, -1);
    assert.ok(dashboardStats < genericStatsFallback);
  });
});
