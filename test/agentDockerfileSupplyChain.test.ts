import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const dockerfile = readFileSync(new URL('../Dockerfile.agent', import.meta.url), 'utf8');
const buildScript = readFileSync(new URL('../scripts/build-images.sh', import.meta.url), 'utf8');
const FINAL_STAGE = 'FROM --platform=${AGENT_PLATFORM} scratch AS final';
const appDockerfiles = [
  'docker/Dockerfile.node',
  'docker/Dockerfile.app.prod',
];

for (const dockerfilePath of appDockerfiles) {
  test(`${dockerfilePath} installs the pinned GitHub CLI used for preview attachments`, () => {
    const appDockerfile = readFileSync(new URL(`../${dockerfilePath}`, import.meta.url), 'utf8');

    assert.match(appDockerfile, /ARG GH_VERSION=2\.99\.0/);
    assert.match(appDockerfile, /cli\/cli\/releases\/download\/v\$\{GH_VERSION\}/);
    assert.match(appDockerfile, /sha256sum -c -/);
    assert.match(appDockerfile, /\/usr\/local\/bin\/gh/);
    assert.match(appDockerfile, /gh --version/);
  });
}

test('Antigravity agent build uses a versioned artifact with a pinned checksum', () => {
  assert.match(dockerfile, /ARG ANTIGRAVITY_CLI_VERSION=\d+\.\d+\.\d+/);
  assert.doesNotMatch(dockerfile, /ANTIGRAVITY_CLI_VERSION=latest/);
  assert.match(dockerfile, /ARG ANTIGRAVITY_CLI_SHA512=[a-f0-9]{128}/);
  assert.match(dockerfile, /antigravity-cli\/\$\{ANTIGRAVITY_CLI_VERSION\}-\$\{ANTIGRAVITY_CLI_RELEASE_ID\}/);
});

test('Antigravity checksum verification happens before archive extraction', () => {
  const checksumIndex = dockerfile.indexOf('sha512sum -c -');
  const extractionIndex = dockerfile.indexOf('tar -xzf');
  assert.ok(checksumIndex > 0);
  assert.ok(extractionIndex > checksumIndex);
});

test('Antigravity artifact download retries and uses a pinned-path fallback', () => {
  assert.match(dockerfile, /--retry 5 --retry-delay 2 --retry-max-time 180 --retry-all-errors/);
  assert.match(dockerfile, /storage\.googleapis\.com\/download\/storage\/v1\/b\/antigravity-public\/o\/antigravity-cli%2F/);
  assert.match(dockerfile, /for candidate_url in "\$source_url" "\$fallback_url"/);
  assert.match(dockerfile, /printf '%s\\n' "\$downloaded_from" > \/home\/node\/\.local\/share\/propr\/antigravity-cli\.source/);
});

test('agent build never downloads and executes the mutable installer script', () => {
  assert.doesNotMatch(dockerfile, /antigravity\.google\/cli\/install\.sh/);
  assert.doesNotMatch(dockerfile, /antigravity-install\.sh/);
  assert.doesNotMatch(dockerfile, /\bagy install\b/);
});

test('the image build script uses the same pinned Antigravity version', () => {
  const dockerVersion = dockerfile.match(/ARG ANTIGRAVITY_CLI_VERSION=(\d+\.\d+\.\d+)/)?.[1];
  const scriptVersion = buildScript.match(/ANTIGRAVITY_CLI_VERSION="\$\{ANTIGRAVITY_CLI_VERSION:-(\d+\.\d+\.\d+)\}"/)?.[1];
  const dockerReleaseId = dockerfile.match(/ARG ANTIGRAVITY_CLI_RELEASE_ID=(\d+)/)?.[1];
  const scriptReleaseId = buildScript.match(/ANTIGRAVITY_CLI_RELEASE_ID="\$\{ANTIGRAVITY_CLI_RELEASE_ID:-(\d+)\}"/)?.[1];
  const dockerSha512 = dockerfile.match(/ARG ANTIGRAVITY_CLI_SHA512=([a-f0-9]{128})/)?.[1];
  const scriptSha512 = buildScript.match(/ANTIGRAVITY_CLI_SHA512="\$\{ANTIGRAVITY_CLI_SHA512:-([a-f0-9]{128})\}"/)?.[1];
  assert.ok(dockerVersion);
  assert.equal(scriptVersion, dockerVersion);
  assert.ok(dockerReleaseId);
  assert.equal(scriptReleaseId, dockerReleaseId);
  assert.ok(dockerSha512);
  assert.equal(scriptSha512, dockerSha512);
  assert.match(buildScript, /"--build-arg" "ANTIGRAVITY_CLI_RELEASE_ID=\$ANTIGRAVITY_CLI_RELEASE_ID"/);
  assert.match(buildScript, /"--build-arg" "ANTIGRAVITY_CLI_SHA512=\$ANTIGRAVITY_CLI_SHA512"/);
});

