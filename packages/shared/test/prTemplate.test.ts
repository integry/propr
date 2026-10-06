import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  PR_TEMPLATE_MAX_BYTES, PR_TEMPLATE_PLACEHOLDERS, PR_TEMPLATE_SCAFFOLD, PrTemplateError,
  composePrBody, composePrTitle, composeWithRepositoryTemplate, defaultPrBody, neutralizeHtml, parsePrTemplate, renderPrTemplateSection,
  type PrBodyPiece, type PrTemplatePlaceholder, type PrTemplateValues,
} from '../src/prTemplate.js';

const values: PrTemplateValues = {
  issue_number: '42', issue_title: 'Fix login', model: 'Claude Opus', agent: 'claude', cost: '$0.42',
  tokens: '12,345', execution_time: '4m 12s', branch: '42-fix-login', commits: '- `abc1234` Fix login',
  files_changed: '- `src/login.ts`', summary: 'Fixed the login form.', session_id: 'session-1', repository: 'acme/app',
};

const pieces: PrBodyPiece[] = [
  { section: 'summary', text: '## Summary\n\nCloses #42\n' },
  { section: 'commits', text: '**Commits:** abc1234' },
  { section: null, text: '\n\n---\n\n' },
  { section: 'run', text: '**Run:** 4m\n\n' },
  { section: 'summary', text: '**Summary:** done\n\n' },
  { section: null, text: '---\n' },
  { section: 'trailer', text: '*By ProPR*' },
  { section: null, text: '\n\n---\n\n' },
  { section: 'review_guidelines', text: '### Need changes?\n\nComment.' },
];

test('parsePrTemplate splits level-2 sections and keeps their Markdown', () => {
  const { sections, problems } = parsePrTemplate('Preamble is ignored\n\n## title\n[{{issue_number}}] {{issue_title}}\n\n## Summary\n\nCloses #{{issue_number}}\n\n### Details\n{{summary}}\n');
  assert.deepEqual(problems, []);
  assert.equal(sections.title, '[{{issue_number}}] {{issue_title}}');
  assert.equal(sections.summary, 'Closes #{{issue_number}}\n\n### Details\n{{summary}}');
});

test('parsePrTemplate stores whitespace-only sections as removals and leaves absent sections undefined', () => {
  const { sections } = parsePrTemplate('## run\n\n   \n## trailer\n');
  assert.equal(sections.run, '');
  assert.equal(sections.trailer, '');
  assert.equal(sections.summary, undefined);
});

test('parsePrTemplate reports unknown and duplicate sections with line numbers', () => {
  const { sections, problems } = parsePrTemplate('## checklist\n- [ ] item\n## summary\none\n## summary\ntwo\n');
  assert.equal(sections.summary, 'two');
  assert.equal((sections as Record<string, unknown>).checklist, undefined);
  assert.deepEqual(problems.map(problem => [problem.kind, problem.line]), [['unknown_section', 1], ['duplicate_section', 5]]);
});

test('parsePrTemplate reports unknown placeholders, including Handlebars logic', () => {
  const { problems } = parsePrTemplate('## summary\n{{#if summary}}\n{{ summary }}\n{{/if}}\n{{ issue_url }}\n');
  assert.deepEqual(problems.map(problem => [problem.kind, problem.line]), [
    ['unknown_placeholder', 2], ['unknown_placeholder', 4], ['unknown_placeholder', 5],
  ]);
  assert.match(problems[2].message, /\{\{issue_url\}\}/);
});

test('parsePrTemplate ignores headings in fenced code and HTML comments', () => {
  const { sections, problems } = parsePrTemplate('<!--\n## nope\n-->\n## summary\n```md\n## not a section\n```\n');
  assert.deepEqual(problems, []);
  assert.equal(sections.summary, '```md\n## not a section\n```');
});

