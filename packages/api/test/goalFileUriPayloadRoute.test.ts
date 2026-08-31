import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { closeConnection } from '@propr/core';
import { toPublicGoalEventPayload } from '../routes/goalRouteDtos.js';

const REDACTED = '[REDACTED_SENSITIVE_PATH]';
const PUBLIC_STRING_FIELDS = [
  'auditTrail', 'count', 'current', 'eventLabel', 'eventName', 'repositoryOwner',
  'requestedModel', 'requestedAt', 'pullRequestNumber', 'prNumber', 'filePath',
  'index', 'label', 'line', 'message', 'name', 'nested', 'note',
  'pathDescription', 'paths', 'progress', 'relativeCopy', 'relativePath',
  'safeArray', 'safeSource', 'sensitiveCopy', 'setting', 'socketDescription',
  'source', 'status', 'target', 'total', 'value',
] as const;

after(async () => {
  await closeConnection();
});

function projectString(value: string): string {
  return (toPublicGoalEventPayload({ message: value }) as { message: string }).message;
}

function assertFullyRedacted(candidate: string): void {
  const projected = projectString(candidate);
  assert.equal(projected, REDACTED, candidate);
  assert.equal(projected.includes(candidate), false, candidate);
}

test('file URI parser redacts the exact F15 probes as whole tokens', () => {
  const probes = [
    'file://localhost/home/propr/.ssh/id_rsa',
    'FiLe://LOCALHOST/run/secrets/token',
    'file:///%72un/%73ecrets/token',
    'file:///custom/team/%2Essh/id_rsa',
    'file:///C:%5CUsers%5Cpropr%5C.ssh%5Cid_rsa',
    'file:////home/propr/.ssh/id_rsa',
    'file:///home%2Fpropr%2F.ssh%2Fid_rsa',
    'file:///C|/Users/alice/Desktop/readme.txt',
    String.raw`file:///C|\Users\alice\Desktop\readme.txt`,
    'file:///C|/Windows/System32/drivers/etc/hosts',
    'file:///project/readme?next=C|/Users/alice/Desktop/readme.txt',
    String.raw`file:///project/readme#next=C|\Users\alice\Desktop\readme.txt`,
  ];

  for (const probe of probes) assertFullyRedacted(probe);
  const projected = projectString(`before ${probes[0]} after`);
  assert.equal(projected, `before ${REDACTED} after`);
});

test('file URI parser fails closed for encoded, malformed, ambiguous, and nonlocal forms', () => {
  const unsafeCandidates = [
    'file:///%68%6f%6d%65/%70%72%6f%70%72/%2e%73%73%68/%69%64%5f%72%73%61',
    'file:///%2e%2e/%72%75%6e/%73%65%63%72%65%74%73/token',
    'file:///%2572un/%2573ecrets/token',
    'file:///project/safe%20name.txt',
    'file:///run/%ZZ/token',
    'file:///run/%/token',
    'file:///run/%C0%AFtoken',
    'file://user@localhost/project/readme.txt',
    'file://localhost@remote.example/project/readme.txt',
    'file://remote.example/project/readme.txt',
    'file://127.0.0.1/project/readme.txt',
    'file://[::1]/project/readme.txt',
    'file://localhost:80/project/readme.txt',
    'file:////server/share/readme.txt',
    'file:project/readme.txt',
    'file:///project/readme.txt?token=short-query-secret',
    'file:///project/readme.txt#credentials/private',
    'file:///project/readme.txt?next=/run/controller.sock',
    `file:///project/readme.txt#${`ghp_${'A'.repeat(36)}`}`,
    'file:\\\\localhost\\run\\secrets\\token',
    'file:///C:\\Users/propr\\.ssh/id_rsa',
    'file:///project/%00hidden.txt',
    'file:///project/%0Ahidden.txt',
    'file://',
    'file:///',
    `file:///project/${'x'.repeat(4_096)}`,
  ];

  for (const candidate of unsafeCandidates) assertFullyRedacted(candidate);
});

