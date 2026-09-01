import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const VERSIONED_TAG_PATTERN = /^desktop-v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SHA_PATTERN = /^[a-f0-9]{40}$/;
const API_PAGE_SIZE = 100;
const CHECKSUM_FILE = 'SHA256SUMS';
const REQUIRED_METADATA = ['desktop-release.json', 'desktop-release.json.sig'];

const sha256File = async path => {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
};

const readFinalAssetSet = async directory => {
  const entries = await readdir(directory, { withFileTypes: true });
  if (entries.some(entry => !entry.isFile())) throw new Error('Final release directory may contain only regular files');
  const names = entries.map(entry => entry.name).sort();
  if (new Set(names).size !== names.length || names.some(name => basename(name) !== name)) {
    throw new Error('Final release directory contains duplicate or invalid asset names');
  }
  const checksumLines = (await readFile(join(directory, CHECKSUM_FILE), 'utf8')).split(/\r?\n/).filter(Boolean);
  const checksums = new Map();
  for (const line of checksumLines) {
    const match = /^([a-f0-9]{64})  ([^/\\\r\n]+)$/.exec(line);
    if (!match || checksums.has(match[2]) || match[2] === CHECKSUM_FILE) {
      throw new Error('Finalized SHA256SUMS contains an invalid or duplicate asset');
    }
    checksums.set(match[2], match[1]);
  }
  if (checksums.size === 0 || REQUIRED_METADATA.some(name => !checksums.has(name))) {
    throw new Error('Finalized SHA256SUMS does not cover the signed release metadata');
  }
  const expectedNames = [...checksums.keys(), CHECKSUM_FILE].sort();
  if (JSON.stringify(names) !== JSON.stringify(expectedNames)) {
    throw new Error('Final release directory does not exactly match the finalized checksum allowlist');
  }
  const assets = new Map();
  for (const name of names) {
    const path = join(directory, name);
    const details = await stat(path);
    if (!details.isFile() || details.size <= 0) throw new Error(`Final release asset ${name} must be a nonempty regular file`);
    const digest = await sha256File(path);
    if (name !== CHECKSUM_FILE && digest !== checksums.get(name)) {
      throw new Error(`Final release asset ${name} does not match finalized checksums`);
    }
    assets.set(name, { name, path, size: details.size, sha256: digest });
  }
  return assets;
};

const githubRequest = async ({
  fetchImpl,
  apiUrl,
  repository,
  token,
  path,
  method = 'GET',
  json,
  body,
  headers = {},
  allowNotFound = false,
  expectedStatus,
}) => {
  const url = path.startsWith('https://') ? path : `${apiUrl}/repos/${repository}${path}`;
  const response = await fetchImpl(url, {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(json === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...headers,
    },
    ...(json === undefined ? {} : { body: JSON.stringify(json) }),
    ...(body === undefined ? {} : { body, duplex: 'half' }),
  });
  if (allowNotFound && response.status === 404) return undefined;
  if (!response.ok || (expectedStatus !== undefined && response.status !== expectedStatus)) {
    throw new Error(`GitHub API ${method} ${path} failed with HTTP ${response.status}`);
  }
  return response;
};

const assertApprovedTag = async ({ requestJson, tag, releaseSha, tagObjectSha }) => {
  const encodedTag = encodeURIComponent(tag);
  const ref = await requestJson(`/git/ref/tags/${encodedTag}`);
  if (ref?.object?.sha !== tagObjectSha) throw new Error('Desktop release tag object drifted from preflight approval');
  const commit = await requestJson(`/commits/${encodedTag}`);
  if (commit?.sha !== releaseSha) throw new Error('Desktop release tag commit drifted from preflight approval');
};

const assertDraftRelease = (release, tag) => {
  if (!Number.isSafeInteger(release?.id)
    || release.tag_name !== tag
    || release.draft !== true
    || release.prerelease !== false
    || release.published_at != null
    || typeof release.upload_url !== 'string') {
    throw new Error('Existing GitHub release is not the exact recoverable draft for the approved tag');
  }
};

const listReleaseAssets = async (requestJson, releaseId) => {
  const assets = [];
  for (let page = 1; ; page += 1) {
    const result = await requestJson(`/releases/${releaseId}/assets?per_page=${API_PAGE_SIZE}&page=${page}`);
    if (!Array.isArray(result)) throw new Error('GitHub release assets response is ambiguous');
    assets.push(...result);
    if (result.length < API_PAGE_SIZE) return assets;
  }
};

const digestResponse = async (response, expectedSize, name) => {
  const declaredLength = response.headers?.get?.('content-length');
  if (declaredLength !== null && declaredLength !== undefined && Number(declaredLength) !== expectedSize) {
    throw new Error(`GitHub release asset ${name} has an unexpected content length`);
  }
  if (!response.body) throw new Error(`GitHub release asset ${name} has no downloadable body`);
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > expectedSize) throw new Error(`GitHub release asset ${name} exceeds its expected size`);
    hash.update(chunk);
  }
  if (size !== expectedSize) throw new Error(`GitHub release asset ${name} has an unexpected size`);
  return hash.digest('hex');
};

