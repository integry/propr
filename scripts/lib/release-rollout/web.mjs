// Plain-HTTP targets of the release rollout check: the hosted UI bundle, a
// JSON status endpoint and the public site's pages.

import { readHostedUiBundle } from '../hosted-ui-bundle.mjs';
import { describeError, get, getJson, missing, ok, stale } from './http.mjs';
import { fill, isVersionTag } from './github.mjs';

/** Same check as the hosted UI deploy: the entry bundle embeds "<version>". */
export async function checkHostedUiBundle(ctx, target) {
  const fetchImpl = (url, init = {}) => ctx.fetchImpl(url, {
    ...init,
    headers: { 'user-agent': 'propr-release-rollout-check', ...init.headers },
    signal: AbortSignal.timeout(ctx.timeoutMs ?? 20_000),
  });
  let result;
  try {
    result = await readHostedUiBundle({ url: target.url, version: ctx.version, fetchImpl });
  } catch (error) {
    return missing(describeError(error));
  }
  const quoted = JSON.stringify(ctx.version);
  if (!result.hasVersion) return stale(`${result.bundle.pathname} does not contain ${quoted}`);
  return ok(`${result.bundle.pathname} contains ${quoted}`);
}

/** A JSON endpoint reports the release version in `target.field`. */
export async function checkStatusJson(ctx, target) {
  let response;
  try {
    response = await getJson(ctx, target.url);
  } catch (error) {
    return missing(describeError(error));
  }
  if (!response.ok) return missing(`GET ${target.url} returned HTTP ${response.status}`);
  const reported = response.json?.[target.field];
  if (reported === ctx.version) return ok(`${target.field} ${reported}`);
  return stale(`${target.field} ${reported === undefined ? 'missing' : JSON.stringify(reported)}`);
}

/** A page for the release exists (HTTP 200 after redirects). */
export async function checkPage(ctx, target) {
  const url = fill(target.url, ctx.version);
  const response = await get(ctx, url, { accept: 'text/html' });
  if (response.status === 200) return ok(`${url} HTTP 200`);
  return missing(`${url} HTTP ${response.status}`);
}

const RELEASE_LINK = /\/releases\/(?:download|tag)\/([^/"'?#\s<>]+)/g;

export function linkedReleaseTags(html) {
  const tags = new Set();
  for (const match of html.matchAll(RELEASE_LINK)) {
    try {
      tags.add(decodeURIComponent(match[1]));
    } catch {
      tags.add(match[1]);
    }
  }
  return [...tags];
}

/** A page links to a release tag of each family for the release version. */
export async function checkPageLinks(ctx, target) {
  const response = await get(ctx, target.url, { accept: 'text/html' });
  if (response.status !== 200) return missing(`${target.url} HTTP ${response.status}`);
  const tags = linkedReleaseTags(response.text);
  const linked = [];
  const outdated = [];
  for (const family of target.tagFamilies) {
    const suffix = family.suffix ?? '';
    const prefix = fill(family.prefix, ctx.version);
    const current = tags.find(tag => isVersionTag(tag, family.prefix, suffix, ctx.version));
    if (current) {
      linked.push(current);
      continue;
    }
    const familyStart = family.prefix.split('{version}')[0];
    const other = tags.find(tag => tag.startsWith(familyStart) && tag.endsWith(suffix));
    outdated.push(other ? `links ${other}, not ${prefix}*${suffix}` : `no ${prefix}*${suffix} link`);
  }
  if (outdated.length === 0) return ok(`links ${linked.join(', ')}`);
  return stale(outdated.join('; '));
}
