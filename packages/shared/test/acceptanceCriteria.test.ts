import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MAX_ACCEPTANCE_CRITERIA, MAX_ACCEPTANCE_CRITERION_LENGTH, MAX_ACCEPTANCE_EVIDENCE_LENGTH,
  evaluateAcceptanceCriteria, extractAcceptanceCriteria, formatAcceptanceCriteriaList,
} from '../src/acceptanceCriteria.js';

const texts = (body: string) => extractAcceptanceCriteria(body).map(criterion => criterion.text);

test('no heading means no criteria', () => {
  assert.deepEqual(extractAcceptanceCriteria(undefined), []);
  assert.deepEqual(extractAcceptanceCriteria(''), []);
  assert.deepEqual(extractAcceptanceCriteria('## Requirements\n\n- one\n- two\n\nAcceptance criteria: it works'), []);
  assert.deepEqual(extractAcceptanceCriteria('**Acceptance criteria**\n- bold is not a heading'), []);
});

test('matches the heading case-insensitively at any ATX or setext level', () => {
  for (const heading of ['# Acceptance criteria', '## Acceptance Criteria', '###### ACCEPTANCE CRITERIA', '### Acceptance criteria:', '## **Acceptance  criteria** ##', '  ## acceptance criteria']) {
    assert.deepEqual(texts(`${heading}\n\n- works`), ['works'], heading);
  }
  assert.deepEqual(texts('Intro\n\nAcceptance criteria\n===\n- one'), ['one']);
  assert.deepEqual(texts('Acceptance Criteria\n---\n- one'), ['one']);
  assert.deepEqual(texts('## Acceptance criteria for later\n- no'), []);
});

test('assigns stable ids in order and stops at the next heading of the same or a higher level', () => {
  const body = [
    '## Problem', '- not a criterion', '',
    '## Acceptance criteria', '', '- First', '* Second', '+ Third', '1. Fourth', '2) Fifth', '',
    '### Backend', '- Under a subheading', '',
    '## Out of scope', '- Not this',
  ].join('\n');
  assert.deepEqual(extractAcceptanceCriteria(body), [
    { id: 'AC1', text: 'First' }, { id: 'AC2', text: 'Second' }, { id: 'AC3', text: 'Third' },
    { id: 'AC4', text: 'Fourth' }, { id: 'AC5', text: 'Fifth' }, { id: 'AC6', text: 'Under a subheading' },
  ]);
  assert.deepEqual(texts('# Acceptance criteria\n- one\n## Deeper\n- two\n# Next\n- three'), ['one', 'two']);
});

test('folds nested items and continuation lines into their parent criterion', () => {
  const body = [
    '## Acceptance criteria',
    '- Parent:', '  - child one', '    - grandchild', '  - child two',
    '- Wrapped item', '  continues here', 'and lazily here',
    '', 'A plain paragraph is not a criterion.', '',
    '- Last',
  ].join('\n');
  assert.deepEqual(texts(body), ['Parent: child one; grandchild; child two', 'Wrapped item continues here and lazily here', 'Last']);
  assert.deepEqual(texts('## Acceptance criteria\n  - indented top level\n  - second\n    - nested'), ['indented top level', 'second; nested']);
});

test('drops checkboxes, HTML comments and list items inside code fences', () => {
  const body = '## Acceptance criteria\n- [ ] Open\n- [x] Done\n- [X] Also done <!-- note -->\n```md\n- fenced\n## Not a heading\n```\n- After fence\n- [ ]\n';
  assert.deepEqual(texts(body), ['Open', 'Done', 'Also done', 'After fence']);
  assert.deepEqual(texts('```\n## Acceptance criteria\n- fenced\n```\n'), []);
});

test('ignores fenced examples inside nested list items', () => {
  const body = [
    '## Acceptance criteria',
    '- Validate input:',
    '  - Reject malformed input, including this example:',
    '    ```text',
    '    - Accept malformed input.',
    '    ```',
    '- Document usage.',
  ].join('\n');
  assert.deepEqual(extractAcceptanceCriteria(body), [
    { id: 'AC1', text: 'Validate input: Reject malformed input, including this example:' },
    { id: 'AC2', text: 'Document usage.' },
  ]);
  // Nested items and continuation text after a fence stay in their criterion.
  const after = [
    '## Acceptance criteria',
    '- Validate input:',
    '',
    '  ```text',
    '  - Accept malformed input.',
    '  ```',
    '  - Reject malformed input',
    '    with a clear error.',
    '  Log each rejection.',
    '- Document usage.',
  ].join('\n');
  assert.deepEqual(texts(after), ['Validate input: Reject malformed input with a clear error. Log each rejection.', 'Document usage.']);
  const afterNested = [
    '## Acceptance criteria',
    '- Validate input:',
    '  - Reject malformed input, including this example:',
    '    ~~~',
    '    - Accept malformed input.',
    '    ~~~',
    '    and report it.',
    '  - Keep valid input.',
    '- Document usage.',
  ].join('\n');
  assert.deepEqual(texts(afterNested), ['Validate input: Reject malformed input, including this example: and report it. Keep valid input.', 'Document usage.']);
  // A top-level fence still ends the item (and its list, so an indented item after it is top-level),
  // and an unindented paragraph after an item's fence is not part of it.
  assert.deepEqual(texts('## Acceptance criteria\n- First\n```\ncode\n```\n  - After the fence\n- Second\n'), ['First', 'After the fence', 'Second']);
  assert.deepEqual(texts('## Acceptance criteria\n- First\n  ```\n  code\n  ```\nNot a criterion.\n- Second\n'), ['First', 'Second']);
  // A fence in a top-level item, and one a less-indented line ends with its list item.
  assert.deepEqual(texts('## Acceptance criteria\n1. First\n   ~~~\n   - example\n   ~~~\n2. Second\n'), ['First', 'Second']);
  assert.deepEqual(texts('## Acceptance criteria\n- First\n  ```\n  - example\n- Second\n'), ['First', 'Second']);
  // Outside a list, four spaces of indentation is still not a fence.
  assert.deepEqual(texts('## Acceptance criteria\n\n    ```\n- Kept\n'), ['Kept']);
});

