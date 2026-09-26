import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import {
  assertInstalledLinuxAcceptanceArtifact,
  cleanupOwnedContainer,
  createInstalledLinuxContainerInvocation,
  DEFAULT_LINUX_PACKAGE_IMAGES,
  INSTALLED_LINUX_ADDED_CAPABILITIES,
  INSTALLED_LINUX_ACCEPTANCE_OPT_IN,
  INSTALLED_LINUX_EVIDENCE_PREFIX,
  INSTALLED_LINUX_SANDBOX_ISOLATIONS,
  parseInstalledLinuxAcceptanceArguments,
  parseInstalledLinuxContainerEvidence,
  runInstalledLinuxPackageAcceptance,
} from './run-installed-linux-package-acceptance.mjs';
import { CONNECT_DEEP_LINK } from './packaged-smoke-plan.mjs';

const canonicalArguments = directory => [
  '--arch', 'x64',
  '--previous-version', '1.2.2',
  '--version', '1.2.3',
  '--previous-deb', join(directory, 'ProPR-Desktop-1.2.2-linux-x64.deb'),
  '--deb', join(directory, 'ProPR-Desktop-1.2.3-linux-x64.deb'),
  '--previous-rpm', join(directory, 'ProPR-Desktop-1.2.2-linux-x64.rpm'),
  '--rpm', join(directory, 'ProPR-Desktop-1.2.3-linux-x64.rpm'),
  '--sandbox-isolation', 'docker-cap-sys-admin',
];

