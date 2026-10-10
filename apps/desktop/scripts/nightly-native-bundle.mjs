#!/usr/bin/env node

// Consolidates the Tier 3 nightly's unsigned native desktop packages into one
// GitHub Actions artifact with a provenance manifest and a run summary. It only
// repackages bytes that `release-artifacts.mjs finalize` already verified in the
// same run; it never builds, signs, publishes, tags, or updates a feed. See
// "Nightly native builds" in apps/desktop/README.md.

import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import {
  expectedProfileArtifacts,
  MACOS_LINUX_RELEASE_PROFILE,
  resolveReleaseProfile,
} from './release-profiles.mjs';
import { validateDesktopRuntimeManifest } from './desktop-runtime-manifest.mjs';

const execFile = promisify(execFileCallback);

const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SHA = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const POSITIVE_INTEGER = /^[1-9]\d*$/;
const DIGEST_PINNED = /@sha256:[a-f0-9]{64}$/;

export const NIGHTLY_SCHEMA_VERSION = 1;
export const NIGHTLY_PROFILE = MACOS_LINUX_RELEASE_PROFILE;
export const NIGHTLY_MANIFEST = 'nightly-manifest.json';
export const NIGHTLY_NOTES = 'NIGHTLY.md';
export const CHECKSUMS = 'SHA256SUMS';
const FINAL_MANIFEST = 'desktop-release.json';

// Every nightly job whose outcome bears on the bundle. `job` names the caller's
// `needs` key; `output` names a step outcome the E2E job exports, because its
// test steps continue on error and only the step outcome says which one failed.
export const NIGHTLY_CHECKS = Object.freeze([
  { id: 'native-packaging', label: 'Native packaging, install lifecycle, and checksum finalization', job: 'desktop-package' },
  { id: 'packaged-connect', label: 'Packaged Connect discovery', job: 'desktop-connect' },
  { id: 'native-electron', label: 'Native Electron units', job: 'native-electron' },
  { id: 'full-test-suite', label: 'Full test suite', job: 'e2e-tests', output: 'full_tests' },
  { id: 'live-e2e-configuration', label: 'Live E2E configuration', job: 'e2e-tests', output: 'e2e_config' },
  { id: 'live-e2e', label: 'Live E2E (plan generation and model tasks)', job: 'e2e-tests', output: 'e2e_tests' },
  { id: 'e2e-job', label: 'Run E2E Test Suite job', job: 'e2e-tests' },
].map(check => Object.freeze(check)));

const OUTCOMES = new Set(['success', 'failure', 'cancelled', 'skipped']);

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

const parseNeeds = needs => {
  const value = typeof needs === 'string' ? JSON.parse(needs || '{}') : needs;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('NEEDS_JSON must be an object');
  return value;
};

// A missing or unrecognised outcome is reported as `not-run`, never as success.
export const readNightlyChecks = needs => {
  const parsed = parseNeeds(needs);
  return NIGHTLY_CHECKS.map(({ id, label, job, output }) => {
    const raw = output ? parsed[job]?.outputs?.[output] : parsed[job]?.result;
    return { id, label, outcome: OUTCOMES.has(raw) ? raw : 'not-run' };
  });
};

// Packaging success makes a download available; it says nothing about the rest
// of the nightly. Only a run where every check succeeded is a release-validation
// candidate, and no nightly is ever promotable: production installers are
// rebuilt and signed from a protected tag.
export const classifyNightly = checks => {
  const packaging = checks.find(check => check.id === 'native-packaging')?.outcome === 'success' ? 'passed' : 'not-passed';
  const blockers = checks.filter(check => check.outcome !== 'success');
  const nightly = blockers.some(check => check.outcome === 'failure')
    ? 'failed'
    : blockers.length ? 'incomplete' : 'passed';
  return {
    packaging,
    nightly,
    releaseValidationCandidate: packaging === 'passed' && nightly === 'passed',
    promotable: false,
    blockers: blockers.map(check => `${check.label}: ${check.outcome}`),
  };
};

