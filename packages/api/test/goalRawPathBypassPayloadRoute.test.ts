import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
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

function addPercentLayers(value: string, count: number): string {
  while (count-- > 0) value = value.replaceAll('%', '%25');
  return value;
}

test('raw traversal paths normalize rooted backslashes without consuming UNC syntax', () => {
  const positiveCases = [
    [String.raw`\Temp\..\Users\alice\private.txt`, REDACTED],
    [String.raw`[\Temp\..\Windows\System32\hosts]`, `[${REDACTED}]`],
    [String.raw`{\safe/../.ssh\id_rsa}`, `{${REDACTED}}`],
    ['%5CTemp%5C%2E%2E%5CUsers%5Calice%5Cprivate.txt', REDACTED],
    ['[%255CTemp%255C%252E%252E%255CWindows%255CSystem32%255Chosts]',
      `[${REDACTED}]`],
  ] as const;
  for (const [input, expected] of positiveCases) {
    assert.equal(projectString(input), expected, input);
  }

  const publicControls = [
    String.raw`\\server\share\..\Users\alice\private.txt`,
    '//server/share/../home/alice/private.txt',
    String.raw`\Temp\..\Public\readme.txt`,
    '%255CTemp%255C%252E%252E%255CPublic%255Creadme.txt',
  ];
  for (const input of publicControls) assert.equal(projectString(input), input);

  assert.deepEqual(toPublicGoalEventPayload({
    message: String.raw`[\Temp\..\Users\alice\private.txt]`,
    nested: { source: ['{%5Csafe%2F..%2F.ssh%5Cid_rsa}'] },
  }), {
    message: `[${REDACTED}]`,
    nested: { source: [`{${REDACTED}}`] },
  });
});

test('three-or-more leading slashes remain rooted POSIX paths, not URI authorities', () => {
  const positiveCases = [
    ['///project/../home/alice/private.txt', REDACTED],
    ['[////project/../root/.ssh/id_rsa]', `[${REDACTED}]`],
    [String.raw`{///project\..\home\alice\private.txt}`, `{${REDACTED}}`],
    ['%2F%2F%2Fproject%2F%2E%2E%2Fhome%2Falice%2Fprivate.txt', REDACTED],
    ['[%252F%252F%252Fproject%252F%252E%252E%252Froot%252Fprivate]',
      `[${REDACTED}]`],
  ] as const;
  for (const [input, expected] of positiveCases) {
    assert.equal(projectString(input), expected, input);
  }

  const publicControls = [
    '//server/share/../home/alice/private.txt',
    'https://example.test///project/../home/alice/private.txt',
    '///project/../docs/readme.txt',
    '////project/./../public/readme.txt',
  ];
  for (const input of publicControls) assert.equal(projectString(input), input);
});

test('residual percent nesting fails closed for raw path syntax', () => {
  const positiveCases = [
    ['%25252Fproject%25252F%25252E%25252E%25252Fhome%25252Fprivate.txt', REDACTED],
    ['[%25255CTemp%25255C%25252E%25252E%25255CUsers%25255Calice]',
      `[${REDACTED}]`],
    ['{%252543%25253A%25255CTemp%25255C%25252E%25252E%25255CWindows}',
      `{${REDACTED}}`],
    ['/project/%25252E%25252E/home/alice/private.txt', REDACTED],
    ['/project/%2G/../home/alice/private.txt', REDACTED],
    [String.raw`\Temp\%2G\..\Users\alice\private.txt`, REDACTED],
    ['/project/%2G/docs/readme.txt', REDACTED],
    [String.raw`\Temp\%\Public\readme.txt`, REDACTED],
  ] as const;
  for (const [input, expected] of positiveCases) {
    assert.equal(projectString(input), expected, input);
  }

  const publicControls = [
    'ordinary malformed encoding %2G and %',
    'https://example.test/%25252Fproject%25252Fguide',
  ];
  for (const input of publicControls) assert.equal(projectString(input), input);
});

