import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, test } from 'node:test';

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
    assert.match(darwin, /bash apps\/desktop\/scripts\/run-packaged-darwin-connect-smoke\.sh '\$\{\{ matrix\.arch \}\}'/u);
    assert.doesNotMatch(forgeConfig, /PACKAGED_CONNECT.*SIGN|SMOKE.*SIGN/iu);
    assert.match(forgeConfig, /\.\.\.\(macSigning \? \{[\s\S]*?osxSign: \{[\s\S]*?identity: macSigning\.PROPR_DESKTOP_MAC_SIGNING_IDENTITY/u);
    assert.doesNotMatch(`${forgeConfig}\n${darwinRunner}\n${darwinSigner}`, /Developer ID Application/u);
  });

  test('Darwin creates one ephemeral certificate-backed identity and proves it across both launches', () => {
    assert.match(darwinRunner, /keychain_root="\$\(mktemp -d\)"/u);
    assert.match(darwinRunner, /keychain_password="\$\(\/usr\/bin\/openssl rand -hex 32\)"/u);
    assert.match(darwinRunner, /identity_password="\$\(\/usr\/bin\/openssl rand -hex 32\)"/u);
    assert.match(darwinRunner, /extendedKeyUsage = critical,codeSigning/u);
    assert.match(darwinRunner, /\/usr\/bin\/security add-trusted-cert -r trustRoot -p codeSign/u);
    assert.match(darwinRunner, /\/usr\/bin\/security import "\$identity_archive"[\s\S]*?-T \/usr\/bin\/codesign/u);
    assert.match(darwinRunner, /\/usr\/bin\/security set-key-partition-list -S apple-tool:,apple:,codesign:/u);
    assert.match(darwinRunner, /node "\$application_signer" "\$application" "\$keychain_path" "\$identity_sha1"/u);
    assert.match(darwinSigner, /identityValidation: true/u);
    assert.match(darwinSigner, /timestamp: 'none'/u);
    assert.match(darwinSigner, /certificate leaf = H"\$\{certificateSha1\}"/u);
    assert.match(darwinSigner, /ignore: \[PACKAGED_CONNECT_NATIVE_ARTIFACTS\]/u);
    assert.match(darwinSigner, /strictVerify: true/u);
    const establish = darwinRunner.indexOf('node "$signature_verifier" establish');
    const smoke = darwinRunner.indexOf('npm run smoke:connect-package');
    const stable = darwinRunner.indexOf('node "$signature_verifier" stable');
    assert.ok(establish >= 0 && establish < smoke && smoke < stable);
  });

  test('Darwin restores keychain state and deletes identity, trust, credentials, and files on every exit', () => {
    assert.match(darwinRunner, /trap cleanup_keychain EXIT/u);
    assert.match(darwinRunner, /trap 'exit 129' HUP/u);
    assert.match(darwinRunner, /trap 'exit 130' INT/u);
    assert.match(darwinRunner, /trap 'exit 143' TERM/u);
    assert.match(darwinRunner, /\/usr\/bin\/security remove-trusted-cert "\$root_certificate"/u);
    assert.match(darwinRunner, /\/usr\/bin\/security list-keychains -d user -s "\$\{original_keychains\[@\]\}"/u);
    assert.match(darwinRunner, /\/usr\/bin\/security default-keychain -d user -s "\$original_default"/u);
    assert.match(darwinRunner, /\/usr\/bin\/security delete-keychain "\$keychain_path"/u);
    assert.match(darwinRunner, /rm -rf -- "\$keychain_root"/u);
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
