import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { after, test } from 'node:test';
import { closeConnection } from '@propr/core';
import { toPublicGoalEventPayload } from '../routes/goalRouteDtos.js';
import { MAX_PERCENT_DECODE_PASSES } from '../routes/goalRoutePublicStringDecoder.js';
import { redactPublicPathTokens } from '../routes/goalRoutePublicStringSanitizer.js';

const DECODE_BUDGET = MAX_PERCENT_DECODE_PASSES;
const REDACTED = '[REDACTED_SENSITIVE_PATH]';

after(async () => {
  await closeConnection();
});

function projectString(value: string): string {
  return (toPublicGoalEventPayload({ message: value }) as { message: string }).message;
}

function encodeAllAscii(value: string): string {
  return [...Buffer.from(value, 'utf8')]
    .map((byte) => `%${byte.toString(16).padStart(2, '0')}`)
    .join('');
}

function recursivelyEncodeAllAscii(value: string, depth: number): string {
  while (depth-- > 0) value = encodeAllAscii(value);
  return value;
}

function recursiveAsciiCases(value: string): string[] {
  return [1, 2, 3].flatMap((asciiDepth) => (
    [DECODE_BUDGET - 1, DECODE_BUDGET, DECODE_BUDGET + 1].map((percentDepth) => (
      addPercentLayers(recursivelyEncodeAllAscii(value, asciiDepth), percentDepth)
    ))
  ));
}

function encodeStructural(value: string): string {
  return value.replace(/[:/\\?#.]/gu, (character) => (
    `%${character.codePointAt(0)!.toString(16).toUpperCase()}`
  ));
}

function alternateSeparators(value: string): string {
  let separator = 0;
  return value.replace(/[\\/]/gu, (character) => {
    separator += 1;
    if (separator % 3 === 1) return character;
    return separator % 3 === 2 ? '%2f' : '%5C';
  });
}

function addPercentLayers(value: string, depth: number): string {
  while (depth-- > 0) value = value.replaceAll('%', '%25');
  return value;
}

function encodingModes(value: string): string[] {
  return [
    value,
    encodeAllAscii(value),
    encodeStructural(value),
    value.replace(/^file/iu, 'f%69le'),
    alternateSeparators(value),
    value.replace(/^file/iu, 'FiLe').replaceAll('%2F', '%2f'),
  ];
}

function assertProjectedEverywhere(candidate: string, expected = REDACTED): void {
  assert.deepEqual(toPublicGoalEventPayload({
    message: candidate,
    source: [candidate, { value: { target: [candidate] } }],
  }), {
    message: expected,
    source: [expected, { value: { target: [expected] } }],
  }, candidate);
}

function decodePass(value: string): string {
  return value.replace(/%([0-9a-f]{2})/giu, (_match, octet: string) => (
    String.fromCharCode(Number.parseInt(octet, 16))
  ));
}

function decodeThroughOracleBudget(value: string): string {
  for (let pass = 0; pass <= DECODE_BUDGET; pass += 1) value = decodePass(value);
  return value.replace(/\\/gu, '/').toLowerCase();
}

function assertOracleClean(projected: string, label: string): void {
  const decoded = decodeThroughOracleBudget(projected);
  const sensitiveSurvivor = [
    /file:\/{1,3}(?:localhost\/)?(?:home|root|run|users|[a-z][:|]\/)/u,
    /\/(?:home|root|run)\//u,
    /[a-z][:|]\/(?:users|windows)\//u,
    /\/server\/share\/(?:\.ssh|\.env(?:\/|$)|credentials?\/)/u,
    /\/(?:custom\/)?(?:\.ssh|\.env|credentials?)\//u,
  ].some((pattern) => pattern.test(decoded));
  assert.equal(sensitiveSurvivor, false, label);
}

