#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  closeSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE_SHA = /^[0-9a-f]{40}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const ARCHITECTURES = ['amd64', 'arm64'];
const IMAGES = Object.freeze({
  app: 'docker/Dockerfile.app.prod',
  ui: 'propr-ui/Dockerfile',
});
// The managed agent image is deliberately outside IMAGES: it keeps its own
// linux/amd64-only contract (see Dockerfile.agent) and its own prepare/publish
// operations, so the two-architecture app/UI scope above never widens.
const AGENT_IMAGE = 'agent';
const AGENT_DOCKERFILE = 'Dockerfile.agent';
const AGENT_ARCHITECTURES = ['amd64'];
const AGENT_PLATFORM_PIN = 'ARG AGENT_PLATFORM=linux/amd64';
const AGENT_NATIVE_METADATA = 'preview-agent-native.json';
const AGENT_CANDIDATE_METADATA = 'preview-agent-candidate.json';
const AGENT_NATIVE_ARCHIVE = 'agent-linux-amd64.docker.tar';
const AGENT_CANDIDATE_ARCHIVE = 'agent.oci.tar';
// Every credential-free smoke check the agent candidate must have passed.
export const AGENT_SMOKE_CHECKS = Object.freeze([
  'bundled-clis-present',
  'bundled-cli-versions-match-labels',
  'agent-tank-entrypoint',
  'gh-wrapper-through-every-entrypoint',
  'no-baked-provider-credentials',
  'non-root-runtime-user',
]);
const AGENT_CLI_LABELS = Object.freeze({
  claude: 'dev.propr.agent.claude.version',
  codex: 'dev.propr.agent.codex.version',
  antigravity: 'dev.propr.agent.antigravity.version',
  opencode: 'dev.propr.agent.opencode.version',
  vibe: 'dev.propr.agent.vibe.version',
  'agent-tank': 'dev.propr.agent-tank.version',
});
const IMAGE_SOURCE = 'https://github.com/integry/propr';
const REPOSITORY = Object.freeze({ owner: 'integry', name: 'propr' });
const here = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(here, '..');

const argumentsOf = argv => {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith('--') || value === undefined || value.startsWith('--')) {
      throw new Error(`Invalid argument ${name ?? ''}`.trim());
    }
    const key = name.slice(2);
    if (result[key] !== undefined) throw new Error(`Duplicate argument --${key}`);
    result[key] = value;
  }
  return result;
};

