#!/usr/bin/env node
// Plans one Release Rollout run (.github/workflows/release-rollout.yml).
//
//   plan     resolve the release tag to its tag commit (the source revision of
//            every preview), check it against the reviewed main revision, and
//            find the immutable artefacts that already exist so a re-run skips
//            them: the three preview runtime images (anonymous registry reads)
//            and the published Linux and macOS preview prereleases.
//   runtime  pick the runtime image references the desktop previews and the
//            preview CLI bundle receive: the one this run published, else the
//            one the plan found, each checked against the source revision.
//            A publication passes only its digest (a full reference names the
//            Docker Hub namespace, which is also the DOCKERHUB_USERNAME secret,
//            and GitHub Actions drops outputs containing a secret value), so
//            the reference is rebuilt from the public namespace constant, the
//            source revision and that digest, then read back anonymously from
//            the registry and compared.
//
// Nothing here writes to a registry, a release, or any other remote.

import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { previewTag } from '../apps/desktop/scripts/desktop-preview-identity.mjs';
import { RUNTIME_NAMESPACE, inspectPublishedRuntime, inspectPublishedRuntimeImage } from './preview-runtime-images.mjs';
import { TARGETS } from './verify-release-rollout.mjs';

export const ROLLOUT_WORKFLOW = '.github/workflows/release-rollout.yml';
const REPOSITORY = 'integry/propr';
const MAIN_REF = 'refs/heads/main';
const SHA = /^[0-9a-f]{40}$/;
const RELEASE_TAG = /^v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/;
const SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const RUNTIME_IMAGES = Object.freeze(['app', 'ui', 'agent']);

/**
 * The release tag this run rolls out, and the commit the tag must name when the
 * run was started by the Docker Images workflow finishing for a tag push.
 */
export function releaseTagFromTrigger({ eventName, inputTag, workflowRun = {} }) {
  if (eventName === 'workflow_dispatch') {
    if (!RELEASE_TAG.test(inputTag ?? '')) throw new Error('release_tag must look like v<major>.<minor>.<patch>, for example v0.9.3');
    return { releaseTag: inputTag, expectedSourceRevision: undefined };
  }
  if (eventName === 'workflow_run') {
    if (workflowRun.conclusion !== 'success' || workflowRun.event !== 'push' || !RELEASE_TAG.test(workflowRun.headBranch ?? '')
      || !SHA.test(workflowRun.headSha ?? '')) {
      throw new Error('Release Rollout starts automatically only after Docker Images succeeds for a v<major>.<minor>.<patch> tag push');
    }
    return { releaseTag: workflowRun.headBranch, expectedSourceRevision: workflowRun.headSha };
  }
  throw new Error(`Release Rollout cannot run for ${eventName} events`);
}

const defaultGit = args => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const gitSucceeds = (git, args) => {
  try {
    git(args);
    return true;
  } catch {
    return false;
  }
};

const versionAt = (git, revision, path) => {
  try {
    return JSON.parse(git(['show', `${revision}:${path}`])).version;
  } catch {
    return undefined;
  }
};

/** The tag commit, bound to the reviewed main revision this workflow runs from. */
export function resolveSource({ releaseTag, expectedSourceRevision, workflowSha, dispatchRef, git = defaultGit }) {
  const [, version] = RELEASE_TAG.exec(releaseTag ?? '') ?? [];
  if (!version) throw new Error('release_tag must look like v<major>.<minor>.<patch>');
  if (dispatchRef !== MAIN_REF) throw new Error('Run Release Rollout from the main branch workflow only');
  if (!SHA.test(workflowSha ?? '') || git(['rev-parse', '--verify', 'HEAD^{commit}']) !== workflowSha) {
    throw new Error('The plan checkout must be the reviewed main workflow revision');
  }
  let sourceRevision;
  try {
    sourceRevision = git(['rev-parse', '--verify', `refs/tags/${releaseTag}^{commit}`]);
  } catch {
    throw new Error(`Release tag ${releaseTag} does not exist in this repository`);
  }
  if (!SHA.test(sourceRevision)) throw new Error(`Release tag ${releaseTag} does not name a commit`);
  if (expectedSourceRevision !== undefined && expectedSourceRevision !== sourceRevision) {
    throw new Error(`Release tag ${releaseTag} names ${sourceRevision}, not the released commit ${expectedSourceRevision}`);
  }
  if (!gitSucceeds(git, ['merge-base', '--is-ancestor', sourceRevision, workflowSha])) {
    throw new Error(`The ${releaseTag} tag commit ${sourceRevision} is not reachable from the reviewed main revision`);
  }
  if (versionAt(git, sourceRevision, 'package.json') !== version) {
    throw new Error(`package.json at ${releaseTag} does not have version ${version}`);
  }
  const desktopVersion = versionAt(git, sourceRevision, 'apps/desktop/package.json');
  if (typeof desktopVersion !== 'string' || !SEMVER.test(desktopVersion)) {
    throw new Error(`apps/desktop/package.json at ${releaseTag} has no canonical semantic version`);
  }
  return { releaseTag, sourceRevision, version, desktopVersion };
}

