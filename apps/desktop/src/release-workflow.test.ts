import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

const normalizeWorkflowText = (contents: string): string => contents.replace(/\r\n?/g, '\n');
const platformArchitecturePattern = /platform: (linux|darwin|win32)\n\s+arch: (x64|arm64)/g;
const workflow = normalizeWorkflowText(readFileSync(
  fileURLToPath(new URL('../../../.github/workflows/desktop-release-guard.yml', import.meta.url)),
  'utf8',
));
const releaseArchitecture = normalizeWorkflowText(readFileSync(
  fileURLToPath(new URL('../scripts/release-architecture.mjs', import.meta.url)),
  'utf8',
));
const releaseArtifacts = normalizeWorkflowText(readFileSync(
  fileURLToPath(new URL('../scripts/release-artifacts.mjs', import.meta.url)),
  'utf8',
));
const makeDmg = normalizeWorkflowText(readFileSync(
  fileURLToPath(new URL('../scripts/make-dmg.mjs', import.meta.url)),
  'utf8',
));
const verifyDarwinImage = normalizeWorkflowText(readFileSync(
  fileURLToPath(new URL('../scripts/verify-darwin-image.mjs', import.meta.url)),
  'utf8',
));
const releasePreflight = normalizeWorkflowText(readFileSync(
  fileURLToPath(new URL('../scripts/release-preflight.mjs', import.meta.url)),
  'utf8',
));
const windowsAuthority = normalizeWorkflowText(readFileSync(
  fileURLToPath(new URL('./windows-update-authority.ts', import.meta.url)),
  'utf8',
));
const windowsAuthoritySource = normalizeWorkflowText(readFileSync(
  fileURLToPath(new URL('./native/propr-windows-authority.cs', import.meta.url)),
  'utf8',
));
const windowsAuthorityBuild = normalizeWorkflowText(readFileSync(
  fileURLToPath(new URL('../scripts/build-windows-authority-helper.mjs', import.meta.url)),
  'utf8',
));
const windowsNativeLauncher = normalizeWorkflowText(readFileSync(
  fileURLToPath(new URL('./native/windows-launcher/propr_windows_launcher.cc', import.meta.url)),
  'utf8',
));
const forgeConfig = normalizeWorkflowText(readFileSync(
  fileURLToPath(new URL('../forge.config.ts', import.meta.url)),
  'utf8',
));
const windowsMachineInstaller = normalizeWorkflowText(readFileSync(
  fileURLToPath(new URL('../scripts/build-windows-machine-installer.mjs', import.meta.url)),
  'utf8',
));
const installedWindowsAuthorityTest = normalizeWorkflowText(readFileSync(
  fileURLToPath(new URL('../scripts/test-installed-windows-authority.ps1', import.meta.url)),
  'utf8',
));

const preflightAppTokenPermissions = (preflight: string): string[] => (
  [...preflight.matchAll(/^\s+permission-([a-z-]+): (read|write)$/gm)]
    .map(match => `${match[1]}:${match[2]}`)
);

const environmentApiPermissionFixtures = [
  {
    endpoint: 'GET /repos/{owner}/{repo}/environments/{environment_name}',
    sources: [/request\(`\/environments\/\$\{environmentName\}`\)/],
    permission: 'actions:read',
  },
  {
    endpoint: 'GET /repos/{owner}/{repo}/environments/{environment_name}/deployment-branch-policies',
    sources: [
      /`\/environments\/\$\{environmentName\}\/deployment-branch-policies`/,
      /paginatedDeploymentPolicies\(request, environmentName\)/,
    ],
    permission: 'actions:read',
  },
] as const;

const job = (name: string, next?: string): string => {
  const start = workflow.indexOf(`\n  ${name}:`);
  const end = next ? workflow.indexOf(`\n  ${next}:`, start + 1) : workflow.length;
  assert.notEqual(start, -1, `missing ${name} job`);
  assert.notEqual(end, -1, `missing ${next} job`);
  return workflow.slice(start, end);
};