test('encoded file schemes classify before generic URI exemptions at every bounded depth', () => {
  const seeds = [
    'file:///home/alice/.ssh/id_rsa',
    'file://localhost/run/secrets/token',
    'file:///C:/Users/alice/private.txt',
  ];
  const depths = [0, 1, 2, DECODE_BUDGET - 1, DECODE_BUDGET, DECODE_BUDGET + 1];
  const positives = new Set(seeds.flatMap((seed) => encodingModes(seed)
    .flatMap((mode) => depths.map((depth) => addPercentLayers(mode, depth)))));
  for (const exactAlias of [
    'file%3A///home/alice/.ssh/id_rsa',
    '%66ile:///home/alice/.ssh/id_rsa',
    'f%69le:///home/alice/.ssh/id_rsa',
    '%2566ile%253A%252F%252F%252Fhome%252Falice%252F.ssh%252Fid_rsa',
  ]) positives.add(exactAlias);

  for (const candidate of positives) {
    assertProjectedEverywhere(candidate);
    assertOracleClean(projectString(candidate), candidate);
  }

  for (const safe of encodingModes('file:///project/public/docs/readme.txt')
    .flatMap((mode) => depths.map((depth) => addPercentLayers(mode, depth)))) {
    assert.equal(projectString(safe), safe, safe);
  }
  for (const safe of [
    'https://example.test/profile/home/alice/.ssh/id_rsa',
    'profile:///home/alice/.ssh/id_rsa',
    'ordinary %66ile prose',
    'ordinary f%69le handling prose',
  ]) assert.equal(projectString(safe), safe, safe);
});

test('direct UNC credential segments redact for both separator styles and traversal states', () => {
  const credentialSegments = [
    '.aws', '.azure', '.config', '.docker', '.env', '.env.production',
    '.git-credentials', '.gnupg', '.kube', '.netrc', '.npmrc', '.ssh',
    'config', 'configs', 'configuration', 'credential', 'credentials',
    'docker.sock', 'secret', 'secrets', 'workspace', 'workspaces',
    'worktree', 'worktrees',
  ];
  for (const segment of credentialSegments) {
    for (const separator of ['/', '\\']) {
      for (const traversal of ['', `folder${separator}..${separator}`]) {
        const raw = `${separator}${separator}server${separator}share${separator}${
          traversal}${segment}${separator}value`;
        for (const candidate of [raw, encodeStructural(raw), alternateSeparators(raw)]) {
          assertProjectedEverywhere(candidate);
          assertOracleClean(projectString(candidate), candidate);
        }
      }
    }
  }

  const safeSegments = [
    'public/docs/readme', '.env.example', '.npmrc.bak', '.environment',
    'secretary', 'credentials-guide',
  ];
  for (const segment of safeSegments) {
    for (const candidate of [
      `//server/share/${segment}`,
      String.raw`\\server\share\${segment.replaceAll('/', '\\')}`,
      `//server/share/folder/../${segment}`,
    ]) assert.equal(projectString(candidate), candidate, candidate);
  }
});

test('decoded structural, control, and malformed prefixes expose later sensitive roots only', () => {
  const cases = [
    ['/docs?/home/alice/private', '/docs?', '/home/alice/private'],
    ['/docs%3F/home/alice/private', '/docs%3F', '/home/alice/private'],
    ['/docs#/root/private', '/docs#', '/root/private'],
    ['/docs%23/root/private', '/docs%23', '/root/private'],
    ['\0/home/alice/private', '\0', '/home/alice/private'],
    ['%00/home/alice/private', '%00', '/home/alice/private'],
    ['\x7f/root/private', '\x7f', '/root/private'],
    ['%7F/root/private', '%7F', '/root/private'],
    ['%2G/home/alice/private', '%2G', '/home/alice/private'],
    ['%/run/secrets', '%', '/run/secrets'],
    [String.raw`%2GC:\Users\alice\private`, '%2G', String.raw`C:\Users\alice\private`],
    ['%2G/custom/.ssh/id_rsa', '%2G', '/custom/.ssh/id_rsa'],
  ] as const;
  for (const [candidate, prefix] of cases) {
    const expected = `${prefix}${REDACTED}`;
    assertProjectedEverywhere(candidate, expected);
    assertOracleClean(expected, candidate);
  }

  const structuralPrefixes = [
    '/docs?', '/docs%3F', '/docs#', '/docs%23', '\0', '%00', '\x7f', '%7F',
    '%2G', '%',
  ];
  const sensitiveRoots = [
    '/home/alice/private',
    String.raw`C:\Users\alice\private`,
    '/custom/.ssh/id_rsa',
  ];
  for (const prefix of structuralPrefixes) {
    for (const root of sensitiveRoots) {
      const candidate = `${prefix}${root}`;
      const expected = `${prefix}${REDACTED}`;
      assertProjectedEverywhere(candidate, expected);
      assertOracleClean(expected, candidate);
    }
  }

  for (const prefixSeed of ['%3F', '%23', '%00', '%7F', '%2G', '%']) {
    for (const depth of [0, 1, 2, DECODE_BUDGET - 1, DECODE_BUDGET,
      DECODE_BUDGET + 1]) {
      const prefix = addPercentLayers(prefixSeed, depth);
      const candidate = `${prefix}/home/alice/private`;
      const expected = `${prefix}${REDACTED}`;
      assertProjectedEverywhere(candidate, expected);
      assertOracleClean(expected, candidate);
    }
  }

  const safeRoots = ['/docs/readme', '/public/readme', String.raw`\Public\readme`];
  const prefixes = ['?', '%3F', '#', '%23', '\0', '%00', '\x7f', '%7F', '%2G', '%'];
  for (const prefix of prefixes) {
    for (const root of safeRoots) {
      const candidate = `${prefix}${root}`;
      assert.equal(projectString(candidate), candidate, candidate);
    }
  }
  for (const prose of [
    'ordinary malformed prose %2G without a path',
    'ordinary control prose\0without a path',
    'ordinary delete prose\x7fwithout a path',
  ]) assert.equal(projectString(prose), prose, prose);
});

