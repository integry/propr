// Registry targets of the release rollout check: Docker Hub tags and the npm
// registry, both read anonymously.

import { getJson, missing, ok, shortDigest, stale } from './http.mjs';

export const DOCKER_HUB_API = 'https://hub.docker.com/v2';
export const NPM_REGISTRY = 'https://registry.npmjs.org';

async function readDockerTag(ctx, repository, tag) {
  const response = await getJson(ctx, `${DOCKER_HUB_API}/repositories/${repository}/tags/${encodeURIComponent(tag)}`);
  if (response.status === 404) return { absent: true };
  if (!response.ok) return { error: `${repository}:${tag} returned HTTP ${response.status}` };
  return { digest: response.json?.digest };
}

/** `<repository>:<version>` exists and `latest` points at the same digest. */
export async function checkDockerImage(ctx, target) {
  const { repository } = target;
  const [release, latest] = await Promise.all([
    readDockerTag(ctx, repository, ctx.version),
    readDockerTag(ctx, repository, 'latest'),
  ]);
  if (release.error) return missing(release.error);
  if (release.absent || !release.digest) return missing(`no ${repository}:${ctx.version} tag`);
  if (latest.error) return stale(`${repository}:${ctx.version} ${shortDigest(release.digest)}; ${latest.error}`);
  if (latest.absent || !latest.digest) return stale(`${repository}:${ctx.version} ${shortDigest(release.digest)}; no latest tag`);
  if (latest.digest !== release.digest) {
    return stale(`${repository}:${ctx.version} ${shortDigest(release.digest)}; latest is ${shortDigest(latest.digest)}`);
  }
  return ok(`${repository}:${ctx.version} ${shortDigest(release.digest)} = latest`);
}

/** The npm `latest` dist-tag is the release version. */
export async function checkNpmPackage(ctx, target) {
  const name = target.package;
  const tags = await getJson(ctx, `${NPM_REGISTRY}/-/package/${encodeURIComponent(name)}/dist-tags`);
  if (!tags.ok) return missing(`${name} dist-tags returned HTTP ${tags.status}`);
  const latest = tags.json?.latest;
  if (latest === ctx.version) return ok(`${name}@latest is ${latest}`);
  const published = await getJson(ctx, `${NPM_REGISTRY}/${encodeURIComponent(name)}/${encodeURIComponent(ctx.version)}`);
  if (!published.ok) return missing(`${name}@${ctx.version} is not published; latest is ${latest ?? 'unset'}`);
  return stale(`${name}@${ctx.version} is published but latest is ${latest ?? 'unset'}`);
}