test('ignores fenced examples that start on a list item line', () => {
  const body = [
    '## Acceptance criteria',
    '- Validate input:',
    '  - ```md',
    '    - Accept malformed input.',
    '    ```',
    '- Document usage.',
    '- ```text',
    '  - Example only.',
    '  ```',
    '  Run the example in CI.',
    '- 1. ~~~',
    '     - Nested example.',
    '     ~~~',
    '- Keep the changelog.',
  ].join('\n');
  // The fence is the item's content: the item still starts there and keeps its later text.
  assert.deepEqual(extractAcceptanceCriteria(body), [
    { id: 'AC1', text: 'Validate input:' },
    { id: 'AC2', text: 'Document usage.' },
    { id: 'AC3', text: 'Run the example in CI.' },
    { id: 'AC4', text: 'Keep the changelog.' },
  ]);
  // Inline code with three backticks is not a fence.
  assert.deepEqual(texts('## Acceptance criteria\n- ```npm test``` passes\n- Second\n'), ['```npm test``` passes', 'Second']);
});

test('starts a new top-level list after a sub-heading or paragraph ends the previous one', () => {
  const body = [
    '## Acceptance criteria',
    '- Backend works',
    '### Documentation',
    '  - Usage is documented',
    '    - with examples',
    '### Release',
    '- Changelog updated',
    '',
    'Operations:',
    '',
    '   1. Alert added',
  ].join('\n');
  assert.deepEqual(texts(body), ['Backend works', 'Usage is documented; with examples', 'Changelog updated', 'Alert added']);
  // A heading also ends the list for fences, so a top-level fence after it hides its whole body.
  assert.deepEqual(texts('## Acceptance criteria\n- Backend works\n### Docs\n  ```\nx\n- fenced\n  ```\n- Real\n'), ['Backend works', 'Real']);
});

test('ignores HTML comments spanning headings and list items', () => {
  const hidden = '<!--\n## Acceptance criteria\n- Obsolete requirement\n-->\n\n## Acceptance criteria\n- Actual requirement\n';
  assert.deepEqual(extractAcceptanceCriteria(hidden), [{ id: 'AC1', text: 'Actual requirement' }]);
  const inside = '## Acceptance criteria\n- First <!-- hidden\n- Not an item\n## Not a heading\n--> still first\n- Second\n<!-- - hidden item -->\n- Third\n';
  assert.deepEqual(texts(inside), ['First still first', 'Second', 'Third']);
  assert.deepEqual(texts('## Acceptance criteria\n- Kept\n<!-- unclosed\n- Hidden\n'), ['Kept']);
  // Comment delimiters inside fenced code are literal and hide nothing.
  assert.deepEqual(texts('```\n<!--\n```\n## Acceptance criteria\n- Visible\n```\n-->\n```\n- Also visible\n'), ['Visible', 'Also visible']);
});

test('bounds the count and the length of each criterion', () => {
  const many = ['## Acceptance criteria', ...Array.from({ length: MAX_ACCEPTANCE_CRITERIA + 5 }, (_, index) => `- item ${index + 1}`)].join('\n');
  const criteria = extractAcceptanceCriteria(many);
  assert.equal(criteria.length, MAX_ACCEPTANCE_CRITERIA);
  assert.equal(criteria.at(-1)?.id, `AC${MAX_ACCEPTANCE_CRITERIA}`);
  const [long] = extractAcceptanceCriteria(`## Acceptance criteria\n- ${'x'.repeat(MAX_ACCEPTANCE_CRITERION_LENGTH * 3)}`);
  assert.equal(long.text.length, MAX_ACCEPTANCE_CRITERION_LENGTH);
  assert.ok(long.text.endsWith('…'));
});