test('recursive all-ASCII properties remain closed across the terminal decode boundary', () => {
  const fileUris = [
    'file:/home',
    'file:///home/.ssh/id',
    'file://localhost/run/secrets/token',
    'file:///C:/Users/alice/private.txt',
  ];
  for (const fileUri of fileUris) {
    for (const candidate of recursiveAsciiCases(fileUri)) {
      assertProjectedEverywhere(candidate);
    }
  }

  const prefixedRoots = [
    ['?', '/home/alice'],
    ['#', '/run/secrets'],
    ['\0', '/home/alice'],
    ['\x7f', '/root/private'],
    ['%2G', '/home/alice'],
  ] as const;
  for (const [prefix, root] of prefixedRoots) {
    for (const asciiDepth of [1, 2, 3]) {
      for (const percentDepth of [
        DECODE_BUDGET - 1,
        DECODE_BUDGET,
        DECODE_BUDGET + 1,
      ]) {
        const encode = (value: string): string => addPercentLayers(
          recursivelyEncodeAllAscii(value, asciiDepth),
          percentDepth
        );
        assertProjectedEverywhere(`${encode(prefix)}${encode(root)}`, `${encode(prefix)}${REDACTED}`);
      }
    }
  }

  const beyondSupportedGrammar = addPercentLayers(
    recursivelyEncodeAllAscii('file:/home', 4),
    DECODE_BUDGET
  );
  assert.equal(projectString(beyondSupportedGrammar), REDACTED);
});

test('recursive all-ASCII spans preserve punctuation, cutoffs, and input identity', () => {
  const encode = (value: string): string => addPercentLayers(
    recursivelyEncodeAllAscii(value, 3),
    DECODE_BUDGET
  );
  const file = encode('file:/home');
  const queryPrefix = encode('?');
  const queryPath = encode('/home/alice');
  const malformedPrefix = encode('%2G');
  const malformedPath = encode('/run/secrets');
  const wrapped = `before [${file}], {${queryPrefix}${queryPath}}; (`
    + `${malformedPrefix}${malformedPath}) after`;
  assert.equal(projectString(wrapped), `before [${REDACTED}], {${queryPrefix}${REDACTED}}; (`
    + `${malformedPrefix}${REDACTED}) after`);

  const payload = {
    message: file,
    source: [queryPrefix + queryPath, {
      value: malformedPrefix + malformedPath,
      target: [file, queryPrefix + queryPath],
    }],
  };
  const snapshot = structuredClone(payload);
  assert.deepEqual(toPublicGoalEventPayload(payload), {
    message: REDACTED,
    source: [`${queryPrefix}${REDACTED}`, {
      value: `${malformedPrefix}${REDACTED}`,
      target: [REDACTED, `${queryPrefix}${REDACTED}`],
    }],
  });
  assert.deepEqual(payload, snapshot);

  const crossingCutoff = `${'p'.repeat(16_384 - file.length + 8)} ${file}`;
  const cutoffProjection = projectString(crossingCutoff);
  assert.equal(cutoffProjection.includes(REDACTED), true);
  assert.equal(cutoffProjection.includes(file), false);

  const aggregateProjection = toPublicGoalEventPayload({
    status: 'a'.repeat(16_384),
    eventName: 'b'.repeat(16_384),
    repositoryOwner: 'c'.repeat(16_384),
    requestedModel: 'd'.repeat(65_536 - (16_384 * 3) - file.length),
    nested: { value: file },
  }) as { nested: { value: string } };
  assert.equal(aggregateProjection.nested.value.includes(REDACTED), true);
  assert.equal(aggregateProjection.nested.value.includes(file), false);
});