test('residual encoded letters classify complete POSIX, Windows, and credential paths', () => {
  const positiveCases = [
    '/project/../%252568ome/alice/private',
    String.raw`C:\Temp\..\%252555sers\alice\private`,
    '/safe/../.s%252573h/id_rsa',
    '/project/../%2525252568ome/alice/private',
  ];
  for (const input of positiveCases) assert.equal(projectString(input), REDACTED, input);

  const publicControls = [
    'ordinary encoded prose %252568ello',
    'https://example.test/%252568ome/guide',
    '/project/../public/%252568ello',
  ];
  for (const input of publicControls) assert.equal(projectString(input), input);

  assert.deepEqual(toPublicGoalEventPayload({
    message: '/project/../%252568ome/alice/private',
    nested: {
      source: [String.raw`C:\Temp\..\%252555sers\alice\private`, {
        value: '/safe/../.s%252573h/id_rsa',
      }],
    },
  }), {
    message: REDACTED,
    nested: { source: [REDACTED, { value: REDACTED }] },
  });
});

test('percent-decoded openers and terminators preserve boundaries around whole redactions', () => {
  const cases = [
    ['%5B/project/../home/alice/private%5D', `%5B${REDACTED}%5D`],
    ['%20/project/../home/alice/private', `%20${REDACTED}`],
    ['%28C%3A%5CTemp%5C..%5CUsers%5Calice%29', `%28${REDACTED}%29`],
    ['[%2Fproject%2F..%2Fhome%5D', `[${REDACTED}%5D`],
    ['/project/../home%20next', `${REDACTED}%20next`],
    ['/project/../home%3Ftoken=x', `${REDACTED}%3Ftoken=x`],
    ['/project/../run%23fragment', `${REDACTED}%23fragment`],
    ['%255B%252Fproject%252F..%252Fhome%255D', `%255B${REDACTED}%255D`],
  ] as const;
  for (const [input, expected] of cases) assert.equal(projectString(input), expected, input);

  const publicControls = [
    '%5Bhttps%3A%2F%2Fexample.test%2Fproject%2F..%2Fhome%5D',
    'ordinary%20encoded%20prose%3Fpublic',
    '%28%2Fproject%2F..%2Fdocs%2Freadme%29',
  ];
  for (const input of publicControls) assert.equal(projectString(input), input);

  assert.deepEqual(toPublicGoalEventPayload({
    message: '%5B/project/../home/alice/private%5D',
    nested: { source: ['/project/../home%20next', {
      target: '%28C%3A%5CTemp%5C..%5CUsers%5Calice%29',
    }] },
  }), {
    message: `%5B${REDACTED}%5D`,
    nested: { source: [`${REDACTED}%20next`, { target: `%28${REDACTED}%29` }] },
  });
});

test('distributed percent octets use standard bounded decoding before classification', () => {
  const posix = '%25%32%46project%25%32%46%25%32%45%25%32%45%25%32%46home';
  const windows = '%25%35%43Temp%25%35%43%25%32%45%25%32%45%25%35%43Users'
    + '%25%35%43alice%25%35%43private';
  assert.equal(projectString(posix), REDACTED);
  assert.equal(projectString(windows), REDACTED);
  assert.deepEqual(toPublicGoalEventPayload({
    message: posix,
    nested: { value: [{ source: windows }] },
  }), {
    message: REDACTED,
    nested: { value: [{ source: REDACTED }] },
  });
});