test('parses adversarial bodies in linear time', () => {
  const started = Date.now();
  extractAcceptanceCriteria(`## Acceptance criteria\n- ${'<!--'.repeat(20_000)}${' #'.repeat(20_000)}\n${'#'.repeat(30_000)}`);
  evaluateAcceptanceCriteria([{ id: 'AC1', text: 'x' }], `AC1: met ${' |'.repeat(50_000)}x`);
  extractAcceptanceCriteria(`## Acceptance criteria\n${'- '.repeat(50_000)}\`\`\`\n${'1. '.repeat(30_000)}x`);
  assert.ok(Date.now() - started < 1000);
});

test('formats criteria for prompts', () => {
  assert.equal(formatAcceptanceCriteriaList([{ id: 'AC1', text: 'One' }, { id: 'AC2', text: 'Two' }]), '- AC1: One\n- AC2: Two');
  assert.equal(formatAcceptanceCriteriaList([]), '');
});

test('pairs each criterion with the agent statement and marks the rest not addressed', () => {
  const criteria = extractAcceptanceCriteria('## Acceptance criteria\n- A\n- B\n- C\n- D\n- E');
  const report = [
    'I implemented the parser.', '',
    '**Acceptance criteria:**',
    '- **AC1:** met — `packages/shared/src/acceptanceCriteria.ts`',
    '- AC2 - not met: the UI part is still missing',
    '| AC3 | not applicable | docs-only change |',
    '- AC1: met — `packages/shared/test/acceptanceCriteria.test.ts`',
    '- AC9: met — unknown id is ignored',
    'The AC4 work is done.',
    '- AC5: met',
  ].join('\n');
  assert.deepEqual(evaluateAcceptanceCriteria(criteria, report), [
    { id: 'AC1', text: 'A', status: 'met', evidence: '`packages/shared/test/acceptanceCriteria.test.ts`' },
    { id: 'AC2', text: 'B', status: 'not_met', evidence: 'the UI part is still missing' },
    { id: 'AC3', text: 'C', status: 'not_applicable', evidence: 'docs-only change' },
    { id: 'AC4', text: 'D', status: 'not_addressed' },
    { id: 'AC5', text: 'E', status: 'met' },
  ]);
  assert.deepEqual(evaluateAcceptanceCriteria(criteria.slice(0, 1), undefined), [{ id: 'AC1', text: 'A', status: 'not_addressed' }]);
  const [bounded] = evaluateAcceptanceCriteria(criteria.slice(0, 1), `AC1: N/A — ${'y'.repeat(1000)}`);
  assert.equal(bounded.status, 'not_applicable');
  assert.equal(bounded.evidence?.length, MAX_ACCEPTANCE_EVIDENCE_LENGTH);
});

test('ignores statements in fenced examples and HTML comments, keeping the last real statement', () => {
  const criteria = [{ id: 'AC1', text: 'A' }, { id: 'AC2', text: 'B' }];
  const report = [
    '- AC1: not met — implementation missing',
    '- AC2: met — `src/b.ts`',
    'Report each criterion like this:',
    '```md',
    '- AC1: met — src/feature.ts',
    '```',
    '~~~',
    '- AC2: not met — example',
    '~~~',
    '<!--',
    '- AC1: met — hidden',
    '-->',
  ].join('\n');
  assert.deepEqual(evaluateAcceptanceCriteria(criteria, report), [
    { id: 'AC1', text: 'A', status: 'not_met', evidence: 'implementation missing' },
    { id: 'AC2', text: 'B', status: 'met', evidence: '`src/b.ts`' },
  ]);
  assert.equal(evaluateAcceptanceCriteria(criteria.slice(0, 1), `${report}\n- AC1: met — src/a.ts`)[0].status, 'met');
  const nested = ['- Notes:', '  - Example format:', '    ```md', '    - AC1: met — example', '    ```', '- AC1: not met — missing'].join('\n');
  assert.equal(evaluateAcceptanceCriteria(criteria.slice(0, 1), nested)[0].status, 'not_met');
  assert.equal(evaluateAcceptanceCriteria(criteria.slice(0, 1), nested.split('\n').slice(0, 5).join('\n'))[0].status, 'not_addressed');
  // A fence opening on the list item line, and the real statement after it.
  const onItemLine = ['- AC1: not met — missing implementation', '- ```md', '  - AC1: met — example', '  ```'];
  assert.deepEqual(evaluateAcceptanceCriteria(criteria.slice(0, 1), onItemLine.join('\n')), [
    { id: 'AC1', text: 'A', status: 'not_met', evidence: 'missing implementation' },
  ]);
  const after = [...onItemLine, '- AC2: met — `src/b.ts`'].join('\n');
  assert.equal(evaluateAcceptanceCriteria(criteria, after)[1].status, 'met');
  assert.equal(evaluateAcceptanceCriteria(criteria.slice(0, 1), '* 1. ~~~\n     AC1: met — example\n     ~~~')[0].status, 'not_addressed');
});