test('safe recursive all-ASCII controls remain byte-identical', () => {
  const safeValues = [
    'file:/docs',
    'https://example.test/profile/home/alice/.ssh/id_rsa',
    'profile:///home/alice/.ssh/id_rsa',
    'ordinary prose about home, roots, and files',
    '//server/share/public/docs/readme.txt',
    String.raw`\\server\share\public\docs\readme.txt`,
    '//server/share/.env.example',
    '/home-project/readme',
    '/runtime/report',
    '/optical/manual',
    '/project/public/readme',
  ];
  for (const safe of safeValues) {
    for (const candidate of recursiveAsciiCases(safe)) {
      assert.equal(projectString(candidate), candidate, `${safe}: ${candidate.length}`);
    }
  }
});

test('raw-span redaction preserves wrappers, lists, cutoffs, nesting, and input identity', () => {
  const first = '%66ile:///home/alice/.ssh/id_rsa';
  const second = '//server/share/credentials/auth.json';
  const third = '/docs%3F/root/private';
  const wrapped = `before [${first}], {${second}}; (${third}) after`;
  assert.equal(projectString(wrapped),
    `before [${REDACTED}], {${REDACTED}}; (/docs%3F${REDACTED}) after`);

  const payload = {
    message: first,
    source: [second, { value: third, target: [first, second] }],
  };
  const snapshot = structuredClone(payload);
  toPublicGoalEventPayload(payload);
  assert.deepEqual(payload, snapshot);

  const circular: Record<string, unknown> = { message: first };
  circular.nested = { source: [circular, { value: second }] };
  assert.deepEqual(toPublicGoalEventPayload(circular), {
    message: REDACTED,
    nested: { source: ['[Circular]', { value: REDACTED }] },
  });

  const perString = `${'p'.repeat(16_350)} ${first}`;
  const perStringProjected = projectString(perString);
  assert.ok(Buffer.byteLength(perStringProjected, 'utf8') <= 16_384);
  assert.equal(perStringProjected.includes('file'), false);
  assert.equal(perStringProjected.includes(REDACTED), true);

  const aggregate = toPublicGoalEventPayload({
    status: 'a'.repeat(16_384),
    eventName: 'b'.repeat(16_384),
    repositoryOwner: 'c'.repeat(16_384),
    requestedModel: 'd'.repeat(16_320),
    nested: { value: second },
  }) as { nested: { value: string } };
  assert.ok(Buffer.byteLength(aggregate.nested.value, 'utf8') <= 64);
  assert.equal(aggregate.nested.value.includes('server'), false);
  assert.equal(aggregate.nested.value.includes(REDACTED), true);
});

test('shared mapped classification scales linearly through the public inspection window', () => {
  const elapsed: number[] = [];
  for (const bytes of [4_096, 8_192, 16_384]) {
    const candidate = `${'%25'.repeat(Math.floor((bytes - 32) / 3))}%2G/home/alice/private`;
    const startedAt = performance.now();
    const projected = redactPublicPathTokens(candidate, false);
    elapsed.push(performance.now() - startedAt);
    assert.equal(projected.endsWith(REDACTED), true, String(bytes));
    assertOracleClean(projected, String(bytes));
  }
  assert.ok(elapsed[2]! < Math.max(1_500, elapsed[0]! * 12), elapsed.join(', '));
});