const runContext = run => {
  const { repository, id, attempt, serverUrl, workflow, ref, eventName } = run ?? {};
  if (!REPOSITORY.test(repository ?? '')) throw new Error('Nightly run repository is missing or invalid');
  if (!POSITIVE_INTEGER.test(String(id ?? '')) || !POSITIVE_INTEGER.test(String(attempt ?? ''))) {
    throw new Error('Nightly run ID and attempt must be positive integers');
  }
  const server = new URL(serverUrl ?? '');
  if (server.protocol !== 'https:' || server.username || server.password || server.search || server.hash) {
    throw new Error('Nightly server URL must be a plain HTTPS origin');
  }
  const base = `${server.origin}/${repository}`;
  return {
    repository,
    id: Number(id),
    attempt: Number(attempt),
    url: `${base}/actions/runs/${id}/attempts/${attempt}`,
    workflow: workflow ?? null,
    ref: ref ?? null,
    eventName: eventName ?? null,
    repositoryUrl: base,
  };
};

export const nightlyArtifactName = ({ version, sourceSha, runId, runAttempt, nightly }) => (
  `propr-desktop-nightly-${version}-${sourceSha.slice(0, 12)}-run${runId}.${runAttempt}-`
  + (nightly === 'passed' ? 'all-checks-passed' : 'packaging-only')
);

const parseChecksums = contents => {
  const entries = new Map();
  for (const line of contents.split('\n').filter(Boolean)) {
    const match = /^([a-f0-9]{64}) {2}([^/\\\s]+)$/.exec(line);
    if (!match || entries.has(match[2])) throw new Error(`Malformed or duplicate ${CHECKSUMS} line`);
    entries.set(match[2], match[1]);
  }
  return entries;
};

const sameMembers = (actual, expected) => {
  const sorted = [...expected].sort();
  return actual.length === sorted.length && [...actual].sort().every((name, index) => name === sorted[index]);
};

// Re-reads what `finalize` wrote and refuses anything other than the complete
// canonical matrix, byte-for-byte equal to its manifest and checksum list.
export const verifyFinalizedDirectory = async ({ directory, version }) => {
  const profile = resolveReleaseProfile(NIGHTLY_PROFILE);
  const expected = expectedProfileArtifacts(profile, version);
  const names = await readdir(directory);
  if (!sameMembers(names, [...expected.keys(), FINAL_MANIFEST, CHECKSUMS])) {
    throw new Error(`Finalized native directory does not contain exactly the ${profile.name} matrix`);
  }
  const final = JSON.parse(await readFile(join(directory, FINAL_MANIFEST), 'utf8'));
  if (final.schemaVersion !== 2 || final.releaseProfile !== profile.name || final.version !== version
    || !Array.isArray(final.artifacts) || final.artifacts.length !== expected.size) {
    throw new Error('Finalized native manifest does not match the nightly version and profile');
  }
  // Nightly packaging is unsigned validation: production signer evidence or an
  // update feed here would mean the bytes came from somewhere else.
  if (JSON.stringify(final.nativeSigners) !== '{}' || JSON.stringify(final.feeds) !== '{}') {
    throw new Error('Nightly native packages must carry no production signer evidence or update feed');
  }
  const checksums = parseChecksums(await readFile(join(directory, CHECKSUMS), 'utf8'));
  if (!sameMembers([...checksums.keys()], [...expected.keys()])) {
    throw new Error(`${CHECKSUMS} does not list exactly the canonical installers`);
  }
  const artifacts = [];
  for (const artifact of final.artifacts) {
    const target = expected.get(artifact?.fileName);
    if (!target || artifact.platform !== target.platform || artifact.arch !== target.arch || artifact.kind !== target.kind
      || !SHA256.test(artifact.sha256 ?? '') || !Number.isSafeInteger(artifact.size) || artifact.size <= 0) {
      throw new Error(`Finalized native manifest has an invalid artifact entry: ${artifact?.fileName ?? '<missing>'}`);
    }
    const bytes = await readFile(join(directory, artifact.fileName));
    if (bytes.length !== artifact.size || sha256(bytes) !== artifact.sha256 || checksums.get(artifact.fileName) !== artifact.sha256) {
      throw new Error(`Native artifact bytes do not match their manifest and checksum: ${artifact.fileName}`);
    }
    artifacts.push({
      fileName: artifact.fileName,
      platform: artifact.platform,
      arch: artifact.arch,
      kind: artifact.kind,
      size: artifact.size,
      sha256: artifact.sha256,
      architectureEvidence: artifact.architectureEvidence,
    });
  }
  if (new Set(artifacts.map(artifact => artifact.fileName)).size !== expected.size) {
    throw new Error('Finalized native manifest repeats an artifact');
  }
  artifacts.sort((left, right) => left.fileName.localeCompare(right.fileName));
  return { profile, artifacts };
};

