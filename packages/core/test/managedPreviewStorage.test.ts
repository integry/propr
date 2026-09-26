import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { inspect } from 'node:util';
import { pino } from 'pino';
import {
  PREVIEW_STORAGE_V1_DEFAULTS, parsePreviewStorageStatusV1, parsePreviewUploadV1,
  parsePreviewArtifactV1, parsePreviewUploadRequestV1, sanitizePreviewDisplayFilename,
  type PreviewStorageStatusV1,
} from '@propr/shared';
import { ManagedPreviewStorageClientV1, type PreviewStorageConnectContext } from '../src/services/previewStorage/v1.js';
import { createManagedPreviewStorageClient } from '../src/services/previewStorage/runtime.js';

const original = Buffer.from([0, 255, 42, 13, 10, 128]);
const directory = await mkdtemp(path.join(tmpdir(), 'managed-preview-test-'));
after(() => rm(directory, { recursive: true, force: true }));
const filePath = path.join(directory, 'original.png');
await writeFile(filePath, original);
const assetMetadata = { taskId: 'task-2285', repository: 'integry/propr', pullRequestNumber: 2285, displayFilename: 'original.png' };
const input = { filePath, contentType: 'image/png', ...assetMetadata };
const metadata = { sizeBytes: original.length, contentType: input.contentType, sha256: createHash('sha256').update(original).digest('hex') };
const secrets = ['relay-secret-value', 'viewer-secret-value', 'signed-secret-value', 'bearer-secret-value'];
const signedUrl = `https://objects.example.test/original?X-Amz-Signature=${secrets[2]}`;
const status: PreviewStorageStatusV1 = {
  version: 1, installationId: 42, enabled: true, ...PREVIEW_STORAGE_V1_DEFAULTS,
  usedBytes: 0, reservedBytes: 0, allowedContentTypes: ['image/png'], deleteSupported: true,
};
const upload = {
  version: 1, artifactId: 'artifact-1', objectKey: '42/original', ...metadata, ...assetMetadata,
  put: { url: signedUrl, headers: { 'Content-Type': 'image/png', 'Content-Length': String(original.length), 'If-None-Match': '*' }, expiresAt: '2099-01-01T00:00:00Z' },
};
const artifact = { version: 1, artifactId: upload.artifactId, state: 'ready', ...metadata, ...assetMetadata,
  viewerUrl: 'https://connect.example.test/previews/artifact-1', retentionExpiresAt: '2099-01-01T00:00:00Z' };
function fixture(options: {
  context?: PreviewStorageConnectContext;
  status?: unknown;
  upload?: unknown;
  finalize?: unknown;
  failAt?: number;
  failure?: Response | Error;
  beforePut?: () => Promise<void>;
} = {}) {
  const calls: Array<{ url: string; init?: RequestInit; putBytes?: Uint8Array }> = [];
  const context = options.context ?? { connected: true, connectAccount: { installationId: 42, hasPlusAccess: true } };
  const client = new ManagedPreviewStorageClientV1({
    routingUrl: 'wss://connect.example.test', trustedConnectOrigin: 'https://connect.example.test', relayToken: secrets[0], getConnectContext: async () => context,
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      if (calls.length === options.failAt) {
        if (options.failure instanceof Error) throw options.failure;
        return options.failure ?? new Response('Unavailable', { status: 503 });
      }
      if (String(url).endsWith('/status')) return Response.json(options.status ?? status);
      if (String(url).endsWith('/uploads')) return Response.json(options.upload ?? upload);
      if (init?.method === 'PUT') {
        await options.beforePut?.();
        // Constructing a real Node Request exercises the duplex requirement.
        const request = new Request(url, init);
        calls.at(-1)!.putBytes = new Uint8Array(await request.arrayBuffer());
      }
      if (init?.method === 'PUT' || init?.method === 'DELETE') return new Response(null, { status: 204 });
      return Response.json(options.finalize ?? artifact);
    },
  });
  return { client, calls, context };
}

