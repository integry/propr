const { app, safeStorage } = require('electron');
const { spawnSync } = require('node:child_process');
const { readFileSync, renameSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { configureMacOSBranding } = require('./branding.cjs');

// Only launched by macos-branding-safe-storage.test.mjs. This is a minimal
// Electron main, never the real application or a paired profile.
const { namespace, legacyName } = require('./fixture.json');
const phase = process.argv[2];
const directory = __dirname;
const phases = ['legacy-write', 'renamed-control', 'branded', 'legacy-read', 'cleanup'];
const syntheticValue = 'Synthetic branding continuity fixture; not a credential.';
let stage = 'isolation';

function check(condition) {
  if (!condition) throw new Error('Fixture check failed');
}

function report(value) {
  // Status only: no plaintext, ciphertext, Keychain password or native errors.
  // launchd owns stdio. Publish atomically inside the private fixture directory
  // so the SSH runner cannot mistake a partial write or native log for a result.
  check(phases.includes(phase));
  const path = join(directory, `${phase}.json`);
  writeFileSync(`${path}.tmp`, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
  renameSync(`${path}.tmp`, path);
}

try {
  check(process.platform === 'darwin');
  check(process.env.PROPR_DESKTOP_MAC_SAFE_STORAGE_TEST === '1');
  check(/^propr-branding-test-[0-9a-f-]{36}$/.test(namespace));
  check(legacyName === 'ProPR Desktop' && phases.includes(phase));
  check(!app.isReady());
  check(app.getName() === `${namespace} ${legacyName}`);

  if (phase === 'cleanup') {
    stage = 'fixture-key-cleanup';
    // Same GUI security session as the probes. Do not read passwords, change
    // ACLs, unlock/reset a Keychain, or change its default/search-list settings.
    // Both service AND account are exact UUID-scoped synthetic identifiers.
    let removed = true;
    for (const name of [legacyName, 'ProPR']) {
      const result = spawnSync('/usr/bin/security', [
        'delete-generic-password', '-s', `${namespace} ${name} Safe Storage`, '-a', `${namespace} ${name} Key`,
      ], { timeout: 10_000, killSignal: 'SIGKILL', stdio: 'ignore' });
      // Attempt both deletions even if one fails; errSecItemNotFound is benign.
      removed = (result.status === 0 || result.status === 44) && removed;
    }
    check(removed);
    report({ phase, removed });
    app.exit(0);
  }

  // Keep REAL native app-name changes, including the deliberately broken
  // control, inside UUID-scoped namespaces. Even a reintroduced setName('ProPR')
  // must never look up/create the real user's ProPR Keychain item. No crypto or
  // path APIs are mocked; only the two accepted test names are prefixed.
  const nativeSetName = app.setName.bind(app);
  const isolatedSetName = name => {
    check([legacyName, 'ProPR'].includes(name));
    nativeSetName(`${namespace} ${name}`);
  };
  // Electron's app.name accessor is non-configurable and captures its native
  // setter. Forward through a facade so both name APIs stay isolated without
  // trying to replace that accessor. Every other call reaches the real app.
  const brandingApp = new Proxy({}, {
    get(_target, key) {
      if (key === 'setName') return isolatedSetName;
      const value = Reflect.get(app, key);
      return typeof value === 'function' ? value.bind(app) : value;
    },
    set(_target, key, value) {
      check(key === 'name');
      isolatedSetName(value);
      return true;
    },
  });
  for (const name of ['userData', 'sessionData', 'logs']) {
    app.setPath(name, join(directory, name));
  }
  const paths = ['userData', 'sessionData', 'logs'].map(name => [name, app.getPath(name)]);

  stage = 'branding';
  if (phase === 'branded') configureMacOSBranding(brandingApp);
  if (phase === 'renamed-control') {
    // Reproduce dab31b7f: rename BEFORE ready, then restore the same paths.
    brandingApp.setName('ProPR');
    for (const [name, path] of paths) app.setPath(name, path);
  }

  app.whenReady().then(() => {
    stage = 'encryption-availability';
    check(safeStorage.isEncryptionAvailable());
    stage = 'crypto';
    // Also force initialization of the control's distinct native key.
    const encrypted = safeStorage.encryptString(syntheticValue);
    check(safeStorage.decryptString(encrypted) === syntheticValue);
    let recovered = null;
    if (phase !== 'legacy-write') {
      const input = readFileSync(join(directory, phase === 'legacy-read' ? 'new.bin' : 'old.bin'));
      try { recovered = safeStorage.decryptString(input) === syntheticValue; }
      catch { recovered = false; }
    }
    if (phase === 'legacy-write' || phase === 'branded') {
      writeFileSync(join(directory, phase === 'legacy-write' ? 'old.bin' : 'new.bin'), encrypted, { mode: 0o600, flag: 'wx' });
    }
    report({
      phase,
      available: true,
      recovered,
      legacyIdentity: app.getName() === `${namespace} ${legacyName}`,
      pathsPreserved: paths.every(([name, path]) => app.getPath(name) === path),
    });
    app.exit(0);
  }).catch(() => { report({ failed: stage }); app.exit(1); });
} catch {
  report({ failed: stage });
  app.exit(1);
}