// Linux ZIPs carry the launcher manifest that guided setup pulls runtime images
// from. Unsigned validation packaging embeds the checked-in launcher pins, so
// the binding is reported as found rather than assumed.
export const readLinuxZipRuntimeManifest = async ({ path, arch }) => {
  const { stdout } = await execFile('unzip', ['-p', path, `propr-desktop-linux-${arch}/resources/manifest.json`], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
  return stdout;
};

export const describeRuntimeBinding = ({ manifests, sourceSha }) => {
  const contents = [...new Set(manifests.map(({ contents: value }) => value))];
  if (manifests.length === 0 || contents.length !== 1) {
    throw new Error('Linux nightly packages must embed one identical runtime launcher manifest');
  }
  let parsed;
  try { parsed = JSON.parse(contents[0]); } catch { throw new Error('Linux nightly runtime launcher manifest is not JSON'); }
  const images = parsed?.images;
  if (!images || typeof images !== 'object' || typeof images.app !== 'string' || typeof images.ui !== 'string') {
    throw new Error('Linux nightly runtime launcher manifest does not name app and UI images');
  }
  const runtime = parsed.desktopRuntime;
  const runtimeSource = typeof runtime?.sourceRevision === 'string' ? runtime.sourceRevision : null;
  const pinned = [images.app, images.ui].every(image => DIGEST_PINNED.test(image));
  // A bound manifest must pass the same validator the release and preview
  // workflows use (image repositories, full-SHA tags, digests, git_sha and the
  // managed-agent binding) before any source claim is made. Conflicting bound
  // metadata is reported as invalid, never as current source.
  let bindingError = null;
  if (runtime !== undefined) {
    try { validateDesktopRuntimeManifest(parsed, { distribution: 'published' }); }
    catch (error) { bindingError = error instanceof Error ? error.message : String(error); }
  }
  const binding = runtime === undefined
    ? 'unbound'
    : bindingError ? 'invalid' : runtimeSource === sourceSha ? 'source-aligned' : 'other-source';
  return {
    binding,
    currentSource: binding === 'source-aligned',
    bindingError,
    manifestSha256: sha256(contents[0]),
    launcherSourceRevision: typeof parsed.git_sha === 'string' ? parsed.git_sha : null,
    runtimeSourceRevision: runtimeSource,
    distribution: typeof runtime?.distribution === 'string' ? runtime.distribution : null,
    images: Object.fromEntries(['app', 'ui', 'agent']
      .filter(key => typeof images[key] === 'string')
      .map(key => [key, images[key]])),
    digestPinned: pinned,
  };
};

const SIGNING_BY_TARGET = Object.freeze({
  'linux-x64': 'unsigned',
  'linux-arm64': 'unsigned',
  'darwin-x64': 'unsigned (no Developer ID signature, not notarized)',
  'darwin-arm64': 'ad-hoc local signature only (no Developer ID signature, not notarized)',
});

const limitations = runtime => [
  'Unsigned validation build: Linux packages are unsigned, macOS apps have no Developer ID signature and are not notarized, and no update metadata is signed.',
  'Self-update is not configured; install newer nightlies manually.',
  runtime.currentSource
    ? 'Linux guided setup is bound to digest-pinned runtime images from this exact source revision.'
    : `Linux guided setup pulls the runtime images named in the packaged launcher manifest (${Object.values(runtime.images).join(', ')}); `
      + 'they are not built from this nightly\'s source, so this download is not a current-source end-to-end runtime build.',
  'macOS packages have no guided local setup; they connect to an existing ProPR instance, which runs whatever source it was deployed from.',
  'Live E2E runs against a separately deployed backend. This run does not attest which source that backend runs, and it covers the configured model-pair subset rather than every provider.',
  'Not promotable: production installers are rebuilt, signed, notarized, runtime-bound, and published only by the protected desktop-v* tag workflow.',
];

export const createNightlyManifest = ({ version, sourceSha, run, needs, artifacts, runtime, e2eModelPairs, createdAt }) => {
  if (!VERSION.test(version ?? '')) throw new Error(`Invalid desktop nightly version: ${version}`);
  if (!SHA.test(sourceSha ?? '')) throw new Error('Nightly source SHA must be a full lowercase commit SHA');
  const context = runContext(run);
  const checks = readNightlyChecks(needs);
  const status = classifyNightly(checks);
  if (status.packaging !== 'passed') throw new Error('Native packaging did not pass; the consolidated bundle is withheld');
  const profile = resolveReleaseProfile(NIGHTLY_PROFILE);
  return {
    schemaVersion: NIGHTLY_SCHEMA_VERSION,
    kind: 'propr-desktop-nightly',
    distribution: 'github-actions-artifact',
    externalPublication: 'none',
    artifactName: nightlyArtifactName({
      version, sourceSha, runId: context.id, runAttempt: context.attempt, nightly: status.nightly,
    }),
    version,
    releaseProfile: profile.name,
    createdAt,
    source: {
      repository: context.repository,
      sha: sourceSha,
      ref: context.ref,
      commitUrl: `${context.repositoryUrl}/commit/${sourceSha}`,
    },
    run: {
      id: context.id,
      attempt: context.attempt,
      url: context.url,
      workflow: context.workflow,
      event: context.eventName,
    },
    platforms: [...profile.targets].map(([target, formats]) => ({
      target,
      formats: [...formats],
      signing: SIGNING_BY_TARGET[target] ?? 'unsigned',
    })),
    artifacts,
    signing: {
      status: 'unsigned-validation',
      notarized: false,
      updateMetadataSigned: false,
      updateFeeds: 'none',
    },
    runtime: {
      linux: runtime,
      darwin: { binding: 'not-applicable', note: 'No guided local setup; connects to an existing ProPR instance.' },
    },
    liveE2E: {
      backendSourceAttestation: 'unavailable',
      modelPairLimit: POSITIVE_INTEGER.test(String(e2eModelPairs ?? '')) ? Number(e2eModelPairs) : null,
      allProviders: false,
    },
    checks,
    status,
    limitations: limitations(runtime),
  };
};

const statusHeadline = status => (status.nightly === 'passed'
  ? 'All nightly checks passed. This is a release-validation candidate, not a release: it is unsigned and not promotable.'
  : `Packaging-only download. The nightly ${status.nightly === 'failed' ? 'failed' : 'is incomplete'}, so this build is not ready for release validation or promotion.`);

export const nightlyInstallNotes = manifest => `# ProPR Desktop nightly ${manifest.version}

${statusHeadline(manifest.status)}

- Source: \`${manifest.source.sha}\` (${manifest.source.commitUrl})
- Workflow run: ${manifest.run.url} (run ${manifest.run.id}, attempt ${manifest.run.attempt})
- Manifest: \`${NIGHTLY_MANIFEST}\` binds every file below to that source and run.
${manifest.status.blockers.length ? `\nBlocking checks:\n\n${manifest.status.blockers.map(blocker => `- ${blocker}`).join('\n')}\n` : ''}
## Verify

\`\`\`sh
sha256sum --check ${CHECKSUMS}                       # Linux
shasum -a 256 --check ${CHECKSUMS}                   # macOS
\`\`\`

## Install

Linux (pick DEB or RPM, never both; use \`arm64\` on ARM hosts):

\`\`\`sh
sudo apt install ./ProPR-Desktop-${manifest.version}-linux-x64.deb   # Debian, Ubuntu
sudo dnf install ./ProPR-Desktop-${manifest.version}-linux-x64.rpm   # Fedora, RHEL family
# A newer nightly usually keeps the same package version; reinstall it explicitly:
sudo apt install --reinstall ./ProPR-Desktop-${manifest.version}-linux-x64.deb
sudo dnf reinstall ./ProPR-Desktop-${manifest.version}-linux-x64.rpm
\`\`\`

macOS: open \`ProPR-Desktop-${manifest.version}-macos-<arch>.dmg\` (\`arm64\` for Apple Silicon, \`x64\` for Intel) and drag
ProPR to Applications. Gatekeeper blocks the first launch because the app is not notarized; allow it from
System Settings → Privacy & Security → Open Anyway.

## Runtime source

${manifest.runtime.linux.currentSource
    ? `Linux guided setup is bound to runtime images from \`${manifest.source.sha}\`.`
    : `Runtime binding: **${manifest.runtime.linux.binding}**. Linux guided setup pulls the images in the packaged launcher
manifest (${Object.entries(manifest.runtime.linux.images).map(([key, image]) => `${key} \`${image}\``).join(', ')}).
They are not built from this nightly's source. For an exact-source Linux runtime, use the Desktop Linux Preview
Release path in apps/desktop/README.md, which binds digest-pinned app, UI, and agent images to one source revision.`}

## Limitations

${manifest.limitations.map(limitation => `- ${limitation}`).join('\n')}
`;