test('bundled Agent Tank is installed at a pinned version, never latest', () => {
  assert.match(dockerfile, /ARG AGENT_TANK_CLI_VERSION=\d+\.\d+\.\d+/);
  assert.match(dockerfile, /npm install -g "agent-tank@\$\{AGENT_TANK_CLI_VERSION\}"/);
  assert.doesNotMatch(dockerfile, /agent-tank@latest/);
  assert.doesNotMatch(dockerfile, /npm install -g agent-tank(\s|$)/m);
  // The final stage must actually verify the binary it ships.
  assert.match(dockerfile, /&& agent-tank --version/);
});

test('the image build script uses the same pinned Agent Tank version', () => {
  const dockerVersion = dockerfile.match(/ARG AGENT_TANK_CLI_VERSION=(\d+\.\d+\.\d+)/)?.[1];
  const scriptVersion = buildScript.match(/AGENT_TANK_CLI_VERSION="\$\{AGENT_TANK_CLI_VERSION:-(\d+\.\d+\.\d+)\}"/)?.[1];
  assert.ok(dockerVersion);
  assert.equal(scriptVersion, dockerVersion);
  assert.match(buildScript, /"--build-arg" "AGENT_TANK_CLI_VERSION=\$AGENT_TANK_CLI_VERSION"/);
});

test('every CLI the image build stage verifies is linked into PATH in that same stage', () => {
  const finalStage = dockerfile.slice(dockerfile.indexOf('FROM agent-base AS agent-image-build'), dockerfile.indexOf(FINAL_STAGE));
  // Stages are independent: copying a package's node_modules tree does not bring
  // along the npm bin symlink created where it was installed. A command that is
  // verified but never linked here fails the build with "command not found".
  const verified = [...finalStage.matchAll(/&& ([a-z][a-z-]*) --version/g)].map(match => match[1]);
  assert.ok(verified.includes('agent-tank'), 'the image build stage should verify bundled Agent Tank');
  for (const command of verified) {
    assert.match(
      finalStage,
      new RegExp(`link_npm_bin \\S+ ${command}\\b|ln -sf \\S+ /usr/local/bin/${command}\\b|COPY --from=\\S+ \\S+ /usr/local/bin/${command}\\b`),
      `${command} is verified in the image build stage but nothing links its executable there`
    );
  }
});

test('the agent image no longer installs iptables: restricted networking needs no firewall inside the container', () => {
  assert.doesNotMatch(dockerfile, /iptables/i);
});

// #3399: snapshotters that cannot set trusted overlay xattrs (rootless Docker,
// userxattr overlay, OrbStack's containerd store) refuse layers carrying
// `.wh..wh..opq` entries, which some builders' overlayfs differs emit for every
// directory a layer creates, COPY destinations included. Only a single-layer
// image avoids them; scripts/check-image-whiteouts.sh proves the built image.
test('the published agent image is one layer copied from the image build stage', () => {
  const stages = [...dockerfile.matchAll(/^FROM (.+)$/gm)].map(match => match[1]);
  assert.equal(stages.at(-1), '--platform=${AGENT_PLATFORM} scratch AS final', 'the published stage must start from scratch');
  assert.equal(stages.at(-2), 'agent-base AS agent-image-build');

  const finalStage = dockerfile.slice(dockerfile.indexOf(FINAL_STAGE));
  assert.match(finalStage, /^COPY --from=agent-image-build \/ \/$/m);
  assert.equal(finalStage.match(/^(COPY|ADD|RUN)\b/gm)?.length, 1, 'the published stage may only copy the build stage and declare config');
  assert.doesNotMatch(finalStage, /--link\b/);
  assert.equal(dockerfile.match(/--from=agent-image-build\b/g)?.length, 1, 'only the flattening COPY may read the image build stage');
});

