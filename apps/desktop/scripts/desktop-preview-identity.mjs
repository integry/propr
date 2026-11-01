// Binds an unsigned desktop preview (Linux or macOS) to a frozen source revision
// reachable from the dispatched main workflow, and validates the three pinned
// runtime images. Both preview workflows run this from a full-history checkout
// of the reviewed main revision, never from the frozen source itself, so an old
// source revision cannot weaken the checks.
import { execFile as execFileCallback } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const SHA = /^[a-f0-9]{40}$/;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const MAIN_REF = 'refs/heads/main';

// Each channel names the files its frozen source must already contain so the
// build and staging steps (which run from that source) know the channel.
export const PREVIEW_CHANNELS = Object.freeze({
  linux: Object.freeze({
    title: 'Desktop Linux Preview Release',
    tagPrefix: 'desktop-linux-preview',
    requiredSourceFiles: Object.freeze([]),
  }),
  macos: Object.freeze({
    title: 'Desktop macOS Preview Release',
    tagPrefix: 'desktop-macos-preview',
    requiredSourceFiles: Object.freeze([
      'apps/desktop/scripts/macos-preview-release.mjs',
      'apps/desktop/scripts/sign-darwin-local-package.mjs',
    ]),
  }),
});

const runtimeImageRules = [
  ['runtimeAppImage', 'runtime_app_image', 'app',
    sha => `runtime_app_image must be a published, digest-pinned propr/app image tagged with ${sha}.`],
  ['runtimeUiImage', 'runtime_ui_image', 'ui',
    sha => `runtime_ui_image must be a published, digest-pinned propr/ui image tagged with ${sha}.`],
  // First-user task setup pulls the managed agent from the packaged launcher
  // manifest; never fall back to its unpublished version tag.
  ['runtimeAgentImage', 'runtime_agent_image', 'agent',
    sha => `runtime_agent_image must be a published, digest-pinned linux/amd64 propr/agent image tagged with ${sha} (Preview Runtime Images publish-agent).`],
];

export const previewTag = (channel, version, sourceRevision) => {
  const definition = PREVIEW_CHANNELS[channel];
  if (!definition || !VERSION.test(version) || !SHA.test(sourceRevision)) {
    throw new Error('Desktop preview identity requires a known channel, semantic version, and full lowercase source revision');
  }
  return `${definition.tagPrefix}-v${version}-${sourceRevision.slice(0, 12)}`;
};

const defaultGit = async (args, { cwd }) => (await execFile('git', args, { cwd, maxBuffer: 1024 * 1024 })).stdout;

const gitSucceeds = async (git, args, cwd) => {
  try {
    await git(args, { cwd });
    return true;
  } catch {
    return false;
  }
};

export const resolveDesktopPreviewIdentity = async ({
  channel,
  dispatchRef,
  requestedSha,
  workflowSha,
  runtimeAppImage,
  runtimeUiImage,
  runtimeAgentImage,
  cwd = process.cwd(),
  git = defaultGit,
}) => {
  const definition = PREVIEW_CHANNELS[channel];
  if (!definition) throw new Error(`Unsupported desktop preview channel: ${channel}`);
  if (dispatchRef !== MAIN_REF) {
    throw new Error(`Dispatch ${definition.title} from the main branch workflow only.`);
  }
  if (typeof requestedSha !== 'string' || !SHA.test(requestedSha)) {
    throw new Error('source_revision must be a full lowercase 40-character commit SHA.');
  }
  if (typeof workflowSha !== 'string' || !SHA.test(workflowSha)
    || (await git(['rev-parse', '--verify', 'HEAD^{commit}'], { cwd })).trim() !== workflowSha) {
    throw new Error('The identity checkout must be the dispatched main workflow revision.');
  }
  if ((await git(['rev-parse', '--verify', `${requestedSha}^{commit}`], { cwd }).catch(() => '')).trim() !== requestedSha) {
    throw new Error('source_revision is not a commit in this repository.');
  }
  if (!await gitSucceeds(git, ['merge-base', '--is-ancestor', requestedSha, workflowSha], cwd)) {
    throw new Error('source_revision must already be reachable from the dispatched main revision.');
  }
  let version;
  try {
    version = JSON.parse(await git(['show', `${requestedSha}:apps/desktop/package.json`], { cwd })).version;
  } catch {
    version = undefined;
  }
  if (typeof version !== 'string' || !VERSION.test(version)) {
    throw new Error('apps/desktop/package.json must contain a canonical semantic package version.');
  }
  for (const path of definition.requiredSourceFiles) {
    if (!await gitSucceeds(git, ['cat-file', '-e', `${requestedSha}:${path}`], cwd)) {
      throw new Error(`source_revision predates the ${definition.title} tooling (${path} is missing); choose a newer main revision.`);
    }
  }
  const images = { runtimeAppImage, runtimeUiImage, runtimeAgentImage };
  for (const [key, , repository, message] of runtimeImageRules) {
    const value = images[key];
    const pattern = new RegExp(`^propr/${repository}:${requestedSha}@sha256:[a-f0-9]{64}$`);
    if (typeof value !== 'string' || !pattern.test(value)) throw new Error(message(requestedSha));
  }
  const sourceDateEpoch = (await git(['show', '-s', '--format=%ct', requestedSha], { cwd })).trim();
  if (!/^[1-9]\d*$/.test(sourceDateEpoch)) throw new Error('source_revision has no usable commit timestamp.');
  return {
    release_sha: requestedSha,
    version,
    tag: previewTag(channel, version, requestedSha),
    source_date_epoch: sourceDateEpoch,
    runtime_app_image: runtimeAppImage,
    runtime_ui_image: runtimeUiImage,
    runtime_agent_image: runtimeAgentImage,
  };
};

export const formatGithubOutputs = outputs => Object.entries(outputs)
  .map(([name, value]) => {
    if (/[\r\n]/.test(value)) throw new Error(`Preview identity output ${name} must be a single line`);
    return `${name}=${value}\n`;
  }).join('');

const argument = name => {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
};

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const identity = await resolveDesktopPreviewIdentity({
      channel: argument('--channel'),
      dispatchRef: process.env.DISPATCH_REF,
      requestedSha: process.env.REQUESTED_SHA,
      workflowSha: process.env.WORKFLOW_SHA,
      runtimeAppImage: process.env.RUNTIME_APP_IMAGE,
      runtimeUiImage: process.env.RUNTIME_UI_IMAGE,
      runtimeAgentImage: process.env.RUNTIME_AGENT_IMAGE,
    });
    process.stdout.write(formatGithubOutputs(identity));
  } catch (error) {
    console.error((error instanceof Error ? error : new Error(String(error))).message);
    process.exitCode = 1;
  }
}