const assembleBundle = async ({ inputDirectory, outputDirectory, manifest }) => {
  await rm(outputDirectory, { recursive: true, force: true });
  await mkdir(outputDirectory, { recursive: true });
  for (const name of [...manifest.artifacts.map(artifact => artifact.fileName), CHECKSUMS]) {
    await copyFile(join(inputDirectory, name), join(outputDirectory, name));
  }
  await writeFile(join(outputDirectory, NIGHTLY_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(join(outputDirectory, NIGHTLY_NOTES), nightlyInstallNotes(manifest));
};

// Validates a staged or downloaded bundle on its own: the exact file set, every
// installer's digest against both the manifest and SHA256SUMS, and the matrix.
export const verifyNightlyBundle = async ({ directory }) => {
  const manifest = JSON.parse(await readFile(join(directory, NIGHTLY_MANIFEST), 'utf8'));
  if (manifest.schemaVersion !== NIGHTLY_SCHEMA_VERSION || manifest.kind !== 'propr-desktop-nightly'
    || manifest.releaseProfile !== NIGHTLY_PROFILE || !VERSION.test(manifest.version ?? '')
    || !SHA.test(manifest.source?.sha ?? '') || manifest.status?.promotable !== false) {
    throw new Error('Nightly manifest identity is invalid');
  }
  const expected = expectedProfileArtifacts(resolveReleaseProfile(NIGHTLY_PROFILE), manifest.version);
  const names = await readdir(directory);
  if (!sameMembers(names, [...expected.keys(), CHECKSUMS, NIGHTLY_MANIFEST, NIGHTLY_NOTES])) {
    throw new Error('Nightly bundle does not contain exactly the canonical installers and metadata');
  }
  const checksums = parseChecksums(await readFile(join(directory, CHECKSUMS), 'utf8'));
  if (!sameMembers([...checksums.keys()], [...expected.keys()])
    || !sameMembers((manifest.artifacts ?? []).map(artifact => artifact.fileName), [...expected.keys()])) {
    throw new Error('Nightly manifest or checksums do not cover exactly the canonical installers');
  }
  for (const artifact of manifest.artifacts) {
    const target = expected.get(artifact.fileName);
    const bytes = await readFile(join(directory, artifact.fileName));
    if (artifact.platform !== target.platform || artifact.arch !== target.arch || artifact.kind !== target.kind
      || bytes.length !== artifact.size || sha256(bytes) !== artifact.sha256 || checksums.get(artifact.fileName) !== artifact.sha256) {
      throw new Error(`Nightly installer does not match its manifest and checksum: ${artifact.fileName}`);
    }
  }
  if (await readFile(join(directory, NIGHTLY_NOTES), 'utf8') !== nightlyInstallNotes(manifest)) {
    throw new Error(`${NIGHTLY_NOTES} does not match the nightly manifest`);
  }
  return manifest;
};

export const createNightlyBundle = async ({
  inputDirectory,
  outputDirectory,
  version,
  sourceSha,
  run,
  needs,
  e2eModelPairs,
  createdAt = new Date().toISOString(),
  readRuntimeManifest = readLinuxZipRuntimeManifest,
}) => {
  // Classify first: a failed or missing packaging result withholds the bundle
  // before any byte is read.
  if (classifyNightly(readNightlyChecks(needs)).packaging !== 'passed') {
    throw new Error('Native packaging did not pass; the consolidated bundle is withheld');
  }
  const { artifacts } = await verifyFinalizedDirectory({ directory: inputDirectory, version });
  const linuxZips = artifacts.filter(artifact => artifact.platform === 'linux' && artifact.kind === 'zip');
  const manifests = await Promise.all(linuxZips.map(async artifact => ({
    target: `${artifact.platform}-${artifact.arch}`,
    contents: await readRuntimeManifest({ path: join(inputDirectory, artifact.fileName), arch: artifact.arch }),
  })));
  const runtime = describeRuntimeBinding({ manifests, sourceSha });
  const manifest = createNightlyManifest({
    version, sourceSha, run, needs, artifacts, runtime, e2eModelPairs, createdAt,
  });
  await assembleBundle({ inputDirectory, outputDirectory, manifest });
  return verifyNightlyBundle({ directory: outputDirectory });
};

const outcomeMark = outcome => (outcome === 'success' ? '✅' : outcome === 'failure' ? '❌' : '⚠️');

const checksTable = checks => [
  '| Check | Outcome |',
  '| --- | --- |',
  ...checks.map(check => `| ${check.label} | ${outcomeMark(check.outcome)} ${check.outcome} |`),
].join('\n');

export const renderRunSummary = ({ manifest, artifactUrl, artifactDigest }) => {
  const download = artifactUrl ? `[${manifest.artifactName}](${artifactUrl})` : `\`${manifest.artifactName}\` (see the run's Artifacts list)`;
  return `## Nightly desktop download

**${statusHeadline(manifest.status)}**

| | |
| --- | --- |
| Download | ${download} |
| Artifact digest | ${artifactDigest ? `\`${artifactDigest}\`` : 'not reported'} |
| Source | [\`${manifest.source.sha}\`](${manifest.source.commitUrl}) |
| Run | [${manifest.run.id} attempt ${manifest.run.attempt}](${manifest.run.url}) |
| Version | \`${manifest.version}\` (${manifest.releaseProfile}) |
| Native matrix | ${manifest.platforms.map(platform => `${platform.target} (${platform.formats.join(', ')})`).join('; ')} |
| Signing | ${manifest.platforms.map(platform => `${platform.target}: ${platform.signing}`).join('; ')} |
| Linux runtime binding | **${manifest.runtime.linux.binding}**${manifest.runtime.linux.currentSource ? '' : ' (not this source; see limitations)'} |
| Packaging | ${manifest.status.packaging} |
| Nightly | ${manifest.status.nightly} |
| Release-validation candidate | ${manifest.status.releaseValidationCandidate ? 'yes' : 'no'} |
| Promotable | no |

### Checks

${checksTable(manifest.checks)}

### Installers

| File | SHA-256 |
| --- | --- |
${manifest.artifacts.map(artifact => `| \`${artifact.fileName}\` | \`${artifact.sha256}\` |`).join('\n')}

Verify with \`sha256sum --check ${CHECKSUMS}\` after extracting the download. \`${NIGHTLY_NOTES}\` inside the artifact has install
steps; \`${NIGHTLY_MANIFEST}\` is the machine-readable record.

### Limitations

${manifest.limitations.map(limitation => `- ${limitation}`).join('\n')}
`;
};