test('parsePrTemplate closes a fence only with a matching fence at least as long', () => {
  const example = '````md\n```sh\nnpm test\n```\n## checklist\n- [ ] done\n````';
  const { sections, problems } = parsePrTemplate(`## summary\n${example}\n## trailer\nbye\n`);
  assert.deepEqual(problems, []);
  assert.equal(sections.summary, example);
  assert.equal(sections.trailer, 'bye');
  // A longer closing fence closes; a closing fence with trailing text does not.
  assert.equal(parsePrTemplate('## summary\n```\n## run\n`````\n## run\nx').sections.run, 'x');
  assert.equal(parsePrTemplate('## summary\n~~~\n~~~ x\n## run\n~~~\n').sections.summary, '~~~\n~~~ x\n## run\n~~~');
});

test('neutralizeHtml keeps nested fenced examples verbatim', () => {
  assert.equal(neutralizeHtml('````\n```\n<div>\n```\n<div>\n````\n<div>'), '````\n```\n<div>\n```\n<div>\n````\n&lt;div>');
});

test('the scaffold is entirely commented out and therefore changes nothing', () => {
  assert.deepEqual(parsePrTemplate(PR_TEMPLATE_SCAFFOLD), { sections: {}, problems: [] });
});

test('parsePrTemplate rejects oversized files without parsing them', () => {
  const { sections, problems } = parsePrTemplate(`## summary\n${'x'.repeat(PR_TEMPLATE_MAX_BYTES)}`);
  assert.deepEqual(sections, {});
  assert.equal(problems[0].kind, 'too_large');
});

test('renderPrTemplateSection substitutes every documented placeholder', () => {
  for (const name of Object.keys(PR_TEMPLATE_PLACEHOLDERS) as PrTemplatePlaceholder[]) {
    assert.equal(renderPrTemplateSection(`[{{${name}}}]`, values), `[${values[name]}]`, name);
    assert.equal(renderPrTemplateSection(`[{{ ${name} }}]`, values), `[${values[name]}]`, name);
  }
});

test('renderPrTemplateSection never evaluates substituted values', () => {
  const rendered = renderPrTemplateSection('{{summary}}', { ...values, summary: '{{issue_title}} {{#each x}}' });
  assert.equal(rendered, '{{issue_title}} {{#each x}}');
});

test('renderPrTemplateSection neutralizes HTML in untrusted values only', () => {
  const hostile = { ...values, issue_title: '<img src=x onerror=alert(1)>', summary: 'Use `Array<string>` and <script>x</script>', repository: '<b>trusted</b>' };
  assert.equal(renderPrTemplateSection('{{issue_title}}', hostile), '&lt;img src=x onerror=alert(1)>');
  assert.equal(renderPrTemplateSection('{{summary}}', hostile), 'Use `Array<string>` and &lt;script>x&lt;/script>');
  assert.equal(renderPrTemplateSection('{{repository}}', hostile), '<b>trusted</b>');
  assert.equal(neutralizeHtml('```\n<div>\n```\n<div>'), '```\n<div>\n```\n&lt;div>');
});

test('renderPrTemplateSection escapes HTML whose code fence only exists inside the value', () => {
  const summary = '```\n<details><summary>Hidden content</summary>\n```';
  assert.equal(renderPrTemplateSection('{{summary}}', { ...values, summary }), summary);
  assert.equal(
    renderPrTemplateSection('Agent result: {{summary}}', { ...values, summary }),
    'Agent result: ```\n&lt;details>&lt;summary>Hidden content&lt;/summary>\n```',
  );
  // A lone CR is a line ending on GitHub, so it cannot hide the prefix either.
  assert.equal(renderPrTemplateSection('Agent result: {{summary}}', { ...values, summary: '```\r<details>\r```' }), 'Agent result: ```\n&lt;details>\n```');
  // A fence nested in a list item closes with the item.
  assert.equal(neutralizeHtml('- a\n\n  ```\n<details>\n  ```'), '- a\n\n  ```\n&lt;details>\n  ```');
});

