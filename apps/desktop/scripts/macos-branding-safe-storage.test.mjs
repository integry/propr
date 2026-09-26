import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const launchctl = args => new Promise(resolveRun => {
  execFile('/bin/launchctl', args, {
    timeout: 10_000, killSignal: 'SIGKILL', maxBuffer: 2 * 1024 * 1024,
  }, (error, stdout) => resolveRun({ code: error ? error.code : 0, stdout }));
});

const xml = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const phases = ['legacy-write', 'renamed-control', 'branded', 'legacy-read'];

// A GUI-domain LaunchAgent inherits the GUI login's security session. Merely
// exec'ing Electron from SSH (or using launchctl asuser, which does not adopt a
// security session) is insufficient even when CGSSessionScreenIsLocked=false.
// No persistent agent, app bundle modification, sudo, or Keychain settings.
async function runPhase(electron, directory, phase, context, {
  control = launchctl, pause = delay, timeout = 30_000,
} = {}) {
  assert.ok([...phases, 'cleanup'].includes(phase));
  assert.match(context.namespace, /^propr-branding-test-[0-9a-f-]{36}$/u);
  assert.match(context.domain, /^gui\/[1-9][0-9]*$/u);
  const label = `${context.namespace}.${phase}`;
  const service = `${context.domain}/${label}`;
  const plist = join(directory, `${phase}.plist`);
  const args = ['/usr/bin/env', '-u', 'ELECTRON_RUN_AS_NODE', '-u', 'NODE_OPTIONS', electron, directory, phase];
  await writeFile(plist, `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>Label</key><string>${xml(label)}</string>
<key>ProgramArguments</key><array>${args.map(value => `<string>${xml(value)}</string>`).join('')}</array>
<key>WorkingDirectory</key><string>${xml(directory)}</string>
<key>EnvironmentVariables</key><dict><key>PROPR_DESKTOP_MAC_SAFE_STORAGE_TEST</key><string>1</string></dict>
<key>LimitLoadToSessionType</key><string>Aqua</string>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><false/>
<key>ExitTimeOut</key><integer>2</integer>
<key>StandardOutPath</key><string>/dev/null</string>
<key>StandardErrorPath</key><string>/dev/null</string>
</dict></plist>
`, { mode: 0o600, flag: 'wx' });
  // Track even a failed/timed-out bootstrap: it may already have registered.
  context.pending.add(service);
  try {
    const started = await control(['bootstrap', context.domain, plist]);
    assert.equal(started.code, 0, `Cannot bootstrap isolated ${phase} in the GUI login; no continuity evidence`);
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const status = await control(['print', service]);
      assert.equal(status.code, 0, `Isolated ${phase} GUI job disappeared; no continuity evidence`);
      // Wait for process exit, not just a report written before app.exit().
      const exitCode = status.stdout.match(/\blast exit code = (\d+)/u)?.[1];
      if (exitCode !== undefined && !/^\s*pid = \d+/mu.test(status.stdout)) {
        let report;
        try { report = JSON.parse(await readFile(join(directory, `${phase}.json`), 'utf8')); } catch { /* no valid report */ }
        // Only our finite stage names may reach test output, never native logs.
        const stage = ['isolation', 'branding', 'encryption-availability', 'crypto', 'fixture-key-cleanup'].includes(report?.failed) ? report.failed : 'no valid report';
        assert.ok(exitCode === '0' && report && !report.failed,
          `Native safeStorage ${phase} failed in GUI context (exit: ${exitCode}, status: ${stage}). ` +
          'A GUI login, accessible default Keychain, and usable Electron signing identity are separate prerequisites; an unlocked screen alone is insufficient. No continuity evidence.');
        return report;
      }
      await pause(100);
    }
    throw new Error(`Native safeStorage ${phase} timed out in GUI context; check fixture-only Keychain consent or Electron launch prerequisites. No continuity evidence.`);
  } finally {
    // Never kill Electron by name or unload the GUI domain: only this UUID job.
    const stopped = await control(['bootout', service]);
    if (stopped.code !== 0 && (await control(['print', service])).code !== 113) {
      throw new Error(`Could not unload isolated job ${service}; fixture directory retained at ${directory}`);
    }
    context.pending.delete(service);
  }
}

