import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

// Exercise the real runner with controlled child output, without rerunning the
// native crash fixtures for each malformed/incomplete TAP result.
const harness = `
  import assert from 'node:assert/strict';
  import childProcess from 'node:child_process';
  import { EventEmitter } from 'node:events';
  import { syncBuiltinESMExports } from 'node:module';
  import { PassThrough } from 'node:stream';
  const fixture = JSON.parse(process.argv[1]);
  childProcess.spawn = (executable, args) => {
    assert.equal(executable, process.execPath);
    assert.deepEqual(args.slice(1), [
      '--test', '--test-concurrency=1',
      'src/profile-store.test.ts', 'src/profile-store.crash-recovery.test.ts',
      'src/credential-service.test.ts',
      'src/pairing-response-lifecycle.test.ts',
      'src/credential-service.pairing-browser.test.ts',
    ]);
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    setImmediate(() => {
      // The summary can arrive after exit; only close guarantees drained pipes.
      child.emit('exit', fixture.code, fixture.signal);
      child.stdout.end(fixture.output);
      child.stderr.end();
      child.emit('close', fixture.code, fixture.signal);
    });
    return child;
  };
  syncBuiltinESMExports();
  await import(${JSON.stringify(new URL('./run-native-durability.mjs', import.meta.url).href)});
`;

const suiteCounts = [
  ['main-process desktop credential service', 87],
  ['desktop profile store', 33],
  ['desktop profile store crash recovery', 4],
  ['desktop pairing service IPC native shutdown lifecycle', 10],
  ['DesktopCredentialService pairing browser sink', 7],
];
const completeOutput = [
  ...suiteCounts.map(([name, count], index) => (
    `# Subtest: ${name}\n    1..${count}\nok ${index + 1} - ${name}`
  )),
  ...[
    'barriers', 'transaction-boundaries', 'bootstrap-migration',
    'verified-handle-swap', 'reordered-visibility',
  ].map(category => `NATIVE_CATEGORY ${category} expected=1 executed=1`),
  ...Object.entries({
    'mirror-repair': 6,
    'revocation-crash': 2,
    'cancellation-switch': 4,
    'detach-crash': process.platform === 'win32' ? 12 : 13,
    'transient-revocation': 4,
    provisional: 1,
    delivery: 1,
    dispose: 1,
  }).flatMap(([category, count]) => Array(count).fill(`NATIVE_SCENARIO ${category}`)),
  ...[
    'start-header', 'start-body', 'poll-header', 'poll-body',
    'activate-header', 'activate-body', 'cancel-header', 'cancel-body',
    'never-settling-reader-cancel', 'never-settling-body-cancel',
  ].map(category => `NATIVE_PAIRING_SHUTDOWN ${category}`),
  '# tests 141', '# pass 141', '# fail 0', '# cancelled 0', '# skipped 0', '',
].join('\n');

const run = ({ output = completeOutput, code = 0, signal = null } = {}) => spawnSync(
  process.execPath,
  ['--input-type=module', '--eval', harness, JSON.stringify({ output, code, signal })],
  { encoding: 'utf8', timeout: 10_000 },
);

test('accepts the exact 141-test inventory after both child pipes drain', () => {
  const result = run();
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /credential-service: expected=87 executed=87/);
  assert.match(result.stdout,
    /Native durability total: expected=141 executed=141 passed=141 failed=0 cancelled=0 skipped=0/);
});

for (const [name, from, to] of [
  ['stale credential inventory', '1..87', '1..86'],
  ['extra credential test', '1..87', '1..88'],
  ['wrong suite distribution', '1..33', '1..32'],
  ['wrong profile store split', '1..4\nok 3', '1..3\nok 3'],
  ['missing executed test', '# tests 141', '# tests 140'],
  ['extra executed test', '# tests 141', '# tests 142'],
  ['missing passing test', '# pass 141', '# pass 140'],
  ['extra passing test', '# pass 141', '# pass 142'],
  ['failed test', '# fail 0', '# fail 1'],
  ['cancelled test', '# cancelled 0', '# cancelled 1'],
  ['skipped test', '# skipped 0', '# skipped 1'],
  ['missing summary', '# skipped 0', ''],
  ['missing scenario', 'NATIVE_SCENARIO delivery\n', ''],
  ['extra scenario', 'NATIVE_SCENARIO delivery\n', 'NATIVE_SCENARIO delivery\nNATIVE_SCENARIO delivery\n'],
  ['incomplete reported category', 'barriers expected=1 executed=1', 'barriers expected=1 executed=0'],
  ['missing shutdown scenario', 'NATIVE_PAIRING_SHUTDOWN start-header\n', ''],
]) {
  test(`rejects ${name} despite a successful child exit`, () => {
    const result = run({ output: completeOutput.replace(from, to) });
    assert.ifError(result.error);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /Native durability matrix incomplete/);
  });
}

for (const termination of [{ code: 1 }, { code: null, signal: 'SIGTERM' }]) {
  test(`rejects incomplete child termination ${JSON.stringify(termination)} despite complete TAP`, () => {
    const result = run(termination);
    assert.ifError(result.error);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /Native durability matrix incomplete/);
  });
}