export const renderWithheldSummary = ({ needs, sourceSha, run, reason }) => {
  const checks = readNightlyChecks(needs);
  const status = classifyNightly(checks);
  const context = runContext(run);
  return `## Nightly desktop download

**No consolidated download for this run.** ${reason}

- Source: \`${sourceSha}\`
- Run: ${context.url}
- Packaging: ${status.packaging}; nightly: ${status.nightly}

${checksTable(checks)}

Per-target \`propr-desktop-validation-*\` artifacts, if any were uploaded, remain diagnostics only. They are not a
verified matrix and must not be used for release validation.
`;
};

// The upload succeeded but the run summary step failed afterwards. The artifact
// exists, so this must not claim it was withheld; it only points at the upload
// and at the manifest inside it for the validation status.
export const renderUnsummarizedSummary = ({ artifactName, artifactUrl, artifactDigest, sourceSha, run }) => {
  const context = runContext(run);
  const name = artifactName ? `\`${artifactName}\`` : 'The consolidated nightly bundle';
  const download = artifactUrl ? `[${artifactName || 'nightly bundle'}](${artifactUrl})` : 'see the run\'s Artifacts list';
  return `## Nightly desktop download

**The download was uploaded, but its run summary could not be generated.** ${name} passed bundle verification
and was uploaded before the summary step failed.

- Download: ${download}
- Artifact digest: ${artifactDigest ? `\`${artifactDigest}\`` : 'not reported'}
- Source: \`${sourceSha}\`
- Run: ${context.url}

The validation status is not repeated here. Read \`${NIGHTLY_MANIFEST}\` inside the download for the packaging, nightly
and release-validation status, and the summary step's log for why it failed.
`;
};