test('distributed path openers beyond the decode-pass boundary cannot bypass discovery', () => {
  for (const layers of [7, 8, 32]) {
    const encodedPathOpener = addPercentLayers('%25%32%46', layers);
    const encodedBoundaryOpener = addPercentLayers('%25%35%42', layers);
    const path = `${encodedPathOpener}project/../home/alice/private`;
    const boundary = `${encodedBoundaryOpener}/project/../home/alice/private%5D`;

    assert.deepEqual(toPublicGoalEventPayload({ message: path, source: boundary }), {
      message: REDACTED,
      source: `${encodedBoundaryOpener}${REDACTED}%5D`,
    }, `outer layers: ${layers}`);
  }

  const deepPath = `${addPercentLayers('%25%32%46', 8)}project/../home/alice/private`;
  const deepBoundaryOpener = addPercentLayers('%25%35%42', 32);
  const deepBoundary = `${deepBoundaryOpener}/project/../home/alice/private%5D`;
  assert.deepEqual(toPublicGoalEventPayload({
    nested: {
      value: [{
        nested: {
          source: [{
            nested: { target: [deepPath, deepBoundary] },
          }],
        },
      }],
    },
  }), {
    nested: {
      value: [{
        nested: {
          source: [{
            nested: { target: [REDACTED, `${deepBoundaryOpener}${REDACTED}%5D`] },
          }],
        },
      }],
    },
  });
});

test('deep distributed percent classification stays bounded and linear', () => {
  const elapsed: number[] = [];
  for (const layers of [256, 512, 1_024, 2_048]) {
    const input = `${addPercentLayers('%25%32%46', layers)
    }project/../home/alice/private`;
    const startedAt = performance.now();
    assert.equal(projectString(input), REDACTED, `outer layers: ${layers}`);
    elapsed.push(performance.now() - startedAt);
  }
  assert.ok(elapsed[3]! < Math.max(500, elapsed[0]! * 16), elapsed.join(', '));
});

test('heterogeneous two-separator roots fail closed while safe authorities remain public', () => {
  const positiveCases = [
    String.raw`/\project/../home/alice/private`,
    String.raw`\/project\..\Users\alice`,
    '%2F%5Cproject%2F..%2Fhome/alice',
    '%5C%2Fproject%5C..%5CUsers%5Calice',
  ];
  for (const input of positiveCases) assert.equal(projectString(input), REDACTED, input);

  const publicControls = [
    '//server/share/folder/../public/readme.txt',
    String.raw`\\server\share\folder\..\public\readme.txt`,
    'https://example.test/project/../home/alice/private',
  ];
  for (const input of publicControls) assert.equal(projectString(input), input);

  assert.deepEqual(toPublicGoalEventPayload({
    paths: [positiveCases[0], { source: positiveCases[2] }],
    nested: { value: [publicControls[0]] },
  }), {
    paths: [REDACTED, { source: REDACTED }],
    nested: { value: [publicControls[0]] },
  });
});

test('control and malformed content fail closed only inside rooted path candidates', () => {
  const positiveCases = [
    '/project/../home%00/alice/private',
    '/safe/../.ssh%0Aid_rsa',
    String.raw`C:\Temp\..\Users%09alice\private`,
    '%2Fproject%2F..%2Fhome%7Fprivate',
    '/project/../home%',
    '/project/../home%0G/private',
    '/project/docs%2G/readme',
  ];
  for (const input of positiveCases) assert.equal(projectString(input), REDACTED, input);

  const publicControls = [
    'ordinary malformed prose %',
    'ordinary invalid hex %0G and %2Z',
    'ordinary control prose%00without a rooted candidate',
  ];
  for (const input of publicControls) assert.equal(projectString(input), input);

  assert.deepEqual(toPublicGoalEventPayload({
    message: positiveCases[0],
    nested: { source: [positiveCases[1], { target: positiveCases[2] }] },
  }), {
    message: REDACTED,
    nested: { source: [REDACTED, { target: REDACTED }] },
  });
});

