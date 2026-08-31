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
  ] as const;
  for (const [input, expected] of positiveCases) {
    assert.equal(projectString(input), expected, input);
  }

  const publicControls = [
    '/project/%2G/docs/readme.txt',
    String.raw`\Temp\%\Public\readme.txt`,
    'ordinary malformed encoding %2G and %',
    'https://example.test/%25252Fproject%25252Fguide',
  ];
  for (const input of publicControls) assert.equal(projectString(input), input);
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