test('the single-layer agent image re-declares the layered image config exactly', () => {
  const nodeVersion = dockerfile.match(/^ARG AGENT_NODE_VERSION=(\d+\.\d+\.\d+)$/m)?.[1];
  const yarnVersion = dockerfile.match(/^ARG AGENT_YARN_VERSION=(\d+\.\d+\.\d+)$/m)?.[1];
  assert.ok(nodeVersion, 'the node base must be pinned to an exact release');
  assert.ok(yarnVersion);
  assert.match(dockerfile, /node:\$\{AGENT_NODE_VERSION\}-bookworm-slim AS agent-base$/m);

  const baseStage = dockerfile.slice(dockerfile.indexOf('AS agent-base\n'), dockerfile.indexOf('FROM agent-base AS claude-cli'));
  assert.match(baseStage, /test "\$NODE_VERSION" = "\$AGENT_NODE_VERSION"/);
  assert.match(baseStage, /test "\$YARN_VERSION" = "\$AGENT_YARN_VERSION"/);
  assert.match(baseStage, /test "\$\(node --version\)" = "v\$AGENT_NODE_VERSION"/);

  // Same config as the layered 0.9.0 image (docker inspect), labels aside:
  // the OCI labels come from build-images.sh --label.
  const finalStage = dockerfile.slice(dockerfile.indexOf(FINAL_STAGE));
  const env = finalStage.match(/^ENV ((?:.*\\\n)*.*)$/m)?.[1].split(/\s*\\\n\s*/).map(entry => entry.trim());
  assert.deepEqual(env, [
    'PATH=/home/node/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    'NODE_VERSION=${AGENT_NODE_VERSION}',
    'YARN_VERSION=${AGENT_YARN_VERSION}',
    'NODE_OPTIONS="--max-old-space-size=8192"',
    'UV_TOOL_DIR=/opt/uv/tools',
    'UV_TOOL_BIN_DIR=/usr/local/bin',
    'UV_PYTHON_INSTALL_DIR=/opt/uv/python',
    'AGY_CLI_DISABLE_AUTO_UPDATE=true',
  ]);
  assert.equal(finalStage.match(/^ENV\b/gm)?.length, 1);
  assert.match(finalStage, /^ARG AGENT_NODE_VERSION$/m);
  assert.match(finalStage, /^ARG AGENT_YARN_VERSION$/m);
  assert.match(finalStage, /^USER node$/m);
  assert.match(finalStage, /^WORKDIR \/home\/node\/workspace$/m);
  assert.match(finalStage, /^ENTRYPOINT \["\/usr\/bin\/tini", "--", "\/home\/node\/agent-entrypoint\.sh"\]$/m);
  assert.doesNotMatch(finalStage, /^CMD\b/m, 'the layered image had no CMD once it set its ENTRYPOINT');
  for (const label of ['agent-bundle', 'agent.claude.version', 'agent.codex.version', 'agent.antigravity.version', 'agent.opencode.version', 'agent.vibe.version', 'agent-tank.version']) {
    assert.match(finalStage, new RegExp(`dev\\.propr\\.${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}=`), `the published stage must label ${label}`);
  }
  assert.doesNotMatch(dockerfile.slice(0, dockerfile.indexOf(FINAL_STAGE)), /^LABEL\b/m, 'labels set before scratch are dropped');
});

test('every agent image smoke rejects overlayfs whiteouts in the built image', () => {
  const releaseSmoke = readFileSync(new URL('../scripts/smoke-test-images.sh', import.meta.url), 'utf8');
  const previewSmoke = readFileSync(new URL('../scripts/smoke-test-preview-agent-image.sh', import.meta.url), 'utf8');
  const restrictedSmoke = readFileSync(new URL('../.github/workflows/restricted-network-smoke.yml', import.meta.url), 'utf8');
  assert.match(releaseSmoke, /scripts\/check-image-whiteouts\.sh" "\$AGENT_TAG"/);
  assert.match(previewSmoke, /scripts\/check-image-whiteouts\.sh" "\$AGENT_IMAGE"/);
  assert.match(restrictedSmoke, /\.\/scripts\/check-image-whiteouts\.sh "\$PROPR_TEST_AGENT_IMAGE"/);
});