const targetAssets = (id, version) => {
  const target = TARGETS.find(candidate => candidate.id === id);
  if (!target) throw new Error(`Release rollout target ${id} is missing`);
  return target.assets.map(asset => asset.replaceAll('{version}', version));
};

/** The immutable preview prerelease tags this source revision publishes. */
export const previewReleases = ({ desktopVersion, sourceRevision }) => ({
  linux: {
    tag: `${previewTag('linux', desktopVersion, sourceRevision)}-all-signed`,
    assets: targetAssets('desktop:linux', desktopVersion),
  },
  macos: {
    tag: previewTag('macos', desktopVersion, sourceRevision),
    assets: targetAssets('desktop:macos', desktopVersion),
  },
});

/**
 * The published prerelease at exactly this tag, or null when there is none.
 * Drafts are not returned by the tag lookup, so an unpublished draft from an
 * earlier run is null here and the chain resumes it. A published release that
 * lacks an expected asset is a broken immutable artefact: stop and say so.
 */
export async function publishedPreviewRelease({ tag, assets, repository = REPOSITORY, token, fetchImpl = fetch }) {
  const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetchImpl(`https://api.github.com/repos/${repository}/releases/tags/${encodeURIComponent(tag)}`, { headers });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Could not read release ${tag}: HTTP ${response.status}`);
  const release = await response.json();
  if (release?.tag_name !== tag || release.draft !== false || release.prerelease !== true || !release.published_at) {
    throw new Error(`Release ${tag} exists but is not a published preview prerelease`);
  }
  const names = new Set((Array.isArray(release.assets) ? release.assets : []).map(asset => asset?.name));
  const absent = assets.filter(name => !names.has(name));
  if (absent.length) throw new Error(`Published preview ${tag} is missing ${absent.join(', ')}; it is immutable, so repair it by hand`);
  return { tag, url: release.html_url };
}

export async function planRollout({
  eventName, inputTag, workflowRun, workflowSha, dispatchRef, token,
  git = defaultGit, fetchImpl = fetch, inspectRuntime = inspectPublishedRuntime,
}) {
  const trigger = releaseTagFromTrigger({ eventName, inputTag, workflowRun });
  const source = resolveSource({ ...trigger, workflowSha, dispatchRef, git });
  const runtime = inspectRuntime(source.sourceRevision);
  const releases = previewReleases(source);
  const [linux, macos] = await Promise.all(['linux', 'macos'].map(channel =>
    publishedPreviewRelease({ ...releases[channel], token, fetchImpl })));
  return { ...source, runtime, releases, published: { linux, macos } };
}

export function rolloutOutputs(plan) {
  const { app, ui, agent } = plan.runtime;
  return {
    release_tag: plan.releaseTag,
    source_revision: plan.sourceRevision,
    version: plan.version,
    desktop_version: plan.desktopVersion,
    // The desktop pre-release tags this tag commit publishes (or already has).
    linux_release_tag: plan.releases.linux.tag,
    macos_release_tag: plan.releases.macos.tag,
    runtime_app_image: app ?? '',
    runtime_ui_image: ui ?? '',
    runtime_agent_image: agent ?? '',
    // Both app and UI publish together; an existing one of the pair is reused.
    publish_agent: String(!agent),
    publish_app_ui: String(!(app && ui)),
    linux: String(!plan.published.linux),
    macos: String(!plan.published.macos),
  };
}

export function planSummary(plan) {
  const runtimeRow = (label, reference, operation) =>
    `| ${label} | ${reference ? `already published: \`${reference}\`` : `publish (Preview Runtime Images \`${operation}\`)`} |`;
  const releaseRow = (label, channel) => {
    const published = plan.published[channel];
    return `| ${label} | ${published ? `already published: [\`${published.tag}\`](${published.url})` : `build and publish \`${plan.releases[channel].tag}\``} |`;
  };
  return [
    `### Release rollout plan for ${plan.releaseTag}`,
    '',
    `Source revision (tag commit): \`${plan.sourceRevision}\``,
    '',
    '| Step | Plan |',
    '| --- | --- |',
    runtimeRow('Managed agent image', plan.runtime.agent, 'publish-agent'),
    runtimeRow('App image', plan.runtime.app, 'publish'),
    runtimeRow('UI image', plan.runtime.ui, 'publish'),
    releaseRow('Desktop Linux preview (draft, signing, publication)', 'linux'),
    releaseRow('Desktop macOS preview', 'macos'),
    '| Preview CLI bundle | prepare a run-specific artifact (publishes nothing) |',
    '',
    'Each protected environment still waits for its reviewers.',
    '',
  ].join('\n');
}

