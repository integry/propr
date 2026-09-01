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

test('raw traversal aliases normalize before sensitive path classification', () => {
  const positiveCases = [
    '/project/../home/node/private.txt',
    '/safe/./../root/.ssh/id_rsa',
    '/safe/one/../../../../run/secrets/token',
    '/././project/../../home/node/private.txt',
    '/project/%2e%2e/%68ome/node/private.txt',
    '/project%2f.%2e%5croot/.ssh/id_rsa',
    '/project/%252e%252e/%2572un/secrets/token',
    String.raw`C:\Temp\..\Users\alice\private.txt`,
    String.raw`c:Temp\.\..\Users\alice\private.txt`,
    String.raw`C:..\..\Users\alice\private.txt`,
    String.raw`D|Temp\..\..\Windows\System32\hosts`,
    String.raw`/H|../../Users/alice/private.txt`,
    String.raw`E:\..\..\ProgramData\private.txt`,
    'F%3ATemp%5C%2e%2E%2FUsers%5Calice%5Cprivate.txt',
    '/G|/Temp/../../Users/alice/private.txt',
  ];
  for (const input of positiveCases) assert.equal(projectString(input), REDACTED, input);
  assert.equal(projectString(`/project/${'x'.repeat(4_000)}/../../home/private.txt`), REDACTED);
});

test('raw traversal tokens preserve wrappers and list punctuation', () => {
  const cases = [
    ['[/project/../home/node/private.txt]', `[${REDACTED}]`],
    ['{/safe/../root/.ssh/id_rsa},next', `{${REDACTED}},next`],
    [String.raw`(C:\Temp\..\Users\alice\private.txt);next`, `(${REDACTED});next`],
    [String.raw`|D|Temp\..\Windows\System32|/public`, `|${REDACTED}|/public`],
    ['paths=/project/../run/controller.sock&next=public', `paths=${REDACTED}&next=public`],
  ] as const;
  for (const [input, expected] of cases) assert.equal(projectString(input), expected, input);

  assert.deepEqual(toPublicGoalEventPayload({
    message: '[/project/../home/node/private.txt]',
    paths: [{ source: String.raw`C:\Temp\..\Users\alice\private.txt` }],
    nested: { value: ['/safe/../root/.ssh/id_rsa', { target: '/x/../../run/token' }] },
  }), {
    message: `[${REDACTED}]`,
    paths: [{ source: REDACTED }],
    nested: { value: [REDACTED, { target: REDACTED }] },
  });
});

test('normalized safe destinations and non-path controls remain public', () => {
  const controls = [
    '/project/../home-project/readme',
    '/project/../runtime/readme',
    '/project/../optical/readme',
    String.raw`C:\Temp\..\UsersGuide\readme`,
    String.raw`C:\Temp\..\WindowsOld\readme`,
    String.raw`D|Temp\..\ProgramDataBackup\readme`,
    '/project/../custom/.env.example',
    'ordinary prose... with .. repeated dots',
    'https://example.test/project/../home/node/private.txt',
    'profile:///project/../home/node/private.txt',
    'prefix/project/../home/node/private.txt',
    String.raw`topicC|C:\Temp\..\Users\alice\private.txt`,
  ];
  for (const input of controls) assert.equal(projectString(input), input);
});

test('traversal aliases fail closed at per-string and aggregate cutoffs', () => {
  const traversal = `/project/${'x'.repeat(300)}/../../home/node/private.txt`;
  const perString = projectString(`${'p'.repeat(16_340)} ${traversal}`);
  assert.ok(Buffer.byteLength(perString, 'utf8') <= 16_384);
  assert.equal(perString.includes(REDACTED), true);
  assert.equal(perString.includes('/project/'), false);

  const aggregate = toPublicGoalEventPayload({
    status: 'a'.repeat(16_384),
    eventName: 'b'.repeat(16_384),
    repositoryOwner: 'c'.repeat(16_384),
    requestedModel: 'd'.repeat(16_320),
    nested: { value: traversal },
  }) as { nested: { value: string } };
  assert.ok(Buffer.byteLength(aggregate.nested.value, 'utf8') <= 64);
  assert.equal(aggregate.nested.value.includes(REDACTED), true);
  assert.equal(aggregate.nested.value.includes('/project/'), false);
});

test('raw traversal classification stays linear on adversarial values', () => {
  const elapsed: number[] = [];
  for (const size of [4_096, 8_192, 16_384]) {
    const input = `[/project/${'./../'.repeat(Math.ceil(size / 5))}home-project/readme]`;
    const started = performance.now();
    assert.equal(projectString(input).includes(REDACTED), false);
    elapsed.push(performance.now() - started);
  }
  assert.ok(elapsed[2]! < Math.max(250, elapsed[0]! * 12), elapsed.join(', '));
});