test('status parser preserves server limits and strips unknown secret fields', () => {
  const effective = { ...status, quotaBytes: 40 * 1024 ** 3, maxObjectBytes: 250 * 1024 ** 2, retentionDays: 30 };
  assert.deepEqual(parsePreviewStorageStatusV1({ ...effective, viewerToken: secrets[1] }), effective);
  for (const invalid of [null, [], { ...status, version: 2 }, { ...status, enabled: 'true' },
    { ...status, usedBytes: -1 }, { ...status, quotaBytes: Number.MAX_SAFE_INTEGER + 1 },
    { ...status, maxObjectBytes: 0 }, { ...status, retentionDays: 1.5 }, { ...status, allowedContentTypes: ['text/html'] }]) {
    assert.equal(parsePreviewStorageStatusV1(invalid), undefined);
  }
});

for (const [name, context, state] of [
  ['Community', { connected: true, connectAccount: { installationId: 42, hasPlusAccess: false } }, 'plus_required'],
  ['offline Plus', { connected: false, connectAccount: { installationId: 42, hasPlusAccess: true } }, 'unavailable'],
  ['missing account_status', { connected: true }, 'unavailable'],
] as const) {
  test(`${name} never contacts managed storage`, async () => {
    const { client, calls } = fixture({ context });
    assert.equal((await client.getStatus()).state, state);
    assert.deepEqual(await client.uploadOriginal(input), { stored: false, code: state });
    assert.equal(calls.length, 0);
  });
}

test('server disabled, unavailable, mismatched installation and v2 statuses fail closed', async () => {
  for (const options of [{ status: { ...status, enabled: false } }, { failAt: 1 },
    { status: { ...status, installationId: 99 } }, { status: { ...status, version: 2 } }]) {
    const { client, calls } = fixture(options);
    assert.equal((await client.uploadOriginal(input)).stored, false);
    assert.equal(calls.length, 1);
  }
});

test('Plus uploads the exact original and finalizes the bound object without forwarding relay credentials', async () => {
  const { client, calls } = fixture({ finalize: { ...artifact, viewerToken: secrets[1], objectKey: upload.objectKey, put: upload.put } });
  assert.deepEqual(await client.uploadOriginal(input), { stored: true, artifact });
  assert.deepEqual(calls.map(call => call.init?.method), ['GET', 'POST', 'PUT', 'POST']);
  assert.equal(calls[2].url, signedUrl);
  assert.deepEqual(calls[2].putBytes, new Uint8Array(original));
  assert.deepEqual(calls[2].init?.headers, upload.put.headers);
  assert.equal(new Headers(calls[2].init?.headers).get('if-none-match'), '*');
  assert.equal((calls[2].init as RequestInit & { duplex: string }).duplex, 'half');
  assert.deepEqual(JSON.parse(calls[1].init?.body as string), { version: 1, ...assetMetadata, ...metadata });
  assert.deepEqual(JSON.parse(calls[3].init?.body as string), { version: 1, objectKey: upload.objectKey, ...metadata });
  assert.equal(new Headers(calls[2].init?.headers).get('authorization'), null);
  assert.equal(new Headers(calls[1].init?.headers).get('authorization'), `Bearer ${secrets[0]}`);
  assert.ok(calls.every(call => call.init?.redirect === 'error'));
});

test('entitlement is rechecked on every upload', async () => {
  const { client, calls, context } = fixture();
  assert.equal((await client.getStatus()).enabled, true);
  context.connectAccount!.hasPlusAccess = false;
  assert.deepEqual(await client.uploadOriginal(input), { stored: false, code: 'plus_required' });
  assert.equal(calls.length, 1);
});

for (const [override, code] of [
  [{ maxObjectBytes: 5 }, 'object_too_large'],
  [{ quotaBytes: 10, usedBytes: 3, reservedBytes: 2 }, 'quota_exceeded'],
  [{ allowedContentTypes: ['video/mp4'] }, 'content_type_not_allowed'],
] as const) {
  test(`server effective constraints prevent upload: ${code}`, async () => {
    const { client, calls } = fixture({ status: { ...status, ...override } });
    assert.deepEqual(await client.uploadOriginal(input), { stored: false, code });
    assert.equal(calls.length, 1);
  });
}

