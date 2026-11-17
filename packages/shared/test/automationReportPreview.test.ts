import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AUTOMATION_REPORT_PREVIEW_MAX_CHARS, automationReportPreview } from '../src/automationReportPreview.js';

test('automationReportPreview takes the first line with words and strips Markdown markers', () => {
  assert.equal(automationReportPreview('## Weekly **dependency** audit\n\n- lodash is outdated'), 'Weekly dependency audit');
  assert.equal(automationReportPreview('\n---\n- [x] `npm audit` found [3 issues](https://example.com)\n'), 'npm audit found 3 issues');
  assert.equal(automationReportPreview('```\n> 1. Nothing new since _last_ run\n'), 'Nothing new since last run');
  assert.equal(automationReportPreview('#\n| --- | --- |\nPlain text'), 'Plain text');
});

test('automationReportPreview skips opening fences that carry an info string', () => {
  assert.equal(automationReportPreview('```json\n{"status":"passed"}'), '{"status":"passed"}');
  assert.equal(automationReportPreview('```ts title="report.ts"\nconst ok = true;'), 'const ok = true;');
  assert.equal(automationReportPreview('~~~json\n{"status":"passed"}'), '{"status":"passed"}');
  assert.equal(automationReportPreview('~~~ python `fenced`\nprint("ok")'), 'print("ok")');
  assert.equal(automationReportPreview('  ````markdown\n# Inner heading'), 'Inner heading');
  assert.equal(automationReportPreview('```json\n```'), null);
  assert.equal(automationReportPreview('```inline code``` after'), 'inline code after');
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

test('automationReportPreview reduces links, images and tags as before', () => {
  assert.equal(automationReportPreview('See ![](x.png) and ![chart](c.png) in [the report](https://example.com/r)'), 'See and chart in the report');
  assert.equal(automationReportPreview('[![badge](b.svg)](https://ci)'), 'badge');
  assert.equal(automationReportPreview('[] (x) [](y) [open ( only'), '[] (x) [](y) [open ( only');
  assert.equal(automationReportPreview('<b>Bold</b> <br/> text <> a < b'), 'Bold text <> a < b');
});

test('automationReportPreview leaves no tag that can be reassembled from its pieces', () => {
  const preview = automationReportPreview('<scr<script>ipt>alert(1)</scr</script>ipt> <<script>script>');
  assert.ok(preview);
  assert.ok(!/<[^>]+>/u.test(preview), preview);
});

test('automationReportPreview stays linear on repeated unmatched brackets', () => {
  const inputs = [`![${'![\\'.repeat(50_000)}`, `![](${'![]('.repeat(50_000)}`, `[${'[a]('.repeat(50_000)}`, '<'.repeat(100_000)];
  for (const input of inputs) {
    const started = performance.now();
    automationReportPreview(input);
    assert.ok(performance.now() - started < 500, `took too long on ${input.slice(0, 8)}…`);
  }
});