test('file URI parser redacts colon and legacy pipe drives in paths and URI metadata', () => {
  const driveCandidates = [
    // Path: raw/encoded colon and pipe, with forward/backslash/mixed separators.
    'file:///C:/Users/alice/Desktop/readme.txt',
    String.raw`file:///c|\Users\alice/Desktop/readme.txt`,
    'file:///D%3A/Projects/readme.txt',
    'file:///e%7C%5CWindows/System32/drivers/etc/hosts',
    // Query: raw/encoded colon and pipe.
    'file:///project/readme.txt?next=f:/Users/alice/Desktop/readme.txt',
    String.raw`file:///project/readme.txt?next=G|\Users/alice\Desktop/readme.txt`,
    'file:///project/readme.txt?next=h%3A%5CProjects/readme.txt',
    'file:///project/readme.txt?next=I%7C/Windows%5CSystem32/hosts',
    // Fragment: raw/encoded colon and pipe.
    String.raw`file:///project/readme.txt#next=J:\Users/alice\Desktop/readme.txt`,
    'file:///project/readme.txt#next=k|/Windows/System32/drivers/etc/hosts',
    'file:///project/readme.txt#next=L%3A/Projects%5Creadme.txt',
    'file:///project/readme.txt#next=m%7C%5CUsers/alice/Desktop/readme.txt',
  ];

  for (const candidate of driveCandidates) assertFullyRedacted(candidate);
});

test('file URI parser preserves ordinary text, HTTP URLs, and explicitly safe local URIs', () => {
  const safeValues = [
    'ordinary file: handling text',
    'profile:///project/readme.txt',
    'https://example.test/home/propr/.ssh/id_rsa',
    'http://localhost/project/readme.txt',
    'ordinary C|/Users/alice/Desktop/readme.txt text',
    'file:///project/docs/readme.txt',
    'file:///project/readme.txt?note=topicC|/Users',
    'FiLe://LOCALHOST/project/docs/readme.txt?view=1#introduction',
    'file:/project/docs/readme.txt',
    'file:///homecoming/readme.txt',
    'file:///runtime/report.txt',
    'file:///optical/manual.txt',
  ];

  for (const safe of safeValues) assert.equal(projectString(safe), safe);
});

test('raw absolute paths recognize exact sensitive roots at token boundaries', () => {
  const projected = toPublicGoalEventPayload({
    message: '/home?user=alice',
    source: '/run#fragment',
    paths: ['/home, next', '/home) next', 'path=/home&x=1'],
    nested: {
      value: '/run?service=controller',
      source: 'list: /opt, /home) done',
    },
  });

  assert.deepEqual(projected, {
    message: `${REDACTED}?user=alice`,
    source: `${REDACTED}#fragment`,
    paths: [`${REDACTED}, next`, `${REDACTED}) next`, `path=${REDACTED}&x=1`],
    nested: {
      value: `${REDACTED}?service=controller`,
      source: `list: ${REDACTED}, ${REDACTED}) done`,
    },
  });
});

test('raw absolute paths preserve alphanumeric sensitive-root continuations', () => {
  const payload = {
    message: '/homecoming',
    source: '/runtime/report.txt',
    nested: { value: '/optical/manual.txt' },
  };

  assert.deepEqual(toPublicGoalEventPayload(payload), payload);
});