for (const [httpStatus, code] of [[413, 'quota_exceeded'], [413, 'object_too_large'], [402, 'plus_required']] as const) {
  test(`Connect ${httpStatus} ${code} envelope remains a safe typed error`, async () => {
    const { client, calls } = fixture({
      failAt: 2,
      failure: Response.json({ error: { code, message: secrets.join(' ') } }, { status: httpStatus }),
    });
    assert.deepEqual(await client.uploadOriginal(input), { stored: false, code });
    assert.equal(calls.length, 2);
  });
}

test('legacy top-level error codes remain compatible and the nested Connect envelope takes precedence', async () => {
  const legacy = fixture({
    failAt: 2,
    failure: Response.json({ code: 'quota_exceeded', message: secrets.join(' ') }, { status: 409 }),
  });
  assert.deepEqual(await legacy.client.uploadOriginal(input), { stored: false, code: 'quota_exceeded' });

  const conflicting = fixture({
    failAt: 2,
    failure: Response.json({
      code: 'quota_exceeded',
      error: { code: 'unknown_code', message: secrets.join(' ') },
    }, { status: 500 }),
  });
  assert.deepEqual(await conflicting.client.uploadOriginal(input), { stored: false, code: 'upload_failed' });
});

test('concurrent Plus downgrades retain plus_required across create, finalize, and delete', async () => {
  for (const failAt of [2, 4]) {
    const { client } = fixture({
      failAt,
      failure: Response.json({
        error: { code: 'plus_required', message: 'ProPR Plus is required to manage preview artifacts' },
      }, { status: 402 }),
    });
    assert.deepEqual(await client.uploadOriginal(input), { stored: false, code: 'plus_required' });
  }

  const deletion = fixture({
    failAt: 2,
    failure: Response.json({
      error: { code: 'plus_required', message: 'ProPR Plus is required to delete managed preview artifacts' },
    }, { status: 402 }),
  });
  await assert.rejects(deletion.client.deleteArtifact('artifact-1'), /plus_required/);
});

test('unknown and oversized 413 bodies use the generic object-size fallback without retaining body data', async () => {
  for (const body of [
    { error: { code: 'unknown_code', message: secrets.join(' ') } },
    { error: { code: 'quota_exceeded', message: 'x'.repeat(5 * 1024) } },
  ]) {
    const { client } = fixture({ failAt: 2, failure: Response.json(body, { status: 413 }) });
    assert.deepEqual(await client.uploadOriginal(input), { stored: false, code: 'object_too_large' });
  }
});

test('upload capability requires the exact signed length and preserves normalized header casing', async () => {
  assert.deepEqual(parsePreviewUploadV1(upload), upload);

  const caseNormalized = {
    ...upload,
    put: { ...upload.put, headers: {
      'content-type': input.contentType,
      'content-length': String(original.length),
      'if-none-match': '*',
    } },
  };
  assert.deepEqual(parsePreviewUploadV1(caseNormalized), caseNormalized);

  const { 'Content-Length': _missingLength, ...withoutLength } = upload.put.headers;
  const { 'If-None-Match': _missingCreateOnly, ...withoutCreateOnly } = upload.put.headers;
  for (const headers of [
    withoutLength,
    { ...upload.put.headers, 'Content-Length': String(original.length + 1) },
    withoutCreateOnly,
  ]) {
    const invalidUpload = { ...upload, put: { ...upload.put, headers } };
    assert.equal(parsePreviewUploadV1(invalidUpload), undefined);
    const { client, calls } = fixture({ upload: invalidUpload });
    assert.deepEqual(await client.uploadOriginal(input), { stored: false, code: 'invalid_contract' });
    assert.equal(calls.length, 2);
  }
});

