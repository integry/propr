import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AUTOMATION_REPORT_PREVIEW_MAX_CHARS, automationReportPreview } from '../src/automationReportPreview.js';

test('automationReportPreview falls back to the title when the report is only a heading', () => {
  assert.equal(automationReportPreview('## Weekly **dependency** audit'), 'Weekly dependency audit');
  assert.equal(automationReportPreview('# Weekly audit\n\n## Findings\n\n---\n'), 'Weekly audit');
});

test('automationReportPreview takes the first sentence of the body after the heading', () => {
  assert.equal(
    automationReportPreview('# Weekly dependency audit\n\nThree packages are **outdated** since Monday. The rest are current.\n\n- lodash'),
    'Three packages are outdated since Monday.',
  );
  // A paragraph wrapped over several lines runs on until its first sentence ends.
  assert.equal(
    automationReportPreview('## Nightly build\nAll targets built\nin 12 minutes! Cache hit rate was 80%.'),
    'All targets built in 12 minutes!',
  );
  // Section headings between the title and the body are skipped too.
  assert.equal(automationReportPreview('# Audit\n## Summary\nNo new advisories for v0.9.2 today'), 'No new advisories for v0.9.2 today');
  // A full stop inside a token does not end the sentence.
  assert.equal(automationReportPreview('# Docs\nSee docs.example.com for e.g.details. Then rerun.'), 'See docs.example.com for e.g.details.');
});

test('automationReportPreview skips Setext headings underlined with = or -', () => {
  // Heading + body, both underline forms.
  assert.equal(
    automationReportPreview('Weekly audit\n---\n\nThree packages are outdated. Upgrade soon.'),
    'Three packages are outdated.',
  );
  assert.equal(
    automationReportPreview('Weekly audit\n============\nThree packages are outdated. Upgrade soon.'),
    'Three packages are outdated.',
  );
  // Heading only: the heading is the fallback, for both underline forms.
  assert.equal(automationReportPreview('Weekly **audit**\n---\n'), 'Weekly audit');
  assert.equal(automationReportPreview('Weekly audit\n==='), 'Weekly audit');
  // A heading wrapped over two lines, then a Setext section heading before the body.
  assert.equal(
    automationReportPreview('Weekly dependency\naudit\n===\n\nSummary\n-------\n- lodash is outdated'),
    'lodash is outdated',
  );
  assert.equal(automationReportPreview('Weekly. Audit\n===\nAll clear.'), 'All clear.');
  // A rule after a blank line, a list item or inside a fence is not an underline.
  assert.equal(automationReportPreview('# Audit\nAll clear today.\n\n---\nMore'), 'All clear today.');
  assert.equal(automationReportPreview('- lodash is outdated\nsince Monday\n---'), 'lodash is outdated');
  assert.equal(automationReportPreview('```\nconst a = 1\n---\n```'), 'const a = 1');
});

test('automationReportPreview previews the first item when the body starts with a list', () => {
  assert.equal(automationReportPreview('## Weekly **dependency** audit\n\n- lodash is outdated\n- react is current'), 'lodash is outdated');
  assert.equal(automationReportPreview('# Checks\n1. Lint passed. Tests failed.\n2. Build passed'), 'Lint passed.');
  // A paragraph does not run on into a list that follows it.
  assert.equal(automationReportPreview('# Checks\nResults\n- lint: passed'), 'Results');
});

test('automationReportPreview strips Markdown markers from the body', () => {
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
  assert.equal(automationReportPreview('\n\n   \n'), null);
  assert.equal(automationReportPreview('#\n\n---\n```'), null);
});

test('automationReportPreview truncates a long first sentence with an ellipsis', () => {
  const preview = automationReportPreview(`# Title\n${'word '.repeat(80)}\nsecond line`);
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

test('automationReportPreview stays linear on long runs of sentence punctuation', () => {
  const inputs = [`# Title\n${'!'.repeat(100_000)}x`, `# Title\n${'.)'.repeat(50_000)}x`, `# Title\n${'?'.repeat(50_000)}${')'.repeat(50_000)}x`];
  for (const input of inputs) {
    const started = performance.now();
    automationReportPreview(input);
    assert.ok(performance.now() - started < 500, `took too long on ${input.slice(8, 16)}…`);
  }
  assert.equal(automationReportPreview('# Title\nDone!!! Then more.'), 'Done!!!');
  assert.equal(automationReportPreview('# Title\nShipped v0.9.2 ("final"). Rest.'), 'Shipped v0.9.2 ("final").');
  assert.equal(automationReportPreview('# Title\nWait?!) next'), 'Wait?!)');
});