const argument = name => {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
};

const runFromEnvironment = env => ({
  repository: env.GITHUB_REPOSITORY,
  id: env.GITHUB_RUN_ID,
  attempt: env.GITHUB_RUN_ATTEMPT,
  serverUrl: env.GITHUB_SERVER_URL,
  workflow: env.GITHUB_WORKFLOW,
  ref: env.GITHUB_REF,
  eventName: env.GITHUB_EVENT_NAME,
});

const writeSummary = async (env, markdown) => {
  if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY, markdown);
  else process.stdout.write(markdown);
};

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const env = process.env;
  const command = process.argv[2];
  try {
    if (command === 'gate') {
      const status = classifyNightly(readNightlyChecks(env.NEEDS_JSON));
      if (status.packaging !== 'passed') {
        await writeSummary(env, renderWithheldSummary({
          needs: env.NEEDS_JSON,
          sourceSha: env.GITHUB_SHA,
          run: runFromEnvironment(env),
          reason: 'Native packaging did not succeed for every required platform, so no verified installer set exists.',
        }));
        throw new Error('Native packaging did not pass; the consolidated bundle is withheld');
      }
    } else if (command === 'withheld') {
      await writeSummary(env, renderWithheldSummary({
        needs: env.NEEDS_JSON,
        sourceSha: env.GITHUB_SHA,
        run: runFromEnvironment(env),
        reason: 'Re-verification of the native artifacts, checksums, or matrix, or the bundle upload, failed, so no verified download exists.',
      }));
    } else if (command === 'unsummarized') {
      await writeSummary(env, renderUnsummarizedSummary({
        artifactName: env.NIGHTLY_ARTIFACT_NAME || undefined,
        artifactUrl: env.NIGHTLY_ARTIFACT_URL || undefined,
        artifactDigest: env.NIGHTLY_ARTIFACT_DIGEST || undefined,
        sourceSha: env.GITHUB_SHA,
        run: runFromEnvironment(env),
      }));
    } else if (command === 'bundle') {
      const manifest = await createNightlyBundle({
        inputDirectory: resolve(argument('--input') || 'desktop-release-final'),
        outputDirectory: resolve(argument('--output') || 'propr-desktop-nightly'),
        version: argument('--version'),
        sourceSha: env.GITHUB_SHA,
        run: runFromEnvironment(env),
        needs: env.NEEDS_JSON,
        e2eModelPairs: env.PROPR_E2E_MAX_MODEL_PAIRS,
      });
      if (env.GITHUB_OUTPUT) await appendFile(env.GITHUB_OUTPUT, `artifact_name=${manifest.artifactName}\n`);
      console.log(JSON.stringify({ artifactName: manifest.artifactName, status: manifest.status }));
    } else if (command === 'verify') {
      const manifest = await verifyNightlyBundle({ directory: resolve(argument('--directory') || 'propr-desktop-nightly') });
      console.log(JSON.stringify({ artifactName: manifest.artifactName, source: manifest.source.sha, status: manifest.status }));
    } else if (command === 'summary') {
      const manifest = await verifyNightlyBundle({ directory: resolve(argument('--directory') || 'propr-desktop-nightly') });
      await writeSummary(env, renderRunSummary({
        manifest,
        artifactUrl: env.NIGHTLY_ARTIFACT_URL || undefined,
        artifactDigest: env.NIGHTLY_ARTIFACT_DIGEST || undefined,
      }));
    } else {
      throw new Error('Expected nightly-native-bundle.mjs gate, withheld, unsummarized, bundle, verify, or summary command');
    }
  } catch (error) {
    console.error(`::error::${error.message}`);
    process.exitCode = 1;
  }
}
