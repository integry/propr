import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AUTOMATION_REPORT_PREVIEW_MAX_CHARS, automationReportPreview } from '../src/automationReportPreview.js';

test('automationReportPreview takes the first line with words and strips Markdown markers', () => {
  assert.equal(automationReportPreview('## Weekly **dependency** audit\n\n- lodash is outdated'), 'Weekly dependency audit');
  assert.equal(automationReportPreview('\n---\n- [x] `npm audit` found [3 issues](https://example.com)\n'), 'npm audit found 3 issues');
  assert.equal(automationReportPreview('```\n> 1. Nothing new since _last_ run\n'), 'Nothing new since last run');
  assert.equal(automationReportPreview('#\n| --- | --- |\nPlain text'), 'Plain text');
});

test('automationReportPreview is null without a report or without words', () => {
  assert.equal(automationReportPreview(null), null);
  assert.equal(automationReportPreview(undefined), null);
  assert.equal(automationReportPreview(''), null);
  assert.equal(automationReportPreview('#\n\n---\n```'), null);
});

test('automationReportPreview truncates a long first line with an ellipsis', () => {
  const preview = automationReportPreview(`# ${'word '.repeat(80)}\nsecond line`);
  assert.ok(preview);
  assert.ok(preview.length <= AUTOMATION_REPORT_PREVIEW_MAX_CHARS);
  assert.ok(preview.endsWith('…'));
  assert.ok(!preview.includes('second'));
});
