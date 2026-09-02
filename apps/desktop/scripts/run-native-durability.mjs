import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const expectedTestsFor = (relativePath) => {
  const source = readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8');
  const matches = [...source.matchAll(
    /^export const NATIVE_DURABILITY_EXPECTED_TESTS = ([1-9]\d*) as const;$/gm,
  )];
  if (matches.length !== 1) {
    throw new Error(`${relativePath} must export exactly one native durability expected-test contract`);
  }
  return Number(matches[0][1]);
};

const EXPECTED = Object.freeze({
  'credential-service': expectedTestsFor('src/credential-service.test.ts'),
  'profile-store': 39,
  'pairing-shutdown': 10,
});
const expectedTotal = Object.values(EXPECTED).reduce((total, count) => total + count, 0);
const tsxCli = fileURLToPath(import.meta.resolve('tsx/cli'));
const child = spawn(process.execPath, [
  tsxCli,
  '--test',
  '--test-concurrency=1',
  'src/profile-store.test.ts',
  'src/credential-service.test.ts',
  'src/pairing-response-lifecycle.test.ts',
], {
  cwd: fileURLToPath(new URL('..', import.meta.url)),
  env: process.env,
  stdio: ['inherit', 'pipe', 'pipe'],
});

let output = '';
const forward = (stream, destination) => {
  stream.setEncoding('utf8');
  stream.on('data', chunk => {
    output += chunk;
    destination.write(chunk);
  });
};
forward(child.stdout, process.stdout);
forward(child.stderr, process.stderr);

const result = await new Promise((resolve, reject) => {
  child.once('error', reject);
  // close fires only after both TAP pipes are drained; exit can race the final
  // summary on Windows and would make a complete run look like setup failure.
  child.once('close', (code, signal) => resolve({ code, signal }));
});

const plannedForSuite = (suiteName) => {
  const escaped = suiteName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = output.match(new RegExp(
    `# Subtest: ${escaped}[\\s\\S]*?\\n    1\\.\\.(\\d+)\\n(?:ok|not ok) \\d+ - ${escaped}`,
  ));
  return match ? Number(match[1]) : 0;
};

const executed = {
  'credential-service': plannedForSuite('main-process desktop credential service'),
  'profile-store': plannedForSuite('desktop profile store'),
  'pairing-shutdown': plannedForSuite('desktop pairing service IPC native shutdown lifecycle'),
};
const reportedCategory = (category) => {
  const match = output.match(new RegExp(
    `NATIVE_CATEGORY ${category} expected=(\\d+) executed=(\\d+)`,
  ));
  return match ? { expected: Number(match[1]), executed: Number(match[2]) } : { expected: -1, executed: -1 };
};
const countedCategory = (category, expected) => ({
  expected,
  executed: output.match(new RegExp(`NATIVE_SCENARIO ${category}`, 'g'))?.length ?? 0,
});
const pairingShutdownCategory = category => ({
  expected: 1,
  executed: output.match(new RegExp(`NATIVE_PAIRING_SHUTDOWN ${category}(?:\\r?\\n|$)`, 'g'))?.length ?? 0,
});
const scenarioCategories = {
  barriers: reportedCategory('barriers'),
  'transaction-boundaries': reportedCategory('transaction-boundaries'),
  'bootstrap-migration': reportedCategory('bootstrap-migration'),
  'verified-handle-swap': reportedCategory('verified-handle-swap'),
  'reordered-visibility': reportedCategory('reordered-visibility'),
  'mirror-repair': countedCategory('mirror-repair', 6),
  'revocation-crash': countedCategory('revocation-crash', 2),
  'cancellation-switch': countedCategory('cancellation-switch', 4),
  'detach-crash': countedCategory('detach-crash', process.platform === 'win32' ? 12 : 13),
  'transient-revocation': countedCategory('transient-revocation', 4),
  provisional: countedCategory('provisional', 1),
  delivery: countedCategory('delivery', 1),
  dispose: countedCategory('dispose', 1),
  'start-header': pairingShutdownCategory('start-header'),
  'start-body': pairingShutdownCategory('start-body'),
  'poll-header': pairingShutdownCategory('poll-header'),
  'poll-body': pairingShutdownCategory('poll-body'),
  'activate-header': pairingShutdownCategory('activate-header'),
  'activate-body': pairingShutdownCategory('activate-body'),
  'cancel-header': pairingShutdownCategory('cancel-header'),
  'cancel-body': pairingShutdownCategory('cancel-body'),
  'never-settling-reader-cancel': pairingShutdownCategory('never-settling-reader-cancel'),
  'never-settling-body-cancel': pairingShutdownCategory('never-settling-body-cancel'),
};
const summary = Object.fromEntries(
  ['tests', 'pass', 'fail', 'cancelled', 'skipped'].map(key => {
    const match = output.match(new RegExp(`^# ${key} (\\d+)$`, 'm'));
    return [key, match ? Number(match[1]) : -1];
  }),
);

for (const [category, expected] of Object.entries(EXPECTED)) {
  console.log(`Native durability category ${category}: expected=${expected} executed=${executed[category]}`);
}
for (const [category, counts] of Object.entries(scenarioCategories)) {
  console.log(`Native durability category ${category}: expected=${counts.expected} executed=${counts.executed}`);
}
console.log(
  `Native durability total: expected=${expectedTotal} executed=${summary.tests} `
  + `passed=${summary.pass} failed=${summary.fail} cancelled=${summary.cancelled} skipped=${summary.skipped}`,
);

const complete = Object.entries(EXPECTED).every(([category, expected]) => executed[category] === expected)
  && Object.values(scenarioCategories).every(({ expected, executed }) => expected >= 0 && executed === expected)
  && summary.tests === expectedTotal
  && summary.pass === expectedTotal
  && summary.fail === 0
  && summary.cancelled === 0
  && summary.skipped === 0
  && result.code === 0
  && result.signal === null;
if (!complete) {
  throw new Error(
    `Native durability matrix incomplete (child code=${String(result.code)}, signal=${String(result.signal)})`,
  );
}