describe('installed Linux package acceptance authority', () => {
  test('requires canonical artifacts and a strictly increasing native target', () => {
    const target = parseInstalledLinuxAcceptanceArguments(canonicalArguments('/private/artifacts'));
    assert.equal(target.arch, 'x64');
    assert.equal(target.previousVersion, '1.2.2');
    assert.equal(target.version, '1.2.3');
    assert.equal(target.sandboxIsolation, 'docker-cap-sys-admin');
    assert.deepEqual(INSTALLED_LINUX_SANDBOX_ISOLATIONS, ['docker-default', 'docker-cap-sys-admin']);
    assert.deepEqual(INSTALLED_LINUX_ADDED_CAPABILITIES, ['SYS_ADMIN', 'IPC_LOCK']);
    assert.deepEqual(target.images, DEFAULT_LINUX_PACKAGE_IMAGES);
    assert.equal(target.artifacts.deb.current, '/private/artifacts/ProPR-Desktop-1.2.3-linux-x64.deb');

    for (const replacement of [
      ['--arch', 'ia32'],
      ['--previous-version', '1.2.3'],
      ['--version', '1.2.2'],
      ['--version', '1.2.3-beta.1'],
      ['--deb', '/private/artifacts/renamed.deb'],
      ['--rpm-image', 'registry.invalid/image@sha256:unsafe'],
      ['--sandbox-isolation', 'privileged'],
    ]) {
      const args = canonicalArguments('/private/artifacts');
      const index = args.indexOf(replacement[0]);
      if (index >= 0) args[index + 1] = replacement[1];
      else args.push(...replacement);
      assert.throws(() => parseInstalledLinuxAcceptanceArguments(args), /invalid|canonical/);
    }

    assert.throws(() => parseInstalledLinuxAcceptanceArguments(
      canonicalArguments('/private/artifacts').slice(0, -2),
    ), /explicit sandbox isolation/);
  });

  test('rejects empty files and linked artifact aliases', async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'propr-installed-package-artifact-')));
    const artifact = join(directory, 'artifact.deb');
    const linked = join(directory, 'linked.deb');
    try {
      await writeFile(artifact, 'package');
      await assert.doesNotReject(assertInstalledLinuxAcceptanceArtifact(artifact));
      await symlink(artifact, linked);
      await assert.rejects(assertInstalledLinuxAcceptanceArtifact(linked), /non-link|canonical/);
      await assert.rejects(assertInstalledLinuxAcceptanceArtifact(`${artifact},injected`), /unsafe/);
      await writeFile(artifact, '');
      await assert.rejects(assertInstalledLinuxAcceptanceArtifact(artifact), /non-empty/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('accepts DEB and RPM GTK dependency metadata with POSIX ERE', { skip: process.platform === 'win32' }, async () => {
    const source = await readFile(new URL('./test-installed-linux-package.sh', import.meta.url), 'utf8');
    const gtkExpression = source.match(
      /grep -Eq '([^']+)' \\\n\s+\|\| fail 'package dependency metadata is missing GTK'/,
    )?.[1];
    assert.ok(gtkExpression, 'GTK dependency expression must remain executable coverage');

    for (const [family, dependencies] of [
      ['DEB', 'libgtk-3-0, libnotify4, libnss3, libxss1, libxtst6, xdg-utils'],
      ['RPM', 'gtk3\nlibnotify\nnss\nlibXScrnSaver\nxdg-utils'],
    ]) {
      const result = spawnSync('grep', ['-Eq', gtkExpression], {
        encoding: 'utf8',
        input: `${dependencies}\n`,
      });
      assert.equal(result.status, 0, `${family} GTK dependency metadata was rejected: ${result.stderr}`);
    }
  });

  test('namespace preflight creates namespaces without changing root mount propagation', {
    skip: process.platform === 'win32',
  }, async () => {
    const source = await readFile(new URL('./test-installed-linux-package.sh', import.meta.url), 'utf8');
    const command = source.match(
      /^(unshare .* >"\$namespace_preflight_log" 2>&1)$/mu,
    )?.[1];
    assert.ok(command, 'namespace preflight command must remain executable coverage');

    const directory = await realpath(await mkdtemp(join(tmpdir(), 'propr-namespace-preflight-')));
    const unshare = join(directory, 'unshare');
    const argumentLog = join(directory, 'arguments');
    const namespacePreflightLog = join(directory, 'preflight.log');
    try {
      await writeFile(unshare, `#!/bin/sh
printf '%s\\n' "$@" > "$PROPR_UNSHARE_ARGUMENT_LOG"
[ "$*" = '--mount --propagation unchanged --pid --net --fork /bin/true' ] || {
  echo 'unshare: cannot change root filesystem propagation: Permission denied' >&2
  exit 1
}
`);
      await chmod(unshare, 0o755);
      const result = spawnSync('bash', ['-euo', 'pipefail', '-c', command], {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${directory}:${process.env.PATH ?? ''}`,
          PROPR_UNSHARE_ARGUMENT_LOG: argumentLog,
          namespace_preflight_log: namespacePreflightLog,
        },
      });
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual((await readFile(argumentLog, 'utf8')).trim().split('\n'), [
        '--mount', '--propagation', 'unchanged', '--pid', '--net', '--fork', '/bin/true',
      ]);
      assert.equal(await readFile(namespacePreflightLog, 'utf8'), '');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('launches the installed smoke with the canonical cold Connect confirmation intent', {
    skip: process.platform === 'win32',
  }, async () => {
    const source = await readFile(new URL('./test-installed-linux-package.sh', import.meta.url), 'utf8');
    const launchScript = source.match(
      /dbus-run-session -- bash -euo pipefail -c '([\s\S]*?)' bash \/usr\/bin\/propr-desktop "\$smoke_root"/u,
    )?.[1];
    assert.ok(launchScript, 'installed smoke launch script must remain executable coverage');

    const directory = await realpath(await mkdtemp(join(tmpdir(), 'propr-installed-smoke-launch-')));
    const keyring = join(directory, 'gnome-keyring-daemon');
    const xvfbRun = join(directory, 'xvfb-run');
    const argumentLog = join(directory, 'arguments');
    const executable = join(directory, 'propr-desktop');
    const smokeRoot = join(directory, 'propr-desktop-smoke-installed');
    try {
      await writeFile(keyring, `#!/bin/sh
[ "$*" = '--unlock --components=secrets' ] || exit 91
cat >/dev/null
`);
      await writeFile(xvfbRun, `#!/bin/sh
printf '%s\\n' "$@" > "$PROPR_XVFB_ARGUMENT_LOG"
`);
      await Promise.all([chmod(keyring, 0o755), chmod(xvfbRun, 0o755)]);
      const result = spawnSync('bash', ['-euo', 'pipefail', '-c', launchScript, 'bash', executable, smokeRoot], {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${directory}:${process.env.PATH ?? ''}`,
          PROPR_XVFB_ARGUMENT_LOG: argumentLog,
        },
      });
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual((await readFile(argumentLog, 'utf8')).trim().split('\n'), [
        '--auto-servernum',
        executable,
        '--disable-gpu',
        '--propr-smoke-test',
        `--user-data-dir=${smokeRoot}`,
        '--password-store=gnome-libsecret',
        CONNECT_DEEP_LINK,
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('preflights the synthetic keyring with bounded distro-daemon and Secret Service argv', {
    skip: process.platform === 'win32',
  }, async () => {
    const source = await readFile(new URL('./test-installed-linux-package.sh', import.meta.url), 'utf8');
    const preflightScript = source.match(
      /preflight_synthetic_keyring\(\) \{[\s\S]*?dbus-run-session -- bash -euo pipefail -c '([\s\S]*?)' >"\$keyring_preflight_log"/u,
    )?.[1];
    assert.ok(preflightScript, 'keyring readiness script must remain executable coverage');

    const directory = await realpath(await mkdtemp(join(tmpdir(), 'propr-keyring-preflight-')));
    const keyring = join(directory, 'gnome-keyring-daemon');
    const dbusSend = join(directory, 'dbus-send');
    const argumentLog = join(directory, 'arguments');
    try {
      await writeFile(keyring, `#!/bin/sh
printf 'keyring:%s\\n' "$*" >> "$PROPR_KEYRING_ARGUMENT_LOG"
cat >/dev/null
`);
      await writeFile(dbusSend, `#!/bin/sh
printf 'dbus:%s\\n' "$*" >> "$PROPR_KEYRING_ARGUMENT_LOG"
`);
      await Promise.all([chmod(keyring, 0o755), chmod(dbusSend, 0o755)]);
      const result = spawnSync('bash', ['-euo', 'pipefail', '-c', preflightScript], {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${directory}:${process.env.PATH ?? ''}`,
          PROPR_KEYRING_ARGUMENT_LOG: argumentLog,
        },
      });
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual((await readFile(argumentLog, 'utf8')).trim().split('\n'), [
        'keyring:--unlock --components=secrets',
        'dbus:--session --type=method_call --print-reply --dest=org.freedesktop.secrets /org/freedesktop/secrets org.freedesktop.DBus.Peer.Ping',
      ]);
      assert.match(source, /timeout --signal=TERM --kill-after=5s 30s[\s\S]*dbus-run-session/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('mounts only the selected artifacts and harness read-only in an auto-removed container', () => {
    const target = parseInstalledLinuxAcceptanceArguments(canonicalArguments('/private/artifacts'));
    const invocation = createInstalledLinuxContainerInvocation({
      family: 'deb',
      target,
      isolationId: '0123456789abcdef',
    });
    assert.equal(invocation.name, 'propr-package-deb-0123456789abcdef');
    assert.equal(invocation.label, 'dev.propr.acceptance=0123456789abcdef');
    assert.deepEqual(invocation.args.slice(0, 8), [
      'run', '--rm', '--init', '--platform=linux/amd64', '--name', invocation.name,
      '--label', invocation.label,
    ]);
    const command = invocation.args.join('\n');
    assert.match(command, /test-installed-linux-package\.sh/);
    assert.match(command, /ProPR-Desktop-1\.2\.2-linux-x64\.deb/);
    assert.match(command, /ProPR-Desktop-1\.2\.3-linux-x64\.deb/);
    assert.doesNotMatch(command, /\.rpm/);
    assert.equal(command.match(/readonly/g)?.length, 3);
    assert.deepEqual(invocation.args.filter(argument => argument.startsWith('--cap-add=')), [
      '--cap-add=SYS_ADMIN',
      '--cap-add=IPC_LOCK',
    ]);
    assert.doesNotMatch(command, /--privileged|--no-sandbox|seccomp=unconfined|\/var\/run\/docker\.sock/);

    const defaultTarget = { ...target, sandboxIsolation: 'docker-default' };
    const defaultInvocation = createInstalledLinuxContainerInvocation({
      family: 'deb',
      target: defaultTarget,
      isolationId: 'fedcba9876543210',
    });
    assert.doesNotMatch(defaultInvocation.args.join('\n'), /--cap-add/);
  });

  test('fails before daemon or package operations without explicit opt-in', async () => {
    let calls = 0;
    await assert.rejects(runInstalledLinuxPackageAcceptance({ arch: process.arch }, {
      environment: {},
      runCommand: async () => { calls += 1; },
    }), new RegExp(INSTALLED_LINUX_ACCEPTANCE_OPT_IN));
    assert.equal(calls, 0);
  });

  test('retains real failed-launch progress without accepting it as lifecycle success', () => {
    const failedLaunch = {
      schemaVersion: 1,
      family: 'deb',
      architecture: 'x64',
      sandboxIsolation: 'docker-cap-sys-admin',
      outcome: 'environment-limited',
      lastCompletedPhase: 'previous-package-payload',
      failedPhase: 'before-upgrade-launch',
      artifactMetadataVerified: true,
      installedPayloadsVerified: 1,
      launchesAttempted: 1,
      launchesPassed: 0,
      upgradeCompleted: false,
      uninstallCompleted: false,
      userDataPreserved: false,
      environmentLimitation: 'Container namespace boundary denied the real launch.',
    };
    const parsed = parseInstalledLinuxContainerEvidence(
      `application output\n${INSTALLED_LINUX_EVIDENCE_PREFIX}${JSON.stringify(failedLaunch)}\n`,
      { family: 'deb', architecture: 'x64', sandboxIsolation: 'docker-cap-sys-admin' },
    );
    assert.deepEqual(parsed, failedLaunch);

    const failedKeyringPreflight = {
      ...failedLaunch,
      family: 'rpm',
      lastCompletedPhase: 'previous-package-payload',
      failedPhase: 'keyring-preflight',
      launchesAttempted: 0,
      environmentLimitation: 'Container capability policy denied execution of the distro keyring daemon.',
    };
    assert.deepEqual(parseInstalledLinuxContainerEvidence(
      `${INSTALLED_LINUX_EVIDENCE_PREFIX}${JSON.stringify(failedKeyringPreflight)}\n`,
      { family: 'rpm', architecture: 'x64', sandboxIsolation: 'docker-cap-sys-admin' },
    ), failedKeyringPreflight);

    assert.throws(() => parseInstalledLinuxContainerEvidence(
      `${INSTALLED_LINUX_EVIDENCE_PREFIX}${JSON.stringify({
        ...failedLaunch,
        outcome: 'passed',
        failedPhase: '',
        environmentLimitation: null,
      })}\n`,
      { family: 'deb', architecture: 'x64', sandboxIsolation: 'docker-cap-sys-admin' },
    ), /incomplete success claim/);
  });

  test('removes only the exact labelled acceptance container', async () => {
    const invocation = {
      name: 'propr-package-deb-0123456789abcdef',
      label: 'dev.propr.acceptance=0123456789abcdef',
    };
    const calls = [];
    await cleanupOwnedContainer('/usr/bin/docker', invocation, async (file, args) => {
      calls.push([file, ...args]);
      if (args[0] === 'inspect') return { code: 0, stdout: '0123456789abcdef\n', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    });
    assert.deepEqual(calls[1], ['/usr/bin/docker', 'rm', '--force', invocation.name]);

    const refused = [];
    await assert.rejects(cleanupOwnedContainer('/usr/bin/docker', invocation, async (file, args) => {
      refused.push([file, ...args]);
      return { code: 0, stdout: 'someone-elses-container\n', stderr: '' };
    }), /does not own/);
    assert.equal(refused.length, 1);
  });

  test('container harness proves package-manager lifecycle without weakening the sandbox', async () => {
    const source = await readFile(new URL('./test-installed-linux-package.sh', import.meta.url), 'utf8');
    assert.match(source, /\[ ! -f \/\.dockerenv \].*\/run\/\.containerenv/);
    assert.match(source, /apt-get install -y "\$package"/);
    assert.match(source, /dnf install -y "\$package"/);
    assert.match(source, /unshare --mount --propagation unchanged --pid --net --fork \/bin\/true/);
    assert.match(source, /outcome='environment-limited'[\s\S]*no application launch, upgrade, or uninstall acceptance was reached/);
    assert.match(source, /assert_mode_owner "\$sandbox" 4755/);
    assert.match(source, /assert_mode_owner "\$native_addon" 755/);
    assert.match(source, /x-scheme-handler\/propr/);
    assert.match(source, /run_installed_smoke before-upgrade[\s\S]*install_artifact "\$artifact"[\s\S]*run_installed_smoke after-upgrade/);
    assert.match(source, /remove_package[\s\S]*package manager still reports propr-desktop installed/);
    assert.match(source, /snapshot_owned_system_entries[\s\S]*database-owned system file behind/);
    assert.match(source, /package removal changed synthetic user configuration/);
    assert.match(source, /launches_attempted=\$\(\(launches_attempted \+ 1\)\)[\s\S]*launches_passed=\$\(\(launches_passed \+ 1\)\)/);
    assert.match(source, /PROPR_INSTALLED_LINUX_EVIDENCE=.*"launchesAttempted":%s,"launchesPassed":%s/);
    assert.match(source, /apt-get install[\s\S]*gnome-keyring libsecret-1-0/);
    assert.match(source, /dnf install[\s\S]*gnome-keyring libsecret/);
    assert.match(source, /synthetic_keyring_root="\$test_home\/propr-desktop-smoke-keyring"/);
    assert.match(source, /XDG_DATA_HOME="\$synthetic_keyring_root"/);
    assert.match(source, /XDG_RUNTIME_DIR="\$xdg_runtime_dir"/);
    assert.match(source, /gnome-keyring-daemon --unlock --components=secrets/);
    assert.match(source, /current_phase='keyring-preflight'[\s\S]*preflight_synthetic_keyring[\s\S]*current_phase='before-upgrade-launch'/);
    assert.match(source, /org\.freedesktop\.DBus\.Peer\.Ping/);
    assert.match(source, /launches_attempted=\$\(\(launches_attempted \+ 1\)\)/);
    assert.match(source, /--password-store=gnome-libsecret/);
    assert.equal(source.match(/propr:\/\/connect\?api=https%3A%2F%2Fconnect\.propr\.dev/g)?.length, 1);
    assert.match(source, /dbus-run-session -- bash -euo pipefail -c '[\s\S]*gnome-keyring-daemon[\s\S]*xvfb-run/);
    assert.match(source, /"\$xdg_cache_home" "\$xdg_config_home" "\$xdg_data_parent" "\$xdg_data_home"[\s\S]*"\$xdg_runtime_dir"/);
    assert.match(source, /install -d -m 700 -o "\$test_user" -g "\$test_user" "\$synthetic_directory"/);
    assert.match(source, /stat -c '%a:%U:%G' "\$synthetic_directory"/);
    assert.doesNotMatch(source, /install -d[^\n]*"\$smoke_root"[^\n]*"\$test_home\/\.config\/propr-desktop"/);
    assert.doesNotMatch(
      source.replace(CONNECT_DEEP_LINK, ''),
      /--no-sandbox|--password-store=basic|setenforce|sysctl|chmod .*\/proc|\.propr/,
    );
  });
});