test('mismatched metadata, expired grants and unsafe signed headers prevent PUT', async () => {
  for (const value of [
    { ...upload, sizeBytes: 20 }, { ...upload, sha256: 'a'.repeat(64) },
    { ...upload, put: { ...upload.put, expiresAt: '2000-01-01T00:00:00Z' } },
    { ...upload, put: { ...upload.put, url: 'http://objects.example.test/file' } },
    { ...upload, put: { ...upload.put, headers: { ...upload.put.headers, Authorization: `Bearer ${secrets[3]}` } } },
    { ...upload, put: { ...upload.put, headers: { ...upload.put.headers, 'If-None-Match': 'anything-but-star' } } },
    { ...upload, put: { ...upload.put, headers: { ...upload.put.headers, 'If-Match': '*' } } },
    { ...upload, put: { ...upload.put, headers: { ...upload.put.headers, 'If-Modified-Since': 'yesterday' } } },
    { ...upload, put: { ...upload.put, headers: { 'Content-Type': 'video/mp4' } } },
    { ...upload, put: { ...upload.put, headers: { ...upload.put.headers, 'content-type': 'image/png' } } },
    { ...upload, put: { ...upload.put, headers: { ...upload.put.headers, 'Content-Length': '7' } } },
  ]) {
    const { client, calls } = fixture({ upload: value });
    assert.equal((await client.uploadOriginal(input)).stored, false);
    assert.equal(calls.length, 2);
  }
  assert.equal(parsePreviewUploadV1({ ...upload, artifactId: '../status' }), undefined);
});

test('failed PUT is never finalized and a mismatched finalize is never accepted', async () => {
  const failedPut = fixture({ failAt: 3 });
  assert.deepEqual(await failedPut.client.uploadOriginal(input), { stored: false, code: 'upload_failed' });
  assert.equal(failedPut.calls.length, 3);
  const badFinalize = fixture({ finalize: { ...artifact, sha256: 'a'.repeat(64) } });
  assert.deepEqual(await badFinalize.client.uploadOriginal(input), { stored: false, code: 'object_mismatch' });
});

test('raw transport errors and malicious response bodies never enter logs or returned errors', async () => {
  let output = '';
  const log = pino({}, { write(chunk) { output += chunk; } });
  for (const failAt of [1, 2, 3, 4]) {
    for (const failure of [new Error(`${signedUrl} ${secrets.join(' ')}`),
      Response.json({ code: secrets[0], message: secrets.join(' '), url: signedUrl }, { status: 500 })]) {
      const { client } = fixture({ failAt, failure });
      const result = await client.uploadOriginal(input);
      log.warn({ result }, 'Storage attempt');
      output += inspect(result);
    }
  }
  const deletion = fixture({ failAt: 2, failure: new Error(secrets.join(' ')) });
  await assert.rejects(deletion.client.deleteArtifact('artifact-1'), error => {
    log.error({ err: error }, 'Delete attempt');
    output += inspect(error);
    return true;
  });
  for (const secret of [...secrets, signedUrl]) assert.ok(!output.includes(secret));
});

test('delete only uses the versioned endpoint when advertised', async () => {
  const enabled = fixture();
  await enabled.client.deleteArtifact('artifact-1');
  assert.equal(enabled.calls[1].url, 'https://connect.example.test/v1/preview-artifacts/artifact-1');
  assert.equal(enabled.calls[1].init?.method, 'DELETE');
  const disabled = fixture({ status: { ...status, deleteSupported: false } });
  await assert.rejects(disabled.client.deleteArtifact('artifact-1'), /delete_unsupported/);
  assert.equal(disabled.calls.length, 1);
});

test('runtime consumes the existing validated account_status and configured installation', async () => {
  const account = {
    installationId: 42, accountLogin: 'example', plan: 'plus', hasPlusAccess: true,
    activeSeats: 1, allowedSeats: 2, seatsRemaining: 1,
    billingCycleResetAt: '2026-10-01T00:00:00Z', sentAt: '2026-09-10T21:00:00Z',
  };
  let snapshot: unknown = { connected: true, connectAccount: account };
  let calls = 0;
  const env = { PROPR_GH_RELAY_TOKEN: secrets[0], GH_INSTALLATION_ID: '42' };
  const client = createManagedPreviewStorageClient(async () => JSON.stringify(snapshot), env,
    async () => { calls++; return Response.json(status); });
  assert.equal((await client.getStatus()).enabled, true);
  for (const value of [null, {}, { connected: false, connectAccount: account },
    { connected: true, connectAccount: { ...account, installationId: 99 } },
    { connected: true, connectAccount: { ...account, hasPlusAccess: 'true' } }]) {
    snapshot = value;
    assert.equal((await client.getStatus()).enabled, false);
  }
  assert.equal(calls, 1);
  const offline = createManagedPreviewStorageClient(async () => { throw new Error(secrets[0]); }, env);
  assert.equal((await offline.getStatus()).state, 'unavailable');
  snapshot = { connected: true, connectAccount: account };
  for (const trustedOrigin of ['https://connect.example.test', 'https://different.example.test']) {
    const configured = createManagedPreviewStorageClient(async () => JSON.stringify(snapshot), {
      ...env, PROPR_CONNECT_URL: trustedOrigin,
    }, async (url, init) => {
      if (String(url).endsWith('/status')) return Response.json(status);
      if (String(url).endsWith('/uploads')) return Response.json(upload);
      if (init?.method === 'PUT') {
        await new Request(url, init).arrayBuffer();
        return new Response(null, { status: 204 });
      }
      return Response.json(artifact);
    });
    assert.equal((await configured.uploadOriginal(input)).stored, trustedOrigin === 'https://connect.example.test');
  }
});


