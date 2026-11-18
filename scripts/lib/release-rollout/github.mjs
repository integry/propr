// GitHub targets of the release rollout check: the release itself and the
// desktop preview pre-releases, read through the public REST API.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cached, get, getJson, missing, ok, stale } from './http.mjs';

export const GITHUB_API = 'https://api.github.com';
export const GITHUB_RAW = 'https://raw.githubusercontent.com';
const RELEASE_PAGES = 5;
const PER_PAGE = 100;

export const fill = (template, version) => template.replaceAll('{version}', version);

const escapeRegExp = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Whether `tag` is a desktop preview tag of exactly `version`: the producers
 * (apps/desktop/scripts/desktop-preview-identity.mjs, linux-preview-release.mjs)
 * emit `<prefix with version><12-hex source revision><suffix>`. Matching the
 * revision keeps `v0.9.2-rc.1-<rev>` from passing as `v0.9.2-<rev>`.
 */
export function isVersionTag(tag, prefixTemplate, suffix, version) {
  const pattern = new RegExp(`^${escapeRegExp(fill(prefixTemplate, version))}[0-9a-f]{12}${escapeRegExp(suffix)}$`);
  return pattern.test(tag);
}

const unreadable = (what, response) => missing(`${what} returned HTTP ${response.status}${response.status === 403 || response.status === 429 ? ' (GitHub API rate limit?)' : ''}`);

const normalise = text => text.replace(/\r\n/g, '\n').trim();

/**
 * The checked-in summary as of the release tag, else (only when the tag has no
 * such file, HTTP 404) the local checkout's copy. Any other unsuccessful read
 * returns `{ error }`: the authoritative copy is unknown, so the local one
 * must not stand in for it.
 */
async function readSummary(ctx, repo, tag, path) {
  const atTag = await get(ctx, `${GITHUB_RAW}/${repo}/${encodeURIComponent(tag)}/${path}`);
  if (atTag.ok) return { text: atTag.text, source: `${path} at ${tag}` };
  if (atTag.status !== 404) return { error: unreadable(`${path} at ${tag}`, atTag) };
  try {
    return { text: await (ctx.readFile ?? readFile)(join(ctx.repoRoot, path), 'utf8'), source: `${path} (local checkout)` };
  } catch {
    return undefined;
  }
}

export async function checkGithubRelease(ctx, target) {
  const tag = `v${ctx.version}`;
  const url = `${GITHUB_API}/repos/${target.repo}/releases/tags/${encodeURIComponent(tag)}`;
  const response = await getJson(ctx, url);
  if (response.status === 404) return missing(`no GitHub release ${tag}`);
  if (!response.ok) return unreadable(`releases/tags/${tag}`, response);
  const release = response.json;
  if (release.draft !== false) return stale(`${tag} is a draft`);
  const path = fill(target.summaryPath, ctx.version);
  const summary = await readSummary(ctx, target.repo, tag, path);
  if (summary?.error) return summary.error;
  if (!summary || !normalise(summary.text)) return missing(`${tag} published ${release.published_at}; no checked-in summary ${path} at ${tag} or in this checkout`);
  if (!normalise(release.body ?? '').startsWith(normalise(summary.text))) {
    return stale(`${tag} published ${release.published_at}; body does not start with ${summary.source}`);
  }
  return ok(`${tag} published ${release.published_at}; body starts with ${summary.source}`);
}

/** Newest-first list of the repository's (non-draft, as seen anonymously) releases. */
export function listReleases(ctx, repo) {
  return cached(ctx, `github-releases:${repo}`, async () => {
    const releases = [];
    for (let page = 1; page <= RELEASE_PAGES; page += 1) {
      const response = await getJson(ctx, `${GITHUB_API}/repos/${repo}/releases?per_page=${PER_PAGE}&page=${page}`);
      if (!response.ok) return { error: unreadable('releases list', response) };
      releases.push(...response.json);
      if (response.json.length < PER_PAGE) break;
    }
    return { releases };
  });
}

export async function checkDesktopPrerelease(ctx, target) {
  const listed = await listReleases(ctx, target.repo);
  if (listed.error) return listed.error;
  const prefix = fill(target.tagPrefix, ctx.version);
  const suffix = target.tagSuffix ?? '';
  const matches = tag => isVersionTag(tag, target.tagPrefix, suffix, ctx.version);
  const candidates = listed.releases.filter(release => !release.draft && matches(release.tag_name));
  if (candidates.length === 0) {
    const family = target.tagPrefix.split('{version}')[0];
    const newest = listed.releases.find(release => !release.draft && release.tag_name.startsWith(family) && release.tag_name.endsWith(suffix));
    return missing(`no published ${prefix}*${suffix} pre-release${newest ? `; newest is ${newest.tag_name}` : ''}`);
  }
  const expected = target.assets.map(name => fill(name, ctx.version));
  const lacking = release => {
    const names = new Set((release.assets ?? []).map(asset => asset.name));
    return expected.filter(name => !names.has(name));
  };
  const complete = candidates.find(release => lacking(release).length === 0);
  if (complete) return ok(`${complete.tag_name} with ${expected.length} expected files`);
  const newest = candidates[0];
  return stale(`${newest.tag_name} lacks ${lacking(newest).join(', ')}`);
}