const exactKeys = (value, keys, label) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${label} has unexpected fields`);
};

const run = (command, args, options = {}) => execFileSync(command, args, {
  cwd: repositoryRoot,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'inherit'],
  ...options,
}).trim();

const runRegctl = args => run('regctl', args);

// Image archives exceed Node's 2 GiB single-buffer read limit (a real agent
// docker-save archive is ~2.4 GB), so hash them through one reused fixed-size
// buffer instead of readFileSync. Memory stays bounded by HASH_CHUNK_BYTES.
const HASH_CHUNK_BYTES = 8 * 1024 * 1024;

export const sha256File = path => {
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(HASH_CHUNK_BYTES);
  const descriptor = openSync(path, 'r');
  try {
    for (let read; (read = readSync(descriptor, buffer, 0, buffer.length, null)) > 0;) {
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    closeSync(descriptor);
  }
  return hash.digest('hex');
};

const writeJson = (path, value) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o644 });
};

const requireSourceRevision = value => {
  if (!SOURCE_SHA.test(value || '')) throw new Error('source_revision must be a full lowercase 40-character commit SHA');
  return value;
};

const requireArchitecture = value => {
  if (!ARCHITECTURES.includes(value)) throw new Error('architecture must be exactly amd64 or arm64');
  return value;
};

const requireRegularFile = path => {
  const details = lstatSync(path);
  if (!details.isFile() || details.isSymbolicLink()) throw new Error(`Expected a regular artifact file: ${path}`);
};

export function validateRepositoryMetadata(root = repositoryRoot) {
  const packageMetadata = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const url = packageMetadata?.repository?.url;
  if (url !== 'git+https://github.com/integry/propr.git') {
    throw new Error('Repository metadata must identify integry/propr');
  }
  for (const path of Object.values(IMAGES)) requireRegularFile(join(root, path));
  return { repository: REPOSITORY, imageDockerfiles: { ...IMAGES } };
}

export function validateAgentRepositoryMetadata(root = repositoryRoot) {
  const metadata = validateRepositoryMetadata(root);
  const dockerfile = join(root, AGENT_DOCKERFILE);
  requireRegularFile(dockerfile);
  // Preserve the managed image's architecture boundary: refuse a source whose
  // agent Dockerfile no longer declares the linux/amd64-only contract.
  if (!readFileSync(dockerfile, 'utf8').split('\n').includes(AGENT_PLATFORM_PIN)) {
    throw new Error(`${AGENT_DOCKERFILE} must keep the supported ${AGENT_PLATFORM_PIN} contract`);
  }
  return { repository: metadata.repository, agentDockerfile: AGENT_DOCKERFILE, architectures: [...AGENT_ARCHITECTURES] };
}

const OPERATIONS = ['prepare', 'publish', 'prepare-agent', 'publish-agent'];
const isAgentOperation = operation => operation === 'prepare-agent' || operation === 'publish-agent';

export function validateIdentity({ sourceRevision, workflowRevision, dispatchRef, operation }, root = repositoryRoot) {
  requireSourceRevision(sourceRevision);
  requireSourceRevision(workflowRevision);
  if (dispatchRef !== 'refs/heads/main') throw new Error('Dispatch Preview Runtime Images from the main branch workflow only');
  if (!OPERATIONS.includes(operation)) {
    throw new Error('operation must be prepare, publish, prepare-agent, or publish-agent');
  }
  if (isAgentOperation(operation)) validateAgentRepositoryMetadata(root);
  else validateRepositoryMetadata(root);
  const head = run('git', ['rev-parse', 'HEAD'], { cwd: root });
  if (head !== sourceRevision) throw new Error('Checked-out source does not match source_revision');
  const ancestry = spawnSync('git', ['merge-base', '--is-ancestor', sourceRevision, workflowRevision], {
    cwd: root,
    encoding: 'utf8',
  });
  if (ancestry.status !== 0) throw new Error('source_revision must already be reachable from the dispatched main revision');
  return { sourceRevision, workflowRevision, operation };
}

const parseDockerInspection = output => {
  const value = JSON.parse(output);
  return Array.isArray(value) ? value[0] : value;
};

export function validateLocalDockerImageInspection(inspection, image, sourceRevision, architecture) {
  exactKeys(IMAGES, ['app', 'ui'], 'Preview runtime image scope');
  if (!Object.hasOwn(IMAGES, image)) throw new Error(`Unexpected preview runtime image: ${image}`);
  if (inspection?.Os !== 'linux' || inspection?.Architecture !== architecture) {
    throw new Error(`${image} artifact must be native linux/${architecture}`);
  }
  const labels = inspection?.Config?.Labels;
  if (labels?.['org.opencontainers.image.revision'] !== sourceRevision
    || labels?.['org.opencontainers.image.source'] !== IMAGE_SOURCE) {
    throw new Error(`${image} artifact is not labelled for the exact integry/propr source revision`);
  }
  if (!DIGEST.test(inspection?.Id || '')) throw new Error(`${image} artifact has an invalid config digest`);
  return inspection;
}

const validateAgentBundleLabels = labels => {
  if (labels?.['dev.propr.agent-bundle'] !== 'true') throw new Error('agent artifact is not the unified ProPR agent bundle');
  for (const [cli, label] of Object.entries(AGENT_CLI_LABELS)) {
    if (typeof labels?.[label] !== 'string' || !/^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/.test(labels[label])) {
      throw new Error(`agent artifact has no valid bundled ${cli} version label`);
    }
  }
  return labels;
};

export function validateLocalAgentImageInspection(inspection, sourceRevision) {
  requireSourceRevision(sourceRevision);
  if (inspection?.Os !== 'linux' || !AGENT_ARCHITECTURES.includes(inspection?.Architecture)) {
    throw new Error('agent artifact must be the supported linux/amd64 managed image');
  }
  const labels = inspection?.Config?.Labels;
  if (labels?.['org.opencontainers.image.revision'] !== sourceRevision
    || labels?.['org.opencontainers.image.source'] !== IMAGE_SOURCE) {
    throw new Error('agent artifact is not labelled for the exact integry/propr source revision');
  }
  validateAgentBundleLabels(labels);
  if (!DIGEST.test(inspection?.Id || '')) throw new Error('agent artifact has an invalid config digest');
  return inspection;
}

export function validateAgentSmokeEvidence(evidence, { sourceRevision, configDigest, labels }) {
  exactKeys(evidence, [
    'schemaVersion', 'image', 'sourceRevision', 'configDigest', 'platform', 'network', 'credentials', 'checks', 'cliVersions',
  ], 'Agent smoke evidence');
  if (evidence.schemaVersion !== 1 || evidence.image !== `propr/${AGENT_IMAGE}:${sourceRevision}`
    || evidence.sourceRevision !== sourceRevision || evidence.configDigest !== configDigest
    || evidence.platform !== 'linux/amd64' || evidence.network !== 'none' || evidence.credentials !== 'none') {
    throw new Error('Agent smoke evidence does not describe the exact credential-free candidate');
  }
  if (!Array.isArray(evidence.checks)
    || JSON.stringify([...evidence.checks].sort()) !== JSON.stringify([...AGENT_SMOKE_CHECKS].sort())) {
    throw new Error('Agent smoke evidence is missing a required check');
  }
  exactKeys(evidence.cliVersions, Object.keys(AGENT_CLI_LABELS), 'Agent smoke CLI versions');
  for (const [cli, label] of Object.entries(AGENT_CLI_LABELS)) {
    if (evidence.cliVersions[cli] !== labels?.[label]) throw new Error(`Agent smoke ${cli} version does not match its label`);
  }
  return evidence;
}

const packageNativeImages = ({ sourceRevision, architecture, output }) => {
  requireSourceRevision(sourceRevision);
  requireArchitecture(architecture);
  const outputDirectory = resolve(output);
  mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
  const images = {};
  for (const image of Object.keys(IMAGES)) {
    const reference = `propr/${image}:${sourceRevision}`;
    const inspection = parseDockerInspection(run('docker', [
      'image', 'inspect', '--format', '{{json .}}', reference,
    ]));
    validateLocalDockerImageInspection(inspection, image, sourceRevision, architecture);
    const archiveName = `${image}-linux-${architecture}.docker.tar`;
    const archivePath = join(outputDirectory, archiveName);
    run('docker', ['save', '--output', archivePath, reference]);
    requireRegularFile(archivePath);
    images[image] = {
      archive: archiveName,
      sha256: sha256File(archivePath),
      configDigest: inspection.Id,
    };
  }
  const metadata = {
    schemaVersion: 1,
    sourceRevision,
    architecture,
    repository: REPOSITORY,
    images,
  };
  writeJson(join(outputDirectory, 'preview-runtime-native.json'), metadata);
  return metadata;
};

const walk = root => readdirSync(root, { withFileTypes: true }).flatMap(entry => {
  const path = join(root, entry.name);
  if (entry.isSymbolicLink()) throw new Error(`Artifact input contains a symbolic link: ${path}`);
  return entry.isDirectory() ? walk(path) : [path];
});

const validateNativeMetadata = (metadata, sourceRevision, architecture) => {
  exactKeys(metadata, ['schemaVersion', 'sourceRevision', 'architecture', 'repository', 'images'], 'Native metadata');
  if (metadata.schemaVersion !== 1 || metadata.sourceRevision !== sourceRevision
    || metadata.architecture !== architecture) throw new Error(`Native metadata identity mismatch for ${architecture}`);
  exactKeys(metadata.repository, ['owner', 'name'], 'Native repository metadata');
  if (metadata.repository.owner !== REPOSITORY.owner || metadata.repository.name !== REPOSITORY.name) {
    throw new Error('Native artifact repository identity mismatch');
  }
  exactKeys(metadata.images, ['app', 'ui'], 'Native image scope');
  for (const image of Object.keys(IMAGES)) {
    exactKeys(metadata.images[image], ['archive', 'sha256', 'configDigest'], `Native ${image} metadata`);
    if (metadata.images[image].archive !== `${image}-linux-${architecture}.docker.tar`
      || !/^[0-9a-f]{64}$/.test(metadata.images[image].sha256)
      || !DIGEST.test(metadata.images[image].configDigest)) {
      throw new Error(`Native ${image} artifact metadata is invalid`);
    }
  }
  return metadata;
};

const collectNativeArtifacts = (input, sourceRevision) => {
  const root = resolve(input);
  const files = walk(root);
  const metadataPaths = files.filter(path => basename(path) === 'preview-runtime-native.json');
  if (metadataPaths.length !== ARCHITECTURES.length) throw new Error('Expected exactly two native metadata artifacts');
  const result = new Map();
  for (const metadataPath of metadataPaths) {
    const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
    requireArchitecture(metadata.architecture);
    validateNativeMetadata(metadata, sourceRevision, metadata.architecture);
    if (result.has(metadata.architecture)) throw new Error(`Duplicate ${metadata.architecture} native artifact`);
    const directory = dirname(metadataPath);
    for (const image of Object.keys(IMAGES)) {
      const archivePath = join(directory, metadata.images[image].archive);
      requireRegularFile(archivePath);
      if (sha256File(archivePath) !== metadata.images[image].sha256) {
        throw new Error(`${image} linux/${metadata.architecture} archive digest mismatch`);
      }
    }
    result.set(metadata.architecture, { directory, metadata });
  }
  if (result.size !== ARCHITECTURES.length) throw new Error('Native artifact architecture matrix is incomplete');
  const allowed = new Set(metadataPaths);
  for (const { directory, metadata } of result.values()) {
    for (const image of Object.keys(IMAGES)) allowed.add(join(directory, metadata.images[image].archive));
  }
  const unexpected = files.filter(path => !allowed.has(path));
  if (unexpected.length) throw new Error(`Native artifact input contains unexpected file: ${unexpected[0]}`);
  return result;
};

const repositoryReference = reference => reference.replace(/@sha256:[0-9a-f]{64}$/, '').replace(/:[^/:]+$/, '');

const manifestJson = reference => JSON.parse(runRegctl(['manifest', 'get', reference, '--format', 'raw-body']));

const configForManifest = (reference, descriptorDigest) => {
  const repository = repositoryReference(reference);
  const manifest = manifestJson(`${repository}@${descriptorDigest}`);
  if (!manifest || !DIGEST.test(manifest?.config?.digest || '')) throw new Error(`Image manifest ${descriptorDigest} has invalid config`);
  const config = JSON.parse(runRegctl(['blob', 'get', repository, manifest.config.digest]));
  return { manifest, config };
};

const requireKnownImage = image => {
  if (!Object.hasOwn(IMAGES, image) && image !== AGENT_IMAGE) throw new Error(`Unexpected preview runtime image: ${image}`);
};

export function validateRuntimeIndex(index, image, sourceRevision, expectedArchitectures = ARCHITECTURES) {
  requireKnownImage(image);
  const manifests = Array.isArray(index?.manifests) ? index.manifests : [];
  const runnable = manifests.filter(item => item?.platform?.os === 'linux');
  const attestations = manifests.filter(item => item?.platform?.os !== 'linux');
  const platforms = runnable.map(item => `${item?.platform?.os}/${item?.platform?.architecture}`);
  const expected = expectedArchitectures.map(arch => `linux/${arch}`).sort();
  const runnableDigests = new Set(runnable.map(item => item.digest));
  const validAttestations = attestations.every(item =>
    item?.platform?.os === 'unknown'
    && item?.platform?.architecture === 'unknown'
    && item?.annotations?.['vnd.docker.reference.type'] === 'attestation-manifest'
    && runnableDigests.has(item?.annotations?.['vnd.docker.reference.digest']));
  if (runnable.length !== expected.length || JSON.stringify([...platforms].sort()) !== JSON.stringify(expected)
    || manifests.some(item => !DIGEST.test(item?.digest || '')) || !validAttestations) {
    throw new Error(`${image} image must contain exactly ${expected.join(' and ')}`);
  }
  return runnable;
}

const inspectRuntimeReference = (reference, image, sourceRevision, expectedArchitectures = ARCHITECTURES) => {
  requireKnownImage(image);
  const top = manifestJson(reference);
  let descriptors;
  if (Array.isArray(top?.manifests)) {
    descriptors = validateRuntimeIndex(top, image, sourceRevision, expectedArchitectures);
  } else {
    if (expectedArchitectures.length !== 1) throw new Error(`${image} image is not a multi-architecture index`);
    const digest = runRegctl(['image', 'digest', reference]);
    if (!DIGEST.test(digest)) throw new Error(`${image} image has an invalid manifest digest`);
    descriptors = [{ digest, platform: { os: 'linux', architecture: expectedArchitectures[0] } }];
  }
  for (const descriptor of descriptors) {
    const { config } = configForManifest(reference, descriptor.digest);
    const architecture = descriptor.platform.architecture;
    if (config?.os !== 'linux' || config?.architecture !== architecture) {
      throw new Error(`${image} descriptor does not match its linux/${architecture} config`);
    }
    const labels = config?.config?.Labels;
    if (labels?.['org.opencontainers.image.revision'] !== sourceRevision
      || labels?.['org.opencontainers.image.source'] !== IMAGE_SOURCE) {
      throw new Error(`${image} linux/${architecture} is not independently bound to the requested source`);
    }
    if (image === AGENT_IMAGE) validateAgentBundleLabels(labels);
  }
  const digest = runRegctl(['image', 'digest', reference]);
  if (!DIGEST.test(digest)) throw new Error(`${image} image has an invalid top-level digest`);
  return { digest, reference: `propr/${image}:${sourceRevision}@${digest}` };
};

const localReference = (path, tag) => `ocidir://${path}:${tag}`;

