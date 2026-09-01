import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';
import { PACKAGED_SMOKE_EVIDENCE_EVENTS } from './smoke-test-evidence';

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
const forgeConfig = normalizeWorkflowText(readFileSync(
  fileURLToPath(new URL('../forge.config.ts', import.meta.url)),
  'utf8',
));
const windowsMachineInstaller = normalizeWorkflowText(readFileSync(
  fileURLToPath(new URL('../scripts/build-windows-machine-installer.mjs', import.meta.url)),
  'utf8',
));
const installedWindowsAppTest = normalizeWorkflowText(readFileSync(
  fileURLToPath(new URL('../scripts/test-installed-windows-app.ps1', import.meta.url)),
  'utf8',
));
const installedWindowsAppSupervisor = normalizeWorkflowText(readFileSync(
  fileURLToPath(new URL('../scripts/run-installed-windows-app-harness.ps1', import.meta.url)),
  'utf8',
));
const installedWindowsAppCleanup = normalizeWorkflowText(readFileSync(
  fileURLToPath(new URL('../scripts/cleanup-installed-windows-app.ps1', import.meta.url)),
  'utf8',
));
const installedWindowsAppWorkflowCleanupWrapper = normalizeWorkflowText(readFileSync(
  fileURLToPath(new URL('../scripts/run-installed-windows-app-workflow-cleanup.ps1', import.meta.url)),
  'utf8',
));
const installedWindowsAppWorkflowCleanup = normalizeWorkflowText(readFileSync(
  fileURLToPath(new URL('../scripts/run-installed-windows-app-workflow-cleanup-body.ps1', import.meta.url)),
  'utf8',
));
const installedWindowsAppSupervisorBehaviorTest = normalizeWorkflowText(readFileSync(
  fileURLToPath(new URL('../scripts/test-installed-windows-app-supervisor.ps1', import.meta.url)),
  'utf8',
));
const installedWindowsAppSupervisorFixture = normalizeWorkflowText(readFileSync(
  fileURLToPath(new URL('../scripts/test-installed-windows-app-supervisor-fixture.ps1', import.meta.url)),
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
    permission: 'environments:read',
  },
  {
    endpoint: 'GET /repos/{owner}/{repo}/environments/{environment_name}/deployment-branch-policies',
    sources: [
      /`\/environments\/\$\{environmentName\}\/deployment-branch-policies`/,
      /paginatedDeploymentPolicies\(request, environmentName\)/,
    ],
    permission: 'environments:read',
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
    assert.match(preflight, /permission-administration: read/);
    assert.match(preflight, /permission-contents: read/);
    assert.match(preflight, /permission-environments: read/);
    assert.deepEqual(
      preflightAppTokenPermissions(preflight),
      ['administration:read', 'contents:read', 'environments:read'],
    );
    assert.match(preflight, /GITHUB_TOKEN: \$\{\{ steps\.preflight-app-token\.outputs\.token \}\}/);
    assert.equal(workflow.match(/steps\.preflight-app-token\.outputs\.token/g)?.length, 1);
    assert.equal(preflight.match(/secrets\./g)?.length, 1);
    assert.ok(!preflight.includes('PROPR_DESKTOP_UPDATE_PRIVATE_KEY'));
    assert.ok(!preflight.includes('PROPR_DESKTOP_MAC_CERTIFICATE'));
    assert.ok(!preflight.includes('PROPR_DESKTOP_WINDOWS_CERTIFICATE'));
    assert.ok(!preflight.includes('permission-administration: write'));
    assert.ok(!preflight.includes('permission-contents: write'));
    assert.ok(!preflight.includes('permission-environments: write'));
    assert.match(production, /needs: preflight/);
    assert.match(production, /environment:\s+name: desktop-release/);
    assert.match(production, /ref: \$\{\{ needs\.preflight\.outputs\.release_sha \}\}/);
    assert.match(production, /gh api .*commits\/\$RELEASE_TAG/);
    assert.match(production, /! gh release view/);
  });

  test('grants the preflight token Environments read for both environment API calls without exposing it', () => {
    const preflight = job('preflight', 'release-package');
    const permissions = preflightAppTokenPermissions(preflight);
    for (const fixture of environmentApiPermissionFixtures) {
      for (const source of fixture.sources) {
        assert.match(releasePreflight, source, `missing ${fixture.endpoint}`);
      }
      assert.ok(permissions.includes(fixture.permission), `${fixture.endpoint} requires ${fixture.permission}`);
    }
    assert.deepEqual(permissions, ['administration:read', 'contents:read', 'environments:read']);
    assert.match(preflight, /persist-credentials: false/);
    assert.equal(preflight.match(/steps\.preflight-app-token\.outputs\.token/g)?.length, 1);
    assert.ok(!/^\s+token:\s+\$\{\{ steps\.preflight-app-token\.outputs\.token \}\}/m.test(preflight));
    assert.ok(!preflight.includes('permission-actions:'));
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
    assert.doesNotMatch(production, /--kind nupkg|full\.nupkg|\*Setup\.exe/);
    assert.equal(production.match(/Expand-Archive -LiteralPath \$archive -DestinationPath \$wixDirectory/g)?.length, 1);
    assert.match(production, /PROPR_DESKTOP_REQUIRE_SIGNED_ARTIFACTS: '1'/);
  });

  test('preserves the opaque Windows certificate password for package and MSI signing', () => {
    assert.match(
      forgeConfig,
      /readCompleteEnvironmentGroup\([\s\S]*?\['PROPR_DESKTOP_WINDOWS_CERTIFICATE_FILE', 'PROPR_DESKTOP_WINDOWS_CERTIFICATE_PASSWORD'\],[\s\S]*?\{ opaqueNames: \['PROPR_DESKTOP_WINDOWS_CERTIFICATE_PASSWORD'\] \},\n\);/,
    );
    assert.match(
      forgeConfig,
      /certificatePassword: windowsSigning\.PROPR_DESKTOP_WINDOWS_CERTIFICATE_PASSWORD/,
    );
    assert.match(forgeConfig, /\.\.\.\(windowsSign \? \{ windowsSign \} : \{\}\)/);
    assert.match(forgeConfig, /await sign\(\{ files: \[machineInstaller\], \.\.\.windowsSign \}\)/);
    assert.doesNotMatch(forgeConfig, /PROPR_DESKTOP_WINDOWS_CERTIFICATE_PASSWORD[^\n]*\.trim\(/);
  });

  test('rechecks package architecture in staging and finalization and publishes only signed new releases', () => {
    assert.equal(workflow.match(platformArchitecturePattern)?.length, 12);
    assert.equal(workflow.match(/release-artifacts\.mjs stage/g)?.length, 2);
    assert.equal(workflow.match(/release-artifacts\.mjs finalize/g)?.length, 2);
    assert.match(job('finalize', 'preflight'), /needs: \[validation-version, package\]/);
    assert.match(job('release-finalize', 'sign'), /needs: \[preflight, release-package\]/);
    assert.equal(workflow.match(/sudo apt-get install --yes cpio msitools p7zip-full rpm/g)?.length, 2);
    assert.equal(workflow.match(/test -x \/usr\/bin\/msiextract/g)?.length, 2);
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
    assert.match(makeDmg, /await image\.sync\(\)/);
    assert.match(makeDmg, /const directory = await open\(outputDirectory, 'r'\)/);
    assert.match(makeDmg, /try \{ await directory\.sync\(\); \} finally \{ await directory\.close\(\); \}/);
    assert.ok(makeDmg.indexOf('await image.sync()') < makeDmg.indexOf('await directory.sync()'));
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


  test('keeps both Windows architectures and the complete machine-scope installer contract mandatory', () => {
    for (const [jobName, section] of [
      ['unsigned validation', job('package', 'finalize')],
      ['trusted production', job('release-package', 'release-finalize')],
    ] as const) {
      assert.match(section, /- platform: win32\n\s+arch: x64\n\s+runner: windows-2025/);
      assert.match(section, /- platform: win32\n\s+arch: arm64\n\s+runner: windows-11-arm/);
      assert.match(section, /Assert (?:signed )?Windows MVP package excludes update authority/);
      assert.match(section, /Probe canonical WiX 3\.14\.1 compiler/);
      assert.match(
        section,
        /build-windows-machine-installer\.mjs probe '\$\{\{ matrix\.arch \}\}' \$env:PROPR_DESKTOP_WIX_DIRECTORY/,
      );
      assert.match(section, /Provision pinned WiX 3\.14\.1 binaries for Windows ARM64\n\s+if: matrix\.platform == 'win32' && matrix\.arch == 'arm64'/);
      assert.match(section, /https:\/\/github\.com\/wixtoolset\/wix3\/releases\/download\/wix3141rtm\/wix314-binaries\.zip/);
      assert.match(section, /6ac824e1642d6f7277d0ed7ea09411a508f6116ba6fae0aa5f2c7daa2ff43d31/);
      assert.match(section, /Get-FileHash -LiteralPath \$archive -Algorithm SHA256/);
      assert.match(section, /Invoke-WebRequest[^\n]+-MaximumRedirection 5 -TimeoutSec 120/);
      assert.match(section, /\$archiveItem\.Length -le 0 -or \$archiveItem\.Length -gt 64MB/);
      assert.match(section, /Expand-Archive -LiteralPath \$archive -DestinationPath \$wixDirectory/);
      assert.match(section, /PROPR_DESKTOP_WIX_DIRECTORY=\$wixDirectory/);
      assert.match(section, /Clean pinned Windows ARM64 WiX binaries\n\s+if: always\(\) && matrix\.platform == 'win32' && matrix\.arch == 'arm64'/);
      assert.doesNotMatch(section, /choco|Chocolatey|wixVendor|electron-winstaller/);
      assert.match(section, /Install and exercise (?:signed )?ordinary-user Windows application/);
      assert.match(section, /Launch (?:signed )?packaged Windows application and exercise MVP desktop flows/);
      assert.doesNotMatch(section, /READY|broker:build|windows-authority-build|windows-update-authority\.test|probe-packaged-windows-authority/,
        `${jobName} retained a deferred Windows authority gate`);
    }
    assert.equal(workflow.match(/\*Machine-Setup\.msi/g)?.length, 3);
    assert.equal(workflow.match(/run-installed-windows-app-harness\.ps1/g)?.length, 2);
    assert.equal(workflow.match(/PROPR_DESKTOP_WINDOWS_INSTALLED_APP=1/g)?.length, 2);
    assert.doesNotMatch(forgeConfig, /extraResource|windows-authority|postPackage/);
    assert.match(forgeConfig, /buildWindowsMachineInstaller/);
    assert.match(forgeConfig, /wixDirectory: process\.env\.PROPR_DESKTOP_WIX_DIRECTORY/);
    assert.doesNotMatch(forgeConfig, /MakerSquirrel|noMsi|Setup\.exe|full\.nupkg/);
    assert.match(windowsMachineInstaller, /InstallScope="perMachine"/);
    assert.match(windowsMachineInstaller, /<Directory Id="ProgramMenuFolder">/);
    assert.match(
      windowsMachineInstaller,
      /<Component Id="ApplicationStartMenuShortcutComponent" Guid="\*">/,
    );
    assert.match(
      windowsMachineInstaller,
      /<RegistryValue Root="HKCU" Key="Software\\\\ProPR\\\\Desktop" Name="installed"\s+Value="1" Type="integer" KeyPath="yes" \/>/,
    );
    assert.doesNotMatch(windowsMachineInstaller, /\bCommonProgramMenuFolder\b/);
    assert.doesNotMatch(
      windowsMachineInstaller,
      /<Component Id="ApplicationStartMenuShortcutComponent"[^>]*(?:\bWin64="yes")/,
    );
    assert.match(windowsMachineInstaller, /INSTALLED_WIX_DIRECTORY = String\.raw`C:\\Program Files \(x86\)\\WiX Toolset v3\.14\\bin`/);
    assert.match(windowsMachineInstaller, /if \(arch === 'x64'\)/);
    assert.match(windowsMachineInstaller, /arch !== 'arm64'/);
    assert.match(windowsMachineInstaller, /!win32\.isAbsolute\(wixDirectory\)/);
    assert.match(windowsMachineInstaller, /\['-\?'\]/);
    assert.match(windowsMachineInstaller, /'CANDLE'/);
    assert.match(windowsMachineInstaller, /'LIGHT'/);
    assert.match(windowsMachineInstaller, /'-arch', arch/);
    assert.match(windowsMachineInstaller, /WIX_DIAGNOSTIC_BYTES = 4 \* 1024/);
    assert.doesNotMatch(windowsMachineInstaller, /wixVendor|electron-winstaller/);
    assert.match(windowsMachineInstaller, /deferred Windows update authority resource present/);
    assert.doesNotMatch(windowsMachineInstaller, /<CustomAction|<ServiceInstall|RollbackProbe|icacls\.exe/);
    assert.match(installedWindowsAppTest, /-Credential \$credential/);
    assert.match(installedWindowsAppTest, /--propr-smoke-test/);
    assert.match(installedWindowsAppTest, /--user-data-dir=\$smokeUserDataDirectory/);
    assert.match(installedWindowsAppTest, /propr-desktop-smoke-/);
    assert.match(installedWindowsAppTest, /SetAccessRuleProtection\(\$true, \$false\)/);
    assert.match(installedWindowsAppTest, /S-1-5-18/);
    assert.match(installedWindowsAppTest, /S-1-5-32-544/);
    assert.match(installedWindowsAppTest, /Remove-SmokeUserDataDirectory \$smokeOwnershipRecord/);
    assert.match(installedWindowsAppTest, /propr:\/\/connect/);
    assert.match(installedWindowsAppTest, /deferred Windows update authority resource/);
    assert.match(installedWindowsAppTest, /\[Environment\]::GetFolderPath\(\[Environment\+SpecialFolder\]::CommonPrograms\)/);
    assert.match(installedWindowsAppTest, /function Test-StartMenuShortcutAsOrdinaryUser\(/);
    assert.match(installedWindowsAppTest, /-ExpectedPresent \$true/);
    assert.match(installedWindowsAppTest, /-ExpectedPresent \$false/);
    assert.match(installedWindowsAppTest, /machine uninstall left the common Start Menu folder behind/);
    assert.equal(workflow.match(/https:\/\/github\.com\/wixtoolset\/wix3\/releases\/download\/wix3141rtm\/wix314-binaries\.zip/g)?.length, 2);
    assert.equal(workflow.match(/6ac824e1642d6f7277d0ed7ea09411a508f6116ba6fae0aa5f2c7daa2ff43d31/g)?.length, 2);
  });

  test('revalidates each real WiX MSI first on native Windows and then from the same staged bytes on Linux', () => {
    for (const [nativeJob, aggregateJob] of [
      [job('package', 'finalize'), job('finalize', 'preflight')],
      [job('release-package', 'release-finalize'), job('release-finalize', 'sign')],
    ] as const) {
      const make = nativeJob.search(/Make (?:signed )?Windows/);
      const installed = nativeJob.indexOf('ordinary-user Windows application');
      const stage = nativeJob.indexOf('release-artifacts.mjs stage');
      const upload = nativeJob.indexOf('Upload');
      assert.ok(make >= 0 && installed > make && stage > installed && upload > stage);
      assert.match(aggregateJob, /sudo apt-get install --yes cpio msitools p7zip-full rpm/);
      assert.match(aggregateJob, /test -x \/usr\/bin\/msiextract/);
      assert.ok(aggregateJob.indexOf('Download all') < aggregateJob.indexOf('release-artifacts.mjs finalize'));
    }
    assert.match(releaseArchitecture, /const MSIEXTRACT = '\/usr\/bin\/msiextract'/);
    assert.match(releaseArchitecture, /KERNEL_MSIEXEC = String\.raw`\\\\\?\\GLOBALROOT\\SystemRoot\\System32\\msiexec\.exe`/);
    assert.doesNotMatch(releaseArchitecture, /electron-winstaller|7z-(?:x64|arm64)\.exe/);
  });

  test('supplementary lint retains installed Windows worker lifecycle contracts', () => {
    assert.doesNotMatch(installedWindowsAppTest, /(?:^|\s)-Wait(?:\s|$)/);
    assert.equal(installedWindowsAppTest.match(/Start-Process/g)?.length, 1);
    assert.match(installedWindowsAppTest, /\$msiTimeoutMilliseconds = 10 \* 60 \* 1000/);
    assert.match(installedWindowsAppTest, /\$applicationTimeoutMilliseconds = 5 \* 60 \* 1000/);
    assert.match(installedWindowsAppTest, /\$terminationTimeoutMilliseconds = 30 \* 1000/);
    assert.match(installedWindowsAppTest, /\$redirectedStreamDrainTimeoutMilliseconds = 30 \* 1000/);
    assert.match(installedWindowsAppTest, /\$Process\.WaitForExit\(\$TimeoutMilliseconds\)/);
    assert.match(installedWindowsAppTest, /\$Process\.Kill\(\$true\)/);
    assert.match(
      installedWindowsAppTest,
      /if \(!\$completed\) \{\n\s+Stop-SpawnedProcessTree \$Process \$Operation\n\s+throw "\$Operation timed out"/,
    );
    assert.match(installedWindowsAppTest, /\$startInfo = \[Diagnostics\.ProcessStartInfo\]::new\(\)/);
    assert.match(installedWindowsAppTest, /\$startInfo\.FileName = \$FilePath/);
    assert.match(installedWindowsAppTest, /\$startInfo\.UseShellExecute = \$false/);
    assert.match(installedWindowsAppTest, /\$startInfo\.WorkingDirectory = \$WorkingDirectory/);
    assert.match(installedWindowsAppTest, /\$startInfo\.UserName = \$UserName/);
    assert.match(installedWindowsAppTest, /\$startInfo\.Domain = \$Domain/);
    assert.match(installedWindowsAppTest, /\$startInfo\.Password = \$Credential\.Password/);
    assert.match(installedWindowsAppTest, /\$startInfo\.LoadUserProfile = \$true/);
    assert.match(installedWindowsAppTest, /\$startInfo\.RedirectStandardOutput = \$true/);
    assert.match(installedWindowsAppTest, /\$startInfo\.RedirectStandardError = \$true/);
    assert.match(installedWindowsAppTest, /foreach \(\$argument in \$Arguments\) \{\n\s+\$startInfo\.ArgumentList\.Add\(\$argument\)/);
    assert.match(installedWindowsAppTest, /\$startInfo\.Environment\.Clear\(\)/);
    assert.match(installedWindowsAppTest, /\$startInfo\.Environment\.Add\(\[string\]\$entry\.Key, \[string\]\$entry\.Value\)/);
    assert.doesNotMatch(installedWindowsAppTest, /\$startInfo\.Arguments\s*=/);
    assert.doesNotMatch(installedWindowsAppTest, /\$applicationArgumentLine|\[string\]::Join\(' ', \$arguments\)/);
    assert.match(installedWindowsAppTest, /"--user-data-dir=\$smokeUserDataDirectory"/);
    assert.doesNotMatch(installedWindowsAppTest, /`"--user-data-dir=\$smokeUserDataDirectory`"/);
    assert.match(installedWindowsAppTest, /-WorkingDirectory \$env:ProgramFiles/);
    assert.match(installedWindowsAppTest, /-StandardOutputPath \(Join-Path \$smokeUserDataDirectory 'application\.stdout\.log'\)/);
    assert.match(installedWindowsAppTest, /-StandardErrorPath \(Join-Path \$smokeUserDataDirectory 'application\.stderr\.log'\)/);
    assert.equal(installedWindowsAppTest.match(/PROPR_DESKTOP_SMOKE_TEST/g)?.length, 1);
    assert.doesNotMatch(installedWindowsAppTest, /Get-Content|Write-(?:Output|Verbose|Debug|Information)/);
    assert.match(installedWindowsAppTest, /-AllowedExitCodes @\(0\)/);
    assert.match(installedWindowsAppTest, /\$exitCode = \$Process\.ExitCode/);
    assert.doesNotMatch(
      installedWindowsAppTest,
      /\[Environment\]::(?:Get|Set)EnvironmentVariable\(\s*'PROPR_DESKTOP_SMOKE_TEST'/,
    );
    assert.doesNotMatch(
      installedWindowsAppTest,
      /PROPR_DESKTOP_SMOKE_TEST'[\s\S]{0,100}\[EnvironmentVariableTarget\]::(?:User|Machine)/,
    );
    assert.match(installedWindowsAppTest, /\[Threading\.Tasks\.Task\]::WaitAll\(\$copyTasks, \$redirectedStreamDrainTimeoutMilliseconds\)/);
    assert.match(installedWindowsAppTest, /\$Launch\.StandardOutputStream\.Dispose\(\)/);
    assert.match(installedWindowsAppTest, /\$Launch\.StandardErrorStream\.Dispose\(\)/);
    assert.doesNotMatch(installedWindowsAppTest, /ReadToEnd|Write-Host[^\n]*(?:StandardOutput|StandardError|Password|UserName|Domain|Arguments)/);

    assert.match(installedWindowsAppTest, /\$smokeEvidenceFileByteCap = 64 \* 1024/);
    assert.match(installedWindowsAppTest, /\$smokeEvidenceFileNames = @\([\s\S]*'application\.smoke-evidence\.jsonl',[\s\S]*'application\.stdout\.log',[\s\S]*'application\.stderr\.log'[\s\S]*\)/);
    assert.match(installedWindowsAppTest, /foreach \(\$fileName in \$smokeEvidenceFileNames\)/);
    assert.match(installedWindowsAppTest, /\[Math\]::Min\(\[int64\]\$item\.Length, \[int64\]\$smokeEvidenceFileByteCap\)/);
    assert.match(installedWindowsAppTest, /!\(\$item -is \[IO\.FileInfo\]\)/);
    assert.match(installedWindowsAppTest, /\$item\.PSIsContainer/);
    assert.match(installedWindowsAppTest, /\$item\.Attributes -band \[IO\.FileAttributes\]::ReparsePoint/);
    assert.match(installedWindowsAppTest, /\[IO\.FileStream\]::new\(/);
    assert.doesNotMatch(installedWindowsAppTest, /New-Object IO\.FileStream\(/);
    const evidenceReader = installedWindowsAppTest.slice(
      installedWindowsAppTest.indexOf('function Get-SmokeEventEvidence'),
      installedWindowsAppTest.indexOf("Write-Stage 'INSTALL' 'BEGIN'"),
    );
    assert.doesNotMatch(evidenceReader, /Get-ChildItem[^\n]*smoke|ReadAll|ReadToEnd/);
    const smokeEventAllowlist = installedWindowsAppTest.match(
      /\$smokeEventCodes = \[ordered\]@\{([\s\S]*?)\n\}/,
    );
    assert.ok(smokeEventAllowlist);
    const expectedSmokeEvents = [
      'desktop.smoke.authorized',
      'desktop.app.ready',
      'desktop.renderer.mvp_flows.ready',
      'desktop.renderer.layout.ready',
      'desktop.native.reduced_window.ready',
      'desktop.renderer.ready',
      'desktop.app.shutdown',
      'desktop.app.start_failed',
      'desktop.main_process.uncaught_exception',
      'desktop.log.write_failed',
    ];
    assert.deepEqual(PACKAGED_SMOKE_EVIDENCE_EVENTS, expectedSmokeEvents);
    assert.deepEqual(
      [...smokeEventAllowlist[1].matchAll(/^\s+'([^']+)' = '[A-Z_]+'$/gm)].map(match => match[1]),
      expectedSmokeEvents,
    );
    assert.match(installedWindowsAppTest, /ConvertFrom-Json -InputObject \$line -ErrorAction Stop/);
    assert.match(installedWindowsAppTest, /\$smokeEventCodes\.Contains\(\$eventName\)/);
    assert.match(
      installedWindowsAppTest,
      /PROPR_WINDOWS_INSTALLED_SMOKE:EVIDENCE:\{0\}['"] -f \(\$summary -join ','\)/,
    );
    assert.doesNotMatch(installedWindowsAppTest, /Write-Host[^\n]*(?:\$line|\$text|\$record|\$filePath|\$eventProperty)/);
    assert.match(installedWindowsAppTest, /\$requiredSmokeEvents = @\([\s\S]*desktop\.smoke\.authorized[\s\S]*desktop\.app\.ready[\s\S]*desktop\.renderer\.mvp_flows\.ready[\s\S]*desktop\.renderer\.layout\.ready[\s\S]*desktop\.native\.reduced_window\.ready[\s\S]*desktop\.renderer\.ready[\s\S]*desktop\.app\.shutdown/);
    assert.match(installedWindowsAppTest, /Get-SmokeEventEvidence \$smokeUserDataDirectory \$testUserSid/);
    assert.match(installedWindowsAppTest, /if \(\$null -ne \$waitFailure\) \{ throw \$waitFailure \}/);
    assert.match(installedWindowsAppTest, /SMOKE_REQUIRED_EVENTS_MISSING/);
    assert.ok(
      installedWindowsAppTest.indexOf('Wait-BoundedProcess `', installedWindowsAppTest.indexOf("Write-Stage 'APP_EXIT' 'BEGIN'"))
        < installedWindowsAppTest.indexOf('Get-SmokeEventEvidence $smokeUserDataDirectory $testUserSid'),
    );
    const applicationExitSection = installedWindowsAppTest.slice(
      installedWindowsAppTest.indexOf("Write-Stage 'APP_EXIT' 'BEGIN'"),
      installedWindowsAppTest.indexOf("Write-Stage 'UNINSTALL' 'BEGIN'"),
    );
    assert.match(
      applicationExitSection,
      /catch \{\n\s+\$waitFailure = \$_\n\s+\} finally \{\n\s+try \{[\s\S]*?Close-RedirectedApplicationStreams \$applicationLaunch[\s\S]*?\} finally \{\n\s+\$applicationLaunch\.Process\.Dispose\(\)\n\s+\$applicationLaunch = \$null/,
    );
    assert.ok(
      applicationExitSection.indexOf('Wait-BoundedProcess `')
        < applicationExitSection.indexOf('Close-RedirectedApplicationStreams $applicationLaunch'),
      'redirected streams must drain only after the bounded process wait completes or fails',
    );
    assert.ok(
      applicationExitSection.indexOf('$applicationLaunch.Process.Dispose()')
        < applicationExitSection.indexOf('Get-SmokeEventEvidence $smokeUserDataDirectory $testUserSid'),
      'the application process must release redirected-stream handles before evidence inspection',
    );
    assert.match(
      applicationExitSection,
      /\} finally \{\n\s+if \(\$null -ne \$applicationLaunch\) \{[\s\S]*Close-RedirectedApplicationStreams \$applicationLaunch[\s\S]*\$applicationLaunch\.Process\.Dispose\(\)/,
    );

    for (const stage of [
      'INSTALL',
      'VALIDATION',
      'USER_SETUP',
      'APP_LAUNCH',
      'APP_EXIT',
      'UNINSTALL',
      'CLEANUP',
    ]) {
      assert.match(installedWindowsAppTest, new RegExp(`Write-Stage '${stage}' 'BEGIN'`));
      assert.match(installedWindowsAppTest, new RegExp(`Write-Stage '${stage}' 'COMPLETE'`));
      assert.match(installedWindowsAppTest, new RegExp(`Write-Stage '${stage}' 'FAILED'`));
    }

    assert.match(
      installedWindowsAppTest,
      /\} catch \{\n\s+\$primaryFailure = \$_\n\s+throw\n\} finally \{\n\s+\$cleanupFailed = \$false[\s\S]*Assert-InstallerArtifactAuthority[\s\S]*Invoke-Msi @\([\s\S]*'\/x', \[string\]\$ownershipState\.InstallerProductCode[\s\S]*Remove-SmokeUserDataDirectory \$smokeOwnershipRecord/,
    );
    assert.match(installedWindowsAppTest, /Get-CimInstance -ClassName Win32_UserProfile/);
    assert.match(installedWindowsAppTest, /Remove-LocalUser -Name \$testUser -ErrorAction Stop/);
    assert.match(
      installedWindowsAppTest,
      /Get-ChildItem -LiteralPath \$installRoot -Force -ErrorAction Stop[\s\S]*Remove-Item -LiteralPath \$installRoot -Force -ErrorAction Stop/,
    );

    for (const section of [job('package', 'finalize'), job('release-package', 'release-finalize')]) {
      assert.match(section, /- platform: win32\n\s+arch: x64\n/);
      assert.match(section, /- platform: win32\n\s+arch: arm64\n/);
      assert.equal(section.match(/run-installed-windows-app-harness\.ps1/g)?.length, 1);
      assert.equal(section.match(/test-installed-windows-app-supervisor\.ps1/g)?.length, 1);
      assert.equal(section.match(/run-installed-windows-app-workflow-cleanup\.ps1/g)?.length, 1);
      assert.match(section, /if: always\(\) && matrix\.platform == 'win32'/);
      assert.match(section, /-OwnershipManifest \$env:PROPR_WINDOWS_INSTALLED_APP_MANIFEST/);
      assert.match(section, /-ExpectedRunId \$env:PROPR_WINDOWS_INSTALLED_APP_RUN_ID/);
    }
  });

  test('runs executable supervisor acceptance on both Windows architectures and keeps supplementary contracts', () => {
    assert.match(installedWindowsAppSupervisorBehaviorTest, /Test-BootstrapTimeout/);
    assert.match(installedWindowsAppSupervisorBehaviorTest, /Test-OperationDeadlineAndTreeTermination/);
    assert.match(installedWindowsAppSupervisorBehaviorTest, /Test-NegativeWorkerExitFinalization/);
    assert.match(installedWindowsAppSupervisorBehaviorTest, /Test-FailClosedMarkers/);
    assert.match(installedWindowsAppSupervisorBehaviorTest, /Test-LiveCancellationAndRedaction/);
    assert.match(installedWindowsAppSupervisorBehaviorTest, /Test-PreExistingCleanupOwnership/);
    assert.match(installedWindowsAppSupervisorBehaviorTest, /Start-ExternallyInterruptibleSupervisor/);
    assert.match(installedWindowsAppSupervisorBehaviorTest, /Invoke-WorkflowCleanupController/);
    assert.match(installedWindowsAppSupervisorBehaviorTest, /Test-PreExistingAppPathsAuthority/);
    assert.match(installedWindowsAppSupervisorBehaviorTest, /Assert-ProcessTreeGone/);
    assert.match(installedWindowsAppSupervisorBehaviorTest, /WindowsIdentity\]::GetCurrent\(\)/);
    assert.match(
      installedWindowsAppSupervisorBehaviorTest,
      /Get-CimInstance -ClassName Win32_UserProfile -ErrorAction Stop/,
    );
    assert.match(installedWindowsAppSupervisorBehaviorTest, /Get-Acl -LiteralPath \$canonicalLocalPath/);
    assert.match(installedWindowsAppSupervisorBehaviorTest, /FileAttributes\]::ReparsePoint/);
    assert.match(installedWindowsAppSupervisorBehaviorTest, /Assert-RunnerProfileUnchanged/);
    assert.match(
      installedWindowsAppSupervisorBehaviorTest,
      /PROPR_WINDOWS_SUPERVISOR_OWNERSHIP:PRE_EXISTING_AUTHORITIES:PRESERVED/,
    );
    assert.doesNotMatch(
      installedWindowsAppSupervisorBehaviorTest,
      /CreateProfile|DeleteProfile|userenv\.dll/,
    );
    assert.match(installedWindowsAppSupervisorFixture, /Start-FixtureDescendant/);

    assert.match(installedWindowsAppSupervisor, /JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000/);
    assert.match(installedWindowsAppSupervisor, /AssignProcessToJobObject\(handle, processHandle\)/);
    assert.match(installedWindowsAppSupervisor, /TerminateJobObject\(handle, exitCode\)/);
    assert.match(installedWindowsAppSupervisor, /\$job\.AddProcess\(\$worker\.Handle\)/);
    assert.match(installedWindowsAppSupervisor, /\[void\]\$ownershipReadyEvent\.Set\(\)/);
    assert.ok(
      installedWindowsAppSupervisor.indexOf('$job.AddProcess($worker.Handle)')
        < installedWindowsAppSupervisor.indexOf('[void]$ownershipReadyEvent.Set()'),
    );
    assert.match(installedWindowsAppTest, /\$ownershipHandshakeTimeoutMilliseconds = 5 \* 1000/);
    assert.match(installedWindowsAppTest, /\$ownershipReady\.WaitOne\(\$ownershipHandshakeTimeoutMilliseconds\)/);
    assert.match(installedWindowsAppSupervisor, /if \(!\$worker\.Start\(\)\)[^\n]+\n\s+\$workerStarted = \$true\n\s+\$bootstrapStopwatch = \[Diagnostics\.Stopwatch\]::StartNew\(\)/);
    assert.match(installedWindowsAppSupervisor, /\[ProPRBoundedMarkerReader\]::ReadAsync\(\$Path\)/);
    assert.match(installedWindowsAppSupervisor, /\$readTask\.Wait\(\$TimeoutMilliseconds\)/);
    assert.match(
      installedWindowsAppSupervisor,
      /\$job\.TerminateAndWait\(\$TerminationExitCode, \$WatchdogTerminationMilliseconds\)/,
    );
    assert.match(installedWindowsAppSupervisor, /\$workerTreeTerminated = Stop-OwnedWorker 125/);
    assert.doesNotMatch(installedWindowsAppSupervisor, /Stop-OwnedWorker \(\[uint32\]\$exitCode\)/);
    assert.match(installedWindowsAppSupervisorFixture, /'NEGATIVE_EXIT'[\s\S]*exit -1/);
    assert.match(installedWindowsAppSupervisor, /\$worker\.WaitForExit\(\$WatchdogTerminationMilliseconds\)/);
    assert.match(
      installedWindowsAppSupervisor,
      /if \(\$workerTreeTerminated -and \$postTerminationCleanupAuthorized\) \{[\s\S]*Invoke-PostTerminationCleanup/,
    );
    assert.match(installedWindowsAppSupervisor, /Invoke-PostTerminationCleanup/);
    assert.match(installedWindowsAppSupervisor, /\$cleanupRequired = \$terminateOwnedTree -or \$workerStarted/);
    assert.match(
      installedWindowsAppSupervisor,
      /PROPR_WINDOWS_INSTALLED_SMOKE:WATCHDOG:POST_TERMINATION_CLEANUP:COMPLETE/,
    );
    assert.match(installedWindowsAppCleanup, /Remove-OwnedProfiles/);
    assert.match(installedWindowsAppCleanup, /Promote-UncapturedOwnedProfiles/);
    assert.match(
      installedWindowsAppCleanup,
      /\$matchingRecords = @\(\)[\s\S]*Resolve-ValidatedOwnedProfilePath[\s\S]*\$matchingRecords\.Count -ne 1[\s\S]*Remove-CimInstance/,
    );
    for (const script of [installedWindowsAppTest, installedWindowsAppCleanup]) {
      assert.match(script, /Resolve-SystemProfilesDirectory/);
      assert.match(script, /-Name 'ProfilesDirectory' -ErrorAction Stop/);
      assert.match(script, /Resolve-CanonicalNonReparseDirectory/);
      assert.match(script, /FileAttributes\]::ReparsePoint/);
      assert.match(script, /Split-Path -Parent \$canonicalLocalPath/);
      assert.match(script, /Split-Path -Leaf \$canonicalLocalPath/);
      assert.match(script, /profile local path is not the exact owned direct child of ProfilesDirectory/);
      assert.match(
        script,
        /Resolve-ValidatedOwnedProfilePath[\s\S]*profile ownership changed immediately before deletion[\s\S]*Remove-CimInstance/,
      );
    }
    assert.match(
      installedWindowsAppSupervisorBehaviorTest,
      /mismatched durable profile path did not fail closed[\s\S]*mismatched profile path discarded ACTIVE recovery authority/,
    );
    assert.match(
      installedWindowsAppSupervisorBehaviorTest,
      /alternate ProfilesDirectory leaf did not fail closed[\s\S]*alternate ProfilesDirectory leaf discarded ACTIVE recovery authority/,
    );
    assert.match(installedWindowsAppCleanup, /Remove-OwnedRegistryKey/);
    assert.match(installedWindowsAppCleanup, /Remove-OwnedDirectory/);
    assert.match(installedWindowsAppCleanup, /APP_PATH/);
    assert.match(installedWindowsAppCleanup, /HKEY_CURRENT_USER\\Software\\ProPR\\Desktop/);
    assert.match(installedWindowsAppCleanup, /Restore-OwnedRegistryValue/);
    assert.match(installedWindowsAppCleanup, /Write-EmptyOwnershipReceipt/);
    assert.match(installedWindowsAppCleanup, /Get-RegistryTreeIdentity/);
    assert.match(installedWindowsAppCleanup, /Get-FileIdentity/);
    assert.match(installedWindowsAppCleanup, /Get-DirectoryIdentity/);
    assert.match(installedWindowsAppCleanup, /Get-FileSystemTreeIdentity/);
    assert.match(installedWindowsAppCleanup, /Assert-MsiManagedFileSystemAuthority/);
    assert.match(
      installedWindowsAppCleanup,
      /Assert-MsiManagedFileSystemAuthority \$manifest\n\s+Assert-InstallerArtifactAuthority \$manifest\n\s+\$msi = Start-Process msiexec\.exe/,
    );
    assert.doesNotMatch(installedWindowsAppCleanup, /AllowProvisionalProductOwnership/);
    assert.doesNotMatch(installedWindowsAppCleanup, /allowProvisionalMsiUninstall/);
    assert.match(
      installedWindowsAppCleanup,
      /\$allowAuthenticatedMsiUninstall[\s\S]*MsiTransactionState -ceq 'COMMITTED'[\s\S]*Start-Process msiexec\.exe/,
    );
    assert.match(
      installedWindowsAppCleanup,
      /provisional registry evidence cannot authorize manual cleanup/,
    );
    assert.match(
      installedWindowsAppTest,
      /MsiTransactionState = 'PENDING'[\s\S]*if \(!\$script:msiInstallCompleted\)[\s\S]*Get-DirectoryIdentity \$installRoot/,
    );
    assert.match(installedWindowsAppTest, /MsiTransactionState = 'ROLLED_BACK_CLEAN'/);
    assert.match(installedWindowsAppTest, /MsiTransactionState = 'COMMITTED'/);
    assert.match(installedWindowsAppTest, /Assert-ExactCleanMsiBaselineAfterRollback/);
    assert.match(
      installedWindowsAppTest,
      /Assert-MsiProductIsUnregistered \(\[string\]\$ownershipState\.InstallerProductCode\)/,
    );
    assert.match(installedWindowsAppCleanup, /Assert-MsiProductIsUnregistered/);
    assert.match(installedWindowsAppSupervisor, /Wait-MsiCriticalTransactionReceipt/);
    assert.match(installedWindowsAppSupervisorBehaviorTest, /DURING_MSI/);
    assert.match(installedWindowsAppSupervisorBehaviorTest, /DURING_OWNERSHIP_CAPTURE/);
    assert.match(
      installedWindowsAppTest,
      /Registry::HKEY_LOCAL_MACHINE\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\propr-desktop\.exe/,
    );
    assert.match(installedWindowsAppTest, /APP_PATH_ASSERTION/);
    assert.match(installedWindowsAppTest, /APP_PATH_ABSENCE_ASSERTION/);
    assert.match(installedWindowsAppTest, /APP_PATH_FALLBACK/);
    assert.match(installedWindowsAppTest, /HKCU_INSTALLED_ASSERTION/);
    assert.match(installedWindowsAppTest, /HKCU_INSTALLED_ABSENCE_ASSERTION/);
    assert.match(installedWindowsAppTest, /HKCU_INSTALLED_FALLBACK/);
    assert.match(installedWindowsAppSupervisorBehaviorTest, /Test-HkcuInstalledValueOwnership/);
    assert.match(installedWindowsAppSupervisorBehaviorTest, /OWNED_RESOURCES_NORMAL_SUCCESS/);
    assert.match(installedWindowsAppSupervisorBehaviorTest, /typed authenticated empty-state receipt/);
    assert.match(
      installedWindowsAppTest,
      /Get-RegistryTreeIdentity \$appPathsRegistryPath[\s\S]*refusing to uninstall over executable metadata[\s\S]*Invoke-Msi @\([\s\S]*'\/x', \[string\]\$ownershipState\.InstallerProductCode/,
    );
    assert.match(
      installedWindowsAppTest,
      /Assert-MsiManagedFileSystemAuthority[\s\S]*Assert-InstallerArtifactAuthority[\s\S]*Invoke-Msi @\([\s\S]*'\/x', \[string\]\$ownershipState\.InstallerProductCode/,
    );
    assert.match(installedWindowsAppSupervisor, /Get-InstallerAuthority \$Installer/);
    assert.ok(
      installedWindowsAppSupervisor.indexOf('Get-InstallerAuthority $Installer')
        < installedWindowsAppSupervisor.indexOf('if (!$worker.Start())'),
      'installer authority must be captured before the worker starts',
    );
    for (const field of [
      'InstallerEntryIdentity', 'InstallerSha256', 'InstallerProductCode',
    ]) {
      assert.match(installedWindowsAppSupervisor, new RegExp(field));
      assert.match(installedWindowsAppTest, new RegExp(field));
      assert.match(installedWindowsAppCleanup, new RegExp(field));
    }
    assert.match(installedWindowsAppSupervisor, /SchemaVersion = 3/);
    assert.match(installedWindowsAppTest, /SchemaVersion = 3/);
    assert.match(installedWindowsAppCleanup, /SchemaVersion -ne 3/);
    assert.match(
      installedWindowsAppCleanup,
      /\[IO\.FileShare\]'ReadWrite, Delete'[\s\S]*ReadHandle\(\s*\$manifestStream\.SafeFileHandle,/,
    );
    assert.match(
      installedWindowsAppCleanup,
      /ReadEntry\(\$manifestPath, \$false\) -cne\s+\$manifestEntryIdentity/,
    );
    assert.match(
      installedWindowsAppCleanup,
      /HANDSHAKE','FILE_AUTHORITY','UTF8_DECODE','JSON_PARSE','EXACT_KEY_SET',[\s\S]*'BOOLEAN_TYPES','TRANSACTION_ENUM','SCHEMA_TYPE_STATE','RUN_ID_FORMAT',[\s\S]*'INSTALLER_ENTRY_ID_FORMAT','INSTALLER_SHA256_FORMAT','INSTALLER_PRODUCT_CODE_FORMAT',[\s\S]*'INITIAL_ACTIVE_MATCH'/,
    );
    assert.match(
      installedWindowsAppCleanup,
      /\$manifest\.Fixture\.PSObject\.BaseObject\.GetType\(\) -ne \[bool\][\s\S]*\$manifest\.BaselineClean\.PSObject\.BaseObject\.GetType\(\) -ne \[bool\][\s\S]*\$manifest\.InstallAttempted\.PSObject\.BaseObject\.GetType\(\) -ne \[bool\]/,
    );
    assert.match(
      installedWindowsAppCleanup,
      /\$manifest\.RunId\.PSObject\.BaseObject[\s\S]*GetType\(\) -ne \[string\][\s\S]*\$manifest\.InstallerEntryIdentity\.PSObject\.BaseObject[\s\S]*\$manifest\.InstallerSha256\.PSObject\.BaseObject[\s\S]*\$manifest\.InstallerProductCode\.PSObject\.BaseObject/,
    );
    assert.match(
      installedWindowsAppCleanup,
      /\$manifest\.RunId = \[string\]\$runIdBaseObject[\s\S]*\$manifest\.InstallerProductCode = \[string\]\$installerProductCodeBaseObject/,
    );
    assert.match(
      installedWindowsAppCleanup,
      /\[IO\.File\]::Replace\(\$temporaryPath, \$Path, \$null, \$true\)/,
    );
    assert.doesNotMatch(
      installedWindowsAppCleanup,
      /\[IO\.File\]::Move\(\$temporaryPath, \$Path, \$true\)/,
    );
    assert.match(
      installedWindowsAppSupervisor,
      /if \(\$fixtureNoMarkerDiagnostic\)[\s\S]*-FixtureValidationDiagnostic/,
    );
    assert.match(
      installedWindowsAppSupervisor,
      /if \(\$fixtureNoMarkerDiagnostic\) \{[\s\S]*RedirectStandardOutput = \$true[\s\S]*RedirectStandardError = \$true/,
    );
    assert.ok(
      installedWindowsAppSupervisor.indexOf('$cleanupJob.AddProcess($cleanupProcess.Handle)')
        < installedWindowsAppSupervisor.indexOf('[void]$cleanupReadyEvent.Set()'),
      'cleanup diagnostic child must enter its Job Object before ownership release',
    );
    assert.ok(
      installedWindowsAppSupervisor.indexOf('[void]$cleanupReadyEvent.Set()')
        < installedWindowsAppSupervisor.indexOf('$cleanupDiagnosticDrain.Start($cleanupProcess)'),
      'cleanup diagnostic ownership must be released before redirected stream drains begin',
    );
    assert.match(installedWindowsAppSupervisor, /class ProPRCleanupDiagnosticDrain/);
    assert.match(installedWindowsAppSupervisor, /StandardOutputByteLimit = 96/);
    assert.match(installedWindowsAppSupervisor, /StandardOutputLineLimit = 1/);
    assert.match(installedWindowsAppSupervisor, /StandardErrorByteLimit = 0/);
    assert.match(installedWindowsAppSupervisor, /StandardErrorLineLimit = 0/);
    assert.match(
      installedWindowsAppSupervisor,
      /\\ACLEANUP_VALIDATION_PHASE:[\s\S]*INITIAL_ACTIVE_MATCH\)\\r\?\\n\\z/,
    );
    assert.match(installedWindowsAppSupervisor, /\$cleanupHostPath = \$hostPath/);
    assert.match(
      installedWindowsAppSupervisor,
      /if \(\$fixtureWindowsPowerShellCleanup\)[\s\S]*System32\\WindowsPowerShell\\v1\.0\\powershell\.exe/,
    );
    assert.match(
      installedWindowsAppSupervisor,
      /function Get-CanonicalManifestIdentifiers[\s\S]*ToLowerInvariant\(\)[\s\S]*\[Guid\]::TryParseExact\([\s\S]*ToString\('B'\)\.ToUpperInvariant\(\)/,
    );
    assert.doesNotMatch(
      installedWindowsAppSupervisor,
      /InstallerEntryIdentity = \[string\]\$InstallerAuthority\.EntryIdentity[\s\S]*InstallerProductCode = \[string\]\$InstallerAuthority\.ProductCode/,
      'the 3af4800 capture/display representation must not be persisted as the identifier wire format',
    );
    assert.match(
      installedWindowsAppSupervisor,
      /\$roundTrip = ConvertFrom-Json[\s\S]*\$roundTrip\.RunId -cne \$identifiers\.RunId[\s\S]*\$roundTrip\.InstallerProductCode -cne[\s\S]*\$identifiers\.InstallerProductCode/,
    );
    assert.match(
      installedWindowsAppCleanup,
      /\[Console\]::Out\.WriteLine\(\s*'CLEANUP_VALIDATION_PHASE:' \+ \$Phase/,
    );
    assert.doesNotMatch(
      installedWindowsAppCleanup,
      /\[Console\]::Out\.WriteLine\([\s\S]{0,120}PROPR_WINDOWS_INSTALLED_SMOKE:WATCHDOG:CLEANUP_VALIDATION_PHASE/,
    );
    assert.match(
      installedWindowsAppSupervisorBehaviorTest,
      /CLEANUP_VALIDATION_PHASE:[\s\S]*HANDSHAKE\|FILE_AUTHORITY\|UTF8_DECODE\|JSON_PARSE\|EXACT_KEY_SET\|[\s\S]*BOOLEAN_TYPES\|TRANSACTION_ENUM\|SCHEMA_TYPE_STATE\|RUN_ID_FORMAT\|[\s\S]*INSTALLER_ENTRY_ID_FORMAT\|INSTALLER_SHA256_FORMAT\|INSTALLER_PRODUCT_CODE_FORMAT\|/,
    );
    assert.match(installedWindowsAppSupervisorBehaviorTest, /Test-WindowsPowerShellCleanupCompatibility/);
    assert.match(installedWindowsAppSupervisorBehaviorTest, /NO_MARKER_WINDOWS_POWERSHELL/);
    assert.doesNotMatch(
      installedWindowsAppCleanup,
      /Start-Process msiexec\.exe[\s\S]{0,180}`"\$resolvedInstaller`"/,
    );
    assert.match(
      installedWindowsAppCleanup,
      /Start-Process msiexec\.exe -ArgumentList @\(\n\s+'\/x', \[string\]\$manifest\.InstallerProductCode/,
    );
    assert.match(
      installedWindowsAppSupervisorBehaviorTest,
      /same-path installer replacement did not fail closed/,
    );
    assert.match(installedWindowsAppSupervisorBehaviorTest, /ACTIVE recovery authority/);
    assert.match(installedWindowsAppTest, /TreeIdentity = \$script:installRootOwnedTreeIdentity/);
    assert.match(installedWindowsAppTest, /EntryIdentity = \$script:shortcutOwnedEntryIdentity/);
    assert.match(installedWindowsAppSupervisorBehaviorTest, /mismatched App Paths ownership identity did not fail closed/);
    assert.match(installedWindowsAppWorkflowCleanup, /ProPRWorkflowCleanupJob/);
    assert.match(installedWindowsAppWorkflowCleanup, /QueryInformationJobObject/);
    assert.match(installedWindowsAppWorkflowCleanup, /WaitForNoActiveProcesses/);
    assert.match(installedWindowsAppWorkflowCleanup, /TerminateAndWait/);
    assert.ok(
      installedWindowsAppWorkflowCleanup.indexOf('$cleanupJob.AddProcess($cleanupProcess.Handle)')
        < installedWindowsAppWorkflowCleanup.indexOf('$outputDrain.Start($cleanupProcess)'),
      'cleanup root must enter the Job Object before redirected output drains begin',
    );
    assert.ok(
      installedWindowsAppWorkflowCleanup.indexOf('$cleanupJob.AddProcess($cleanupProcess.Handle)')
        < installedWindowsAppWorkflowCleanup.indexOf('[void]$cleanupReadyEvent.Set()'),
      'cleanup root must enter the Job Object before worker ownership is released',
    );
    assert.ok(
      installedWindowsAppCleanup.indexOf('$ownershipReady.WaitOne(5000)')
        < installedWindowsAppCleanup.indexOf("Add-Type -TypeDefinition @'"),
      'cleanup worker ownership handshake must precede cold type loading',
    );
    assert.match(installedWindowsAppSupervisorBehaviorTest, /early-initialization child cleanup/);
    assert.match(installedWindowsAppCleanup, /workflow-cleanup-early-processes\.json/);
    assert.match(installedWindowsAppWorkflowCleanup, /MANIFEST_VALIDATION_FAILURE/);
    assert.match(installedWindowsAppWorkflowCleanup, /OWNED_RESOURCE_CLEANUP_FAILURE/);
    assert.match(installedWindowsAppWorkflowCleanup, /ProPRWorkflowCleanupOutputDrain/);
    assert.match(installedWindowsAppWorkflowCleanup, /StreamReader reader/);
    assert.match(installedWindowsAppWorkflowCleanup, /reader\.ReadAsync/);
    assert.match(installedWindowsAppWorkflowCleanup, /STREAM_DRAIN_(?:TIMEOUT|FAILURE)/);
    assert.match(installedWindowsAppWorkflowCleanup, /CHILD_STDERR/);
    assert.match(installedWindowsAppWorkflowCleanup, /WorkflowCleanupControllerPhase/);
    assert.match(installedWindowsAppWorkflowCleanup, /WorkflowCleanupControllerLine/);
    assert.match(installedWindowsAppWorkflowCleanup, /Set-CaughtControllerFailure/);
    assert.doesNotMatch(installedWindowsAppWorkflowCleanup, /Console\]::SetError|\btrap\b|controllerBody/);
    assert.match(installedWindowsAppWorkflowCleanup, /\[Console\]::Out\.WriteLine/);
    assert.equal(installedWindowsAppWorkflowCleanup.match(/\[Console\]::Out\.WriteLine/g)?.length, 2);
    assert.doesNotMatch(installedWindowsAppWorkflowCleanup, /Write-Host/);
    assert.match(
      installedWindowsAppWorkflowCleanup,
      /Add-Type -TypeDefinition @'[\s\S]*'@\n\ntry \{\n\$controllerPhase = 'PARAMETER_VALIDATION'[\s\S]*\$controllerPhase = 'PROCESS_WAIT'[\s\S]*\n\} catch \{\n\s+Set-CaughtControllerFailure \$_\n\}/,
    );
    assert.doesNotMatch(installedWindowsAppWorkflowCleanup, /\$invokeController|StartupFailureClass/);
    assert.match(
      installedWindowsAppWorkflowCleanupWrapper,
      /run-installed-windows-app-workflow-cleanup-body\.ps1/,
    );
    assert.match(
      installedWindowsAppWorkflowCleanupWrapper,
      /\[object\]\$OwnershipManifest[\s\S]*\[object\]\$Installer[\s\S]*\[object\]\$ExpectedRunId/,
    );
    assert.match(
      installedWindowsAppWorkflowCleanupWrapper,
      /'PARSER'[\s\S]*'PARAMETER_BINDING'[\s\S]*'TYPE_LOAD'[\s\S]*'OTHER'/,
    );
    assert.match(installedWindowsAppWorkflowCleanupWrapper, /Write-StartupFailure \$_/);
    assert.equal(
      installedWindowsAppWorkflowCleanupWrapper.match(/\[Console\]::Out\.WriteLine/g)?.length,
      2,
    );
    assert.doesNotMatch(
      installedWindowsAppWorkflowCleanupWrapper,
      /Console\]::SetError|Write-(?:Error|Host)|\btrap\b/,
    );
    assert.match(installedWindowsAppWorkflowCleanup, /CancelAndFinish/);
    assert.doesNotMatch(
      installedWindowsAppWorkflowCleanup,
      /add_(?:Output|Error)DataReceived|Begin(?:Output|Error)ReadLine/,
    );
    assert.match(
      installedWindowsAppWorkflowCleanup,
      /if \(\$fixedResult -ceq 'COMPLETE' -and \$cleanupTreeZeroVerified -and/,
    );
    assert.match(
      installedWindowsAppSupervisor,
      /if \(\$fixedCleanupResult -eq \$true -and !\$workflowManagedManifest\)/,
    );
    assert.match(installedWindowsAppSupervisorBehaviorTest, /OWNED_RESOURCES_REPLACED_THEN_DEADLINE/);
    assert.match(
      installedWindowsAppSupervisorBehaviorTest,
      /OWNED_EXECUTABLE_REPLACED_THEN_DEADLINE/,
    );
    assert.match(
      installedWindowsAppSupervisorBehaviorTest,
      /OWNED_SHORTCUT_REPLACED_THEN_DEADLINE/,
    );
    assert.match(installedWindowsAppSupervisorBehaviorTest, /replacement executable was removed or changed/);
    assert.match(installedWindowsAppSupervisorBehaviorTest, /replacement shortcut was removed or changed/);
    assert.match(
      installedWindowsAppSupervisorFixture,
      /function Initialize-FixtureDirectoryIdentity \{[\s\S]*?Add-Type -TypeDefinition/,
    );
    assert.doesNotMatch(
      installedWindowsAppSupervisorFixture.slice(
        0,
        installedWindowsAppSupervisorFixture.indexOf('function Initialize-FixtureDirectoryIdentity'),
      ),
      /Add-Type/,
    );
    assert.match(
      installedWindowsAppSupervisorFixture,
      /'OWNED_RESOURCES_THEN_DEADLINE' \{[\s\S]*Write-FixtureMarker[\s\S]*New-OwnedFixtureResources/,
    );
    assert.ok(
      installedWindowsAppSupervisorBehaviorTest.indexOf('$statusMatch = [regex]::Match(')
        < installedWindowsAppSupervisorBehaviorTest.indexOf('if ($errorOutput.Length -ne 0)'),
      'controller fixed stdout must be parsed before bounded stderr classification',
    );
    assert.match(
      installedWindowsAppSupervisorBehaviorTest,
      /PROPR_WORKFLOW_CLEANUP_FIXTURE:\{0\}:STATUS:\{1\}:EXIT_CODE:\{2\}/,
    );
    assert.match(installedWindowsAppSupervisorBehaviorTest, /Get-SanitizedControllerStartupDiagnostic/);
    assert.match(
      installedWindowsAppSupervisorBehaviorTest,
      /STARTUP_CLASS:\{0\}:PROCESS_EXIT:\{1\}:LINE:\{2\}/,
    );
    assert.match(
      installedWindowsAppSupervisorBehaviorTest,
      /'PARSER'[\s\S]*'PARAMETER_BINDING'[\s\S]*'TYPE_LOAD'[\s\S]*'OTHER'/,
    );
    assert.match(
      installedWindowsAppSupervisorBehaviorTest,
      /OWNED_RESOURCES_FOREIGN_CHILD_THEN_DEADLINE/,
    );
    assert.match(installedWindowsAppSupervisorBehaviorTest, /in-place foreign child was removed or changed/);
    for (const checkpoint of [
      'SMOKE_BEFORE_PROMOTION_THEN_DEADLINE',
      'SMOKE_AFTER_PROMOTION_THEN_DEADLINE',
      'SMOKE_AFTER_ARTIFACTS_THEN_DEADLINE',
      'SMOKE_FOREIGN_DESCENDANT_THEN_DEADLINE',
      'SMOKE_TOKEN_MISMATCH_THEN_DEADLINE',
    ]) {
      assert.match(installedWindowsAppSupervisorBehaviorTest, new RegExp(checkpoint));
      assert.match(installedWindowsAppSupervisorFixture, new RegExp(checkpoint));
    }
    assert.match(installedWindowsAppSupervisorBehaviorTest, /foreign-smoke-in-place/);
    assert.match(installedWindowsAppSupervisorBehaviorTest, /Test-PrimaryWorkerFallbackForeignDescendants/);
    assert.match(installedWindowsAppSupervisorFixture, /PRIMARY_FALLBACK_FOREIGN_DESCENDANTS/);
    assert.match(installedWindowsAppSupervisorBehaviorTest, /primary install fallback removed or changed/);
    assert.match(installedWindowsAppSupervisorBehaviorTest, /primary shortcut fallback removed or changed/);
    assert.match(installedWindowsAppSupervisorBehaviorTest, /Get-SanitizedSupervisorMarkerDiagnostic/);
    assert.match(
      installedWindowsAppSupervisorBehaviorTest,
      /SUPERVISOR_EXIT:\{0\}:BOOTSTRAP_TIMED_OUT:\{1\}:LAST_VALID_NONE:\{2\}/,
    );
    assert.match(
      installedWindowsAppSupervisorBehaviorTest,
      /POST_TERMINATION_CLEANUP:\{3\}:SUBPHASE:\{4\}:CLEANUP_CHILD_EXIT:\{5\}/,
    );
    assert.match(
      installedWindowsAppSupervisor,
      /FIXTURE_FINALIZATION:' \+\s*'WORKER_TREE_TERMINATION:\{0\}'\) -f/,
    );
    assert.match(
      installedWindowsAppSupervisor,
      /FIXTURE_FINALIZATION:' \+\s*'CLEANUP_CHILD_EXIT:\{0\}'\) -f/,
    );
    assert.match(installedWindowsAppCleanup, /\$initialActiveFixtureManifest/);
    assert.match(
      installedWindowsAppCleanup,
      /Write-EmptyOwnershipReceipt \$manifestPath \$manifest/,
    );
    const primaryFallbackFixture = installedWindowsAppSupervisorFixture.slice(
      installedWindowsAppSupervisorFixture.indexOf('function Test-PrimaryFallbackForeignDescendants'),
      installedWindowsAppSupervisorFixture.indexOf('function Start-FixtureDescendant'),
    );
    assert.doesNotMatch(primaryFallbackFixture, /Initialize-FixtureDirectoryIdentity|Add-Type/);
    assert.match(installedWindowsAppSupervisorBehaviorTest, /CONTROLLER_PARAMETER_VALIDATION_PARAMETERS_/);
    assert.match(installedWindowsAppSupervisorBehaviorTest, /InjectTerminationFailure/);
    assert.match(installedWindowsAppSupervisorBehaviorTest, /termination failure discarded authenticated recovery authority/);
    assert.match(installedWindowsAppSupervisorBehaviorTest, /Test-ProvisionalUserMarkerOwnership/);
    assert.match(installedWindowsAppSupervisorBehaviorTest, /provisional username authorized replacement-account deletion/);
    assert.match(installedWindowsAppTest, /-Description \$userOwnershipMarker/);
    assert.match(installedWindowsAppCleanup, /provisional local-user ownership marker does not match/);
    assert.doesNotMatch(installedWindowsAppCleanup, /\$skipMsiUninstall/);
    const ownedDirectoryCleanup = installedWindowsAppCleanup.slice(
      installedWindowsAppCleanup.indexOf('function Remove-OwnedDirectory'),
      installedWindowsAppCleanup.indexOf('function Remove-OwnedFile'),
    );
    assert.doesNotMatch(ownedDirectoryCleanup, /Remove-Item[^\n]*-Recurse/);
    assert.match(ownedDirectoryCleanup, /owned directory contains an unexpected descendant/);
    assert.match(ownedDirectoryCleanup, /Get-ChildItem[^\n]*-Force/);
    assert.match(installedWindowsAppCleanup, /Resolve-SmokeDirectoryAuthority/);
    assert.match(installedWindowsAppCleanup, /Remove-OwnedSmokeDirectory/);
    assert.match(installedWindowsAppCleanup, /Get-FileSystemEntryIdentity/);
    const ownedFileCleanup = installedWindowsAppCleanup.slice(
      installedWindowsAppCleanup.indexOf('function Remove-OwnedFile'),
      installedWindowsAppCleanup.indexOf('function Remove-OwnedRegistryKey'),
    );
    assert.match(
      ownedFileCleanup,
      /Record\.EntryIdentity[\s\S]*Get-FileSystemEntryIdentity \$path \$false/,
    );
    assert.ok(
      ownedFileCleanup.indexOf('Get-FileSystemEntryIdentity $path $false')
        < ownedFileCleanup.indexOf('Remove-Item -LiteralPath $path'),
      'owned file entry identity must be checked immediately before deletion',
    );
    assert.match(
      installedWindowsAppSupervisorBehaviorTest,
      /OWNED_EXECUTABLE_BYTE_IDENTICAL_REPLACED_THEN_DEADLINE/,
    );
    assert.match(installedWindowsAppSupervisorBehaviorTest, /LINE_COUNT:\{0\}:STDERR_COUNT:\{1\}/);
    assert.match(installedWindowsAppCleanup, /smoke user-data object owner is not authorized/);
    assert.match(installedWindowsAppCleanup, /smoke user-data object ACL is not authorized/);
    assert.match(installedWindowsAppCleanup, /entries\.Count -ge 50000/);
    const smokeCleanup = installedWindowsAppCleanup.slice(
      installedWindowsAppCleanup.indexOf('function Remove-OwnedSmokeDirectory'),
      installedWindowsAppCleanup.indexOf('function Remove-OwnedDirectory'),
    );
    assert.doesNotMatch(smokeCleanup, /Remove-Item[^\n]*-Recurse/);
    assert.match(smokeCleanup, /Get-ChildItem[^\n]*-Force/);
    assert.match(
      installedWindowsAppTest,
      /Write-DurableOwnershipToken[\s\S]*Promote-SmokeOwnershipRecord[\s\S]*SHORTCUT_PRESENT_PROBE/,
    );
    assert.match(
      installedWindowsAppTest,
      /CreatorSid = \[Security\.Principal\.WindowsIdentity\]::GetCurrent\(\)\.User\.Value/,
    );
    assert.match(
      installedWindowsAppSupervisorBehaviorTest,
      /replacement install tree was removed or changed/,
    );
    assert.match(
      installedWindowsAppSupervisorBehaviorTest,
      /timed-out workflow cleanup discarded authenticated recovery authority[\s\S]*failed workflow cleanup discarded authenticated recovery authority[\s\S]*retry to fixed cleanup success/,
    );
    const fixedResultWrite = installedWindowsAppWorkflowCleanup.indexOf(
      'Write-FixedResult $fixedResult',
    );
    assert.ok(
      fixedResultWrite > installedWindowsAppWorkflowCleanup.indexOf('$resource.Dispose()')
        && fixedResultWrite > installedWindowsAppWorkflowCleanup.indexOf(
          'if ($fixedResult -ceq \'COMPLETE\' -and $validatedManifestPath)',
        ),
      'fixed controller evidence must be emitted after bounded finalization',
    );
    assert.doesNotMatch(
      installedWindowsAppSupervisorBehaviorTest,
      /workflowCleanup\.(?:Error|StandardError)|failedCleanup\.(?:Error|StandardError)/,
    );
    for (const result of ['COMPLETE', 'FAILED', 'TIMED_OUT']) {
      assert.match(
        installedWindowsAppWorkflowCleanup,
        new RegExp(`PROPR_WINDOWS_INSTALLED_SMOKE:WORKFLOW_CLEANUP:\\$Result|["']${result}["']`),
      );
    }
    assert.match(installedWindowsAppSupervisor, /exit \$exitCode/);
    assert.match(
      installedWindowsAppSupervisor,
      /foreach \(\$resource in @\(\$job, \$worker, \$ownershipReadyEvent, \$cancellationEvent\)\)/,
    );
    assert.match(installedWindowsAppSupervisor, /try \{ \$resource\.Dispose\(\) \} catch/);

    assert.match(installedWindowsAppTest, /\[IO\.FileOptions\]::WriteThrough/);
    assert.equal(installedWindowsAppTest.match(/\.Flush\(\$true\)/g)?.length, 4);
    assert.match(
      installedWindowsAppTest,
      /\$record = '\{0\}\|\{1\}\|\{2\}\|\{3\}' -f \$deadline, \$Stage, \$Substage, \$Status/,
    );
    assert.match(
      installedWindowsAppSupervisor,
      /\(\?<Status>BEGIN\|COMPLETE\|FAILED\)/,
    );
    assert.match(
      installedWindowsAppSupervisor,
      /PROPR_WINDOWS_INSTALLED_SMOKE:WATCHDOG:\{0\}:\{1\}:\{2\}:TIMED_OUT/,
    );
    assert.match(
      installedWindowsAppSupervisor,
      /PROPR_WINDOWS_INSTALLED_SMOKE:WATCHDOG:BOOTSTRAP:TIMED_OUT/,
    );
    assert.match(
      installedWindowsAppSupervisor,
      /PROPR_WINDOWS_INSTALLED_SMOKE:WATCHDOG:BOOTSTRAP:FAILED/,
    );
    assert.match(
      installedWindowsAppSupervisor,
      /PROPR_WINDOWS_INSTALLED_SMOKE:WATCHDOG:ACCEPTED:\{0\}:\{1\}:\{2\}/,
    );
    assert.match(
      installedWindowsAppSupervisor,
      /PROPR_WINDOWS_INSTALLED_SMOKE:WATCHDOG:LAST_VALID:\{0\}:\{1\}:\{2\}/,
    );
    assert.match(
      installedWindowsAppTest,
      /PROPR_WINDOWS_INSTALLED_SMOKE:OPERATION:\{0\}:\{1\}:\{2\}' -f `[\s\S]{0,100}\[Console\]::Out\.Flush\(\)/,
    );

    const markerWriter = installedWindowsAppTest.match(
      /function Write-WatchdogMarker\(([\s\S]*?)\n\}/,
    );
    assert.ok(markerWriter);
    const operationAllowlist = markerWriter[1].match(
      /\[ValidateSet\(\n([\s\S]*?)\n\s+\)\]\[string\]\$Substage/,
    );
    assert.ok(operationAllowlist);
    const operations = [...operationAllowlist[1].matchAll(/'([A-Z_]+)'/g)]
      .map(match => match[1]);
    assert.deepEqual(operations, [
      'PATHS',
      'BASELINE',
      'MSI_INSTALL',
      'OWNERSHIP_CAPTURE',
      'INSTALL_TREE_SCAN',
      'APPLICATION_IMAGE',
      'PROTOCOL_ASSERTION',
      'APP_PATH_ASSERTION',
      'HKCU_INSTALLED_ASSERTION',
      'SHORTCUT_ASSERTION',
      'USER_CREATE',
      'USER_SID',
      'SMOKE_DATA_CREATE',
      'SHORTCUT_PRESENT_PROBE',
      'ALTERNATE_USER_START',
      'APPLICATION_WAIT',
      'STREAM_DRAIN',
      'EVIDENCE_INSPECTION',
      'MSI_UNINSTALL',
      'INSTALL_TREE_ASSERTION',
      'PROTOCOL_ABSENCE_ASSERTION',
      'APP_PATH_ABSENCE_ASSERTION',
      'HKCU_INSTALLED_ABSENCE_ASSERTION',
      'SHORTCUT_FILE_ASSERTION',
      'SHORTCUT_FOLDER_ASSERTION',
      'SHORTCUT_ABSENCE_PROBE',
      'SMOKE_DATA_REMOVE',
      'PROFILE_LOOKUP',
      'PROFILE_REMOVE',
      'USER_LOOKUP',
      'USER_REMOVE',
      'INSTALL_ROOT_FALLBACK',
      'PROTOCOL_FALLBACK',
      'APP_PATH_FALLBACK',
      'HKCU_INSTALLED_FALLBACK',
      'SHORTCUT_FALLBACK',
    ]);
    for (const operation of operations) {
      assert.ok(
        installedWindowsAppTest.match(new RegExp(`'${operation}'`, 'g'))!.length >= 2,
        `${operation} must be allowlisted and reached by a bounded marker path`,
      );
    }
    assert.match(
      installedWindowsAppTest,
      /Write-WatchdogMarker \$Stage \$Substage \$TimeoutMilliseconds 'BEGIN'[\s\S]*Write-WatchdogMarker \$Stage \$Substage \$TimeoutMilliseconds 'COMPLETE'[\s\S]*Write-WatchdogMarker \$Stage \$Substage \$TimeoutMilliseconds 'FAILED'/,
    );

    const diagnosticSources = `${installedWindowsAppSupervisor}\n${installedWindowsAppTest}`;
    assert.doesNotMatch(
      diagnosticSources,
      /Write-(?:Host|Warning|Error|Verbose|Debug|Information)[^\n]*(?:\$password|\$credential|\$Installer|\$installerPath|\$testUser|\$UserName|\$Domain|\$Arguments|\$record|\$bytes)/i,
    );
  });

  test('supplementary lint retains fail-closed installed-app cleanup guards', () => {
    assert.match(
      installedWindowsAppTest,
      /if \(\$installRootExistedBeforeInstall -or \$protocolExistedBeforeInstall -or[\s\S]*\$appPathsExistedBeforeInstall -or[\s\S]*\$startMenuShortcutFolderExistedBeforeInstall\) \{\n\s+throw 'installed-app harness requires an unowned clean machine baseline'/,
    );
    assert.match(installedWindowsAppTest, /\$script:testUserCreatedByRun = \$true/);
    assert.match(
      installedWindowsAppTest,
      /if \(\$testUserCreatedByRun -and \$null -ne \$testUserSid\)[\s\S]*!\$ownedUser\.SID\.Equals\(\$testUserSid\)[\s\S]*Remove-LocalUser/,
    );
    assert.match(
      installedWindowsAppTest,
      /\$matchingRecords = @\(\)[\s\S]*foreach \(\$record in \$ownedProfileRecords\)[\s\S]*\$matchingRecords\.Count -ne 1[\s\S]*Remove-CimInstance -InputObject \$profile/,
    );
    assert.match(
      installedWindowsAppTest,
      /if \(\$installRootCreatedByRun -and \(Test-Path -LiteralPath \$installRoot\)\)[\s\S]*Get-ChildItem -LiteralPath \$installRoot -Force[\s\S]*Remove-Item -LiteralPath \$installRoot -Force/,
    );
    assert.match(
      installedWindowsAppTest,
      /if \(\$protocolCreatedByRun -and[\s\S]*Get-RegistryTreeIdentity \$protocolRegistryPath[\s\S]*Remove-Item -LiteralPath \$protocolRegistryPath -Recurse/,
    );
    assert.match(
      installedWindowsAppTest,
      /if \(\$appPathsCreatedByRun -and[\s\S]*Get-RegistryTreeIdentity \$appPathsRegistryPath[\s\S]*Remove-Item -LiteralPath \$appPathsRegistryPath -Recurse/,
    );
    assert.match(
      installedWindowsAppTest,
      /if \(\$createdByRun\) \{[\s\S]*Get-ChildItem -LiteralPath \$path -Force[\s\S]*Remove-Item -LiteralPath \$path -Force/,
    );
  });

  test('uses bounded network logon impersonation with secure native credential cleanup', () => {
    const nativeLogon = [...installedWindowsAppTest.matchAll(
      /Add-Type -TypeDefinition @'\n([\s\S]*?)\n'@/g,
    )].find((match) => match[1].includes('public static class ProPRWindowsLogon'));
    assert.ok(nativeLogon);
    assert.match(nativeLogon[1], /using Microsoft\.Win32\.SafeHandles;/);
    assert.match(nativeLogon[1], /public const int LOGON32_LOGON_NETWORK = 3;/);
    assert.match(nativeLogon[1], /public const int LOGON32_PROVIDER_DEFAULT = 0;/);
    assert.match(
      nativeLogon[1],
      /\[DllImport\("advapi32\.dll",[\s\S]*EntryPoint = "LogonUserW"\)\]/,
    );
    assert.match(nativeLogon[1], /\[return: MarshalAs\(UnmanagedType\.Bool\)\]/);
    assert.match(
      nativeLogon[1],
      /public static extern bool LogonUserW\([\s\S]*IntPtr password,[\s\S]*out SafeAccessTokenHandle token\);/,
    );

    const probeStart = installedWindowsAppTest.indexOf('function Test-StartMenuShortcutAsOrdinaryUser(');
    const probeEnd = installedWindowsAppTest.indexOf('function New-SmokeUserDataDirectory(', probeStart);
    assert.ok(probeStart >= 0 && probeEnd > probeStart);
    const shortcutProbe = installedWindowsAppTest.slice(probeStart, probeEnd);
    assert.match(
      shortcutProbe,
      /\[Runtime\.InteropServices\.Marshal\]::SecureStringToGlobalAllocUnicode\(\n\s+\$Credential\.Password\n\s+\)/,
    );
    assert.match(
      shortcutProbe,
      /\[ProPRWindowsLogon\]::LogonUserW\([\s\S]*\[ProPRWindowsLogon\]::LOGON32_LOGON_NETWORK,[\s\S]*\[ProPRWindowsLogon\]::LOGON32_PROVIDER_DEFAULT,[\s\S]*\[ref\]\$token/,
    );
    assert.match(
      shortcutProbe,
      /\[Microsoft\.Win32\.SafeHandles\.SafeAccessTokenHandle\]\$token = \$null/,
    );
    const finallyStart = shortcutProbe.indexOf('} finally {');
    const zeroFree = shortcutProbe.indexOf(
      '[Runtime.InteropServices.Marshal]::ZeroFreeGlobalAllocUnicode($passwordBuffer)',
    );
    const tokenDispose = shortcutProbe.indexOf('$token.Dispose()');
    assert.ok(finallyStart >= 0 && zeroFree > finallyStart && tokenDispose > zeroFree);
    assert.match(shortcutProbe, /if \(\$passwordBuffer -ne \[IntPtr\]::Zero\)/);
    assert.match(shortcutProbe, /if \(\$null -ne \$token\)/);
  });

  test('requires the exact ordinary-user SID before bounded presence and absence checks', () => {
    const probeStart = installedWindowsAppTest.indexOf('function Test-StartMenuShortcutAsOrdinaryUser(');
    const probeEnd = installedWindowsAppTest.indexOf('function New-SmokeUserDataDirectory(', probeStart);
    assert.ok(probeStart >= 0 && probeEnd > probeStart);
    const shortcutProbe = installedWindowsAppTest.slice(probeStart, probeEnd);
    const impersonated = shortcutProbe.match(
      /\[Security\.Principal\.WindowsIdentity\]::RunImpersonated\(\$token, \[Action\]\{([\s\S]*?)\n\s+\}\)/,
    );
    assert.ok(impersonated);
    const action = impersonated[1];
    const identityCheck = action.indexOf(
      'if ($null -eq $identity.User -or !$identity.User.Equals($UserSid))',
    );
    const presenceCheck = action.indexOf(
      'Test-Path -LiteralPath $ShortcutPath -ErrorAction Stop',
    );
    assert.ok(identityCheck >= 0 && presenceCheck > identityCheck);
    assert.match(action, /\$identity = \[Security\.Principal\.WindowsIdentity\]::GetCurrent\(\)/);
    assert.match(action, /\[string\]::IsNullOrWhiteSpace\(\$ShortcutPath\)/);
    assert.match(action, /!\[IO\.Path\]::IsPathRooted\(\$ShortcutPath\)/);
    assert.match(action, /if \(!\$ExpectedPresent -and !\$present\) \{ return \}/);
    assert.match(action, /if \(\$present -ne \$ExpectedPresent\)/);
    assert.match(action, /Get-Item -LiteralPath \$ShortcutPath -Force -ErrorAction Stop/);
    assert.match(action, /!\(\$item -is \[IO\.FileInfo\]\)/);
    assert.match(action, /\$item\.Attributes -band \[IO\.FileAttributes\]::ReparsePoint/);
    assert.match(action, /\$item\.Length -le 0 -or \$item\.Length -gt \$shortcutFileByteCap/);
    assert.match(action, /\[IO\.File\]::Open\([\s\S]*\[IO\.FileAccess\]::Read/);
    assert.match(action, /\$stream\.Length -le 0 -or \$stream\.Length -gt \$shortcutFileByteCap/);
    assert.match(action, /\$stream\.ReadByte\(\) -lt 0/);
    assert.match(action, /if \(\$null -ne \$stream\) \{ \$stream\.Dispose\(\) \}/);
    assert.match(action, /if \(\$null -ne \$identity\) \{ \$identity\.Dispose\(\) \}/);

    const shortcutCalls = [...installedWindowsAppTest.matchAll(
      /Test-StartMenuShortcutAsOrdinaryUser `([\s\S]*?)\n\s+-ExpectedPresent \$(true|false)/g,
    )];
    assert.deepEqual(shortcutCalls.map(call => call[2]), ['true', 'false']);
    for (const call of shortcutCalls) {
      assert.match(call[1], /-UserSid \$testUserSid `/);
      assert.match(call[1], /-ShortcutPath \$startMenuShortcut `/);
    }
  });

  test('keeps shortcut proof output fixed and redacted and rejects the legacy process proof', () => {
    const probeStart = installedWindowsAppTest.indexOf('function Test-StartMenuShortcutAsOrdinaryUser(');
    const probeEnd = installedWindowsAppTest.indexOf('function New-SmokeUserDataDirectory(', probeStart);
    assert.ok(probeStart >= 0 && probeEnd > probeStart);
    const shortcutProbe = installedWindowsAppTest.slice(probeStart, probeEnd);
    assert.equal(
      shortcutProbe.match(/PROPR_WINDOWS_INSTALLED_SMOKE:SHORTCUT_PROBE/g)?.length,
      2,
    );
    assert.match(
      shortcutProbe,
      /Write-Host \('PROPR_WINDOWS_INSTALLED_SMOKE:SHORTCUT_PROBE:\{0\}:SUCCESS' -f \$expectation\)/,
    );
    assert.match(
      shortcutProbe,
      /Write-Host \('PROPR_WINDOWS_INSTALLED_SMOKE:SHORTCUT_PROBE:\{0\}:\{1\}' -f \$expectation, \$failureCategory\)/,
    );
    const categories = [...shortcutProbe.matchAll(
      /\$failureCategory = '(LOGON_FAILED|ACCESS_CHECK_FAILED|CLEANUP_FAILED)'/g,
    )].map(match => match[1]);
    assert.deepEqual([...new Set(categories)].sort(), [
      'ACCESS_CHECK_FAILED',
      'CLEANUP_FAILED',
      'LOGON_FAILED',
    ]);
    assert.doesNotMatch(
      shortcutProbe,
      /(?:Write-Host|throw)[^\n]*(?:\$ShortcutPath|\$UserName|\$Domain|\$UserSid|\$Credential|\.Exception|\.Message|NativeErrorCode)/,
    );
    assert.doesNotMatch(
      shortcutProbe,
      /ProcessStartInfo|\$process\.Start\(|SPAWN_FAILED|EncodedCommand|probeChildEnvironment|PROPR_DESKTOP_START_MENU_SHORTCUT|shortcutProbeExitCategories|StandardOutput|StandardError/,
    );
    assert.doesNotMatch(installedWindowsAppTest, /\$shortcutProbeExitCategories|\$probeTemplate/);
  });

  test('emits fixed uninstall and cleanup substages without masking the primary failure', () => {
    const writerStart = installedWindowsAppTest.indexOf('function Write-CleanupSubstage(');
    const writerEnd = installedWindowsAppTest.indexOf('function Stop-SpawnedProcessTree(', writerStart);
    assert.ok(writerStart >= 0 && writerEnd > writerStart);
    const writer = installedWindowsAppTest.slice(writerStart, writerEnd);
    const substageAllowlist = writer.match(/\[ValidateSet\(\n([\s\S]*?)\n\s+\)\]\[string\]\$Substage/);
    assert.ok(substageAllowlist);
    const substages = [...substageAllowlist[1].matchAll(/'([A-Z_]+)'/g)].map(match => match[1]);
    assert.deepEqual(substages, [
      'MSI_UNINSTALL',
      'INSTALL_TREE',
      'PROTOCOL',
      'APP_PATH',
      'HKCU_INSTALLED',
      'SHORTCUT_FILE',
      'SHORTCUT_FOLDER',
      'ORDINARY_USER_ABSENCE_PROBE',
      'SMOKE_DATA',
      'PROFILE',
      'USER',
      'INSTALL_ROOT_FALLBACK',
      'PROTOCOL_FALLBACK',
      'APP_PATH_FALLBACK',
      'HKCU_INSTALLED_FALLBACK',
      'SHORTCUT_FALLBACK',
      'FINAL_AGGREGATION',
    ]);
    assert.match(writer, /\[ValidateSet\('BEGIN','COMPLETE','FAILED','SKIPPED'\)\]\[string\]\$Status/);
    assert.match(
      writer,
      /PROPR_WINDOWS_INSTALLED_SMOKE:\{0\}:\{1\}:\{2\}' -f \$Scope, \$Substage, \$Status/,
    );

    const cleanupCalls = [...installedWindowsAppTest.matchAll(
      /^\s+Write-CleanupSubstage '([A-Z_]+)' '([A-Z_]+)' '([A-Z_]+)'$/gm,
    )];
    assert.ok(cleanupCalls.length > 0);
    assert.equal(
      installedWindowsAppTest.match(/^\s+Write-CleanupSubstage /gm)?.length,
      cleanupCalls.length,
      'every cleanup diagnostic call must use fixed literal allowlisted fields',
    );
    for (const [, scope, substage, status] of cleanupCalls) {
      assert.ok(['UNINSTALL', 'CLEANUP'].includes(scope));
      assert.ok(substages.includes(substage));
      assert.ok(['BEGIN', 'COMPLETE', 'FAILED', 'SKIPPED'].includes(status));
    }
    for (const substage of [
      'MSI_UNINSTALL',
      'INSTALL_TREE',
      'PROTOCOL',
      'APP_PATH',
      'HKCU_INSTALLED',
      'SHORTCUT_FILE',
      'SHORTCUT_FOLDER',
    ]) {
      for (const status of ['BEGIN', 'COMPLETE', 'FAILED']) {
        assert.ok(cleanupCalls.some(match => match[1] === 'UNINSTALL' && match[2] === substage && match[3] === status));
      }
    }
    assert.ok(cleanupCalls.some(match => (
      match[1] === 'UNINSTALL'
      && match[2] === 'ORDINARY_USER_ABSENCE_PROBE'
      && match[3] === 'SKIPPED'
    )));
    for (const substage of [
      'SMOKE_DATA',
      'PROFILE',
      'USER',
      'INSTALL_ROOT_FALLBACK',
      'PROTOCOL_FALLBACK',
      'APP_PATH_FALLBACK',
      'HKCU_INSTALLED_FALLBACK',
      'SHORTCUT_FALLBACK',
      'FINAL_AGGREGATION',
    ]) {
      for (const status of ['BEGIN', 'COMPLETE', 'FAILED']) {
        assert.ok(cleanupCalls.some(match => match[1] === 'CLEANUP' && match[2] === substage && match[3] === status));
      }
    }
    assert.match(
      installedWindowsAppTest,
      /\} catch \{\n\s+\$primaryFailure = \$_\n\s+throw\n\} finally \{/,
    );
    assert.match(
      installedWindowsAppTest,
      /if \(\$cleanupFailed\)[\s\S]*?if \(\$null -eq \$primaryFailure\) \{\n\s+throw 'installed Windows cleanup did not complete'/,
    );
  });

  test('keeps the canonical common shortcut and exact-identity cleanup', () => {
    const probeStart = installedWindowsAppTest.indexOf('function Test-StartMenuShortcutAsOrdinaryUser(');
    const probeEnd = installedWindowsAppTest.indexOf('function New-SmokeUserDataDirectory(', probeStart);
    assert.ok(probeStart >= 0 && probeEnd > probeStart);
    const shortcutProbe = installedWindowsAppTest.slice(probeStart, probeEnd);
    assert.match(shortcutProbe, /\[string\]\$ShortcutPath/);
    assert.match(shortcutProbe, /Test-Path -LiteralPath \$ShortcutPath -ErrorAction Stop/);
    assert.equal(installedWindowsAppTest.match(/-ShortcutPath \$startMenuShortcut/g)?.length, 2);

    const installStart = installedWindowsAppTest.indexOf("Write-Stage 'INSTALL' 'BEGIN'");
    assert.ok(
      installedWindowsAppTest.indexOf(
        '$startMenuShortcutExistedBeforeInstall = Test-Path -LiteralPath $startMenuShortcut',
      ) < installStart,
    );
    assert.ok(
      installedWindowsAppTest.indexOf(
        '$startMenuShortcutFolderExistedBeforeInstall = Test-Path -LiteralPath $startMenuShortcutFolder',
      ) < installStart,
    );
    assert.match(
      installedWindowsAppTest,
      /\$script:startMenuShortcutCreatedByRun =\n\s+!\$startMenuShortcutExistedBeforeInstall -and \(Test-Path -LiteralPath \$startMenuShortcut\)/,
    );
    assert.match(
      installedWindowsAppTest,
      /\$script:startMenuShortcutFolderCreatedByRun =\n\s+!\$startMenuShortcutFolderExistedBeforeInstall -and[\s\S]{0,40}\(Test-Path -LiteralPath \$startMenuShortcutFolder\)/,
    );

    const cleanupStart = installedWindowsAppTest.indexOf("Write-Stage 'CLEANUP' 'BEGIN'");
    assert.ok(cleanupStart >= 0);
    const cleanup = installedWindowsAppTest.slice(cleanupStart);
    assert.match(
      cleanup,
      /if \(\$startMenuShortcutCreatedByRun -and \(Test-Path -LiteralPath \$startMenuShortcut\)\)[\s\S]*Get-FileIdentity \$startMenuShortcut[\s\S]*Remove-Item -LiteralPath \$startMenuShortcut -Force -ErrorAction Stop/,
    );
    assert.match(
      cleanup,
      /if \(\$startMenuShortcutFolderCreatedByRun[\s\S]*Get-DirectoryIdentity \$startMenuShortcutFolder[\s\S]*Get-ChildItem -LiteralPath \$startMenuShortcutFolder -Force[\s\S]*Remove-Item -LiteralPath \$startMenuShortcutFolder -Force -ErrorAction Stop/,
    );
    const installFallback = cleanup.slice(
      cleanup.indexOf("'CLEANUP' 'INSTALL_ROOT_FALLBACK' 'BEGIN'"),
      cleanup.indexOf("'CLEANUP' 'PROTOCOL_FALLBACK' 'BEGIN'"),
    );
    const shortcutFallback = cleanup.slice(
      cleanup.indexOf("'CLEANUP' 'SHORTCUT_FALLBACK' 'BEGIN'"),
      cleanup.indexOf("'CLEANUP' 'FINAL_AGGREGATION' 'BEGIN'"),
    );
    assert.doesNotMatch(installFallback, /Remove-Item[^\n]*-Recurse/);
    assert.doesNotMatch(shortcutFallback, /Remove-Item[^\n]*-Recurse/);
    assert.doesNotMatch(
      installedWindowsAppTest,
      /Remove-Item[^\n]*\$commonPrograms[^\n]*-Recurse|Remove-Item[^\n]*-Recurse[^\n]*\$commonPrograms/,
    );
    assert.match(installedWindowsAppTest, /machine uninstall left the common Start Menu shortcut behind/);
    assert.match(installedWindowsAppTest, /machine uninstall left the common Start Menu folder behind/);
  });


  test('replaces a hostile privileged parent environment with the exact smoke child allowlist', () => {
    const allowlist = installedWindowsAppTest.match(
      /\$childEnvironment = \[ordered\]@\{([\s\S]*?)\n\s+\}/,
    );
    assert.ok(allowlist);
    const entries = [...allowlist[1].matchAll(/^\s+'([^']+)' = ('[^']*'|\$[A-Za-z][A-Za-z0-9]*)$/gm)]
      .map(([, key, expression]) => ({ key, expression }));
    assert.deepEqual(entries.map(({ key }) => key), [
      'APPDATA',
      'LOCALAPPDATA',
      'PROPR_DESKTOP_SMOKE_TEST',
      'SystemRoot',
      'TEMP',
      'TMP',
      'USERPROFILE',
    ]);

    const hostileNames = [
      'BUILD_PASSWORD',
      'CI_TOKEN',
      'DEPLOY_SECRET',
      'SSH_PRIVATE_KEY',
      'CSC_LINK',
      'CSC_KEY_PASSWORD',
      'WIN_CSC_LINK',
      'WIN_CSC_KEY_PASSWORD',
      'WINDOWS_CERTIFICATE_FILE',
      'WINDOWS_CERTIFICATE_PASSWORD',
      'GITHUB_TOKEN',
      'GH_TOKEN',
      'AZURE_CLIENT_ID',
      'AZURE_CLIENT_SECRET',
      'AZURE_TENANT_ID',
      'PROPR_DESKTOP_UPDATE_PRIVATE_KEY',
      'PROPR_DESKTOP_SIGNING_SECRET',
      'PROPR_DESKTOP_UNRELATED',
      'PATH',
    ];
    const seededValues = new Set<string>();
    const childEnvironment = new Map<string, string>();
    for (const name of [...hostileNames, ...entries.map(({ key }) => key)]) {
      const value = `hostile-parent-value:${name}`;
      seededValues.add(value);
      childEnvironment.set(name, value);
    }

    const launch = installedWindowsAppTest.match(
      /\$startInfo = \[Diagnostics\.ProcessStartInfo\]::new\(\)([\s\S]*?)if \(!\$process\.Start\(\)\)/,
    );
    assert.ok(launch);
    const clear = launch[0].indexOf('$startInfo.Environment.Clear()');
    const add = launch[0].indexOf('$startInfo.Environment.Add([string]$entry.Key, [string]$entry.Value)');
    const start = launch[0].indexOf('if (!$process.Start())');
    assert.ok(clear > 0 && clear < add && add < start);
    assert.equal(launch[0].match(/\$startInfo\.Environment/g)?.length, 2);
    assert.doesNotMatch(launch[0], /GetEnvironmentVariables|EnvironmentVariables|\.Environment\s*=|Remove\(/);

    const smokeRoot = 'C:\\private smoke root\\propr-desktop-smoke-0123456789abcdef0123456789abcdef';
    const fixedValues: Record<string, string> = {
      '$roamingAppDataDirectory': `${smokeRoot}\\profile\\AppData\\Roaming`,
      '$localAppDataDirectory': `${smokeRoot}\\profile\\AppData\\Local`,
      '$WindowsDirectory': 'C:\\Windows',
      '$temporaryDirectory': `${smokeRoot}\\temp`,
      '$profileDirectory': `${smokeRoot}\\profile`,
    };
    childEnvironment.clear();
    for (const { key, expression } of entries) {
      const value = expression.startsWith("'")
        ? expression.slice(1, -1)
        : fixedValues[expression];
      assert.ok(value, `unexpected child environment expression ${expression}`);
      childEnvironment.set(key, value);
    }

    assert.deepEqual([...childEnvironment.keys()], entries.map(({ key }) => key));
    assert.equal(childEnvironment.get('PROPR_DESKTOP_SMOKE_TEST'), '1');
    assert.equal(childEnvironment.get('SystemRoot'), 'C:\\Windows');
    for (const name of ['APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'USERPROFILE']) {
      assert.ok(childEnvironment.get(name)?.startsWith(`${smokeRoot}\\`));
    }
    for (const hostileName of hostileNames) assert.ok(!childEnvironment.has(hostileName));
    for (const value of childEnvironment.values()) assert.ok(!seededValues.has(value));

    assert.match(installedWindowsAppTest, /\[Environment\]::GetFolderPath\(\[Environment\+SpecialFolder\]::Windows\)/);
    assert.doesNotMatch(allowlist[0], /\$env:|PATH/);
    assert.doesNotMatch(installedWindowsAppTest, /Write-Host[^\n]*(?:childEnvironment|Environment|Password|UserName|Domain)/);
    assert.match(installedWindowsAppTest, /alternate-credential child profile ACL is not inherited from the smoke directory/);
  });

  test('keeps spaced and unspaced smoke argv values as distinct ArgumentList entries', () => {
    const launch = installedWindowsAppTest.match(
      /function Start-AlternateCredentialApplication\([\s\S]*?\n\}/,
    );
    assert.ok(launch);
    assert.match(
      launch[0],
      /foreach \(\$argument in \$Arguments\) \{\n\s+\$startInfo\.ArgumentList\.Add\(\$argument\)\n\s+\}/,
    );
    assert.doesNotMatch(launch[0], /\.Arguments\s*=|Join\(|-join|CommandLine|cmd\.exe|powershell\.exe/);

    for (const argumentValues of [
      ['--propr-smoke-test', '--user-data-dir=C:\\smoke root\\profile'],
      ['--propr-smoke-test', '--user-data-dir=C:\\smoke-root\\profile'],
    ]) {
      const argumentList: string[] = [];
      for (const argument of argumentValues) argumentList.push(argument);
      assert.deepEqual(argumentList, argumentValues);
    }
  });

  test('opens installed Windows smoke evidence with a bounded, redacted reader', () => {
    const inspectionPhase = installedWindowsAppTest.match(
      /enum SmokeEvidenceInspectionPhase \{([\s\S]*?)\n\}/,
    );
    assert.ok(inspectionPhase);
    assert.deepEqual(
      [...inspectionPhase[1].matchAll(/^\s+([A-Z_]+)$/gm)].map(match => match[1]),
      ['DIRECTORY', 'ACL', 'FILE_METADATA', 'FILE_OPEN', 'FILE_READ', 'EVENT_PARSE', 'SUMMARY'],
    );

    const evidenceReader = installedWindowsAppTest.match(
      /function Get-SmokeEventEvidence\([\s\S]*?\n\}\n\ntry \{/,
    );
    assert.ok(evidenceReader);
    const reader = evidenceReader[0];
    assert.match(reader, /foreach \(\$fileName in \$smokeEvidenceFileNames\)/);
    assert.doesNotMatch(reader, /Get-ChildItem|Get-Content|ReadAll|ReadToEnd/);
    assert.match(reader, /Get-Item -LiteralPath \$filePath -Force -ErrorAction Stop/);
    assert.match(reader, /!\(\$item -is \[IO\.FileInfo\]\)/);
    assert.match(reader, /\$item\.Attributes -band \[IO\.FileAttributes\]::ReparsePoint/);
    assert.match(reader, /\[Math\]::Min\(\[int64\]\$item\.Length, \[int64\]\$smokeEvidenceFileByteCap\)/);

    assert.match(installedWindowsAppTest, /\$smokeEvidenceOpenRetryDeadlineMilliseconds = 2 \* 1000/);
    assert.match(installedWindowsAppTest, /\$smokeEvidenceOpenRetryDelayMilliseconds = 50/);
    assert.match(reader, /\$openRetryStopwatch = \[Diagnostics\.Stopwatch\]::StartNew\(\)/);
    assert.match(reader, /\$openAttempt -gt 0 -and\n\s+\$openRetryStopwatch\.ElapsedMilliseconds -ge/);
    assert.match(reader, /catch \[IO\.IOException\] \{/);
    assert.match(reader, /\$nativeErrorCode -notin @\(32, 33\)/);
    assert.match(
      reader,
      /\$openRetryStopwatch\.ElapsedMilliseconds -ge \$smokeEvidenceOpenRetryDeadlineMilliseconds/,
    );
    assert.match(
      reader,
      /\$retryDelayMilliseconds = \[Math\]::Min\([\s\S]*?\$smokeEvidenceOpenRetryDelayMilliseconds,[\s\S]*?\$remainingMilliseconds/,
    );
    assert.match(reader, /Start-Sleep -Milliseconds \$retryDelayMilliseconds/);

    assert.match(
      reader,
      /\[IO\.FileStream\]::new\([\s\S]*?\[IO\.FileMode\]::Open,[\s\S]*?\[IO\.FileAccess\]::Read,[\s\S]*?\[IO\.FileShare\]::Read,[\s\S]*?\[IO\.FileOptions\]::SequentialScan/,
    );
    assert.doesNotMatch(reader, /New-Object IO\.FileStream/);
    assert.match(
      reader,
      /\} finally \{\n\s+if \(\$null -ne \$stream\) \{ \$stream\.Dispose\(\) \}\n\s+\}/,
    );
    assert.match(reader, /\[Text\.UTF8Encoding\]::new\(\$false, \$true\)/);
    assert.match(
      reader,
      /\} finally \{\n\s+if \(\$null -ne \$stream\) \{ \$stream\.Dispose\(\) \}\n\s+\}\n\s+\$inspectionPhase = \[SmokeEvidenceInspectionPhase\]::EVENT_PARSE\n\s+if \(\$offset -eq 0\) \{ continue \}/,
    );
    assert.match(
      reader,
      /try \{\n\s+\$record = ConvertFrom-Json -InputObject \$line -ErrorAction Stop\n\s+if \(\$null -eq \$record -or \$record -isnot \[PSCustomObject\]\) \{ continue \}/,
    );
    assert.match(
      reader,
      /\$eventProperty = \$record\.PSObject\.Properties\['event'\]\n\s+if \(\$null -eq \$eventProperty -or \$eventProperty\.Name -cne 'event' -or\n\s+\$eventProperty\.Value -isnot \[string\]\) \{\n\s+continue\n\s+\}/,
    );
    assert.match(
      reader,
      /\$eventName = \$eventProperty\.Value\n\s+if \(!\$smokeEventCodes\.Contains\(\$eventName\)\) \{ continue \}\n\s+\$events\[\$eventName\] = \$true\n\s+\} catch \{\n\s+continue\n\s+\}/,
    );
    assert.match(
      reader,
      /\$fileName -ceq 'application\.smoke-evidence\.jsonl' -and\n\s+@\(\$record\.PSObject\.Properties\)\.Count -ne 1/,
    );

    assert.match(
      reader,
      /Write-Host \('PROPR_WINDOWS_INSTALLED_SMOKE:EVIDENCE_INSPECTION_FAILED:\{0\}' -f \$inspectionPhase\)\n\s+throw 'smoke evidence inspection failed'/,
    );
    assert.match(
      reader,
      /\[SmokeEvidenceInspectionPhase\]\$inspectionPhase = \[SmokeEvidenceInspectionPhase\]::DIRECTORY/,
    );
    assert.equal(reader.match(/EVIDENCE_INSPECTION_FAILED/g)?.length, 1);
    assert.doesNotMatch(
      reader,
      /Write-(?:Host|Warning|Error|Verbose|Debug|Information)[^\n]*(?:\$_|\$filePath|\$fullPath|\$item|\$bytes|\$text|\$line|\$record|\$eventProperty|\$eventName|Exception|Message|Error|endpoint)/i,
    );
  });

  test('configures signed updates only for macOS and never advertises a Windows update feed', () => {
    const production = job('release-package', 'release-finalize');
    assert.match(production, /Require macOS signed-update runtime configuration\n\s+if: matrix\.platform == 'darwin'/);
    assert.doesNotMatch(workflow, /PROPR_DESKTOP_WINDOWS_(?:X64|ARM64)_FEED_URL/);
    assert.doesNotMatch(workflow, /Require signed-update runtime configuration\n\s+if: matrix\.platform != 'linux'/);
  });
});