it('native macOS safeStorage decrypts across old → branded → old launches and rejects a renamed namespace', {
  // Requires real Keychain access. Never silently substitute Linux basic_text
  // or JS crypto, which cannot detect a macOS app-name namespace regression.
  skip: process.platform !== 'darwin' ? 'Requires macOS Keychain' :
    process.env.PROPR_DESKTOP_MAC_SAFE_STORAGE_TEST !== '1' ? 'Opt in with PROPR_DESKTOP_MAC_SAFE_STORAGE_TEST=1 as the logged-in GUI user (SSH supported)' : false,
  timeout: 240_000,
}, async () => {
  // Run the same command over SSH as the current GUI user, without sudo:
  // PROPR_DESKTOP_MAC_SAFE_STORAGE_TEST=1 node --test apps/desktop/scripts/macos-branding-safe-storage.test.mjs
  const uid = process.getuid();
  assert.ok(uid !== 0 && (await stat('/dev/console')).uid === uid,
    'Run as the current GUI login user; root or a different SSH user cannot supply that Keychain context');
  const domain = `gui/${uid}`;
  assert.equal((await launchctl(['print', domain])).code, 0,
    'No accessible GUI login domain; native encryption continuity has not been tested');
  const directory = await mkdtemp(join(tmpdir(), 'propr-branding-crypto-'));
  const namespace = `propr-branding-test-${randomUUID()}`;
  const context = { namespace, domain, pending: new Set() };
  let electron;
  try {
    const manifest = JSON.parse(await readFile(join(desktop, 'package.json'), 'utf8'));
    assert.equal(manifest.productName, 'ProPR Desktop');
    for (const name of ['userData', 'sessionData', 'logs']) await mkdir(join(directory, name));
    await writeFile(join(directory, 'package.json'), JSON.stringify({
      name: namespace, productName: `${namespace} ${manifest.productName}`, version: '1.0.0', main: 'main.cjs',
    }));
    await writeFile(join(directory, 'fixture.json'), JSON.stringify({ namespace, legacyName: manifest.productName }));
    await copyFile(join(desktop, 'scripts/macos-branding-safe-storage-probe.cjs'), join(directory, 'main.cjs'));
    await build({
      entryPoints: [join(desktop, 'src/macos-branding.ts')], outfile: join(directory, 'branding.cjs'),
      bundle: true, platform: 'node', format: 'cjs', external: ['electron'],
    });
    electron = require('electron');
    for (const phase of phases) {
      const report = await runPhase(electron, directory, phase, context);
      assert.deepEqual(report, {
        phase, available: true,
        recovered: phase === 'legacy-write' ? null : phase !== 'renamed-control',
        legacyIdentity: phase !== 'renamed-control', pathsPreserved: true,
      }, `${phase}: real encryption continuity and internal identity must both hold`);
    }
  } finally {
    // If unloading failed, do not race a live probe's Keychain writes or remove
    // its files. The error identifies the exact job and retained directory.
    assert.equal(context.pending.size, 0, `Isolated GUI job cleanup incomplete; retain ${directory} for cleanup: ${[...context.pending].join(', ')}`);
    // Delete only our two synthetic service/account pairs, in the same GUI
    // security session that created them. Retain the fixture if cleanup fails.
    if (electron) {
      try {
        assert.deepEqual(await runPhase(electron, directory, 'cleanup', context), { phase: 'cleanup', removed: true });
      } catch (error) {
        throw new Error(`Synthetic Keychain cleanup incomplete; fixture retained at ${directory}`, { cause: error });
      }
    }
    await rm(directory, { recursive: true, force: true });
  }
});

