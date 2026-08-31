import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { closeConnection } from '@propr/core';
import { toPublicGoalEventPayload } from '../routes/goalRouteDtos.js';

const REDACTED = '[REDACTED_SENSITIVE_PATH]';

after(async () => {
  await closeConnection();
});

function projectString(value: string): string {
  return (toPublicGoalEventPayload({ message: value }) as { message: string }).message;
}

test('raw sensitive roots use explicit leading and trailing token boundaries', () => {
  const positiveCases = [
    ['/home', REDACTED],
    ['/HOME/alice', REDACTED],
    ['/home/child', REDACTED],
    ['/home?user=alice', `${REDACTED}?user=alice`],
    ['/RUN#fragment', `${REDACTED}#fragment`],
    ['/opt, next', `${REDACTED}, next`],
    ['/home; next', `${REDACTED}; next`],
    ['/run|/public', `${REDACTED}|/public`],
    ['/home) next', `${REDACTED}) next`],
    ['/home next', `${REDACTED} next`],
    ['"/run"', `"${REDACTED}"`],
    ['path=/home&x=1', `path=${REDACTED}&x=1`],
    ['[/home]', `[${REDACTED}]`],
    ['{/HOME}', `{${REDACTED}}`],
    ['|/run/controller.sock', `|${REDACTED}`],
    [';/home/alice', `;${REDACTED}`],
    ['first&/OPT#fragment', `first&${REDACTED}#fragment`],
    ['[file:///%68ome/alice]', `[${REDACTED}]`],
    ['{FILE:///%72un/controller.sock}', `{${REDACTED}}`],
  ] as const;
  for (const [input, expected] of positiveCases) {
    assert.equal(projectString(input), expected, input);
  }

  const negativeCases = [
    '/home-project/readme',
    '/HOME_backup/readme',
    '/home.txt',
    '/run-book',
    '/runtime',
    '/optical',
    '/HOME-PROJECT/README',
    '/HOME_BACKUP/README',
    '/HOME.TXT',
    '/RUN-BOOK',
    '/RUNTIME',
    '/OPTICAL',
    '/home+project/readme',
    '/run@book',
    '/opt:ical',
    'file:/home-project/readme',
    'file:/home_backup/readme',
    'file:/home.txt',
    'file:/run-book',
    '/project/readme',
    '/public/assets',
    '/docs/guide',
    'prefix/home/alice',
    'word/custom/.env',
    '[/home-project/readme]',
    '{/home_backup/readme}',
    '|/runtime/report.txt',
    ';/optical/manual.txt',
  ];
  for (const input of negativeCases) assert.equal(projectString(input), input);

  const nested = toPublicGoalEventPayload({
    message: '[/home]',
    nested: {
      source: [
        '{/RUN/controller.sock}',
        { value: ';/home/alice' },
        '[file:///%68ome/alice]',
      ],
    },
  });
  assert.deepEqual(nested, {
    message: `[${REDACTED}]`,
    nested: {
      source: [
        `{${REDACTED}}`,
        { value: `;${REDACTED}` },
        `[${REDACTED}]`,
      ],
    },
  });
});

test('credential paths use wrapper boundaries without matching public continuations', () => {
  const positiveCases = [
    ['[/custom/.env]', `[${REDACTED}]`],
    ['{/CUSTOM/.NPMRC}', `{${REDACTED}}`],
    ['|/custom/.ssh/id_rsa', `|${REDACTED}`],
    [';/custom/.netrc', `;${REDACTED}`],
    ['[file:///custom/%2Eenv]', `[${REDACTED}]`],
    ['{FILE:///custom/%2Enpmrc}', `{${REDACTED}}`],
    ['file:///project|/run/controller.sock', REDACTED],
  ] as const;
  for (const [input, expected] of positiveCases) {
    assert.equal(projectString(input), expected, input);
  }

  const negativeCases = [
    '/custom/.env.example',
    '/CUSTOM/.ENV.EXAMPLE',
    '/custom/.npmrc.bak',
    '/CUSTOM/.NPMRC.BAK',
    'prefix/custom/.env',
    'word/custom/.npmrc',
    '[/custom/.env.example]',
    '{/custom/.npmrc.bak}',
    '|/custom/.environment',
    ';/custom/.npmrc-backup',
    'file:///custom/.env.example',
    'file:///custom/.npmrc.bak',
    'file:///project|/runtime/report.txt',
    'file:///project|/optical/manual.txt',
  ];
  for (const input of negativeCases) assert.equal(projectString(input), input);

  const nested = toPublicGoalEventPayload({
    paths: [
      '[/custom/.env]',
      { target: '{/CUSTOM/.NPMRC}' },
      '[file:///custom/%2Eenv]',
    ],
    nested: {
      value: ['|/run/controller.sock', { source: ';/custom/.ssh/id_rsa' }],
    },
  });
  assert.deepEqual(nested, {
    paths: [
      `[${REDACTED}]`,
      { target: `{${REDACTED}}` },
      `[${REDACTED}]`,
    ],
    nested: {
      value: [`|${REDACTED}`, { source: `;${REDACTED}` }],
    },
  });
});

test('raw path boundary matching remains safe across public string cutoffs', () => {
  const perStringPrefix = `${'p'.repeat(16_329)} |`;
  const perStringInput = `${perStringPrefix}/RUN/${'x'.repeat(600)}`;
  const perStringProjected = projectString(perStringInput);
  assert.ok(Buffer.byteLength(perStringProjected, 'utf8') <= 16_384);
  assert.equal(perStringProjected.includes('/RUN/'), false);
  assert.equal(perStringProjected.includes(REDACTED), true);

  const safePerString = [
    'p'.repeat(16_330),
    '/home-project/readme',
    '/custom/.env.example',
    'x'.repeat(600),
  ].join(' ');
  const safePerStringProjected = projectString(safePerString);
  assert.ok(Buffer.byteLength(safePerStringProjected, 'utf8') <= 16_384);
  assert.equal(safePerStringProjected.includes('/home-project/readme'), true);
  assert.equal(safePerStringProjected.includes('/custom/.env.example'), true);
  assert.equal(safePerStringProjected.includes(REDACTED), false);

  const aggregatePrefixBytes = 65_536 - 70;
  const aggregatePayload = {
    status: 'a'.repeat(16_384),
    eventName: 'b'.repeat(16_384),
    repositoryOwner: 'c'.repeat(16_384),
    requestedModel: 'd'.repeat(aggregatePrefixBytes - (16_384 * 3)),
    nested: {
      value: `[/custom/.env/${'x'.repeat(600)}]`,
    },
  };
  const aggregateProjected = toPublicGoalEventPayload(aggregatePayload) as {
    nested: { value: string };
  };
  assert.ok(Buffer.byteLength(aggregateProjected.nested.value, 'utf8') <= 70);
  assert.equal(aggregateProjected.nested.value.includes('/custom/.env'), false);
  assert.equal(aggregateProjected.nested.value.includes(REDACTED), true);

  const safeAggregateProjected = toPublicGoalEventPayload({
    ...aggregatePayload,
    nested: { value: '/home_backup/readme /custom/.npmrc.bak ordinary' },
  }) as { nested: { value: string } };
  assert.equal(safeAggregateProjected.nested.value.includes('/home_backup/readme'), true);
  assert.equal(safeAggregateProjected.nested.value.includes('/custom/.npmrc.bak'), true);
  assert.equal(safeAggregateProjected.nested.value.includes(REDACTED), false);
});