test('long Windows-trimmed candidates redact wholly with bounded linear work', () => {
  const longCandidate = `C:\\${'d'.repeat(8_000)}\\..${' '.repeat(512)}${
    String.raw`\Users\alice\private.txt`
  }`;
  const startedAt = performance.now();
  assert.equal(projectString(longCandidate), REDACTED);
  assert.ok(performance.now() - startedAt < 2_000);

  const nested = toPublicGoalEventPayload({
    message: `[${longCandidate}]`,
    nested: { source: [{ value: longCandidate }] },
  });
  assert.deepEqual(nested, {
    message: `[${REDACTED}]`,
    nested: { source: [{ value: REDACTED }] },
  });

  const elapsed: number[] = [];
  for (const count of [1_000, 2_000, 4_000, 8_000]) {
    const input = `C:\\${'d'.repeat(count)}\\..${' '.repeat(128)}${
      String.raw`\Users\alice\private.txt`
    }`;
    const iterationStartedAt = performance.now();
    assert.equal(projectString(input), REDACTED);
    elapsed.push(performance.now() - iterationStartedAt);
  }
  assert.ok(elapsed[3]! < Math.max(500, elapsed[0]! * 16), elapsed.join(', '));
});

test('credential-bearing UNC traversal redacts without broadening safe UNC controls', () => {
  const positiveCases = [
    String.raw`\\server\share\folder\..\.ssh\id_rsa`,
    '//server/share/folder/../.env',
  ];
  for (const input of positiveCases) assert.equal(projectString(input), REDACTED, input);

  const publicControls = [
    String.raw`\\server\share\folder\..\public\readme.txt`,
    '//server/share/folder/../docs/readme.txt',
  ];
  for (const input of publicControls) assert.equal(projectString(input), input);

  assert.deepEqual(toPublicGoalEventPayload({
    message: positiveCases[0],
    nested: { paths: [{ source: positiveCases[1] }, publicControls[0]] },
  }), {
    message: REDACTED,
    nested: { paths: [{ source: REDACTED }, publicControls[0]] },
  });
});

test('Windows-trimmed dot segments participate in traversal normalization', () => {
  const positiveCases = [
    [String.raw`C:\Temp\.. \Users\alice\private.txt`, REDACTED],
    [String.raw`C:\Temp\..  \Users\alice\private.txt`, REDACTED],
    [String.raw`[\Temp\.. \Windows\System32\hosts]`, `[${REDACTED}]`],
    [String.raw`{D:/Temp/.. \Users\alice\private.txt}`, `{${REDACTED}}`],
    ['C:%5CTemp%5C..%20%5CUsers%5Calice%5Cprivate.txt', REDACTED],
    ['[C%253A%255CTemp%255C%252E%252E%2520%255CWindows%255CSystem32]',
      `[${REDACTED}]`],
  ] as const;
  for (const [input, expected] of positiveCases) {
    assert.equal(projectString(input), expected, input);
  }

  const publicControls = [
    String.raw`C:\Temp\.. \Public\readme.txt`,
    String.raw`\Temp\.. \Public\readme.txt`,
    'C:%5CTemp%5C..%20%5CPublic%5Creadme.txt',
    String.raw`C:\Temp\dot segment prose\Public\readme.txt`,
  ];
  for (const input of publicControls) assert.equal(projectString(input), input);
});

test('nested-percent and Windows-trimmed traversal scanning stays bounded', () => {
  const deepPercentPrefix = `%${'25'.repeat(7_500)}2F`;
  const input = `${deepPercentPrefix}project%2F..%2Fhome%2Fprivate.txt`;
  const startedAt = performance.now();
  assert.equal(projectString(input), REDACTED);
  assert.ok(performance.now() - startedAt < 2_000);

  const repeatedUnit = `${String.raw`Temp\.. `}\\`;
  const repeatedTrimmedSegments = `C:\\${repeatedUnit.repeat(500)}${
    String.raw`Users\alice\private.txt`
  }`;
  const repeatedStartedAt = performance.now();
  assert.equal(projectString(repeatedTrimmedSegments), REDACTED);
  assert.ok(performance.now() - repeatedStartedAt < 2_000);

  const longTrim = `${String.raw`C:\Temp\..`}${' '.repeat(8_000)}${
    String.raw`\Users\alice\private.txt`
  }`;
  const longTrimStartedAt = performance.now();
  assert.equal(projectString(longTrim), REDACTED);
  assert.ok(performance.now() - longTrimStartedAt < 2_000);
});