test('file URI parser handles multiple tokens and a token spanning the public cutoff', () => {
  const multiple = [
    'safe file:///project/docs/readme.txt',
    'private file://localhost/run/secrets/token',
    'remote file://192.0.2.1/share/readme.txt',
    'web https://example.test/file:///unchanged',
  ].join(' | ');
  assert.equal(projectString(multiple), [
    'safe file:///project/docs/readme.txt',
    `private ${REDACTED}`,
    `remote ${REDACTED}`,
    'web https://example.test/file:///unchanged',
  ].join(' | '));
  assert.equal(
    projectString('file:///project/readme.txt,file://localhost/home/propr/private.txt'),
    `file:///project/readme.txt,${REDACTED}`
  );

  const prefix = `${'p'.repeat(16_319)} `;
  const sensitiveUri = `file://localhost/home/propr/.ssh/${'x'.repeat(600)}`;
  const projected = projectString(`${prefix}${sensitiveUri}`);
  assert.ok(Buffer.byteLength(projected, 'utf8') <= 16_384);
  assert.equal(projected.includes('file://localhost'), false);
  assert.equal(projected.includes('/home/propr/.ssh'), false);
  assert.equal(projected.includes(REDACTED), true);

  const driveUris = [
    `file:///C|/Users/alice/Desktop/${'x'.repeat(600)}`,
    `file:///project/readme.txt?next=d:/Projects/${'x'.repeat(600)}`,
    String.raw`file:///project/readme.txt#next=e|\Users\alice\Desktop\${'x'.repeat(600)}`,
  ];
  for (const driveUri of driveUris) {
    const driveProjected = projectString(`${prefix}${driveUri}`);
    assert.ok(Buffer.byteLength(driveProjected, 'utf8') <= 16_384, driveUri);
    assert.equal(driveProjected.includes('file:'), false, driveUri);
    assert.equal(driveProjected.includes(REDACTED), true, driveUri);
  }
});

test('file URI sanitization reaches nested strings in every public payload field', () => {
  const driveCandidates = [
    'file:///C|/Users/alice/Desktop/readme.txt',
    String.raw`file:///project/readme.txt?next=d:\Users\alice\Desktop\readme.txt`,
    'file:///e%7C%5CWindows/System32/drivers/etc/hosts',
    'file:///project/readme.txt#next=F%3A/Projects/readme.txt',
  ];
  const payload = Object.fromEntries(PUBLIC_STRING_FIELDS.map((field, index) => [
    field,
    [
      driveCandidates[index % driveCandidates.length],
      { value: driveCandidates[(index + 1) % driveCandidates.length] },
    ],
  ]));
  const projected = toPublicGoalEventPayload(payload) as Record<
    string,
    Array<string | { value: string }>
  >;
  const serialized = JSON.stringify(projected);

  for (const field of PUBLIC_STRING_FIELDS) {
    assert.deepEqual(projected[field], [REDACTED, { value: REDACTED }], field);
  }
  for (const forbidden of [
    ...driveCandidates, 'C|', 'd:', '%7C', '%3A', 'Users', 'Windows',
  ]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});

test('file URI normalization property matrix never emits raw or encoded credentials', () => {
  const schemes = ['file:', 'FILE:', 'FiLe:'];
  const authorities = ['///', '//localhost/', '//LOCALHOST/'];
  const sensitiveSegments = [
    '.ssh', '.env', '.env.production', '.npmrc', '.netrc', 'credentials', 'secrets',
  ];
  const separators = ['/', '\\'];
  const encodeEveryByte = (value: string): string => [...Buffer.from(value)]
    .map((byte) => `%${byte.toString(16).padStart(2, '0')}`)
    .join('');
  const matrix = schemes.flatMap((scheme) => authorities.flatMap((authority) => (
    sensitiveSegments.flatMap((segment) => separators.map((separator) => ({
      authority, scheme, segment, separator,
    })))
  )));

  for (const { authority, scheme, segment, separator } of matrix) {
    const candidates = [
      `${scheme}${authority}project${separator}team${separator}${segment}${separator}value`,
      `${scheme}${authority}${encodeEveryByte('project')}${separator}${encodeEveryByte(segment)}${separator}value`,
      `${scheme}${authority}project%2Fteam%2F${encodeEveryByte(segment)}%2Fvalue`,
    ];
    for (const candidate of candidates) assertFullyRedacted(candidate);
  }
});