const verifyRemoteAssets = async ({ request, requestJson, releaseId, expected, allowSubset, apiOrigin }) => {
  const remote = await listReleaseAssets(requestJson, releaseId);
  const seen = new Set();
  for (const asset of remote) {
    if (!Number.isSafeInteger(asset?.id) || typeof asset.name !== 'string' || seen.has(asset.name)) {
      throw new Error('GitHub release contains duplicate or ambiguous assets');
    }
    seen.add(asset.name);
    const local = expected.get(asset.name);
    if (!local) throw new Error(`GitHub release contains unexpected asset ${asset.name}`);
    if (asset.state !== 'uploaded' || asset.size !== local.size || typeof asset.url !== 'string') {
      throw new Error(`GitHub release asset ${asset.name} metadata does not match the finalized asset`);
    }
    let assetUrl;
    try { assetUrl = new URL(asset.url); } catch { throw new Error(`GitHub release asset ${asset.name} has an invalid API URL`); }
    if (assetUrl.origin !== apiOrigin) throw new Error(`GitHub release asset ${asset.name} has an untrusted API URL`);
    if (asset.digest != null && asset.digest !== `sha256:${local.sha256}`) {
      throw new Error(`GitHub release asset ${asset.name} digest metadata does not match finalized checksums`);
    }
    const download = await request(asset.url, { headers: { Accept: 'application/octet-stream' } });
    if (await digestResponse(download, local.size, asset.name) !== local.sha256) {
      throw new Error(`GitHub release asset ${asset.name} content digest does not match finalized checksums`);
    }
  }
  if (!allowSubset && (seen.size !== expected.size || [...expected.keys()].some(name => !seen.has(name)))) {
    throw new Error(`GitHub release asset set is incomplete: expected ${expected.size}, found ${seen.size}`);
  }
  return seen;
};

export const publishDesktopRelease = async ({
  repository,
  tag,
  releaseSha,
  tagObjectSha,
  directory,
  token,
  apiUrl = 'https://api.github.com',
  fetchImpl = fetch,
}) => {
  if (!repository?.includes('/') || !VERSIONED_TAG_PATTERN.test(tag) || !SHA_PATTERN.test(releaseSha)
    || !SHA_PATTERN.test(tagObjectSha) || !token) {
    throw new Error('Desktop release publication inputs are invalid');
  }
  const finalDirectory = resolve(directory);
  const expected = await readFinalAssetSet(finalDirectory);
  const apiOrigin = new URL(apiUrl).origin;
  const baseOptions = { fetchImpl, apiUrl, repository, token };
  const request = (path, options = {}) => githubRequest({ ...baseOptions, path, ...options });
  const requestJson = async (path, options = {}) => {
    const response = await request(path, options);
    return response === undefined ? undefined : response.json();
  };

  await assertApprovedTag({ requestJson, tag, releaseSha, tagObjectSha });
  const encodedTag = encodeURIComponent(tag);
  let release = await requestJson(`/releases/tags/${encodedTag}`, { allowNotFound: true });
  if (release === undefined) {
    release = await requestJson('/releases', {
      method: 'POST',
      expectedStatus: 201,
      json: {
        tag_name: tag,
        target_commitish: releaseSha,
        name: `ProPR Desktop ${tag}`,
        draft: true,
        prerelease: false,
        generate_release_notes: true,
      },
    });
  }
  assertDraftRelease(release, tag);
  await assertApprovedTag({ requestJson, tag, releaseSha, tagObjectSha });

  const uploaded = await verifyRemoteAssets({
    request, requestJson, releaseId: release.id, expected, allowSubset: true, apiOrigin,
  });
  const uploadBase = release.upload_url.replace(/\{.*$/, '');
  let uploadOrigin;
  try { uploadOrigin = new URL(uploadBase).origin; } catch { throw new Error('GitHub release returned an invalid asset upload URL'); }
  const allowedUploadOrigins = new Set([apiOrigin]);
  if (apiOrigin === 'https://api.github.com') allowedUploadOrigins.add('https://uploads.github.com');
  if (!allowedUploadOrigins.has(uploadOrigin)) throw new Error('GitHub release returned an untrusted asset upload URL');
  for (const asset of expected.values()) {
    if (uploaded.has(asset.name)) continue;
    const uploadUrl = new URL(uploadBase);
    uploadUrl.searchParams.set('name', asset.name);
    await request(uploadUrl.toString(), {
      method: 'POST',
      expectedStatus: 201,
      body: createReadStream(asset.path),
      headers: {
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(asset.size),
      },
    });
  }

  await assertApprovedTag({ requestJson, tag, releaseSha, tagObjectSha });
  await verifyRemoteAssets({
    request, requestJson, releaseId: release.id, expected, allowSubset: false, apiOrigin,
  });
  await assertApprovedTag({ requestJson, tag, releaseSha, tagObjectSha });
  const published = await requestJson(`/releases/${release.id}`, {
    method: 'PATCH',
    json: { draft: false },
  });
  if (published?.id !== release.id || published.tag_name !== tag || published.draft !== false || !published.published_at) {
    throw new Error('GitHub did not confirm publication of the exact verified draft release');
  }
  return published;
};

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await publishDesktopRelease({
    repository: process.env.GITHUB_REPOSITORY,
    tag: process.env.RELEASE_TAG,
    releaseSha: process.env.RELEASE_SHA,
    tagObjectSha: process.env.TAG_OBJECT_SHA,
    directory: process.env.RELEASE_DIRECTORY || 'desktop-release-final',
    token: process.env.GITHUB_TOKEN,
    apiUrl: process.env.GITHUB_API_URL,
  });
}