test('request metadata is validated, sanitized, and round-tripped without installation authority', async () => {
  const { client, calls } = fixture();
  assert.equal((await client.uploadOriginal({ ...input, displayFilename: '../unsafe\\original.png' })).stored, true);
  const request = JSON.parse(calls[1].init!.body as string);
  assert.equal(request.displayFilename, 'original.png');
  assert.equal('installationId' in request, false);
  assert.deepEqual(parsePreviewUploadRequestV1({ ...request, installationId: 999 }), request);
  assert.equal(parsePreviewUploadRequestV1({ ...request, taskId: 'task/42' })?.taskId, 'task/42');
  for (const override of [
    { taskId: '' }, { taskId: ' bad ' }, { taskId: 'task\n42' }, { taskId: 'x'.repeat(257) }, { repository: '../repo' }, { repository: 'owner/..' },
    { pullRequestNumber: 0 }, { pullRequestNumber: 1.5 }, { pullRequestNumber: '2285' },
    { displayFilename: '../secret.png' }, { displayFilename: 'a\n.png' }, { displayFilename: '' },
  ]) assert.equal(parsePreviewUploadRequestV1({ ...request, ...override }), undefined);
  for (const name of ['../../foo.png', 'C:\\temp\\foo.png', 'a\n[link](bad).png', '.'.repeat(150), 'a'.repeat(127) + '.xxx']) {
    const safe = sanitizePreviewDisplayFilename(name);
    assert.equal(sanitizePreviewDisplayFilename(safe), safe);
    assert.ok(safe.length <= 128);
  }
  for (const override of [{ taskId: 'other' }, { repository: 'other/repo' }, { pullRequestNumber: 1 }, { displayFilename: 'other.png' }]) {
    const grant = fixture({ upload: { ...upload, ...override } });
    assert.equal((await grant.client.uploadOriginal(input)).stored, false);
    assert.equal(grant.calls.length, 2);
    const finalized = fixture({ finalize: { ...artifact, ...override } });
    assert.equal((await finalized.client.uploadOriginal(input)).stored, false);
  }
  const { pullRequestNumber: _pr, ...withoutPr } = assetMetadata;
  const optional = fixture({ upload: { ...upload, pullRequestNumber: undefined }, finalize: { ...artifact, pullRequestNumber: undefined } });
  assert.equal((await optional.client.uploadOriginal({ filePath, contentType: input.contentType, ...withoutPr })).stored, true);
});

test('finalized viewer links require the exact configured HTTPS Connect origin and retention', async () => {
  const trusted = 'https://connect.example.test';
  assert.deepEqual(parsePreviewArtifactV1(artifact, trusted), artifact);
  for (const viewerUrl of [
    'http://connect.example.test/previews/1', 'https://evil.test/previews/1',
    'https://connect.example.test.evil.test/previews/1', 'https://connect.example.test:444/previews/1',
    'https://user:secret@connect.example.test/previews/1', '/previews/1',
    '//connect.example.test/previews/1', 'https://connect.example.test/previews/1?token=secret',
    'https://connect.example.test/previews/1#secret', 'javascript:alert(1)',
  ]) {
    assert.equal(parsePreviewArtifactV1({ ...artifact, viewerUrl }, trusted), undefined);
    const { client } = fixture({ finalize: { ...artifact, viewerUrl } });
    assert.deepEqual(await client.uploadOriginal(input), { stored: false, code: 'object_mismatch' });
  }
  for (const origin of ['', 'http://connect.example.test', 'https://user@connect.example.test', trusted + '/path']) {
    assert.equal(parsePreviewArtifactV1(artifact, origin), undefined);
  }
  for (const retentionExpiresAt of [undefined, 'nonsense', '2000-01-01T00:00:00Z']) {
    assert.equal((await fixture({ finalize: { ...artifact, retentionExpiresAt } }).client.uploadOriginal(input)).stored, false);
  }
});

