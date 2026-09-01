import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { describe, test } from 'node:test';
import { publishDesktopRelease } from './release-publish.mjs';

const releaseSha = '1'.repeat(40);
const tagObjectSha = '2'.repeat(40);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

const createFinalAssets = async (extraCount = 1) => {
  const directory = await mkdtemp(join(tmpdir(), 'propr-publish-'));
  const files = new Map([
    ['desktop-release.json', Buffer.from('{}\n')],
    ['desktop-release.json.sig', Buffer.from('signed\n')],
  ]);
  for (let index = 0; index < extraCount; index += 1) {
    files.set(`ProPR-Desktop-asset-${String(index).padStart(3, '0')}.bin`, Buffer.from(`asset-${index}\n`));
  }
  const checksums = [...files]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, bytes]) => `${sha256(bytes)}  ${name}`)
    .join('\n');
  files.set('SHA256SUMS', Buffer.from(`${checksums}\n`));
  for (const [name, bytes] of files) await writeFile(join(directory, name), bytes);
  return { directory, files };
};

const response = ({ status = 200, value, bytes }) => ({
  status,
  ok: status >= 200 && status < 300,
  json: async () => value,
  body: bytes === undefined ? undefined : Readable.from([bytes]),
  headers: new Headers(bytes === undefined ? {} : { 'content-length': String(bytes.length) }),
});

const createGitHub = ({ seedAssets = [], failUploadAt, driftAfterTagChecks } = {}) => {
  const state = {
    release: undefined,
    assets: seedAssets.map(asset => ({ ...asset })),
    calls: [],
    patchCalls: 0,
    uploadCalls: 0,
    failUploadAt,
    tagChecks: 0,
  };
  const draft = () => ({
    id: 7,
    tag_name: 'desktop-v1.2.3',
    draft: true,
    prerelease: false,
    published_at: null,
    upload_url: 'https://uploads.github.com/releases/7/assets{?name,label}',
  });
  if (seedAssets.length) state.release = draft();
  state.fetchImpl = async (url, options = {}) => {
    const parsed = new URL(url);
    const path = parsed.pathname.replace('/repos/integry/propr', '');
    const method = options.method ?? 'GET';
    state.calls.push(`${method} ${path}${parsed.search}`);
    if (path === '/git/ref/tags/desktop-v1.2.3') {
      state.tagChecks += 1;
      const drifted = driftAfterTagChecks && state.tagChecks >= driftAfterTagChecks;
      return response({ value: { object: { sha: drifted ? '3'.repeat(40) : tagObjectSha } } });
    }
    if (path === '/commits/desktop-v1.2.3') return response({ value: { sha: releaseSha } });
    if (path === '/releases/tags/desktop-v1.2.3') {
      return state.release ? response({ value: state.release }) : response({ status: 404 });
    }
    if (path === '/releases' && method === 'POST') {
      const input = JSON.parse(options.body);
      assert.equal(input.draft, true);
      assert.equal(input.tag_name, 'desktop-v1.2.3');
      assert.equal(input.target_commitish, releaseSha);
      state.release = draft();
      return response({ status: 201, value: state.release });
    }
    if (path === '/releases/7/assets' && method === 'GET') {
      const page = Number(parsed.searchParams.get('page'));
      return response({ value: state.assets.slice((page - 1) * 100, page * 100) });
    }
    if (parsed.host === 'uploads.github.com' && method === 'POST') {
      state.uploadCalls += 1;
      if (state.failUploadAt === state.uploadCalls) return response({ status: 500 });
      const chunks = [];
      for await (const chunk of options.body) chunks.push(chunk);
      const bytes = Buffer.concat(chunks);
      const name = parsed.searchParams.get('name');
      const asset = {
        id: state.assets.length + 1,
        name,
        state: 'uploaded',
        size: bytes.length,
        digest: `sha256:${sha256(bytes)}`,
        url: `https://api.github.com/assets/${state.assets.length + 1}`,
        bytes,
      };
      state.assets.push(asset);
      return response({ status: 201, value: asset });
    }
    if (parsed.host === 'api.github.com' && path.startsWith('/assets/')) {
      const asset = state.assets.find(candidate => candidate.url === url);
      return asset ? response({ bytes: asset.bytes }) : response({ status: 404 });
    }
    if (path === '/releases/7' && method === 'PATCH') {
      state.patchCalls += 1;
      state.release = { ...state.release, draft: false, published_at: '2026-08-29T00:00:00Z' };
      return response({ value: state.release });
    }
    throw new Error(`Unexpected request: ${method} ${url}`);
  };
  return state;
};

