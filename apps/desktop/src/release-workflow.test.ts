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
    assert.equal(workflow.match(/test-installed-windows-app\.ps1/g)?.length, 2);
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
    assert.match(installedWindowsAppTest, /Remove-SmokeUserDataDirectory \$smokeUserDataDirectory/);
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

  test('bounds and diagnoses installed Windows process lifecycles on x64 and ARM64', () => {
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
    assert.doesNotMatch(installedWindowsAppTest, /Get-ChildItem[^\n]*smoke|ReadAll|ReadToEnd/);
    const smokeEventAllowlist = installedWindowsAppTest.match(
      /\$smokeEventCodes = \[ordered\]@\{([\s\S]*?)\n\}/,
    );
    assert.ok(smokeEventAllowlist);
    const expectedSmokeEvents = [
      'desktop.smoke.authorized',
      'desktop.app.ready',
      'desktop.renderer.mvp_flows.ready',
      'desktop.renderer.layout.ready',
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
    assert.match(installedWindowsAppTest, /\$requiredSmokeEvents = @\([\s\S]*desktop\.smoke\.authorized[\s\S]*desktop\.app\.ready[\s\S]*desktop\.renderer\.mvp_flows\.ready[\s\S]*desktop\.renderer\.layout\.ready[\s\S]*desktop\.renderer\.ready[\s\S]*desktop\.app\.shutdown/);
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
      /catch \{\n\s+\$waitFailure = \$_\n\s+\} finally \{\n\s+try \{\n\s+Close-RedirectedApplicationStreams \$applicationLaunch[\s\S]*?\} finally \{\n\s+\$applicationLaunch\.Process\.Dispose\(\)\n\s+\$applicationLaunch = \$null/,
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
      /\} catch \{\n\s+\$primaryFailure = \$_\n\s+throw\n\} finally \{\n\s+\$cleanupFailed = \$false[\s\S]*Invoke-Msi @\('\/x'[\s\S]*Remove-SmokeUserDataDirectory \$smokeUserDataDirectory/,
    );
    assert.match(installedWindowsAppTest, /Get-CimInstance -ClassName Win32_UserProfile/);
    assert.match(installedWindowsAppTest, /Remove-LocalUser -Name \$testUser -ErrorAction Stop/);
    assert.match(installedWindowsAppTest, /Remove-Item -LiteralPath \$installRoot -Recurse -Force -ErrorAction Stop/);

    for (const section of [job('package', 'finalize'), job('release-package', 'release-finalize')]) {
      assert.match(section, /- platform: win32\n\s+arch: x64\n/);
      assert.match(section, /- platform: win32\n\s+arch: arm64\n/);
      assert.equal(section.match(/test-installed-windows-app\.ps1/g)?.length, 1);
    }
  });

  test('maps every shortcut child outcome to one fixed redacted parent category', () => {
    const probeStart = installedWindowsAppTest.indexOf('function Test-StartMenuShortcutAsOrdinaryUser(');
    const probeEnd = installedWindowsAppTest.indexOf('function New-SmokeUserDataDirectory(', probeStart);
    assert.ok(probeStart >= 0 && probeEnd > probeStart);
    const shortcutProbe = installedWindowsAppTest.slice(probeStart, probeEnd);
    const childSource = shortcutProbe.match(/\$probeTemplate = @'\n([\s\S]*?)\n'@/);
    assert.ok(childSource);

    const exitCategorySource = installedWindowsAppTest.match(
      /\$shortcutProbeExitCategories = \[ordered\]@\{([\s\S]*?)\n\}/,
    );
    assert.ok(exitCategorySource);
    const exitCategories = Object.fromEntries(
      [...exitCategorySource[1].matchAll(/^\s+(\d+) = '([A-Z_]+)'$/gm)]
        .map(([, code, category]) => [Number(code), category]),
    );
    assert.deepEqual(exitCategories, {
      10: 'ENV_PATH_MISSING_OR_EMPTY',
      11: 'PATH_NOT_ROOTED',
      12: 'PRESENCE_MISMATCH',
      13: 'ITEM_LOOKUP_OR_TYPE_FAILURE',
      14: 'REPARSE_REJECTED',
      15: 'ZERO_SIZE_REJECTED',
      16: 'READ_OPEN_DENIED_OR_FAILED',
      17: 'EMPTY_STREAM',
      18: 'UNEXPECTED_CHILD_FAILURE',
    });
    const childExitCodes = [...new Set(
      [...childSource[1].matchAll(/\bexit (\d+)\b/g)].map(([, code]) => Number(code)),
    )].sort((left, right) => left - right);
    assert.deepEqual(childExitCodes, [0, ...Object.keys(exitCategories).map(Number)]);

    assert.match(childSource[1], /IsNullOrWhiteSpace\(\$shortcut\)\) \{ exit 10 \}/);
    assert.match(childSource[1], /!\[IO\.Path\]::IsPathRooted\(\$shortcut\)\) \{ exit 11 \}/);
    assert.match(childSource[1], /\$present -ne __EXPECTED_PRESENT__\) \{ exit 12 \}/);
    assert.match(childSource[1], /Get-Item[\s\S]*?catch \{\n\s+exit 13/);
    assert.match(childSource[1], /!\(\$item -is \[IO\.FileInfo\]\)\) \{ exit 13 \}/);
    assert.match(childSource[1], /ReparsePoint\) -ne 0\) \{ exit 14 \}/);
    assert.match(childSource[1], /\$item\.Length -le 0\) \{ exit 15 \}/);
    assert.match(childSource[1], /\[IO\.File\]::Open\([\s\S]*?catch \{\n\s+exit 16/);
    assert.match(childSource[1], /\$stream\.Length -le 0\) \{ exit 17 \}/);
    assert.match(childSource[1], /\} catch \{\n\s+exit 18\n\} finally/);
    const absentSuccess = childSource[1].indexOf('if (!__EXPECTED_PRESENT__ -and !$present) { exit 0 }');
    assert.ok(absentSuccess >= 0);
    assert.ok(absentSuccess < childSource[1].indexOf('if ($present -ne __EXPECTED_PRESENT__)'));
    assert.ok(absentSuccess < childSource[1].indexOf('Get-Item -LiteralPath $shortcut'));

    assert.match(shortcutProbe, /\$expectation = if \(\$ExpectedPresent\) \{ 'PRESENT' \} else \{ 'ABSENT' \}/);
    assert.match(shortcutProbe, /catch \{\n\s+\$failureCategory = 'SPAWN_FAILED'\n\s+\}/);
    assert.match(shortcutProbe, /!\$started\) \{\n\s+\$failureCategory = 'SPAWN_FAILED'/);
    assert.match(shortcutProbe, /\$process\.WaitForExit\(\$terminationTimeoutMilliseconds\)/);
    assert.match(shortcutProbe, /!\$completed\) \{\n\s+\$failureCategory = 'TIMEOUT'/);
    assert.match(shortcutProbe, /\$exitCode = \$process\.ExitCode\n\s+\} catch \{\n\s+\$failureCategory = 'UNKNOWN'/);
    assert.match(
      shortcutProbe,
      /if \(\$shortcutProbeExitCategories\.Contains\(\$exitCode\)\)[\s\S]*?else \{\n\s+\$failureCategory = 'UNKNOWN'/,
    );
    assert.match(shortcutProbe, /\$process\.Kill\(\$true\)/);
    assert.match(shortcutProbe, /\$process\.Dispose\(\)/);
    assert.match(shortcutProbe, /\$startInfo\.RedirectStandardOutput = \$true/);
    assert.match(shortcutProbe, /\$startInfo\.RedirectStandardError = \$true/);

    assert.equal(
      shortcutProbe.match(/PROPR_WINDOWS_INSTALLED_SMOKE:SHORTCUT_PROBE/g)?.length,
      2,
    );
    assert.match(
      shortcutProbe,
      /if \(\$null -eq \$failureCategory\) \{\n\s+Write-Host \('PROPR_WINDOWS_INSTALLED_SMOKE:SHORTCUT_PROBE:\{0\}:SUCCESS' -f \$expectation\)\n\s+return/,
    );
    assert.match(
      shortcutProbe,
      /Write-Host \('PROPR_WINDOWS_INSTALLED_SMOKE:SHORTCUT_PROBE:\{0\}:\{1\}' -f \$expectation, \$failureCategory\)\n\s+throw 'ordinary-user shortcut probe failed'/,
    );
    assert.doesNotMatch(shortcutProbe, /(?:Write-Host|throw)[^\n]*(?:\$exitCode|\$ShortcutPath|\$UserName|\$Domain|\.Exception|StandardOutput|StandardError)/);
    assert.doesNotMatch(shortcutProbe, /(?:Write-Host|throw)[^\n]*\$process\.|ReadToEnd|Write-(?:Output|Error|Warning|Verbose|Debug|Information)/);
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
      'SHORTCUT_FILE',
      'SHORTCUT_FOLDER',
      'ORDINARY_USER_ABSENCE_PROBE',
      'SMOKE_DATA',
      'PROFILE',
      'USER',
      'INSTALL_ROOT_FALLBACK',
      'PROTOCOL_FALLBACK',
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
    for (const substage of ['MSI_UNINSTALL', 'INSTALL_TREE', 'PROTOCOL', 'SHORTCUT_FILE', 'SHORTCUT_FOLDER']) {
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

  test('hands the canonical common shortcut to a profile-loading ordinary-user probe and cleans only owned paths', () => {
    const probeStart = installedWindowsAppTest.indexOf('function Test-StartMenuShortcutAsOrdinaryUser(');
    const probeEnd = installedWindowsAppTest.indexOf('function New-SmokeUserDataDirectory(', probeStart);
    assert.ok(probeStart >= 0 && probeEnd > probeStart);
    const shortcutProbe = installedWindowsAppTest.slice(probeStart, probeEnd);
    const childSource = shortcutProbe.match(/\$probeTemplate = @'\n([\s\S]*?)\n'@/);
    assert.ok(childSource);

    assert.match(shortcutProbe, /\[string\]\$ShortcutPath/);
    assert.match(childSource[1], /\$shortcut = \$env:PROPR_DESKTOP_START_MENU_SHORTCUT/);
    assert.match(childSource[1], /\[string\]::IsNullOrWhiteSpace\(\$shortcut\)/);
    assert.match(childSource[1], /!\[IO\.Path\]::IsPathRooted\(\$shortcut\)/);
    assert.match(childSource[1], /Test-Path -LiteralPath \$shortcut -PathType Leaf/);
    assert.match(childSource[1], /!\(\$item -is \[IO\.FileInfo\]\)/);
    assert.match(childSource[1], /\$item\.Attributes -band \[IO\.FileAttributes\]::ReparsePoint/);
    assert.match(childSource[1], /\$item\.Length -le 0/);
    assert.match(childSource[1], /\[IO\.File\]::Open\(/);
    assert.match(childSource[1], /\$stream\.Length -le 0/);
    assert.doesNotMatch(childSource[1], /CommonPrograms|ShortcutPath|Write-|Out-/);
    assert.match(shortcutProbe, /\$startInfo\.Environment\.Clear\(\)/);
    assert.match(
      shortcutProbe,
      /\$startInfo\.Environment\.Add\('PROPR_DESKTOP_START_MENU_SHORTCUT', \$ShortcutPath\)/,
    );
    assert.deepEqual(
      [...shortcutProbe.matchAll(/\$startInfo\.Environment\.Add\('([^']+)'/g)].map(([, name]) => name),
      ['SystemRoot', 'PROPR_DESKTOP_START_MENU_SHORTCUT'],
    );
    assert.equal(shortcutProbe.match(/PROPR_DESKTOP_START_MENU_SHORTCUT/g)?.length, 2);
    assert.match(shortcutProbe, /\$startInfo\.LoadUserProfile = \$true/);
    assert.doesNotMatch(shortcutProbe, /\$startInfo\.LoadUserProfile = \$false/);
    assert.match(shortcutProbe, /\$startInfo\.UserName = \$UserName/);
    assert.match(shortcutProbe, /\$startInfo\.Domain = \$Domain/);
    assert.match(shortcutProbe, /\$startInfo\.Password = \$Credential\.Password/);
    assert.match(shortcutProbe, /\$process\.WaitForExit\(\$terminationTimeoutMilliseconds\)/);
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
      /\$startMenuShortcutCreatedByRun =\n\s+!\$startMenuShortcutExistedBeforeInstall -and \(Test-Path -LiteralPath \$startMenuShortcut\)/,
    );
    assert.match(
      installedWindowsAppTest,
      /\$startMenuShortcutFolderCreatedByRun =\n\s+!\$startMenuShortcutFolderExistedBeforeInstall -and \(Test-Path -LiteralPath \$startMenuShortcutFolder\)/,
    );

    const cleanupStart = installedWindowsAppTest.indexOf("Write-Stage 'CLEANUP' 'BEGIN'");
    assert.ok(cleanupStart >= 0);
    const cleanup = installedWindowsAppTest.slice(cleanupStart);
    assert.match(
      cleanup,
      /if \(\$startMenuShortcutCreatedByRun -and \(Test-Path -LiteralPath \$startMenuShortcut\)\) \{\n\s+Remove-Item -LiteralPath \$startMenuShortcut -Force -ErrorAction Stop/,
    );
    assert.match(
      cleanup,
      /if \(\$startMenuShortcutFolderCreatedByRun[\s\S]*\$ownedShortcutFolderContents\.Count -eq 0\) \{\n\s+Remove-Item -LiteralPath \$startMenuShortcutFolder -Force -ErrorAction Stop/,
    );
    assert.doesNotMatch(
      cleanup,
      /Remove-Item -LiteralPath \$startMenuShortcut(?:Folder)?[^\n]*-Recurse/,
    );
    assert.doesNotMatch(
      installedWindowsAppTest,
      /Remove-Item[^\n]*(?:\$commonPrograms|\$startMenuShortcut(?:Folder)?)[^\n]*-Recurse|Remove-Item[^\n]*-Recurse[^\n]*(?:\$commonPrograms|\$startMenuShortcut(?:Folder)?)/,
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
