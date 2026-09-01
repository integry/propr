import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { closeConnection } from '@propr/core';
import { toPublicGoalEventPayload } from '../routes/goalRouteDtos.js';
import { MAX_PERCENT_DECODE_PASSES } from '../routes/goalRoutePublicStringDecoder.js';

const REDACTED = '[REDACTED_SENSITIVE_PATH]';
const POSIX_ROOTS = [
  'app', 'build', 'builds', 'data', 'etc', 'github', 'home', 'mnt', 'opt',
  'private', 'root', 'run', 'srv', 'tmp', 'users', 'var', 'workspace',
  'workspaces', 'worktree', 'worktrees',
];

after(async () => {
  await closeConnection();
});

function projectString(value: string): string {
  return (toPublicGoalEventPayload({ message: value }) as { message: string }).message;
}

function addPercentLayers(value: string, depth: number): string {
  while (depth-- > 0) value = value.replaceAll('%', '%25');
  return value;
}

function encodeAllAscii(value: string): string {
  return [...Buffer.from(value, 'utf8')]
    .map((byte) => `%${byte.toString(16).padStart(2, '0')}`)
    .join('');
}

function assertProjectedEverywhere(candidate: string, expected: string): void {
  assert.deepEqual(toPublicGoalEventPayload({
    message: candidate,
    source: [candidate, { value: { target: [candidate] } }],
  }), {
    message: expected,
    source: [expected, { value: { target: [expected] } }],
  }, candidate);
}

test('single-backslash POSIX roots redact across boundaries and recursive depths', () => {
  const boundaries = ['?', '#', '\0', '%2G'];
  for (const root of POSIX_ROOTS) {
    const mixedPath = `\\${root}/private\\value`;
    const encodedPath = `%5C${root}%2Fprivate\\value`;
    const spellings = [
      `\\${root}`,
      `%5C${root}`,
      mixedPath,
      encodedPath,
      addPercentLayers(encodedPath, 1),
      encodeAllAscii(mixedPath),
    ];
    for (const boundary of boundaries) {
      for (const spelling of spellings) {
        assertProjectedEverywhere(`${boundary}${spelling}`, `${boundary}${REDACTED}`);
      }
      for (const outerDepth of [
        MAX_PERCENT_DECODE_PASSES - 1,
        MAX_PERCENT_DECODE_PASSES,
        MAX_PERCENT_DECODE_PASSES + 1,
      ]) {
        const deep = addPercentLayers(encodedPath, outerDepth);
        assertProjectedEverywhere(`${boundary}${deep}`, `${boundary}${REDACTED}`);
      }
    }
  }
});

test('single-backslash aliases redact in every public field without mutation', () => {
  const seam = '?%5Chome%2Falice/private';
  const publicFields = [
    'auditTrail', 'count', 'current', 'eventLabel', 'eventName', 'repositoryOwner',
    'requestedModel', 'requestedAt', 'pullRequestNumber', 'prNumber', 'filePath',
    'index', 'label', 'line', 'message', 'name', 'nested', 'note', 'pathDescription',
    'paths', 'progress', 'relativeCopy', 'relativePath', 'safeArray', 'safeSource',
    'sensitiveCopy', 'setting', 'socketDescription', 'source', 'status', 'target',
    'total', 'value',
  ];
  const payload = Object.fromEntries(publicFields.map((field) => [field, seam]));
  const snapshot = structuredClone(payload);
  assert.deepEqual(toPublicGoalEventPayload(payload),
    Object.fromEntries(publicFields.map((field) => [field, `?${REDACTED}`])));
  assert.deepEqual(payload, snapshot);

  const nested = {
    message: seam,
    nested: {
      source: ['#%5Croot%2Fprivate', { value: '%00%5Cetc%2Fprivate' }],
    },
  };
  const nestedSnapshot = structuredClone(nested);
  assert.deepEqual(toPublicGoalEventPayload(nested), {
    message: `?${REDACTED}`,
    nested: {
      source: [`#${REDACTED}`, { value: `%00${REDACTED}` }],
    },
  });
  assert.deepEqual(nested, nestedSnapshot);
});

test('single-backslash aliases preserve wrappers and redact across cutoffs', () => {
  const wrapped = 'before [?%5Chome%2Falice], {#%5Croot%2Fprivate}; '
    + '(%2G%5Crun%2Fsecrets) after';
  assert.equal(projectString(wrapped), `before [?${REDACTED}], {#${REDACTED}}; (`
    + `%2G${REDACTED}) after`);

  const cutoffSeam = `?%5Chome%2F${'x'.repeat(600)}`;
  const cutoffProjection = projectString(`${'p'.repeat(16_350)} ${cutoffSeam}`);
  assert.equal(cutoffProjection.includes(REDACTED), true);
  assert.equal(cutoffProjection.includes('%5Chome'), false);
});

test('single-backslash root classification preserves safe path controls byte-for-byte', () => {
  const safeControls = [
    String.raw`\\server\share\public`,
    String.raw`\Temp\..\Public`,
    String.raw`C:\Temp\..\Public`,
    String.raw`C:\Projects\public\readme.txt`,
    'file:///project/public/readme.txt',
    'https://example.test/profile/home/alice/private',
    'profile:///home/alice/private',
    'ordinary prose about home, root, run, etc, tmp, var, and opt',
    String.raw`\home-project\readme`,
    String.raw`\runtime\report`,
    String.raw`\optical\manual`,
    String.raw`\UsersGuide\readme`,
  ];
  for (const safe of safeControls) assert.equal(projectString(safe), safe, safe);
});