/**
 * The reference a downstream step receives: this run's publication, else the
 * existing one the plan found, else (a publication whose digest did not arrive)
 * the image the registry now holds at the source revision tag.
 *
 * `published` holds digests only. Each is rebuilt into
 * `<namespace>/<image>:<source>@<digest>` and verified: the source revision tag
 * must exist in the registry, satisfy the preview contract, and resolve to the
 * same digest. `inspect(image)` is the anonymous registry lookup the plan uses.
 */
export function runtimeReferences({
  sourceRevision, published = {}, existing = {},
  inspect = image => inspectPublishedRuntimeImage(image, sourceRevision),
}) {
  if (!SHA.test(sourceRevision ?? '')) throw new Error('source_revision must be a full lowercase commit SHA');
  return Object.fromEntries(RUNTIME_IMAGES.map(image => {
    const tag = `${RUNTIME_NAMESPACE}/${image}:${sourceRevision}`;
    const digest = published[image];
    let reference;
    if (digest) {
      if (!DIGEST.test(digest)) throw new Error(`The published ${image} digest is not sha256:<64 lowercase hex>: ${digest}`);
      const remote = inspect(image);
      if (!remote) throw new Error(`This run published ${tag}@${digest}, but ${tag} is not in the registry`);
      if (remote.digest !== digest) {
        throw new Error(`This run published ${tag}@${digest}, but the registry resolves ${tag} to ${remote.digest}`);
      }
      reference = `${tag}@${digest}`;
    } else if (existing[image]) {
      reference = existing[image];
    } else {
      reference = inspect(image)?.reference;
    }
    if (!new RegExp(`^${RUNTIME_NAMESPACE}/${image}:${sourceRevision}@sha256:[0-9a-f]{64}$`).test(reference ?? '')) {
      throw new Error(`No published ${tag}@sha256:<digest> reference is available`);
    }
    return [`runtime_${image}_image`, reference];
  }));
}

export const formatOutputs = outputs => Object.entries(outputs).map(([name, value]) => {
  if (/[\r\n]/.test(value)) throw new Error(`Output ${name} must be a single line`);
  return `${name}=${value}\n`;
}).join('');

const main = async (command, env = process.env) => {
  if (command === 'plan') {
    const plan = await planRollout({
      eventName: env.EVENT_NAME,
      inputTag: env.RELEASE_TAG,
      workflowRun: {
        conclusion: env.RUN_CONCLUSION, event: env.RUN_EVENT, headBranch: env.RUN_HEAD_BRANCH, headSha: env.RUN_HEAD_SHA,
      },
      workflowSha: env.WORKFLOW_SHA,
      dispatchRef: env.DISPATCH_REF,
      token: env.GITHUB_TOKEN,
    });
    const outputs = formatOutputs(rolloutOutputs(plan));
    if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, outputs);
    if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, planSummary(plan));
    process.stdout.write(outputs);
  } else if (command === 'runtime') {
    const references = runtimeReferences({
      sourceRevision: env.SOURCE_REVISION,
      published: { app: env.PUBLISHED_APP_DIGEST, ui: env.PUBLISHED_UI_DIGEST, agent: env.PUBLISHED_AGENT_DIGEST },
      existing: { app: env.EXISTING_APP_IMAGE, ui: env.EXISTING_UI_IMAGE, agent: env.EXISTING_AGENT_IMAGE },
    });
    const outputs = formatOutputs(references);
    if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, outputs);
    if (env.GITHUB_STEP_SUMMARY) {
      appendFileSync(env.GITHUB_STEP_SUMMARY, ['### Verified runtime images', '',
        ...Object.values(references).map(reference => `- \`${reference}\``), '', ''].join('\n'));
    }
    process.stdout.write(outputs);
  } else {
    throw new Error('Usage: release-rollout-plan.mjs <plan|runtime>');
  }
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv[2]).catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