// These cross-platform tests cover launch/report/teardown failures only. They
// never substitute mocked crypto for the opt-in native acceptance test above.
async function launcherFixture(callback) {
  const directory = await mkdtemp(join(tmpdir(), 'propr-branding-launcher-'));
  const context = { namespace: `propr-branding-test-${randomUUID()}`, domain: 'gui/501', pending: new Set() };
  try { await callback(directory, context); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

it('GUI launcher waits for exit and scopes bootstrap/bootout to its fixture', async () => {
  await launcherFixture(async (directory, context) => {
    const calls = [];
    const report = { phase: 'legacy-write' };
    await writeFile(join(directory, 'legacy-write.json'), JSON.stringify(report));
    let printed = 0;
    const result = await runPhase('/Electron & Test.app/Contents/MacOS/Electron', directory, 'legacy-write', context, {
      pause: async () => {},
      control: async args => {
        calls.push(args);
        return { code: 0, stdout: args[0] === 'print' && ++printed === 1 ? 'pid = 123\nlast exit code = 0' : 'last exit code = 0' };
      },
    });
    assert.deepEqual(result, report);
    assert.equal(printed, 2, 'a report must not allow a still-running process to pass');
    const service = `${context.domain}/${context.namespace}.legacy-write`;
    assert.deepEqual(calls, [
      ['bootstrap', context.domain, join(directory, 'legacy-write.plist')],
      ['print', service], ['print', service], ['bootout', service],
    ]);
    const plist = await readFile(join(directory, 'legacy-write.plist'), 'utf8');
    assert.ok(plist.includes('/Electron &amp; Test.app/Contents/MacOS/Electron'));
    assert.ok(plist.includes('<key>LimitLoadToSessionType</key><string>Aqua</string>'));
    assert.ok(plist.includes('<key>KeepAlive</key><false/>'));
    assert.ok(plist.includes('<string>-u</string><string>ELECTRON_RUN_AS_NODE</string>'));
    assert.ok(plist.includes('<string>-u</string><string>NODE_OPTIONS</string>'));
    assert.equal(context.pending.size, 0);
  });
});

it('GUI launcher rejects missing, failed, and nonzero-exit reports without leaking native output', async () => {
  for (const [exitCode, report] of [[0, null], [0, { failed: 'encryption-availability' }], [1, { phase: 'legacy-write' }], [1, { failed: 'PRIVATE-NATIVE-ERROR' }]]) {
    await launcherFixture(async (directory, context) => {
      if (report) await writeFile(join(directory, 'legacy-write.json'), JSON.stringify(report));
      const calls = [];
      await assert.rejects(runPhase('/Electron', directory, 'legacy-write', context, {
        control: async args => {
          calls.push(args[0]);
          return { code: 0, stdout: `last exit code = ${exitCode}\nPRIVATE-NATIVE-ERROR` };
        },
      }), error => {
        assert.match(error.message, /No continuity evidence/u);
        assert.ok(!error.message.includes('PRIVATE-NATIVE-ERROR'));
        return true;
      });
      assert.equal(calls.at(-1), 'bootout');
      assert.equal(context.pending.size, 0);
    });
  }
});

it('GUI launcher unloads its exact job on timeout and failed bootstrap', async () => {
  for (const bootstrapCode of [0, 5]) {
    await launcherFixture(async (directory, context) => {
      const calls = [];
      await assert.rejects(runPhase('/Electron', directory, 'legacy-write', context, {
        timeout: 0,
        control: async args => {
          calls.push(args);
          return { code: args[0] === 'bootstrap' ? bootstrapCode : 0, stdout: '' };
        },
      }), bootstrapCode === 0 ? /timed out/u : /Cannot bootstrap/u);
      assert.deepEqual(calls.at(-1), ['bootout', `${context.domain}/${context.namespace}.legacy-write`]);
      assert.equal(context.pending.size, 0);
    });
  }
});

it('GUI launcher retains pending jobs when teardown fails, but accepts an already absent job', async () => {
  for (const printCode of [0, 113]) {
    await launcherFixture(async (directory, context) => {
      await assert.rejects(runPhase('/Electron', directory, 'legacy-write', context, {
        timeout: 0,
        control: async args => ({ code: args[0] === 'bootout' ? 5 : args[0] === 'print' ? printCode : 0, stdout: '' }),
      }), printCode === 0 ? /Could not unload isolated job/u : /timed out/u);
      assert.equal(context.pending.size, printCode === 0 ? 1 : 0);
    });
  }
});