test('missing files and changes between hash and PUT fail safely without finalize', async () => {
  assert.deepEqual(await fixture().client.uploadOriginal({ ...input, filePath: path.join(directory, 'missing') }),
    { stored: false, code: 'source_unavailable' });
  const changed = path.join(directory, 'changed.png');
  await writeFile(changed, original);
  const { client, calls } = fixture({ beforePut: async () => { await writeFile(changed, Buffer.alloc(original.length, 7)); } });
  assert.equal((await client.uploadOriginal({ ...input, filePath: changed })).stored, false);
  assert.equal(calls.length, 3);
});

test('500 MiB staged original hashes and uploads in bounded chunks without a full-size memory copy', async () => {
  const sizeBytes = 500 * 1024 ** 2;
  const largePath = path.join(directory, 'large.png');
  const file = await open(largePath, 'w');
  await file.truncate(sizeBytes); // Sparse staged fixture; never allocate the original in memory.
  await file.close();
  const zeroChunk = Buffer.alloc(64 * 1024);
  const expectedHash = createHash('sha256');
  for (let i = 0; i < sizeBytes; i += zeroChunk.length) expectedHash.update(zeroChunk);
  const sha256 = expectedHash.digest('hex');
  let requestMetadata: Record<string, unknown> = {};
  let sentBytes = 0;
  let peakBuffers = process.memoryUsage().arrayBuffers;
  const initialBuffers = peakBuffers;
  const client = new ManagedPreviewStorageClientV1({
    routingUrl: 'wss://relay.example.test', trustedConnectOrigin: 'https://connect.example.test', relayToken: secrets[0],
    getConnectContext: async () => ({ connected: true, connectAccount: { installationId: 42, hasPlusAccess: true } }),
    fetchImpl: async (url, init) => {
      if (String(url).endsWith('/status')) return Response.json(status);
      if (String(url).endsWith('/uploads')) {
        requestMetadata = JSON.parse(init!.body as string);
        assert.equal(requestMetadata.sizeBytes, sizeBytes);
        assert.equal(requestMetadata.sha256, sha256);
        return Response.json({ ...upload, ...requestMetadata, put: { ...upload.put,
          headers: { ...upload.put.headers, 'Content-Length': String(sizeBytes), 'x-amz-meta-test': 'signed-value' } } });
      }
      if (init?.method === 'PUT') {
        const request = new Request(url, init);
        assert.equal(request.headers.get('authorization'), null);
        assert.equal(request.headers.get('content-length'), String(sizeBytes));
        assert.equal(request.headers.get('x-amz-meta-test'), 'signed-value');
        assert.equal(request.redirect, 'error');
        const receivedHash = createHash('sha256');
        for await (const chunk of request.body!) {
          assert.ok(chunk.byteLength <= 64 * 1024);
          sentBytes += chunk.byteLength;
          receivedHash.update(chunk);
          peakBuffers = Math.max(peakBuffers, process.memoryUsage().arrayBuffers);
        }
        assert.equal(receivedHash.digest('hex'), sha256);
        return new Response(null, { status: 204 });
      }
      assert.equal(sentBytes, sizeBytes);
      return Response.json({ ...artifact, ...requestMetadata });
    },
  });
  assert.equal((await client.uploadOriginal({ ...input, filePath: largePath })).stored, true);
  assert.equal(sentBytes, sizeBytes);
  assert.ok(peakBuffers - initialBuffers < 128 * 1024 ** 2, `Peak additional buffers: ${peakBuffers - initialBuffers}`);
});
