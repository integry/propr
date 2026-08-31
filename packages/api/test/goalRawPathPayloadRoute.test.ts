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

test('raw socket, Docker TCP, and Windows values share structural boundaries', () => {
  const positiveCases = [
    ['[unix:///var/run/docker.sock]', `[${REDACTED}]`],
    ['{npipe:////./pipe/docker_engine}', `{${REDACTED}}`],
    ['(UNIX:///%76ar/%72un/docker.sock)', `(${REDACTED})`],
    ['|tcp://localhost:2375;', `|${REDACTED};`],
    [';tcp://127.0.0.1:2376/path', `;${REDACTED}`],
    ['{TCP://LOCALHOST:2375/%70rivate}', `{${REDACTED}}`],
    [String.raw`[C:\Users\alice\private.txt]`, `[${REDACTED}]`],
    [String.raw`{d:/WINDOWS/System32/drivers/etc/hosts}`, `{${REDACTED}}`],
    ['(E:%5CProgramData%5Cprivate%2Etxt)', `(${REDACTED})`],
  ] as const;
  for (const [input, expected] of positiveCases) {
    assert.equal(projectString(input), expected, input);
  }

  const punctuationCases = [
    ['unix:///var/run/docker.sock', 'unix:///var/run/docker.sock'],
    ['npipe:////./pipe/docker_engine', 'npipe:////./pipe/docker_engine'],
    ['tcp://localhost:2375/path', 'tcp://localhost:2375/path'],
    [String.raw`C:\Users\alice\private.txt`, String.raw`C:\Users\alice\private.txt`],
  ] as const;
  const terminators = [')', ']', '}', ',', ';', '|', '&', ' ', '"'] as const;
  for (const [value, label] of punctuationCases) {
    for (const terminator of terminators) {
      const input = `${value}${terminator}next`;
      assert.equal(projectString(input), `${REDACTED}${terminator}next`, `${label} ${terminator}`);
    }
  }

  const nested = toPublicGoalEventPayload({
    message: '[unix:///var/run/docker.sock]',
    paths: [
      { source: '{npipe:////./pipe/docker_engine}' },
      '|tcp://localhost:2375;',
    ],
    nested: {
      value: [
        ';tcp://127.0.0.1:2376/path',
        { target: String.raw`[C:\Users\alice\private.txt]` },
      ],
    },
  });
  assert.deepEqual(nested, {
    message: `[${REDACTED}]`,
    paths: [{ source: `{${REDACTED}}` }, `|${REDACTED};`],
    nested: {
      value: [`;${REDACTED}`, { target: `[${REDACTED}]` }],
    },
  });
});

test('bracketed IPv6 Docker TCP values redact with bounded structural boundaries', () => {
  const positiveCases = [
    ['tcp://[::1]:2375', REDACTED],
    ['[tcp://[::1]:2375]', `[${REDACTED}]`],
    ['tcp://[2001:db8::1]:2376/path', REDACTED],
    ['tcp://[fe80::1%25eth0]:2375', REDACTED],
    ['{TcP://[FE80::A%25ETH0]:2376/%70rivate}', `{${REDACTED}}`],
    ['|tcp://[2001:DB8::5]:2375;', `|${REDACTED};`],
  ] as const;
  for (const [input, expected] of positiveCases) {
    assert.equal(projectString(input), expected, input);
  }

  const terminators = [')', ']', '}', ',', ';', '|', '&', ' ', '"'] as const;
  for (const terminator of terminators) {
    const input = `tcp://[2001:db8::1]:2376/path${terminator}next`;
    assert.equal(projectString(input), `${REDACTED}${terminator}next`, terminator);
  }

  const nested = toPublicGoalEventPayload({
    message: '[tcp://[::1]:2375]',
    paths: [
      { source: '{TCP://[2001:DB8::1]:2376/%70ath}' },
      '|tcp://[fe80::1%25eth0]:2375;',
    ],
    nested: {
      value: [{ target: '(tcp://[::ffff:192.0.2.1]:2376/path)' }],
    },
  });
  assert.deepEqual(nested, {
    message: `[${REDACTED}]`,
    paths: [{ source: `{${REDACTED}}` }, `|${REDACTED};`],
    nested: { value: [{ target: `(${REDACTED})` }] },
  });
});

test('bracketed IPv6 Docker TCP values preserve ports, invalid text, and word boundaries', () => {
  const negativeCases = [
    'public tcp://[::1]:23750',
    'public tcp://[::1]:23751/path',
    'public tcp://[::1]:1234/path',
    'public tcp://[example.com]:2375',
    'public tcp://[12345::1]:2375',
    'public tcp://[:::]:2376',
    'public tcp://[::1:2375',
    'public [ordinary bracketed text]',
    'prefixtcp://[::1]:2375',
    'topicC|tcp://[::1]:2376/path',
  ];
  for (const input of negativeCases) assert.equal(projectString(input), input);
});

test('raw socket, Docker TCP, and Windows values preserve exact controls', () => {
  const negativeCases = [
    '[unix-guide]',
    'prefixunix:///var/run/docker.sock',
    'topicC|unix:///var/run/docker.sock',
    'public tcp://localhost:23750',
    'public tcp://localhost:23751/path',
    'public tcp://localhost:1234/path',
    'public tcp://localhost:2376guide',
    String.raw`C:\UsersGuide\readme.txt`,
    String.raw`C:\WindowsOld\readme.txt`,
    String.raw`C:\ProgramDataBackup\readme.txt`,
    String.raw`C:\workspaces-old\readme.txt`,
    String.raw`C:\worktrees_backup\readme.txt`,
    String.raw`topicC|C:\Users\alice\private.txt`,
    'topicC|/Users',
    'embedded public text about unix sockets and Docker TCP ports',
  ];
  for (const input of negativeCases) assert.equal(projectString(input), input);

  const longSensitiveValues = [
    `|unix:///var/run/${'s'.repeat(4_000)}]`,
    `;tcp://localhost:2376/${'t'.repeat(4_000)},next`,
    `${String.raw`[C:\Users\alice\private-`}${'w'.repeat(4_000)}]`,
  ];
  for (const input of longSensitiveValues) {
    const projected = projectString(input);
    assert.equal(projected.includes(REDACTED), true, input.slice(0, 80));
    assert.equal(projected.includes('s'.repeat(100)), false, input.slice(0, 80));
    assert.equal(projected.includes('t'.repeat(100)), false, input.slice(0, 80));
    assert.equal(projected.includes('w'.repeat(100)), false, input.slice(0, 80));
  }
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

test('raw socket, Docker TCP, and Windows values redact across public cutoffs', () => {
  const cases = [
    `|unix:///var/run/${'u'.repeat(600)}`,
    `;tcp://127.0.0.1:2376/${'t'.repeat(600)}`,
    `[tcp://[2001:db8::1]:2376/${'v'.repeat(600)}]`,
    `${String.raw`[C:\Users\alice\private-`}${'w'.repeat(600)}]`,
  ];
  for (const sensitiveValue of cases) {
    const projected = projectString(`${'p'.repeat(16_349)} ${sensitiveValue}`);
    assert.ok(Buffer.byteLength(projected, 'utf8') <= 16_384, sensitiveValue.slice(0, 40));
    assert.equal(projected.includes(REDACTED), true, sensitiveValue.slice(0, 40));
    assert.equal(projected.includes(sensitiveValue.slice(1, 24)), false, sensitiveValue.slice(0, 40));
  }
});
