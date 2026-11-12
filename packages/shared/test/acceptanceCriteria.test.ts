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

test('keeps sibling items apart however their markers are indented', () => {
  // A marker left of the previous item's content column starts a sibling, not a child.
  assert.deepEqual(texts('## Acceptance criteria\n- Backend works\n - Documents usage'), ['Backend works', 'Documents usage']);
  assert.deepEqual(texts('## Acceptance criteria\n  - First\n - Second\n- Third\n   - Child of third'), ['First', 'Second', 'Third; Child of third']);
  assert.deepEqual(texts('## Acceptance criteria\n1. First\n  2. Second\n   3. Third\n      1. Child of third'), ['First', 'Second', 'Third; Child of third']);
  // An ordered list starting at another number cannot interrupt a paragraph, so `4.` continues the text, as GitHub renders it.
  assert.deepEqual(texts('## Acceptance criteria\n1. First\n  2. Second\n   3. Third\n      4. Child of third'), ['First', 'Second', 'Third 4. Child of third']);
  // The same holds after the first item's children.
  assert.deepEqual(texts('## Acceptance criteria\n- Parent\n  - child\n - Sibling\n   - its child'), ['Parent; child', 'Sibling; its child']);
  assert.deepEqual(extractAcceptanceCriteria('## Acceptance criteria\n- Backend works\n - Documents usage').map(criterion => criterion.id), ['AC1', 'AC2']);
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

test('a fence delimiter followed by text does not close a fence', () => {
  for (const delimiter of ['~~~', '```']) {
    // At top level, and inside a list item, where `- Fenced` would otherwise become a criterion or part of one.
    const topLevel = ['## Acceptance criteria', '- First', `${delimiter}text`, `${delimiter} example`, '- Fenced', delimiter, '- Second'];
    assert.deepEqual(texts(topLevel.join('\n')), ['First', 'Second'], delimiter);
    const inItem = ['## Acceptance criteria', '- First:', `  ${delimiter}text`, `  ${delimiter}${delimiter[0]} example`, '  - Fenced', `  ${delimiter}`, '  - Nested', '- Second'];
    assert.deepEqual(texts(inItem.join('\n')), ['First: Nested', 'Second'], delimiter);
    // Trailing whitespace is allowed, so these still close.
    assert.deepEqual(texts(`## Acceptance criteria\n${delimiter}\n- Fenced\n${delimiter}  \t\n- Kept\n`), ['Kept'], delimiter);
  }
});

test('ignores fenced examples inside block quotes', () => {
  const body = [
    '## Acceptance criteria',
    '- Validate input:',
    '  > ```text',
    '  > - Accept malformed input.',
    '  > ```',
    '  - Reject it.',
    '- Document usage.',
    '> ~~~',
    '> - Quoted example.',
    '> ~~~',
    '- Keep the changelog.',
  ].join('\n');
  // A quote in an item reads as blank lines, so the item continues; a top-level quote ends it, like a top-level fence.
  assert.deepEqual(texts(body), ['Validate input: Reject it.', 'Document usage.', 'Keep the changelog.']);
});

test('keeps a heading inside a list item, and the criteria after it, in the section', () => {
  const body = ['## Acceptance criteria', '- Document usage:', '  ## Examples', '  - Include a working example.', '- Add automated tests.'].join('\n');
  const expected = [
    { id: 'AC1', text: 'Document usage: Examples; Include a working example.' },
    { id: 'AC2', text: 'Add automated tests.' },
  ];
  assert.deepEqual(extractAcceptanceCriteria(body), expected);
  // A lower-level or setext heading in an item does not split the requirement under it off as a criterion.
  assert.deepEqual(extractAcceptanceCriteria(body.replace('  ## Examples', '  ### Examples')), expected);
  const setext = ['## Acceptance criteria', '- Document usage:', '', '  Examples', '  ---', '  - Include a working example.', '- Add automated tests.'];
  assert.deepEqual(extractAcceptanceCriteria(setext.join('\n')), expected);
  // A heading outside the list still ends the section: after a paragraph ends the list (nothing continues a
  // heading lazily), and when the section's own heading is inside a list item, a heading in that same item.
  assert.deepEqual(texts('## Acceptance criteria\n- First\n  ## Examples\nNot a criterion.\n  ## Out of scope\n- Not this\n'), ['First; Examples']);
  assert.deepEqual(texts('- Notes:\n  ## Acceptance criteria\n  - First\n  ## Out of scope\n  - Not this\n'), ['First']);
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
  const inside = '## Acceptance criteria\n- First <!-- hidden -->\n<!--\n- Not an item\n## Not a heading\n-->\n- Second\n<!-- - hidden item -->\n- Third\n';
  assert.deepEqual(texts(inside), ['First', 'Second', 'Third']);
  // An inline `<!--` with no `-->` in its paragraph is not a comment, so GitHub shows it, and the lines after it.
  assert.deepEqual(texts('## Acceptance criteria\n- First <!-- hidden\n- Not an item\n## Not a heading\n--> still first\n- Second\n'), ['First <!-- hidden', 'Not an item']);
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
  evaluateAcceptanceCriteria([{ id: 'AC1', text: 'x' }], `${'> '.repeat(50_000)}\`\`\`\n${'- > '.repeat(25_000)}\`\`\`\n${'> - ```\n'.repeat(20_000)}AC1: met`);
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

test('ignores statements after a fence delimiter followed by text, which leaves the fence open', () => {
  const criteria = [{ id: 'AC1', text: 'A' }, { id: 'AC2', text: 'B' }];
  for (const delimiter of ['~~~', '```']) {
    const report = ['- AC1: not met — implementation missing', `${delimiter}text`, `${delimiter} example`, '- AC1: met — example only', delimiter];
    assert.deepEqual(evaluateAcceptanceCriteria(criteria.slice(0, 1), report.join('\n')), [
      { id: 'AC1', text: 'A', status: 'not_met', evidence: 'implementation missing' },
    ], delimiter);
    // The real closing delimiter still ends the example, so a statement after it counts.
    assert.equal(evaluateAcceptanceCriteria(criteria, [...report, '- AC2: met — `src/b.ts`'].join('\n'))[1].status, 'met', delimiter);
    const inItem = ['- AC1: not met — missing', '- Example:', `  ${delimiter}md`, `  ${delimiter}${delimiter[0]} example`, '  - AC1: met — example only', `  ${delimiter}`];
    assert.equal(evaluateAcceptanceCriteria(criteria.slice(0, 1), inItem.join('\n'))[0].status, 'not_met', delimiter);
  }
});

test('ignores statements in fenced examples inside block quotes', () => {
  const criteria = [{ id: 'AC1', text: 'A' }, { id: 'AC2', text: 'B' }];
  const real = '- AC1: not met — implementation missing';
  const notMet = { id: 'AC1', text: 'A', status: 'not_met', evidence: 'implementation missing' };
  for (const example of [
    ['> ```md', '> - AC1: met — example', '> ```'],
    ['> > ~~~', '> > - AC1: met — example', '> > ~~~'],
    ['> - ```md', '>   - AC1: met — example', '>   ```'],
    ['- Notes:', '  > ```md', '  > - AC1: met — example', '  > ```'],
    ['- > ```md', '  > - AC1: met — example', '  > ```'],
    // A line nested too deep to parse reads as blank.
    [`${'> '.repeat(9)}- AC1: met — example`],
  ]) {
    assert.deepEqual(evaluateAcceptanceCriteria(criteria.slice(0, 1), [real, 'Report each criterion like this:', ...example].join('\n')), [notMet], example.join('\n'));
  }
  // A blank or unquoted line ends the quote and its fence, so a statement after it counts.
  for (const after of [
    ['> ```md', '', '- AC2: met — `src/b.ts`'],
    ['> ```md', '- AC2: met — `src/b.ts`'],
  ]) {
    assert.deepEqual(evaluateAcceptanceCriteria(criteria, [real, ...after].join('\n')), [
      notMet, { id: 'AC2', text: 'B', status: 'met', evidence: '`src/b.ts`' },
    ], after.join('\n'));
  }
  // A statement in a block quote is quoted, not the agent's report, even outside a fence.
  for (const quoted of [
    ['> ```md', '> - AC1: met — example', '> ```', '> - AC2: met — `src/b.ts`'],
    ['- Notes:', '  > ```md', '> - AC2: met — `src/b.ts`'],
  ]) {
    assert.deepEqual(evaluateAcceptanceCriteria(criteria, [real, ...quoted].join('\n')).map(result => result.status), ['not_met', 'not_addressed'], quoted.join('\n'));
  }
});

test('reads criteria and statements from the Markdown syntax tree', () => {
  // Wording is sliced from the source, as written; indented code, block quotes and quoted headings are never criteria.
  const body = [
    '> ## Acceptance criteria', '> - Quoted, not this', '',
    '## Acceptance criteria', '- Uses **bold**, `code` and [a link](https://example.com)', '',
    '      - indented code', '',
    '> - Quoted requirement', '',
    '---', '- After a thematic break',
  ].join('\n');
  assert.deepEqual(texts(body), ['Uses **bold**, `code` and [a link](https://example.com)', 'After a thematic break']);
  assert.deepEqual(texts('## Acceptance criteria\n- - - - - - - - - -\n- Kept\n'), ['Kept']);
  // Statements in a real GFM table count, row by row; indented code does not.
  const criteria = [{ id: 'AC1', text: 'A' }, { id: 'AC2', text: 'B' }];
  const report = ['| Criterion | Status | Evidence |', '| --- | --- | --- |', '| AC1 | met | `src/a.ts` |', '', '    AC2: met — example'].join('\n');
  assert.deepEqual(evaluateAcceptanceCriteria(criteria, report).map(result => [result.status, result.evidence]), [['met', '`src/a.ts`'], ['not_addressed', undefined]]);
});

test('bounds the input that slow Markdown constructs can make expensive', () => {
  const started = Date.now();
  // Many lazy continuation lines and table rows are quadratic in micromark; only the first lines are parsed.
  const lazy = texts(`## Acceptance criteria\n- First\n${'lazy\n'.repeat(30_000)}- Too late\n`);
  assert.equal(lazy.length, 1);
  assert.ok(lazy[0].startsWith('First lazy lazy'));
  evaluateAcceptanceCriteria([{ id: 'AC1', text: 'x' }], `| a | b |\n| - | - |\n${'| x | y |\n'.repeat(20_000)}`);
  // A line nested too deep reads as blank: its own text is dropped, the lines after it are parsed as before.
  assert.deepEqual(texts(`## Acceptance criteria\n- Kept\n${'- > '.repeat(9)}deep\n- Also kept\n`), ['Kept', 'Also kept']);
  assert.deepEqual(texts(`## Acceptance criteria\n- Kept:\n  ${'- > '.repeat(9)}deep\n  - nested\n- Also kept\n`), ['Kept: nested', 'Also kept']);
  assert.deepEqual(texts(`## Acceptance criteria\n- Kept\n${'- > '.repeat(4)}nested\n- Also kept\n`).length, 2);
  // Many such lines, within the length bound, stay cheap.
  assert.deepEqual(texts(`## Acceptance criteria\n- Kept\n${`${'- > '.repeat(20)}deep\n`.repeat(500)}- Also kept\n`), ['Kept', 'Also kept']);
  assert.ok(Date.now() - started < 2000);
});

test('a fenced example with deeply nested markers hides nothing after it', () => {
  // The markers are literal code, which GitHub renders as text: the criteria after the example are kept, wherever the example is.
  const example = ['```text', '> > > > > > > > > example', `${'- '.repeat(12)}another`, '```'];
  const criteria = ['## Acceptance criteria', '- Works', '- Documented'];
  assert.deepEqual(texts([...example, '', ...criteria].join('\n')), ['Works', 'Documented']);
  assert.deepEqual(texts([...criteria, '- Example:', ...example.map(line => `  ${line}`), '- After'].join('\n')), ['Works', 'Documented', 'Example:', 'After']);
  assert.deepEqual(texts([...example.map(line => `> ${line}`), '', ...criteria].join('\n')), ['Works', 'Documented']);
  assert.deepEqual(texts([...criteria, ...example, '- After the fence'].join('\n')), ['Works', 'Documented', 'After the fence']);
  // The same for the agent's report: an example with such markers does not hide the statements after it.
  const report = ['Format example:', ...example, '', '- AC1: met — `src/a.ts`'].join('\n');
  assert.deepEqual(evaluateAcceptanceCriteria([{ id: 'AC1', text: 'Works' }], report), [{ id: 'AC1', text: 'Works', status: 'met', evidence: '`src/a.ts`' }]);
});

test('keeps the whitespace within a criterion and its evidence as written', () => {
  // Consecutive spaces and tabs inside a literal can be the requirement; only line breaks and continuation indentation read as one space.
  const body = ['## Acceptance criteria', '- Preserve the exact string `a  b`.', '- Accept `x\t\ty` and  double  spaces', '  on a wrapped line', '  - nested `c   d`', '- Keep `e  f` <!-- note --> and `g  h`'].join('\n');
  assert.deepEqual(texts(body), [
    'Preserve the exact string `a  b`.',
    'Accept `x\t\ty` and  double  spaces on a wrapped line; nested `c   d`',
    'Keep `e  f` and `g  h`',
  ]);
  assert.deepEqual(extractAcceptanceCriteria(body)[0], { id: 'AC1', text: 'Preserve the exact string `a  b`.' });
  const [result] = evaluateAcceptanceCriteria(extractAcceptanceCriteria(body).slice(0, 1), '- AC1: met — `test/a  b.test.ts` and `x\t\ty`');
  assert.equal(result.evidence, '`test/a  b.test.ts` and `x\t\ty`');
});
