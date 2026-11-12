import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  AUTOMATION_REPORT_MIN_NOVEL_CHARS,
  automationRunNoChangeReason,
  isAutomationUnproductiveRunThreshold,
} from '@propr/shared';
import {
  classifyAgentReportNovelty,
  hashAgentReport,
  normalizeAgentReport,
} from '../packages/core/src/services/agents/agentRunNovelty.ts';

const RUN_A = '3d934921-c7ae-4cb4-add8-b82d109ed330';
const RUN_B = '1f731cb6-c2ad-4aa4-b8c4-ad5fcbf92f1c';
const BODY = 'Dependency watch: lodash is outdated in acme/web and acme/api; no security advisories are open.';

describe('normalizeAgentReport', () => {
  test('collapses whitespace and trims', () => {
    assert.equal(normalizeAgentReport('  ## Summary\n\n\tlodash   is\r\noutdated  \n'), '## Summary lodash is outdated');
  });

  test('replaces ISO, numeric and named dates, weekdays, clock times, epochs and relative times', () => {
    const cases: Array<[string, string]> = [
      ['Checked 2026-11-11.', 'Checked <date>.'],
      ['At 2026-11-11T22:00:00.123Z the run began.', 'At <date> the run began.'],
      ['At 2026-11-11 22:00 UTC the run began.', 'At <date> the run began.'],
      ['At 2026-11-11T22:00:00+01:00 the run began.', 'At <date> the run began.'],
      ['Due 11/11/2026 and 2026/11/11 and 11.11.2026 and 11/11/26.', 'Due <date> and <date> and <date> and <date>.'],
      ['Report for Nov 11, 2026.', 'Report for <date>.'],
      ['Report for 11th November 2026.', 'Report for <date>.'],
      ['Report for November 2026.', 'Report for <date>.'],
      ['Generated on Wednesday at 9:05 pm.', 'Generated on <day> at <time>.'],
      ['Started 22:00:15, ended 22:04 UTC.', 'Started <time>, ended <time>.'],
      ['createdAt 1790000000000.', 'createdAt <time>.'],
      ['Last merged 3 hours ago.', 'Last merged <ago>.'],
    ];
    for (const [input, expected] of cases) assert.equal(normalizeAgentReport(input), expected, input);
  });

  test('a timestamp normalises the same whatever whitespace separates its parts', () => {
    const layouts: Array<[string, string[]]> = [
      ['Checked 2026-11-11 22:00 UTC.', ['Checked 2026-11-12  22:00 UTC.', 'Checked 2026-11-12\n22:00 UTC.', 'Checked 2026-11-12\r\n\t22:00\nUTC.', 'Checked 2026-11-12 22:00  UTC.']],
      ['Started 2026-11-11 22:00:15 +01:00.', ['Started 2026-11-12\n22:00:15\n+01:00.', 'Started 2026-11-12   22:00:15  +01:00.']],
      ['Finished at 9:05 pm UTC.', ['Finished at 10:15\npm\nUTC.', 'Finished at 10:15  pm  UTC.']],
      ['Report for Nov 11, 2026.', ['Report for Nov\n12,\n2026.', 'Report for Nov  12,   2026.']],
    ];
    for (const [single, variants] of layouts) {
      const expected = normalizeAgentReport(single);
      for (const variant of variants) assert.equal(normalizeAgentReport(variant), expected, JSON.stringify(variant));
    }
    assert.equal(normalizeAgentReport('Checked 2026-11-12\n22:00 UTC.'), 'Checked <date>.');
  });

  test('replaces only the run ids given, ignoring case, and keeps other UUIDs', () => {
    assert.equal(normalizeAgentReport(`Run run-42 (see ${RUN_A})`, { runIds: ['run-42'] }), `Run <run> (see ${RUN_A})`);
    assert.equal(normalizeAgentReport(`Run ${RUN_A.toUpperCase()}`, { runIds: [RUN_A] }), 'Run <run>');
    assert.equal(normalizeAgentReport('a.b+c', { runIds: ['a.b+c'] }), '<run>', 'ids are matched literally, not as patterns');
    assert.equal(normalizeAgentReport('run-42-b and run-42', { runIds: ['run-42', 'run-42-b'] }), '<run> and <run>', 'a longer id is replaced whole');
  });

  test('keeps meaningful numbers and wording', () => {
    assert.equal(normalizeAgentReport('3 PRs need review; version 4.17.21 is current.'), '3 PRs need review; version 4.17.21 is current.');
  });
});

describe('hashAgentReport', () => {
  test('is a stable SHA-256 hex of the normalised text', () => {
    const hash = hashAgentReport(`${BODY}\nGenerated 2026-11-11 for ${RUN_A}`, { runIds: [RUN_A, RUN_B] });
    assert.match(hash, /^[0-9a-f]{64}$/);
    assert.equal(hashAgentReport(`${BODY}   \n\nGenerated 2026-11-12 for ${RUN_B}`, { runIds: [RUN_A, RUN_B] }), hash);
    assert.notEqual(hashAgentReport(`${BODY.replace('lodash', 'react')}\nGenerated 2026-11-11 for ${RUN_A}`), hash);
  });
});

