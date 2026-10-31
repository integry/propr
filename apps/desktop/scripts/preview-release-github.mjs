// Shared, channel-neutral helpers for the unsigned desktop preview releases
// (Linux and macOS). Each channel keeps its own manifest, notes and trust rules;
// this module only owns byte hashing, checksum parsing and the draft-release
// GitHub API primitives so both channels verify remote bytes the same way.
import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';

const SHA256 = /^[a-f0-9]{64}$/;
const API_PAGE_SIZE = 100;

export const sha256File = async path => {
  const hash = createHash('sha256');
  const handle = await open(path, 'r');
  try {
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
  } finally {
    await handle.close();
  }
  return hash.digest('hex');
};

export const exactKeys = (value, keys, label) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== keys.length
    || Object.keys(value).some(key => !keys.includes(key))) {
    throw new Error(`${label} has missing or unknown fields`);
  }
};

export const exactRuntimeImage = (value, repository, sourceRevision) => (
  typeof value === 'string'
  && value === value.trim()
  && value.startsWith(`propr/${repository}:${sourceRevision}@sha256:`)
  && SHA256.test(value.slice(value.lastIndexOf(':') + 1))
);

export const parseChecksums = (contents, label) => {
  if (!contents.endsWith('\n') || contents.includes('\r')) {
    throw new Error(`${label} SHA256SUMS must be canonical LF-terminated text`);
  }
  const entries = contents.trimEnd().split('\n').map(line => {
    const match = /^([a-f0-9]{64})  ([A-Za-z0-9][A-Za-z0-9._-]*)$/.exec(line);
    if (!match) throw new Error(`${label} SHA256SUMS contains a malformed entry`);
    return [match[2], match[1]];
  });
  const names = entries.map(([name]) => name);
  if (new Set(names).size !== names.length || names.join('\n') !== [...names].sort().join('\n')) {
    throw new Error(`${label} SHA256SUMS must be unique and sorted by asset name`);
  }
  return new Map(entries);
};

const githubRequest = async ({ fetchImpl, apiUrl, repository, token, path, method = 'GET', json, body, headers = {}, allowNotFound = false }) => {
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
  if (!response.ok) throw new Error(`GitHub API ${method} ${path} failed with HTTP ${response.status}`);
  return response;
};

export const githubClient = ({ repository, token, apiUrl, fetchImpl }) => {
  const request = (path, options = {}) => githubRequest({
    repository, token, apiUrl, fetchImpl, path, ...options,
  });
  const json = async (path, options = {}) => {
    const response = await request(path, options);
    return response === undefined ? undefined : response.json();
  };
  return { request, json };
};

export const findReleaseByTag = async (json, tag, label) => {
  let release;
  for (let page = 1; ; page += 1) {
    const result = await json(`/releases?per_page=${API_PAGE_SIZE}&page=${page}`);
    if (!Array.isArray(result)) throw new Error(`GitHub returned an invalid ${label} release list`);
    for (const candidate of result) {
      if (candidate?.tag_name !== tag) continue;
      if (release !== undefined) {
        throw new Error(`GitHub returned duplicate releases for the ${label} tag`);
      }
      release = candidate;
    }
    if (result.length < API_PAGE_SIZE) return release;
  }
};

export const listAssets = async (json, releaseId, label) => {
  const assets = [];
  for (let page = 1; ; page += 1) {
    const result = await json(`/releases/${releaseId}/assets?per_page=${API_PAGE_SIZE}&page=${page}`);
    if (!Array.isArray(result)) throw new Error(`GitHub returned an invalid ${label} asset list`);
    assets.push(...result);
    if (result.length < API_PAGE_SIZE) return assets;
  }
};

const digestResponse = async (response, expectedSize, name, outputPath) => {
  if (!response.body) throw new Error(`GitHub preview asset has no body: ${name}`);
  const hash = createHash('sha256');
  let size = 0;
  const chunks = [];
  const handle = outputPath ? await open(outputPath, 'wx', 0o600) : undefined;
  try {
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > expectedSize) throw new Error(`GitHub preview asset exceeds expected size: ${name}`);
      hash.update(chunk);
      if (handle) await handle.write(chunk);
      else chunks.push(chunk);
    }
  } finally {
    await handle?.close();
  }
  if (size !== expectedSize) throw new Error(`GitHub preview asset has an unexpected size: ${name}`);
  return { sha256: hash.digest('hex'), bytes: outputPath ? undefined : Buffer.concat(chunks) };
};

export const verifyRemoteAsset = async ({ request, asset, expected, apiOrigin, outputPath }) => {
  if (!Number.isSafeInteger(asset?.id) || asset.name !== expected.name || asset.state !== 'uploaded'
    || asset.size !== expected.size || typeof asset.url !== 'string') {
    throw new Error(`GitHub preview asset metadata mismatch: ${expected.name}`);
  }
  const url = new URL(asset.url);
  if (url.origin !== apiOrigin) throw new Error(`GitHub preview asset has an untrusted API URL: ${expected.name}`);
  if (expected.sha256 && asset.digest != null && asset.digest !== `sha256:${expected.sha256}`) {
    throw new Error(`GitHub preview asset digest metadata mismatch: ${expected.name}`);
  }
  const response = await request(asset.url, { headers: { Accept: 'application/octet-stream' } });
  const downloaded = await digestResponse(response, expected.size, expected.name, outputPath);
  if ((expected.sha256 && downloaded.sha256 !== expected.sha256)
    || (!expected.sha256 && asset.digest != null && asset.digest !== `sha256:${downloaded.sha256}`)) {
    throw new Error(`GitHub preview asset content digest mismatch: ${expected.name}`);
  }
  return downloaded.bytes;
};

export const trustedUploadBase = (release, apiOrigin, label) => {
  const uploadBase = release.upload_url.replace(/\{.*$/, '');
  const uploadOrigin = new URL(uploadBase).origin;
  if (uploadOrigin !== apiOrigin && !(apiOrigin === 'https://api.github.com' && uploadOrigin === 'https://uploads.github.com')) {
    throw new Error(`GitHub returned an untrusted ${label} upload URL`);
  }
  return uploadBase;
};
