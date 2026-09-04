import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, test } from 'node:test';

const workflow = await readFile(
  new URL('../../../.github/workflows/desktop-connect-discovery-guard.yml', import.meta.url),
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

  test('Darwin uses only a generated ephemeral default keychain and restores it on exit', () => {
    const darwin = workflow.slice(
      workflow.indexOf('- name: Run packaged Darwin main-to-renderer discovery'),
      workflow.indexOf('- name: Run packaged Windows main-to-renderer discovery'),
    );
    assert.match(darwin, /keychain_root="\$\(mktemp -d\)"/u);
    assert.match(darwin, /keychain_password="\$\(openssl rand -hex 32\)"/u);
    assert.match(darwin, /trap cleanup_keychain EXIT/u);
    assert.match(darwin, /security create-keychain -p "\$keychain_password" "\$keychain_path"/u);
    assert.match(darwin, /security unlock-keychain -p "\$keychain_password" "\$keychain_path"/u);
    assert.match(darwin, /security list-keychains -d user -s "\$keychain_path"/u);
    assert.match(darwin, /security default-keychain -d user -s "\$keychain_path"/u);
    assert.match(darwin, /safe_storage_secret="\$\(openssl rand -hex 32\)"/u);
    assert.match(darwin, /security add-generic-password -a "ProPR Desktop" -s "ProPR Desktop Safe Storage" -w "\$safe_storage_secret" -A "\$keychain_path"/u);
    assert.match(darwin, /unset safe_storage_secret\n\s+npm run smoke:connect-package/u);
    assert.match(darwin, /security list-keychains -d user -s "\$\{original_keychains\[@\]\}"/u);
    assert.match(darwin, /security delete-keychain "\$keychain_path"/u);
    assert.doesNotMatch(darwin, /echo[^\n]*safe_storage_secret|printf[^\n]*safe_storage_secret/u);
    assert.doesNotMatch(darwin, /CERTIFICATE|security import|codesign|notari/iu);
  });
});
