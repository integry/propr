import assert from 'node:assert/strict';
import { execFile as nodeExecFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { describe, test } from 'node:test';
import { promisify } from 'node:util';

const execFile = promisify(nodeExecFile);

const workflow = await readFile(
  new URL('../../../.github/workflows/desktop-connect-discovery-guard.yml', import.meta.url),
  'utf8',
);
const darwinRunner = await readFile(
  new URL('./run-packaged-darwin-connect-smoke.sh', import.meta.url),
  'utf8',
);
const forgeConfig = await readFile(new URL('../forge.config.ts', import.meta.url), 'utf8');
const darwinSigner = await readFile(
  new URL('./sign-darwin-packaged-connect.mjs', import.meta.url),
  'utf8',
);
const darwinVerifier = await readFile(
  new URL('./verify-darwin-packaged-connect-signature.mjs', import.meta.url),
  'utf8',
);
const packagedConnectSmoke = await readFile(
  new URL('./smoke-packaged-connect.mjs', import.meta.url),
  'utf8',
);
const desktopMain = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8');
const boundedDarwinRunner = await readFile(
  new URL('./run-bounded-darwin-command.mjs', import.meta.url),
  'utf8',
);

describe('packaged Connect target-native credential setup', () => {
  test('Linux retains one isolated unlocked libsecret session and rejects plaintext fallback', async () => {
    const linux = workflow.slice(
      workflow.indexOf('- name: Run packaged Linux main-to-renderer discovery'),
      workflow.indexOf('- name: Run packaged Darwin main-to-renderer discovery'),
    );
    assert.match(linux, /keyring_root="\$\(mktemp -d\)"/u);
    assert.match(linux, /export XDG_DATA_HOME="\$1"/u);
    assert.match(linux, /export PROPR_DESKTOP_SMOKE_KEYRING_ROOT="\$1"/u);
    assert.match(linux, /gnome-keyring-daemon --unlock --components=secrets/u);

    const main = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8');
    assert.match(main, /process\.platform === 'linux' \? 'gnome_libsecret' : 'os-protected'/u);
    assert.match(main, /security\.backend !== requiredStorageBackend/u);
  });

  test('inspects the ordinary unsigned package before adding the Darwin-only acceptance identity', () => {
    const darwin = workflow.slice(
      workflow.indexOf('- name: Run packaged Darwin main-to-renderer discovery'),
      workflow.indexOf('- name: Run packaged Windows main-to-renderer discovery'),
    );
    const inspect = workflow.indexOf('- name: Inspect the unsigned target-native desktop app');
    const darwinLaunch = workflow.indexOf('- name: Run packaged Darwin main-to-renderer discovery');
    assert.ok(inspect >= 0 && inspect < darwinLaunch);
    assert.match(workflow, /- name: Inspect the unsigned target-native desktop app\n\s+run: npm run desktop:smoke:inspect/u);
    assert.match(darwin, /node apps\/desktop\/scripts\/run-bounded-darwin-command\.mjs[\s\S]*?--timeout-ms 480000[\s\S]*?-- bash apps\/desktop\/scripts\/run-packaged-darwin-connect-smoke\.sh '\$\{\{ matrix\.arch \}\}'/u);
    assert.doesNotMatch(forgeConfig, /PACKAGED_CONNECT.*SIGN|SMOKE.*SIGN/iu);
    assert.match(forgeConfig, /\.\.\.\(macSigning \? \{[\s\S]*?osxSign: \{[\s\S]*?identity: macSigning\.PROPR_DESKTOP_MAC_SIGNING_IDENTITY/u);
    assert.doesNotMatch(`${forgeConfig}\n${darwinRunner}\n${darwinSigner}`, /Developer ID Application/u);
  });

  test('Darwin creates one ephemeral certificate-backed identity and proves it across both launches', () => {
    assert.match(darwinRunner, /keychain_root="\$\(run_bounded_forward[^\n]*\/usr\/bin\/mktemp -d\)"/u);
    assert.match(darwinRunner, /keychain_password="\$\(run_bounded_forward[\s\S]*?\/usr\/bin\/openssl rand -hex 32\)"/u);
    assert.match(darwinRunner, /identity_password="\$\(run_bounded_forward[\s\S]*?\/usr\/bin\/openssl rand -hex 32\)"/u);
    assert.match(darwinRunner, /x509_extensions = leaf_extensions/u);
    assert.match(darwinRunner, /basicConstraints = critical,CA:FALSE/u);
    assert.match(darwinRunner, /extendedKeyUsage = critical,codeSigning/u);
    assert.match(darwinRunner, /openssl req -new -x509 -newkey rsa:2048[\s\S]*?-days 1[\s\S]*?-config "\$leaf_config"/u);
    assert.doesNotMatch(darwinRunner, /root_(?:private_key|certificate|config)|leaf_request|-CA(?:key)?\b/u);
    assert.doesNotMatch(darwinRunner, /add-trusted-cert|remove-trusted-cert|trustRoot/u);
    assert.match(darwinRunner, /\/usr\/bin\/security import "\$identity_archive" \\[\s\S]*?-T \/usr\/bin\/codesign/u);
    assert.match(darwinRunner, /\/usr\/bin\/security set-key-partition-list \\[\s\S]*?-S apple-tool:,apple:,codesign:/u);
    assert.match(darwinRunner, /run_bounded_forward "\$SIGNING_TIMEOUT_MS" node "\$application_signer"/u);
    assert.doesNotMatch(darwinSigner, /from '@electron\/osx-sign'/u);
    assert.match(darwinSigner, /discoverDarwinSignablePaths/u);
    assert.match(darwinSigner, /'--sign', certificateSha1/u);
    assert.match(darwinSigner, /'--keychain', keychain/u);
    assert.match(darwinSigner, /'--timestamp=none'/u);
    assert.match(darwinVerifier, /'find-certificate', '-a', '-Z', keychain/u);
    assert.match(darwinVerifier, /\['-d', '--verbose=4', application\]/u);
    assert.doesNotMatch(darwinVerifier, /'--test-requirement'|['"`]?-R(?:=|['"`])/u);
    assert.match(darwinVerifier, /fingerprints\.length !== 1 \|\| fingerprints\[0\] !== expectedSha1/u);
    assert.match(darwinVerifier, /ADHOC_SIGNATURE_LINE = \/\^\\s\*signature\\s\*=\\s\*adhoc\\s\*\$\/iu/u);
    assert.match(darwinVerifier, /identifiers\.length !== 1/u);
    assert.match(darwinVerifier, /identifiers\[0\] !== REQUIRED_IDENTIFIER/u);
    assert.match(darwinVerifier, /signatureSizes\.length !== 1/u);
    assert.match(darwinVerifier, /POSITIVE_SIGNATURE_SIZE\.test\(signatureSizes\[0\]\)/u);
    assert.match(darwinVerifier, /DESIGNATED_REQUIREMENT_PREFIX/u);
    assert.match(darwinVerifier, /DESIGNATED_REQUIREMENT_GRAMMAR/u);
    assert.match(darwinVerifier, /designatedLines\.length !== 1/u);
    assert.match(darwinVerifier, /requirementMatch\[1\] !== REQUIRED_IDENTIFIER/u);
    assert.match(darwinVerifier, /requirementMatch\[2\]\.toUpperCase\(\) !== expectedSha1/u);
    assert.doesNotMatch(darwinVerifier, /Authority=/u);
    assert.doesNotMatch(darwinVerifier, /extract-certificates/u);
    assert.doesNotMatch(darwinVerifier, /find-identity/u);
    assert.match(darwinSigner, /certificate leaf = H"\$\{certificateSha1\}"/u);
    assert.match(darwinSigner, /filter\(filePath => !PACKAGED_CONNECT_NATIVE_ARTIFACTS\.test\(filePath\)\)/u);
    assert.match(darwinSigner, /'--verify', '--deep', '--strict', application/u);
    assert.match(darwinVerifier, /'--verify', '--deep', '--strict', application/u);
    assert.match(darwinVerifier, /previousDesignatedRequirement !== normalizedRequirement/u);
    assert.match(desktopMain, /storageBackend: requiredStorageBackend/u);
    assert.match(packagedConnectSmoke, /expectedStorageBackend: 'os-protected'/u);
    assert.match(packagedConnectSmoke, /outcome = await runPhase\('pair'\);[\s\S]*?outcome = await runPhase\('reprobe'\)/u);
    assert.match(packagedConnectSmoke, /authenticatedRestCount: authenticatedRest\.length/u);
    assert.match(packagedConnectSmoke, /authenticatedSocketCount: socketEvidence\.authenticatedSocketCount/u);
    const establish = darwinRunner.indexOf('node "$signature_verifier" establish');
    const smoke = darwinRunner.indexOf('npm run smoke:connect-package');
    const stable = darwinRunner.indexOf('node "$signature_verifier" stable');
    assert.ok(establish >= 0 && establish < smoke && smoke < stable);
    assert.match(packagedConnectSmoke, /const runPhase = async phase => await runPackagedConnectLifecycle\([\s\S]*?spawn: spawnLifecycleProcess/u);
    assert.match(packagedConnectSmoke, /outcome = await runPhase\('pair'\);\s*if \(outcome\.ok && journeyFixture\) \{\s*const pairingRequestCountAtPairTerminal = journeyFixture\.requests\.filter\(request =>[^{};]+\)\.length;\s*outcome = await runPhase\('reprobe'\);/u);
    assert.match(workflow, /target: darwin-x64\s+runner: macos-15-intel\s+platform: darwin\s+arch: x64/u);
    assert.match(workflow, /target: darwin-arm64\s+runner: macos-15\s+platform: darwin\s+arch: arm64/u);
  });

  test('Darwin root signing sets, but never preserves, the required identifier', () => {
    assert.match(darwinSigner, /isApplication \? \[\s*'--identifier', REQUIRED_IDENTIFIER,\s*'--preserve-metadata=entitlements,flags',\s*\] : \[\s*'--preserve-metadata=identifier,entitlements,flags',\s*\]/u);
    const rootMetadataBranch = /isApplication \? \[([\s\S]*?)\] : \[/u.exec(darwinSigner)?.[1];
    assert.ok(rootMetadataBranch);
    assert.match(rootMetadataBranch, /'--identifier', REQUIRED_IDENTIFIER/u);
    assert.match(rootMetadataBranch, /'--preserve-metadata=entitlements,flags'/u);
    assert.doesNotMatch(rootMetadataBranch, /--preserve-metadata=identifier,/u);
  });

  test('Darwin emits only allowlisted fixed stage markers around every blocking phase', async () => {
    const expectedStages = [
      'KEY_CERTIFICATE_GENERATION',
      'KEYCHAIN_CREATION_SELECTION',
      'IDENTITY_IMPORT',
      'PARTITION_LIST_UPDATE',
      'APPLICATION_SIGNING',
      'INITIAL_SIGNATURE_VERIFICATION',
      'PAIR_REPROBE_JOURNEY',
      'STABLE_SIGNATURE_VERIFICATION',
      'KEYCHAIN_RESTORATION_DELETION',
      'TEMPORARY_FILE_CLEANUP',
    ];
    const invokedStages = [...darwinRunner.matchAll(/^\s*run_stage ([A-Z_]+)\b/gmu)]
      .map(match => match[1]);
    assert.deepEqual(new Set(invokedStages), new Set(expectedStages));
    assert.equal(invokedStages.length, expectedStages.length);
    assert.match(darwinRunner, /case "\$code" in\n\s+STARTED\|PASSED\|FAILED\)/u);
    assert.match(darwinRunner, /printf 'DARWIN_PACKAGED_CONNECT_SETUP:%s:%s\\n' "\$stage" "\$code"/u);
    assert.doesNotMatch(darwinRunner, /stage_marker[^\n]*(?:password|certificate_serial|identity_sha1)/u);

    const markerFunction = darwinRunner.slice(
      darwinRunner.indexOf('stage_marker() {'),
      darwinRunner.indexOf('\n\nrun_bounded()'),
    );
    const markerCalls = expectedStages
      .flatMap(stage => ['STARTED', 'PASSED', 'FAILED']
        .map(code => `stage_marker ${stage} ${code}`))
      .join('\n');
    const { stdout } = await execFile('/bin/bash', ['-c', `${markerFunction}\n${markerCalls}`], {
      encoding: 'utf8', timeout: 2_000, maxBuffer: 16 * 1024,
    });
    assert.deepEqual(stdout.trim().split('\n'), expectedStages.flatMap(stage => [
      'STARTED', 'PASSED', 'FAILED',
    ].map(code => `DARWIN_PACKAGED_CONNECT_SETUP:${stage}:${code}`)));
    await assert.rejects(execFile('/bin/bash', ['-c', `${markerFunction}\nstage_marker BAD SECRET`], {
      encoding: 'utf8', timeout: 2_000, maxBuffer: 16 * 1024,
    }));
  });

  test('Darwin bounds setup, nested signing, verification, journey, cleanup, and the wrapper', () => {
    assert.match(boundedDarwinRunner, /detached: platform !== 'win32'/u);
    assert.match(boundedDarwinRunner, /process\.kill\(-child\.pid, signal\)/u);
    assert.match(boundedDarwinRunner, /GROUP_GUARD_RELEASE/u);
    assert.match(boundedDarwinRunner, /prevents the PGID from being reused/u);
    assert.match(boundedDarwinRunner, /signalProcessGroup\(child, 'SIGTERM'/u);
    assert.match(boundedDarwinRunner, /signalProcessGroup\(child, 'SIGKILL'/u);
    assert.match(boundedDarwinRunner, /maximumBytes - state\.bytes/u);
    assert.match(darwinVerifier, /runBoundedProcess/u);
    assert.match(darwinVerifier, /timeoutMs: VERIFICATION_TIMEOUT_MS/u);
    assert.match(darwinVerifier, /maxOutputBytes: VERIFICATION_MAX_OUTPUT_BYTES/u);
    assert.match(darwinSigner, /runBoundedProcess/u);
    assert.match(darwinSigner, /timeoutMs: CODESIGN_TIMEOUT_MS/u);
    assert.match(darwinSigner, /forwardOutput: false/u);
    assert.match(darwinRunner, /run_bounded "\$COMMAND_TIMEOUT_MS" \/usr\/bin\/security/gmu);
    assert.match(darwinRunner, /run_bounded "\$COMMAND_TIMEOUT_MS" \/usr\/bin\/openssl/gmu);
    assert.match(darwinRunner, /run_bounded_forward "\$SIGNING_TIMEOUT_MS" node "\$application_signer"/u);
    assert.match(darwinRunner, /run_bounded_forward "\$JOURNEY_TIMEOUT_MS" npm run smoke:connect-package/u);
  });

  test('Darwin failure diagnostics are fixed, classified, and secret-safe', () => {
    for (const diagnostic of [
      'MISSING_IDENTITY_OR_CHAIN',
      'TRUST_REJECTION',
      'REQUIREMENTS_FAILURE',
      'CODESIGN_FAILURE',
    ]) {
      assert.match(darwinSigner, new RegExp(`['"]${diagnostic}['"]`, 'u'));
    }
    for (const diagnostic of [
      'CERTIFICATE_LOOKUP_FAILURE',
      'SIGNATURE_DISPLAY_FAILURE',
      'EMBEDDED_REQUIREMENT_FAILURE',
      'STRICT_VERIFY_FAILURE',
      'KEYCHAIN_EVIDENCE_FAILURE',
      'ADHOC_SIGNATURE_FAILURE',
      'IDENTIFIER_METADATA_FAILURE',
      'SIGNATURE_METADATA_FAILURE',
      'REQUIREMENT_EVIDENCE_FAILURE',
      'EVIDENCE_ASSERTION_FAILURE',
    ]) {
      assert.match(darwinVerifier, new RegExp(`['"]${diagnostic}['"]`, 'u'));
    }
    assert.match(darwinSigner, /DARWIN_PACKAGED_CONNECT_DIAGNOSTIC:\$\{classifyDarwinSigningFailure\(error\)\}/u);
    assert.doesNotMatch(darwinSigner, /process\.stderr\.write\([^\n]*(?:application|keychain|certificateSha1|stderr|stdout)/u);
    assert.match(darwinRunner, /run_bounded_forward "\$COMMAND_TIMEOUT_MS" node "\$signature_verifier" establish/u);
    assert.match(darwinRunner, /run_bounded_forward "\$COMMAND_TIMEOUT_MS" node "\$signature_verifier" stable/u);
  });

  test('Darwin restores keychain state and deletes identity, credentials, and files on every exit', () => {
    assert.match(darwinRunner, /trap cleanup_keychain EXIT/u);
    assert.match(darwinRunner, /trap 'exit_for_signal 129' HUP/u);
    assert.match(darwinRunner, /trap 'exit_for_signal 130' INT/u);
    assert.match(darwinRunner, /trap 'exit_for_signal 143' TERM/u);
    assert.match(darwinRunner, /if \[\[ -n "\$active_stage" \]\]; then\n\s+stage_marker "\$active_stage" FAILED/u);
    assert.doesNotMatch(darwinRunner, /add-trusted-cert|remove-trusted-cert|trustRoot/u);
    assert.match(darwinRunner, /\/usr\/bin\/security list-keychains -d user -s \\[\s\S]*?"\$\{original_keychains\[@\]\}"/u);
    assert.match(darwinRunner, /\/usr\/bin\/security default-keychain -d user -s \\[\s\S]*?"\$original_default"/u);
    assert.match(darwinRunner, /\/usr\/bin\/security delete-keychain "\$keychain_path"/u);
    assert.doesNotMatch(darwinRunner, /certificate_prefix/u);
    assert.match(darwinRunner, /"\$requirement_proof" "\$keychain_path"/u);
    assert.match(darwinRunner, /run_bounded "\$CLEANUP_TIMEOUT_MS" \/bin\/rm -rf -- "\$keychain_root"/u);
    assert.match(darwinRunner, /if \(\( cleanup_status != 0 \)\)[\s\S]*?primary_status=1/u);
  });

  test('Darwin smoke has no static or production identity and does not widen or pre-seed Safe Storage', async () => {
    const main = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8');
    assert.doesNotMatch(darwinRunner, /add-generic-password|Safe Storage|-A(?:\s|$)/u);
    assert.doesNotMatch(darwinRunner, /Developer ID|notari|APPLE_|PROPR_DESKTOP_MAC_/iu);
    assert.doesNotMatch(darwinRunner, /(?:keychain|identity)_password=['"][^$]/u);
    assert.doesNotMatch(workflow, /secrets\.[^\n]*Packaged Connect|Packaged Connect[^\n]*secrets\./u);
    assert.match(main, /const requiredStorageBackend = process\.platform === 'linux' \? 'gnome_libsecret' : 'os-protected'/u);
    assert.match(main, /security\.backend !== requiredStorageBackend/u);
  });
});