test('neutralizeHtml only exempts real inline code spans', () => {
  assert.equal(neutralizeHtml('``<details>`'), '``&lt;details>`');
  assert.equal(neutralizeHtml('`<details>``'), '`&lt;details>``');
  assert.equal(neutralizeHtml('`a`` <details> ``b`'), '`a`` <details> ``b`');
  assert.equal(neutralizeHtml('\\`<details>`'), '\\`&lt;details>`');
  // The first backtick pairs with one on the next line, so `<details>` is outside code.
  assert.equal(neutralizeHtml('a `b\nc` <details> `d`'), 'a `b\nc` &lt;details> `d`');
  // Table cells split before code spans.
  assert.equal(neutralizeHtml('| `x | <details> ` |'), '| `x | &lt;details> ` |');
  assert.equal(neutralizeHtml('Use ``Array<`T`>`` and `Map<K, V>`'), 'Use ``Array<`T`>`` and `Map<K, V>`');
});

test('renderPrTemplateSection escapes values that template HTML turns into raw HTML', () => {
  const hostile = { ...values, summary: '`<details>`' };
  assert.equal(renderPrTemplateSection('<div>\n{{summary}}', hostile), '<div>\n`&lt;details>`');
  const fenced = { ...values, summary: '```\n<details>\n```' };
  assert.equal(renderPrTemplateSection('<pre>\n\n{{summary}}', fenced), '<pre>\n\n```\n&lt;details>\n```');
});

test('composePrBody decides code boundaries in the composed description', () => {
  const template = parsePrTemplate('## summary\n{{summary}}\n## review_guidelines\n```\n{{issue_title}}\n```\n');
  const body = composePrBody(pieces, template, { ...values, summary: '```', issue_title: '<details>' });
  // The summary's unclosed fence swallows everything up to the template's opening fence, which closes it.
  assert.match(body, /\n```\n&lt;details>\n```\n/);
  assert.doesNotMatch(body, /<details>/);
  const intact = composePrBody(pieces, template, { ...values, issue_title: '<details>' });
  assert.match(intact, /\n```\n<details>\n```\n/);
});

test('renderPrTemplateSection throws on unknown placeholders', () => {
  assert.throws(() => renderPrTemplateSection('{{nope}}', values), PrTemplateError);
});

test('defaultPrBody joins every piece unchanged', () => {
  assert.equal(defaultPrBody(pieces), pieces.map(piece => piece.text).join(''));
});

test('composePrBody replaces present sections, removes empty ones and keeps defaults for absent ones', () => {
  const template = parsePrTemplate('## summary\nResolves #{{issue_number}} in {{repository}}\n## run\n\n## commands\n- `/review`\n');
  assert.equal(composePrBody(pieces, template, values), [
    'Resolves #42 in acme/app',
    '**Commits:** abc1234',
    '### Need changes?\n\nComment.',
    '- `/review`',
    '*By ProPR*',
  ].join('\n\n'));
});

test('composeWithRepositoryTemplate prepends the summary and run block to the repository template', () => {
  assert.equal(
    composeWithRepositoryTemplate(pieces, '## Checklist\r\n- [ ] Tested\r\n'),
    '## Summary\n\nCloses #42\n\n**Summary:** done\n\n**Run:** 4m\n\n## Checklist\n- [ ] Tested',
  );
});

test('composePrTitle renders plain text and keeps the default when absent or empty', () => {
  const template = parsePrTemplate('## title\n{{issue_number}}:\n  {{issue_title}}\n');
  assert.equal(composePrTitle('[42 by Claude] Fix', template, { ...values, issue_title: 'A <b>bold</b>\nfix' }), '42: A <b>bold</b> fix');
  assert.equal(composePrTitle('default', parsePrTemplate('## title\n\n'), values), 'default');
  assert.equal(composePrTitle('default', undefined, values), 'default');
  assert.equal(composePrTitle('default', parsePrTemplate('## title\n{{issue_title}}'), { ...values, issue_title: 'x'.repeat(300) }).length, 256);
});

test('placeholder matching stays linear on unterminated braces followed by whitespace', () => {
  const hostile = `{{{{${'\t'.repeat(50_000)}`;
  const started = Date.now();
  assert.equal(renderPrTemplateSection(hostile, values), hostile);
  assert.deepEqual(parsePrTemplate(`## summary\n${hostile}`).problems, []);
  assert.equal(renderPrTemplateSection('{{ \tissue_number\t }}', values), '42');
  assert.ok(Date.now() - started < 1000);
});