const publish = ({ directory, fetchImpl }) => publishDesktopRelease({
  repository: 'integry/propr',
  tag: 'desktop-v1.2.3',
  releaseSha,
  tagObjectSha,
  directory,
  token: 'token',
  apiUrl: 'https://api.github.com',
  fetchImpl,
});

describe('atomic desktop release publication', () => {
  test('creates a draft, paginates and verifies the exact final assets, then publishes', async () => {
    const { directory } = await createFinalAssets(101);
    const github = createGitHub();
    const result = await publish({ directory, fetchImpl: github.fetchImpl });
    assert.equal(result.draft, false);
    assert.equal(github.patchCalls, 1);
    assert.equal(github.assets.length, 104);
    assert(github.calls.includes('GET /releases/7/assets?per_page=100&page=2'));
    assert(github.calls.lastIndexOf('GET /git/ref/tags/desktop-v1.2.3') < github.calls.indexOf('PATCH /releases/7'));
  });

  test('leaves a partial upload as a recoverable draft and resumes only matching assets', async () => {
    const { directory, files } = await createFinalAssets(2);
    const github = createGitHub({ failUploadAt: 2 });
    await assert.rejects(publish({ directory, fetchImpl: github.fetchImpl }), /failed with HTTP 500/);
    assert.equal(github.release.draft, true);
    assert.equal(github.patchCalls, 0);
    assert.equal(github.assets.length, 1);

    github.failUploadAt = undefined;
    await publish({ directory, fetchImpl: github.fetchImpl });
    assert.equal(github.release.draft, false);
    assert.equal(github.assets.length, files.size);
    assert.equal(new Set(github.assets.map(asset => asset.name)).size, files.size);
  });

  test('rejects unexpected, duplicate, size, and content-digest asset mismatches without publishing', async () => {
    const { directory, files } = await createFinalAssets();
    const [name, bytes] = [...files].find(([candidate]) => candidate !== 'SHA256SUMS');
    const matching = {
      id: 1,
      name,
      state: 'uploaded',
      size: bytes.length,
      digest: `sha256:${sha256(bytes)}`,
      url: 'https://api.github.com/assets/1',
      bytes,
    };
    const cases = [
      [{ ...matching, name: 'unexpected.bin' }],
      [matching, { ...matching, id: 2, url: 'https://api.github.com/assets/2' }],
      [{ ...matching, size: bytes.length + 1 }],
      [{ ...matching, bytes: Buffer.from('x'.repeat(bytes.length)), digest: `sha256:${sha256(bytes)}` }],
    ];
    for (const assets of cases) {
      const github = createGitHub({ seedAssets: assets });
      await assert.rejects(publish({ directory, fetchImpl: github.fetchImpl }), /unexpected|duplicate|metadata|content digest/);
      assert.equal(github.patchCalls, 0);
      assert.equal(github.release.draft, true);
    }
  });

  test('rejects tag drift before publishing the verified draft', async () => {
    const { directory } = await createFinalAssets();
    const github = createGitHub({ driftAfterTagChecks: 4 });
    await assert.rejects(publish({ directory, fetchImpl: github.fetchImpl }), /tag object drifted/);
    assert.equal(github.patchCalls, 0);
    assert.equal(github.release.draft, true);
  });

  test('rejects local files outside or missing from finalized checksums', async () => {
    const { directory } = await createFinalAssets();
    await writeFile(join(directory, 'unexpected.bin'), 'unexpected');
    const github = createGitHub();
    await assert.rejects(publish({ directory, fetchImpl: github.fetchImpl }), /checksum allowlist/);
    assert.equal(github.calls.length, 0);
  });
});