describe('classifyAgentReportNovelty', () => {
  test('a report with no previous report is new', () => {
    const result = classifyAgentReportNovelty({ runId: RUN_B, report: BODY, previous: null });
    assert.equal(result.reportNovelty, 'new');
    assert.equal(result.reportHash, hashAgentReport(BODY));
  });

  test('the same report on another night, with another run id and wrapping, is unchanged', () => {
    const previous = { runId: 'legacy-run-7', report: `# Nightly 2026-11-10 (run legacy-run-7)\n\n${BODY}` };
    const result = classifyAgentReportNovelty({ runId: RUN_B, report: `# Nightly   2026-11-11 (run ${RUN_B})\n${BODY}\n`, previous });
    assert.equal(result.reportNovelty, 'unchanged');
  });

  test('the same report with the next timestamp wrapped or spaced differently is unchanged', () => {
    const watch = 'Dependency watch: lodash remains outdated in acme/web.';
    const previous = { runId: RUN_A, report: `Checked 2026-11-11 22:00 UTC. ${watch}` };
    for (const report of [`Checked 2026-11-12\n22:00 UTC. ${watch}`, `Checked 2026-11-12  22:00 UTC. ${watch}`, `Checked 2026-11-12 22:00 UTC. ${watch}`]) {
      const result = classifyAgentReportNovelty({ runId: RUN_B, report, previous });
      assert.equal(result.reportNovelty, 'unchanged', JSON.stringify(report));
      assert.equal(result.reportHash, hashAgentReport(previous.report));
    }
  });

  test('a report about another incident or task is new; one that only quotes another run id is unchanged', () => {
    const INCIDENT_A = '9b2f6c1e-5d4a-4e8b-9f3c-2a1d7e6b5c40';
    const INCIDENT_B = '6e0a3d7f-1b2c-4d5e-8f9a-0b1c2d3e4f5a';
    const incident = (id: string, runId: string) => `Unresolved incident ${id} requires investigation and escalation to the owner (run ${runId}).`;
    const previous = { runId: RUN_A, report: incident(INCIDENT_A, RUN_A) };
    assert.equal(classifyAgentReportNovelty({ runId: RUN_B, report: incident(INCIDENT_B, RUN_B), previous }).reportNovelty, 'new');
    const task = (id: string) => `Task ${id} is still blocked on review; nothing else changed in acme/web since the last run.`;
    assert.equal(classifyAgentReportNovelty({ runId: RUN_B, report: task(INCIDENT_B), previous: { runId: RUN_A, report: task(INCIDENT_A) } }).reportNovelty, 'new');
    assert.equal(classifyAgentReportNovelty({ runId: RUN_B, report: incident(INCIDENT_A, RUN_B), previous }).reportNovelty, 'unchanged');
  });

  test('run ids named as known count as volatile in both reports', () => {
    const OLDER = '0c4e1f2a-7b3d-4c5e-9a6f-1d2e3f4a5b6c';
    const since = (runId: string) => `${BODY} Compared with run ${runId}.`;
    const previous = { runId: RUN_A, report: since(OLDER) };
    assert.equal(classifyAgentReportNovelty({ runId: RUN_B, report: since(RUN_A), previous }).reportNovelty, 'new', 'an unnamed run id is kept');
    assert.equal(classifyAgentReportNovelty({ runId: RUN_B, report: since(RUN_A), previous, knownRunIds: [RUN_A, OLDER] }).reportNovelty, 'unchanged');
  });

  test('a report that says something different is new', () => {
    const previous = { runId: RUN_A, report: BODY };
    assert.equal(classifyAgentReportNovelty({ runId: RUN_B, report: `${BODY} react is outdated too.`, previous }).reportNovelty, 'new');
  });

  test('a report below the minimum length is empty, even when it repeats the previous one', () => {
    const short = 'Nothing to report on 2026-11-11.';
    assert.ok(normalizeAgentReport(short).length < AUTOMATION_REPORT_MIN_NOVEL_CHARS);
    assert.equal(classifyAgentReportNovelty({ runId: RUN_B, report: short, previous: { runId: RUN_A, report: short } }).reportNovelty, 'empty');
    assert.equal(classifyAgentReportNovelty({ runId: RUN_B, report: '   \n ', previous: null }).reportNovelty, 'empty');
    // Placeholders replace dates, so a report that is mostly a date is still empty.
    assert.equal(classifyAgentReportNovelty({ runId: RUN_B, report: `${RUN_B} 2026-11-11T22:00:00Z`, previous: null }).reportNovelty, 'empty');
  });
});

describe('automationRunNoChangeReason', () => {
  test('flags empty and unchanged reports and no-op acting steps', () => {
    assert.equal(automationRunNoChangeReason({ reportNovelty: 'empty', actingMutations: null }), 'empty_report');
    assert.equal(automationRunNoChangeReason({ reportNovelty: 'unchanged', actingMutations: null }), 'unchanged_report');
    assert.equal(automationRunNoChangeReason({ reportNovelty: 'new', actingMutations: 0 }), 'no_op_action');
    assert.equal(automationRunNoChangeReason({ reportNovelty: null, actingMutations: 0 }), 'no_op_action');
  });

  test('a new report, or an acting step that changed something, is productive; unflagged runs are not flagged', () => {
    assert.equal(automationRunNoChangeReason({ reportNovelty: 'new', actingMutations: null }), null);
    assert.equal(automationRunNoChangeReason({ reportNovelty: 'unchanged', actingMutations: 2 }), null);
    assert.equal(automationRunNoChangeReason({ reportNovelty: null, actingMutations: null }), null);
  });

  test('the streak threshold setting accepts whole numbers from 1 to 50', () => {
    for (const value of [1, 3, 50]) assert.ok(isAutomationUnproductiveRunThreshold(value), String(value));
    for (const value of [0, 51, 2.5, '3', null]) assert.ok(!isAutomationUnproductiveRunThreshold(value), String(value));
  });
});