const assembleImages = ({ sourceRevision, input, output }) => {
  requireSourceRevision(sourceRevision);
  const native = collectNativeArtifacts(input, sourceRevision);
  const outputDirectory = resolve(output);
  mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
  const work = mkdtempSync(join(tmpdir(), 'propr-preview-runtime-assemble.'));
  const images = {};
  try {
    for (const image of Object.keys(IMAGES)) {
      const target = localReference(join(work, image), sourceRevision);
      runRegctl(['index', 'create', target]);
      for (const architecture of ARCHITECTURES) {
        const artifact = native.get(architecture);
        const source = localReference(join(work, `${image}-${architecture}`), sourceRevision);
        runRegctl(['image', 'import', source, join(artifact.directory, artifact.metadata.images[image].archive)]);
        inspectRuntimeReference(source, image, sourceRevision, [architecture]);
        runRegctl(['index', 'add', target, '--ref', source, '--desc-platform', `linux/${architecture}`]);
      }
      const inspected = inspectRuntimeReference(target, image, sourceRevision);
      const archive = `${image}.oci.tar`;
      const archivePath = join(outputDirectory, archive);
      runRegctl(['image', 'export', target, archivePath]);
      requireRegularFile(archivePath);
      images[image] = { archive, sha256: sha256File(archivePath), manifestDigest: inspected.digest };
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  const candidate = { schemaVersion: 1, sourceRevision, repository: REPOSITORY, images };
  writeJson(join(outputDirectory, 'preview-runtime-candidate.json'), candidate);
  return candidate;
};

const validateCandidate = (directory, sourceRevision) => {
  const metadataPath = join(directory, 'preview-runtime-candidate.json');
  requireRegularFile(metadataPath);
  const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
  exactKeys(metadata, ['schemaVersion', 'sourceRevision', 'repository', 'images'], 'Candidate metadata');
  if (metadata.schemaVersion !== 1 || metadata.sourceRevision !== sourceRevision) throw new Error('Candidate identity mismatch');
  exactKeys(metadata.repository, ['owner', 'name'], 'Candidate repository metadata');
  if (metadata.repository.owner !== REPOSITORY.owner || metadata.repository.name !== REPOSITORY.name) {
    throw new Error('Candidate repository identity mismatch');
  }
  exactKeys(metadata.images, ['app', 'ui'], 'Candidate image scope');
  const allowed = new Set([metadataPath]);
  for (const image of Object.keys(IMAGES)) {
    exactKeys(metadata.images[image], ['archive', 'sha256', 'manifestDigest'], `Candidate ${image} metadata`);
    const entry = metadata.images[image];
    if (entry.archive !== `${image}.oci.tar` || !/^[0-9a-f]{64}$/.test(entry.sha256)
      || !DIGEST.test(entry.manifestDigest)) throw new Error(`Candidate ${image} metadata is invalid`);
    const archivePath = join(directory, entry.archive);
    requireRegularFile(archivePath);
    if (sha256File(archivePath) !== entry.sha256) throw new Error(`Candidate ${image} archive digest mismatch`);
    allowed.add(archivePath);
  }
  const unexpected = walk(directory).filter(path => !allowed.has(path));
  if (unexpected.length) throw new Error(`Candidate contains unexpected file: ${unexpected[0]}`);
  return metadata;
};

const inspectRemoteIfPresent = (image, sourceRevision, expectedArchitectures = ARCHITECTURES) => {
  const reference = `docker.io/propr/${image}:${sourceRevision}`;
  const probe = spawnSync('regctl', ['manifest', 'get', reference, '--format', 'raw-body'], { encoding: 'utf8' });
  if (probe.status === 0) return inspectRuntimeReference(reference, image, sourceRevision, expectedArchitectures);
  const failure = `${probe.stdout || ''}\n${probe.stderr || ''}`;
  if (/manifest unknown|name unknown|not found|404/i.test(failure)
    && !/unauthorized|denied|authentication|insufficient.scope/i.test(failure)) return null;
  throw new Error(`Unable to safely inspect existing ${reference}: ${failure.trim()}`);
};

const publishImages = ({ sourceRevision, input, githubOutput, stepSummary }) => {
  requireSourceRevision(sourceRevision);
  const inputDirectory = resolve(input);
  const candidate = validateCandidate(inputDirectory, sourceRevision);
  const localRoot = mkdtempSync(join(tmpdir(), 'propr-preview-runtime-publish.'));
  const local = {};
  try {
    for (const image of Object.keys(IMAGES)) {
      local[image] = localReference(join(localRoot, image), sourceRevision);
      runRegctl(['image', 'import', local[image], join(inputDirectory, candidate.images[image].archive)]);
      const inspected = inspectRuntimeReference(local[image], image, sourceRevision);
      if (inspected.digest !== candidate.images[image].manifestDigest) {
        throw new Error(`Candidate ${image} manifest digest changed during protected import`);
      }
    }

    const existing = {};
    for (const image of Object.keys(IMAGES)) existing[image] = inspectRemoteIfPresent(image, sourceRevision);
    for (const image of Object.keys(IMAGES)) {
      if (existing[image]) continue;
      const target = `docker.io/propr/${image}:${sourceRevision}`;
      const appeared = inspectRemoteIfPresent(image, sourceRevision);
      if (appeared) {
        existing[image] = appeared;
        continue;
      }
      runRegctl(['image', 'copy', local[image], target]);
    }

    const published = {};
    for (const image of Object.keys(IMAGES)) published[image] = inspectRemoteIfPresent(image, sourceRevision);
    if (!published.app || !published.ui) throw new Error('Published preview runtime image pair is incomplete');
    const output = [
      `runtime_app_image=${published.app.reference}`,
      `runtime_ui_image=${published.ui.reference}`,
    ].join('\n');
    if (githubOutput) appendFileSync(githubOutput, `${output}\n`);
    if (stepSummary) appendFileSync(stepSummary, [
      '### Verified Linux preview runtime images',
      '',
      `- \`${published.app.reference}\``,
      `- \`${published.ui.reference}\``,
      '',
      'Use these exact values as the Desktop Linux Preview Release `runtime_app_image` and `runtime_ui_image` inputs.',
      '',
    ].join('\n'));
    process.stdout.write(`${output}\n`);
    return published;
  } finally {
    rmSync(localRoot, { recursive: true, force: true });
  }
};

const agentReference = sourceRevision => `propr/${AGENT_IMAGE}:${sourceRevision}`;

// Resolve the single linux/amd64 image config behind an agent reference, which
// may be a plain image manifest (docker save import, ordinary release) or a
// one-platform index (the assembled preview candidate).
const agentConfigOf = (reference, sourceRevision) => {
  const top = manifestJson(reference);
  const descriptor = Array.isArray(top?.manifests)
    ? validateRuntimeIndex(top, AGENT_IMAGE, sourceRevision, AGENT_ARCHITECTURES)[0]
    : { digest: runRegctl(['image', 'digest', reference]) };
  if (!DIGEST.test(descriptor.digest || '')) throw new Error('agent image has an invalid manifest digest');
  const { manifest, config } = configForManifest(reference, descriptor.digest);
  return { configDigest: manifest.config.digest, labels: config?.config?.Labels };
};

const packageAgentImage = ({ sourceRevision, output, smokeEvidence }) => {
  requireSourceRevision(sourceRevision);
  if (!smokeEvidence) throw new Error('package-agent requires --smoke-evidence from the credential-free agent smoke');
  const reference = agentReference(sourceRevision);
  const inspection = parseDockerInspection(run('docker', ['image', 'inspect', '--format', '{{json .}}', reference]));
  validateLocalAgentImageInspection(inspection, sourceRevision);
  requireRegularFile(smokeEvidence);
  const smoke = validateAgentSmokeEvidence(JSON.parse(readFileSync(smokeEvidence, 'utf8')), {
    sourceRevision, configDigest: inspection.Id, labels: inspection.Config.Labels,
  });
  const outputDirectory = resolve(output);
  mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
  const archivePath = join(outputDirectory, AGENT_NATIVE_ARCHIVE);
  run('docker', ['save', '--output', archivePath, reference]);
  requireRegularFile(archivePath);
  const metadata = {
    schemaVersion: 1,
    sourceRevision,
    architecture: AGENT_ARCHITECTURES[0],
    repository: REPOSITORY,
    image: { archive: AGENT_NATIVE_ARCHIVE, sha256: sha256File(archivePath), configDigest: inspection.Id },
    smoke,
  };
  writeJson(join(outputDirectory, AGENT_NATIVE_METADATA), metadata);
  return metadata;
};

const validateAgentRepository = (repository, label) => {
  exactKeys(repository, ['owner', 'name'], `${label} repository metadata`);
  if (repository.owner !== REPOSITORY.owner || repository.name !== REPOSITORY.name) {
    throw new Error(`${label} repository identity mismatch`);
  }
};

const readAgentNative = (input, sourceRevision) => {
  const root = resolve(input);
  const files = walk(root);
  const metadataPaths = files.filter(path => basename(path) === AGENT_NATIVE_METADATA);
  if (metadataPaths.length !== 1) throw new Error('Expected exactly one native linux/amd64 agent metadata artifact');
  const metadata = JSON.parse(readFileSync(metadataPaths[0], 'utf8'));
  exactKeys(metadata, ['schemaVersion', 'sourceRevision', 'architecture', 'repository', 'image', 'smoke'], 'Native agent metadata');
  if (metadata.schemaVersion !== 1 || metadata.sourceRevision !== sourceRevision
    || !AGENT_ARCHITECTURES.includes(metadata.architecture)) {
    throw new Error('Native agent metadata identity or architecture mismatch');
  }
  validateAgentRepository(metadata.repository, 'Native agent');
  exactKeys(metadata.image, ['archive', 'sha256', 'configDigest'], 'Native agent image metadata');
  if (metadata.image.archive !== AGENT_NATIVE_ARCHIVE || !/^[0-9a-f]{64}$/.test(metadata.image.sha256)
    || !DIGEST.test(metadata.image.configDigest)) throw new Error('Native agent artifact metadata is invalid');
  const archivePath = join(dirname(metadataPaths[0]), metadata.image.archive);
  requireRegularFile(archivePath);
  if (sha256File(archivePath) !== metadata.image.sha256) throw new Error('agent linux/amd64 archive digest mismatch');
  const unexpected = files.filter(path => path !== metadataPaths[0] && path !== archivePath);
  if (unexpected.length) throw new Error(`Native agent input contains unexpected file: ${unexpected[0]}`);
  return { metadata, archivePath };
};

const assembleAgentImage = ({ sourceRevision, input, output }) => {
  requireSourceRevision(sourceRevision);
  const { metadata, archivePath } = readAgentNative(input, sourceRevision);
  const outputDirectory = resolve(output);
  mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
  const work = mkdtempSync(join(tmpdir(), 'propr-preview-agent-assemble.'));
  let image;
  try {
    const source = localReference(join(work, 'agent-amd64'), sourceRevision);
    runRegctl(['image', 'import', source, archivePath]);
    inspectRuntimeReference(source, AGENT_IMAGE, sourceRevision, AGENT_ARCHITECTURES);
    const imported = agentConfigOf(source, sourceRevision);
    if (imported.configDigest !== metadata.image.configDigest) {
      throw new Error('agent archive config does not match the smoke-tested image');
    }
    validateAgentSmokeEvidence(metadata.smoke, {
      sourceRevision, configDigest: imported.configDigest, labels: imported.labels,
    });
    // An explicit one-platform index makes arm64 hosts fail with "no matching
    // manifest" instead of silently pulling an amd64 binary image.
    const target = localReference(join(work, AGENT_IMAGE), sourceRevision);
    runRegctl(['index', 'create', target]);
    runRegctl(['index', 'add', target, '--ref', source, '--desc-platform', 'linux/amd64']);
    const inspected = inspectRuntimeReference(target, AGENT_IMAGE, sourceRevision, AGENT_ARCHITECTURES);
    const archive = join(outputDirectory, AGENT_CANDIDATE_ARCHIVE);
    runRegctl(['image', 'export', target, archive]);
    requireRegularFile(archive);
    image = {
      archive: AGENT_CANDIDATE_ARCHIVE,
      sha256: sha256File(archive),
      manifestDigest: inspected.digest,
      configDigest: imported.configDigest,
    };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  const candidate = {
    schemaVersion: 1, sourceRevision, repository: REPOSITORY, platform: 'linux/amd64', image, smoke: metadata.smoke,
  };
  writeJson(join(outputDirectory, AGENT_CANDIDATE_METADATA), candidate);
  return candidate;
};

export const validateAgentCandidate = (directory, sourceRevision) => {
  const metadataPath = join(directory, AGENT_CANDIDATE_METADATA);
  requireRegularFile(metadataPath);
  const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
  exactKeys(metadata, ['schemaVersion', 'sourceRevision', 'repository', 'platform', 'image', 'smoke'], 'Agent candidate metadata');
  if (metadata.schemaVersion !== 1 || metadata.sourceRevision !== sourceRevision || metadata.platform !== 'linux/amd64') {
    throw new Error('Agent candidate identity or platform mismatch');
  }
  validateAgentRepository(metadata.repository, 'Agent candidate');
  exactKeys(metadata.image, ['archive', 'sha256', 'manifestDigest', 'configDigest'], 'Agent candidate image metadata');
  const entry = metadata.image;
  if (entry.archive !== AGENT_CANDIDATE_ARCHIVE || !/^[0-9a-f]{64}$/.test(entry.sha256)
    || !DIGEST.test(entry.manifestDigest) || !DIGEST.test(entry.configDigest)) {
    throw new Error('Agent candidate metadata is invalid');
  }
  if (metadata.smoke?.configDigest !== entry.configDigest) throw new Error('Agent candidate smoke evidence is for another image');
  const archivePath = join(directory, entry.archive);
  requireRegularFile(archivePath);
  if (sha256File(archivePath) !== entry.sha256) throw new Error('Agent candidate archive digest mismatch');
  const unexpected = walk(directory).filter(path => path !== metadataPath && path !== archivePath);
  if (unexpected.length) throw new Error(`Agent candidate contains unexpected file: ${unexpected[0]}`);
  return metadata;
};

const publishAgentImage = ({ sourceRevision, input, githubOutput, stepSummary }) => {
  requireSourceRevision(sourceRevision);
  const inputDirectory = resolve(input);
  const candidate = validateAgentCandidate(inputDirectory, sourceRevision);
  const localRoot = mkdtempSync(join(tmpdir(), 'propr-preview-agent-publish.'));
  try {
    const local = localReference(join(localRoot, AGENT_IMAGE), sourceRevision);
    runRegctl(['image', 'import', local, join(inputDirectory, candidate.image.archive)]);
    const inspected = inspectRuntimeReference(local, AGENT_IMAGE, sourceRevision, AGENT_ARCHITECTURES);
    const imported = agentConfigOf(local, sourceRevision);
    if (inspected.digest !== candidate.image.manifestDigest || imported.configDigest !== candidate.image.configDigest) {
      throw new Error('Candidate agent manifest or config digest changed during protected import');
    }
    validateAgentSmokeEvidence(candidate.smoke, {
      sourceRevision, configDigest: imported.configDigest, labels: imported.labels,
    });

    // Preflight the only consumer tag before any mutation. An existing tag is
    // reused only when it is linux/amd64-only and bound to this source; a
    // conflicting tag fails closed and is never overwritten.
    let published = inspectRemoteIfPresent(AGENT_IMAGE, sourceRevision, AGENT_ARCHITECTURES);
    if (!published) {
      published = inspectRemoteIfPresent(AGENT_IMAGE, sourceRevision, AGENT_ARCHITECTURES);
      if (!published) runRegctl(['image', 'copy', local, `docker.io/${agentReference(sourceRevision)}`]);
    }
    published = inspectRemoteIfPresent(AGENT_IMAGE, sourceRevision, AGENT_ARCHITECTURES);
    if (!published) throw new Error('Published preview agent image is unavailable after publication');
    const reused = published.digest !== candidate.image.manifestDigest;
    const output = `runtime_agent_image=${published.reference}`;
    if (githubOutput) appendFileSync(githubOutput, `${output}\n`);
    if (stepSummary) appendFileSync(stepSummary, [
      '### Verified Linux preview managed-agent image',
      '',
      `- \`${published.reference}\` (linux/amd64 only)`,
      '',
      reused
        ? 'An existing source-bound full-SHA tag was kept; it was not overwritten with this run\'s candidate.'
        : 'This run\'s smoke-tested candidate was published to the full-SHA tag.',
      'Use this exact value as the Desktop Linux Preview Release `runtime_agent_image` input.',
      '',
    ].join('\n'));
    process.stdout.write(`${output}\n`);
    return { ...published, reused };
  } finally {
    rmSync(localRoot, { recursive: true, force: true });
  }
};

const main = () => {
  const [command, ...argv] = process.argv.slice(2);
  const args = argumentsOf(argv);
  if (command === 'identity') {
    const result = validateIdentity({
      sourceRevision: args['source-revision'],
      workflowRevision: args['workflow-revision'],
      dispatchRef: args['dispatch-ref'],
      operation: args.operation,
    });
    if (args.output) appendFileSync(args.output, `source_revision=${result.sourceRevision}\n`);
  } else if (command === 'package') {
    packageNativeImages({
      sourceRevision: args['source-revision'], architecture: args.architecture, output: args.output,
    });
  } else if (command === 'assemble') {
    assembleImages({ sourceRevision: args['source-revision'], input: args.input, output: args.output });
  } else if (command === 'publish') {
    publishImages({
      sourceRevision: args['source-revision'], input: args.input,
      githubOutput: args['github-output'], stepSummary: args['step-summary'],
    });
  } else if (command === 'package-agent') {
    packageAgentImage({
      sourceRevision: args['source-revision'], output: args.output, smokeEvidence: args['smoke-evidence'],
    });
  } else if (command === 'assemble-agent') {
    assembleAgentImage({ sourceRevision: args['source-revision'], input: args.input, output: args.output });
  } else if (command === 'publish-agent') {
    publishAgentImage({
      sourceRevision: args['source-revision'], input: args.input,
      githubOutput: args['github-output'], stepSummary: args['step-summary'],
    });
  } else {
    throw new Error('Expected identity, package, assemble, publish, package-agent, assemble-agent, or publish-agent command');
  }
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); }
  catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