describe('desktop trusted release workflow', () => {
  test('keeps pull-request packaging unsigned and completely secretless', () => {
    const validation = `${job('validation-version', 'package')}\n${job('package', 'finalize')}\n${job('finalize', 'preflight')}`;
    assert.match(validation, /github\.event_name == 'pull_request'/);
    assert.match(validation, /Prove pull-request validation is secretless/);
    assert.ok(!validation.includes('secrets.'), 'PR jobs must not reference any GitHub secret');
    assert.ok(!validation.includes('PROPR_DESKTOP_UPDATE_PRIVATE_KEY'));
    assert.ok(!validation.includes('environment:\n'));
    assert.ok(!validation.includes('PROPR_DESKTOP_ENABLE_UPDATES=1'));
  });

  test('allows production only from a new protected-main desktop tag after protected read-only preflight', () => {
    const preflight = job('preflight', 'release-package');
    const production = job('release-package', 'release-finalize');
    assert.ok(!workflow.includes('workflow_dispatch:'));
    assert.match(preflight, /github\.event_name == 'push'/);
    assert.match(preflight, /release-preflight\.mjs/);
    assert.match(preflight, /ref: \$\{\{ github\.sha \}\}/);
    assert.match(preflight, /environment:\s+name: desktop-release-preflight/);
    assert.match(preflight, /actions\/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1/);
    assert.match(preflight, /app-id: \$\{\{ vars\.PROPR_DESKTOP_PREFLIGHT_APP_ID \}\}/);
    assert.match(preflight, /private-key: \$\{\{ secrets\.PROPR_DESKTOP_PREFLIGHT_APP_PRIVATE_KEY \}\}/);
    assert.match(preflight, /permission-actions: read/);
    assert.match(preflight, /permission-administration: read/);
    assert.match(preflight, /permission-contents: read/);
    assert.deepEqual(
      preflightAppTokenPermissions(preflight),
      ['actions:read', 'administration:read', 'contents:read'],
    );
    assert.match(preflight, /GITHUB_TOKEN: \$\{\{ steps\.preflight-app-token\.outputs\.token \}\}/);
    assert.equal(workflow.match(/steps\.preflight-app-token\.outputs\.token/g)?.length, 1);
    assert.equal(preflight.match(/secrets\./g)?.length, 1);
    assert.ok(!preflight.includes('PROPR_DESKTOP_UPDATE_PRIVATE_KEY'));
    assert.ok(!preflight.includes('PROPR_DESKTOP_MAC_CERTIFICATE'));
    assert.ok(!preflight.includes('PROPR_DESKTOP_WINDOWS_CERTIFICATE'));
    assert.ok(!preflight.includes('permission-actions: write'));
    assert.ok(!preflight.includes('permission-administration: write'));
    assert.ok(!preflight.includes('permission-contents: write'));
    assert.match(production, /needs: preflight/);
    assert.match(production, /environment:\s+name: desktop-release/);
    assert.match(production, /ref: \$\{\{ needs\.preflight\.outputs\.release_sha \}\}/);
    assert.match(production, /gh api .*commits\/\$RELEASE_TAG/);
    assert.match(production, /! gh release view/);
  });

  test('grants the preflight token Actions read for both environment API calls without exposing it', () => {
    const preflight = job('preflight', 'release-package');
    const permissions = preflightAppTokenPermissions(preflight);
    for (const fixture of environmentApiPermissionFixtures) {
      for (const source of fixture.sources) {
        assert.match(releasePreflight, source, `missing ${fixture.endpoint}`);
      }
      assert.ok(permissions.includes(fixture.permission), `${fixture.endpoint} requires ${fixture.permission}`);
    }
    assert.deepEqual(permissions, ['actions:read', 'administration:read', 'contents:read']);
    assert.match(preflight, /persist-credentials: false/);
    assert.equal(preflight.match(/steps\.preflight-app-token\.outputs\.token/g)?.length, 1);
    assert.ok(!/^\s+token:\s+\$\{\{ steps\.preflight-app-token\.outputs\.token \}\}/m.test(preflight));
    assert.ok(!preflight.includes('permission-environments:'));
  });

  test('keeps every certificate and the update private key inside preflight-dependent environment jobs', () => {
    const packageJob = job('release-package', 'release-finalize');
    const signing = job('sign', 'publish');
    for (const secret of [
      'PROPR_DESKTOP_MAC_CERTIFICATE_P12_BASE64',
      'PROPR_DESKTOP_MAC_CERTIFICATE_PASSWORD',
      'PROPR_DESKTOP_APPLE_API_KEY_P8_BASE64',
      'PROPR_DESKTOP_APPLE_API_KEY_ID',
      'PROPR_DESKTOP_APPLE_API_ISSUER_ID',
      'PROPR_DESKTOP_WINDOWS_CERTIFICATE_PFX_BASE64',
      'PROPR_DESKTOP_WINDOWS_CERTIFICATE_PASSWORD',
    ]) {
      assert.equal(workflow.match(new RegExp(`secrets\\.${secret}`, 'g'))?.length, 1);
      assert.ok(packageJob.includes(`secrets.${secret}`));
    }
    assert.equal(workflow.match(/secrets\.PROPR_DESKTOP_UPDATE_PRIVATE_KEY/g)?.length, 1);
    assert.ok(signing.includes('secrets.PROPR_DESKTOP_UPDATE_PRIVATE_KEY'));
    assert.match(signing, /needs: \[preflight, release-finalize\]/);
    assert.match(signing, /environment:\s+name: desktop-release/);
  });

  test('fails closed for every production signing, notarization, update, and signer condition', () => {
    const production = job('release-package', 'release-finalize');
    for (const field of [
      'CERTIFICATE_P12_BASE64',
      'CERTIFICATE_PASSWORD',
      'APPLE_API_KEY_P8_BASE64',
      'APPLE_API_KEY_ID',
      'APPLE_API_ISSUER_ID',
      'UPDATE_MAC_SIGNING_IDENTITY',
      'UPDATE_MAC_TEAM_ID',
      'CERTIFICATE_PFX_BASE64',
      'UPDATE_WINDOWS_SIGNING_IDENTITY',
      'UPDATE_WINDOWS_SIGNER_PINS',
      'UPDATE_PUBLIC_KEY',
      'UPDATE_MANIFEST_URL',
    ]) assert.ok(production.includes(field), `missing fail-closed production field ${field}`);
    assert.match(
      production,
      /for name in CERTIFICATE_P12_BASE64 CERTIFICATE_PASSWORD APPLE_API_KEY_P8_BASE64 APPLE_API_KEY_ID APPLE_API_ISSUER_ID UPDATE_MAC_SIGNING_IDENTITY UPDATE_MAC_TEAM_ID; do\s+test -n "\$\{!name\}"/,
    );
    assert.match(production, /foreach \(\$entry in \$values\.GetEnumerator\(\)\) \{ if \(!\$entry\.Value\) \{ throw/);
    assert.ok(!production.includes('signing_present'));
    assert.ok(!production.includes('notarization_present'));
    assert.match(production, /Production updates require a code-signed build/);
    assert.match(production, /codesign --verify --deep --strict/);
    assert.match(production, /spctl --assess/);
    assert.match(production, /stapler validate/);
    assert.match(production, /Authenticode signer does not match the configured build pin/);
    assert.match(production, /TimeStamperCertificate/);
    assert.match(production, /CertificateSha256/);
    assert.match(production, /SpkiSha256/);
    assert.match(production, /Windows artifacts have mixed Authenticode signers/);
    assert.match(production, /certificate\|spki\)-sha256:\[a-f0-9\]\{64\}/);
    assert.match(production, /release-architecture\.mjs inspect[\s\S]*--kind msi/);
    assert.doesNotMatch(production, /--kind nupkg|Expand-Archive|full\.nupkg|\*Setup\.exe/);
    assert.match(production, /PROPR_DESKTOP_REQUIRE_SIGNED_ARTIFACTS: '1'/);
  });

  test('rechecks package architecture in staging and finalization and publishes only signed new releases', () => {
    assert.equal(workflow.match(platformArchitecturePattern)?.length, 12);
    assert.equal(workflow.match(/release-artifacts\.mjs stage/g)?.length, 2);
    assert.equal(workflow.match(/release-artifacts\.mjs finalize/g)?.length, 2);
    assert.match(job('finalize', 'preflight'), /needs: \[validation-version, package\]/);
    assert.match(job('release-finalize', 'sign'), /needs: \[preflight, release-package\]/);
    assert.match(workflow, /p7zip-full rpm/);
    const publish = job('publish');
    assert.match(publish, /test -s desktop-release-final\/desktop-release\.json\.sig/);
    assert.match(publish, /ref: \$\{\{ needs\.preflight\.outputs\.release_sha \}\}/);
    assert.match(publish, /release-publish\.mjs/);
    assert.ok(!publish.includes('gh release create'));
    assert.ok(!publish.includes('desktop-release-final/*'));
    assert.ok(!publish.includes('--clobber'));
    assert.ok(!publish.includes('gh release upload'));
  });

  test('retains the exact native matrix when the workflow checkout uses CRLF', () => {
    const crlfFixture = workflow.replaceAll('\n', '\r\n');
    const normalizedFixture = normalizeWorkflowText(crlfFixture);
    assert.equal(normalizedFixture.match(platformArchitecturePattern)?.length, 12);
    assert.equal(normalizedFixture, workflow);
  });

  test('runs the native DMG layout suite on both macOS architectures', () => {
    for (const [jobName, section] of [
      ['unsigned validation', job('package', 'finalize')],
      ['trusted production', job('release-package', 'release-finalize')],
    ] as const) {
      assert.equal(section.match(platformArchitecturePattern)?.length, 6, `${jobName} must retain all six native jobs`);
      assert.match(section, /- platform: darwin\n\s+arch: x64\n\s+runner: macos-15-intel/, `${jobName} is missing native macOS x64`);
      assert.match(section, /- platform: darwin\n\s+arch: arm64\n\s+runner: macos-15/, `${jobName} is missing native macOS arm64`);
      assert.match(
        section,
        /- name: Typecheck and test (?:unsigned|production) desktop runtime\n\s+shell: bash\n\s+run: \|\n\s+npm run desktop:typecheck\n\s+npm run desktop:test/,
        `${jobName} must run the complete desktop tests without a platform condition`,
      );
      assert.match(section, /Prove private-snapshot native DMG mounting is available/);
      assert.match(section, /release-artifacts\.mjs probe-dmg-private-snapshot-isolation/);
      assert.match(section, /probe-dmg-private-snapshot-isolation[\s\S]*--arch "\$\{\{ matrix\.arch \}\}"/);
      assert.match(section, /Stage architecture(?:-verified| and signer verified) .* with native DMG mount evidence/);
      assert.match(section, /release-artifacts\.mjs stage[\s\S]*--platform "\$\{\{ matrix\.platform \}\}"[\s\S]*--arch "\$\{\{ matrix\.arch \}\}"/);
      assert.match(section, /Expected \$\{process\.env\.EXPECTED_PLATFORM\}-\$\{process\.env\.EXPECTED_ARCH\}/);
    }
    assert.equal(workflow.match(/release-artifacts\.mjs probe-dmg-private-snapshot-isolation/g)?.length, 2);
    assert.ok(!releaseArchitecture.includes('probe-dmg-descriptor'));
    assert.ok(!releaseArchitecture.includes("['attach', '-readonly', '-nobrowse', '-mountpoint', directory, '/dev/fd/3']"));
    assert.match(releaseArtifacts, /fsConstants\.O_RDONLY \| fsConstants\.O_NOFOLLOW \| \(privateSnapshot \? 0 : fsConstants\.O_NONBLOCK\)/);
    assert.match(releaseArtifacts, /mkdtemp\(join\(tmpdir\(\), 'propr-dmg-snapshot-'\)\)/);
    assert.match(releaseArtifacts, /fsConstants\.O_WRONLY \| fsConstants\.O_CREAT \| fsConstants\.O_EXCL \| fsConstants\.O_NOFOLLOW/);
    assert.match(releaseArtifacts, /\(pathStats\.mode & 0o777n\) !== 0o600n/);
    assert.match(releaseArtifacts, /pathStats\.nlink !== 1n/);
    assert.ok(!releaseArtifacts.includes('modified: stats.mtimeNs'));
    assert.ok(!releaseArtifacts.includes('changed: stats.ctimeNs'));
    assert.match(releaseArchitecture, /const HDIUTIL = '\/usr\/bin\/hdiutil'/);
    assert.match(releaseArchitecture, /HDIUTIL, \['attach', '-readonly', '-nobrowse', '-mountpoint', directory, privatePath\]/);
    assert.match(releaseArchitecture, /try \{\n\s+if \(mounted\) await execFile\(HDIUTIL, \['detach', directory\]\);\n\s+\} finally \{\n\s+await rm\(directory/);
    assert.match(verifyDarwinImage, /const HDIUTIL = '\/usr\/bin\/hdiutil'/);
    assert.match(verifyDarwinImage, /await chmod\(root, 0o500\)/);
    assert.match(verifyDarwinImage, /await run\(HDIUTIL, \['verify', snapshot\.path\]\)/);
    assert.match(makeDmg, /for \(let attempt = 0; attempt < 2 && !created; attempt \+= 1\)/);
    assert.match(makeDmg, /\^hdiutil: create failed - Resource busy\\s\*\$/);
    assert.match(makeDmg, /await rename\(temporaryOutput, outputPath\)/);
    assert.match(makeDmg, /try \{ await rm\(temporaryOutput, \{ force: true \}\); \} finally \{\n\s+await rm\(stagingDirectory/);
    assert.ok(
      releaseArchitecture.indexOf("['attach', '-readonly', '-nobrowse', '-mountpoint', directory, privatePath]")
        < releaseArchitecture.indexOf('inspectDmgLayout({ root: directory'),
      'native DMG bytes must be mounted read-only before layout validation',
    );
    assert.ok(
      releaseArchitecture.indexOf('inspectDmgLayout({ root: directory')
        < releaseArchitecture.indexOf('nativeValidation: nativeDmgLayoutEvidence'),
      'native layout evidence must be produced only after the real layout validator succeeds',
    );
    assert.ok(
      releaseArtifacts.indexOf('const inspection = await inspectArchitecture')
        < releaseArtifacts.indexOf('createNativeDmgEvidence({'),
      'staging must inspect the copied canonical DMG before binding native evidence',
    );
  });

  test('runs the short-argv native Windows broker smoke before both x64 and arm64 suites', () => {
    assert.equal(workflow.match(/Probe Windows authority production C# before desktop suite/g)?.length, 2);
    assert.equal(workflow.match(/Smoke Windows authority broker before the runtime suite/g)?.length, 2);
    for (const [jobName, section] of [
      ['unsigned validation', job('package', 'finalize')],
      ['trusted production', job('release-package', 'release-finalize')],
    ] as const) {
      assert.match(section, /- platform: win32\n\s+arch: x64\n\s+runner: windows-2025/);
      assert.match(section, /- platform: win32\n\s+arch: arm64\n\s+runner: windows-11-arm/);
      assert.match(section, /Probe Windows authority production C# before desktop suite\n\s+if: matrix\.platform == 'win32'/);
      assert.match(section, /Smoke Windows authority broker before the runtime suite\n\s+if: matrix\.platform == 'win32'/);
      assert.ok(
        section.indexOf('Probe Windows authority production C# before desktop suite')
          < section.indexOf('Smoke Windows authority broker before the runtime suite'),
        `${jobName} must build and directly launch the exact helper before starting the production broker`,
      );
      assert.ok(
        section.indexOf('Smoke Windows authority broker before the runtime suite')
          < section.indexOf(`Typecheck and test ${jobName === 'unsigned validation' ? 'unsigned' : 'production'} desktop runtime`),
        `${jobName} must build, authenticate, and exercise the compiled broker before the complete runtime suite`,
      );
      const packagedProbe = jobName === 'unsigned validation'
        ? 'Directly launch packaged Windows authority helper to READY'
        : 'Directly launch signed packaged Windows authority helper to READY';
      assert.ok(
        section.indexOf(packagedProbe)
          < section.indexOf(`Typecheck and test ${jobName === 'unsigned validation' ? 'unsigned' : 'production'} desktop runtime`),
        `${jobName} must directly exercise the packaged helper before the complete runtime suite`,
      );
    }
    assert.match(workflow, /PROPR_DESKTOP_PRODUCTION_RELEASE=0 npm run desktop:broker:build/g);
    assert.match(windowsAuthority, /spawn\(helper\.executable, \['--broker'\], \{/);
    assert.match(windowsAuthority, /shell: false/);
    assert.match(windowsAuthority, /windowsHide: true/);
    assert.match(windowsAuthority, /stdio: \['pipe', 'pipe', 'pipe'\]/);
    assert.match(windowsAuthority,
      /env: \{\s*SystemRoot: helper\.systemRoot,\s*TEMP: sessionTempDirectory,\s*TMP: sessionTempDirectory/);
    assert.doesNotMatch(windowsAuthority, /helper\.launcher\.launch\(\{/);
    assert.match(windowsAuthority, /nativeLauncher\.probeSystemDirectory/);
    assert.match(windowsAuthority, /nativeLauncher\.protectPrivateDirectory/);
    assert.match(windowsAuthority, /activeAuthenticatedHandleSets--/);
    assert.match(windowsAuthority, /rm\(this\.sessionTempDirectory, \{ recursive: true, force: true \}\)/);
    assert.match(windowsNativeLauncher, /CreateFileW\(path\.c_str\(\), GENERIC_READ \| READ_CONTROL, FILE_SHARE_READ/);
    assert.match(windowsNativeLauncher, /VerifyPinnedSignature/);
    assert.match(windowsNativeLauncher, /CompileHeld/);
    assert.match(windowsNativeLauncher, /VerifyMicrosoftCompilerInput/);
    assert.match(windowsNativeLauncher, /CryptCATAdminEnumCatalogFromHash/);
    assert.match(windowsNativeLauncher, /CERT_QUERY_CONTENT_FLAG_PKCS7_SIGNED[^_]/);
    assert.match(windowsNativeLauncher, /SignerContent::StandaloneCatalog/);
    assert.match(windowsNativeLauncher, /SignerContent::EmbeddedPe/);
    assert.match(windowsNativeLauncher, /CreateProcessW\(paths\[0\]\.c_str\(\)/);
    assert.match(windowsNativeLauncher, /HANDLE inherited\[\] = \{child_stdin, child_stdout, child_stderr\}/);
    assert.match(windowsNativeLauncher, /SameIdentity\(identities\[0\], loaded_id\)/);
    assert.match(windowsNativeLauncher, /DangerousUntrustedAcl/);
    assert.match(windowsAuthority, /GLOBALROOT\\SystemRoot\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe/);
    assert.doesNotMatch(windowsAuthority, /process\.env\.(?:SystemRoot|windir|COMSPEC|PATH)/i);
    assert.match(windowsAuthority, /const child = spawn\(KERNEL_SYSTEM_POWERSHELL/);
    assert.match(windowsAuthority, /env: \{\}/);
    assert.ok(!windowsAuthority.includes('writeBootstrap'));
    assert.ok(!windowsAuthority.includes('brokerSource'));
    assert.match(windowsAuthority, /await session\.write\(JSON\.stringify\(\{/);
    assert.match(windowsAuthority, /BROKER_STARTUP_TIMEOUT_MS = 60_000/);
    assert.match(windowsAuthoritySource, /"type", "ready"/);
    assert.match(windowsAuthoritySource, /"nativeSmoke", true/);
    assert.match(windowsAuthoritySource, /"compileCount", 1/);
    for (const stage of [
      'BUILD_COMPILER',
      'BUILD_SOURCE',
      'BUILD_OUTPUT',
      'TRANSPORT_SPAWN',
      'MANIFEST',
      'HELPER_OPEN',
      'HELPER_OWNER_DACL',
      'HELPER_REPARSE',
      'HELPER_IDENTITY',
      'HELPER_HASH',
      'PROTOCOL_INIT',
      'READY',
    ]) assert.match(windowsAuthority, new RegExp(`'${stage}'`));
    assert.doesNotMatch(windowsAuthority, /TRANSPORT_(?:HELPER|PIPE|PROCESS|JOB|IMAGE)/);
    assert.doesNotMatch(windowsNativeLauncher, /launch-stage-/);
    assert.match(windowsAuthorityBuild, /Microsoft\.NET', layout, 'v4\.0\.30319'/);
    assert.match(windowsAuthorityBuild, /await invoke\(compiler, args, \{/);
    assert.match(windowsAuthorityBuild, /'\/platform:anycpu'/);
    assert.match(windowsAuthorityBuild, /shell: false/);
    assert.match(windowsAuthorityBuild, /env: \{ SystemRoot: systemRoot, TEMP: cwd, TMP: cwd \}/);
    assert.doesNotMatch(windowsAuthorityBuild, /nativeLauncher\.compileHeld\(\{/);
    assert.doesNotMatch(windowsAuthorityBuild, /require\(launcher\.path\)/);
    assert.doesNotMatch(windowsAuthority, /require\(launcherProof\.path\)/);
    assert.match(windowsAuthority, /require\(bootstrapProof\.path\)/);
    assert.match(windowsAuthority, /bootstrap\.loadVerifiedModule\(\{/);
    assert.match(forgeConfig, /extraResource: \[resolve\('build', 'windows-authority'\)\]/);
    assert.match(forgeConfig, /refreshPackagedWindowsAuthorityManifest/);
    assert.match(windowsAuthority, /purpose: BrokerPurpose/);
    assert.match(windowsAuthority, /expectedBytes: number \| null/);
  });

  test('installs the full machine-wide Windows artifact and exercises its protected authority on both architectures', () => {
    assert.equal(workflow.match(/Install and exercise machine-protected Windows authority/g)?.length, 1);
    assert.equal(workflow.match(/Install and exercise signed machine-protected Windows authority/g)?.length, 1);
    assert.equal(workflow.match(/test-installed-windows-authority\.ps1/g)?.length, 2);
    assert.match(workflow, /\*Machine-Setup\.msi/);
    assert.match(workflow, /-Architecture '\$\{\{ matrix\.arch \}\}'/);
    assert.match(forgeConfig, /postMake:/);
    assert.match(forgeConfig, /buildWindowsMachineInstaller/);
    assert.doesNotMatch(forgeConfig, /MakerSquirrel|noMsi|Setup\.exe|full\.nupkg/);
    assert.match(forgeConfig, /Machine-Setup\.msi/);
    assert.match(windowsMachineInstaller, /InstallScope="perMachine"/);
    assert.match(windowsMachineInstaller, /\/inheritance:r/);
    assert.match(windowsMachineInstaller, /\/setowner \*S-1-5-18/);
    assert.match(windowsMachineInstaller, /\*S-1-5-32-545:\(OI\)\(CI\)RX/);
    assert.doesNotMatch(windowsMachineInstaller, /\*S-1-5-32-545:\(OI\)\(CI\)(?:M|F)/);
    assert.match(installedWindowsAuthorityTest, /AreAccessRulesProtected/);
    assert.match(installedWindowsAuthorityTest, /--propr-authority-smoke/);
    assert.match(installedWindowsAuthorityTest, /-Credential \$credential/);
    assert.match(installedWindowsAuthorityTest, /OpenWrite/);
    assert.match(installedWindowsAuthorityTest, /File\]::Move/);
    assert.match(installedWindowsAuthorityTest, /File\]::Delete/);
    assert.match(installedWindowsAuthorityTest, /'\/fa'/);
    assert.match(installedWindowsAuthorityTest, /machine uninstall left the protected canonical install tree behind/);
    assert.match(installedWindowsAuthorityTest, /machine downgrade unexpectedly succeeded/);
    assert.match(installedWindowsAuthorityTest, /deliberately failing upgrade unexpectedly succeeded/);
    assert.match(windowsMachineInstaller, /RollbackProbe/);
    assert.match(windowsMachineInstaller, /MajorUpgrade AllowSameVersionUpgrades="yes"/);
    assert.match(windowsMachineInstaller, /Software\\\\Classes\\\\propr/);
    assert.match(workflow, /PROPR_DESKTOP_WINDOWS_INSTALLED_AUTHORITY=1/g);
  });
});
