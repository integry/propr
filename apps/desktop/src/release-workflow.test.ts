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


  test('keeps both Windows architectures mandatory while excluding every deferred update authority gate and resource', () => {
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
    assert.match(installedWindowsAppTest, /Credential = \$credential/);
    assert.match(installedWindowsAppTest, /--propr-smoke-test/);
    assert.match(installedWindowsAppTest, /--user-data-dir=\$smokeUserDataDirectory/);
    assert.match(installedWindowsAppTest, /propr-desktop-smoke-/);
    assert.match(installedWindowsAppTest, /SetAccessRuleProtection\(\$true, \$false\)/);
    assert.match(installedWindowsAppTest, /S-1-5-18/);
    assert.match(installedWindowsAppTest, /S-1-5-32-544/);
    assert.match(installedWindowsAppTest, /Remove-SmokeUserDataDirectory \$smokeUserDataDirectory/);
    assert.match(installedWindowsAppTest, /propr:\/\/connect/);
    assert.match(installedWindowsAppTest, /deferred Windows update authority resource/);
    assert.equal(workflow.match(/https:\/\/github\.com\/wixtoolset\/wix3\/releases\/download\/wix3141rtm\/wix314-binaries\.zip/g)?.length, 2);
    assert.equal(workflow.match(/6ac824e1642d6f7277d0ed7ea09411a508f6116ba6fae0aa5f2c7daa2ff43d31/g)?.length, 2);
  });

  test('bounds and diagnoses installed Windows process lifecycles on x64 and ARM64', () => {
    assert.doesNotMatch(installedWindowsAppTest, /(?:^|\s)-Wait(?:\s|$)/);
    assert.equal(installedWindowsAppTest.match(/Start-Process/g)?.length, 1);
    assert.match(installedWindowsAppTest, /\$msiTimeoutMilliseconds = 10 \* 60 \* 1000/);
    assert.match(installedWindowsAppTest, /\$applicationTimeoutMilliseconds = 5 \* 60 \* 1000/);
    assert.match(installedWindowsAppTest, /\$terminationTimeoutMilliseconds = 30 \* 1000/);
    assert.match(installedWindowsAppTest, /\$Process\.WaitForExit\(\$TimeoutMilliseconds\)/);
    assert.match(installedWindowsAppTest, /\$Process\.Kill\(\$true\)/);
    assert.match(
      installedWindowsAppTest,
      /if \(!\$completed\) \{\n\s+Stop-SpawnedProcessTree \$Process \$Operation\n\s+throw "\$Operation timed out"/,
    );
    assert.match(installedWindowsAppTest, /LoadUserProfile = \$true/);
    assert.match(installedWindowsAppTest, /RedirectStandardOutput = \(Join-Path \$smokeUserDataDirectory 'application\.stdout\.log'\)/);
    assert.match(installedWindowsAppTest, /RedirectStandardError = \(Join-Path \$smokeUserDataDirectory 'application\.stderr\.log'\)/);
    const applicationStart = installedWindowsAppTest.match(/\$applicationStart = @\{([\s\S]*?)\n\s+\}/);
    assert.ok(applicationStart);
    assert.match(applicationStart[1], /^\s+Environment = @\{ PROPR_DESKTOP_SMOKE_TEST = '1' \}$/m);
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

    assert.match(installedWindowsAppTest, /\$smokeEvidenceFileByteCap = 64 \* 1024/);
    assert.match(installedWindowsAppTest, /foreach \(\$fileName in @\('application\.stdout\.log', 'application\.stderr\.log'\)\)/);
    assert.match(installedWindowsAppTest, /\[Math\]::Min\(\[int64\]\$item\.Length, \[int64\]\$smokeEvidenceFileByteCap\)/);
    assert.match(installedWindowsAppTest, /!\(\$item -is \[IO\.FileInfo\]\)/);
    assert.match(installedWindowsAppTest, /\$item\.PSIsContainer/);
    assert.match(installedWindowsAppTest, /\$item\.Attributes -band \[IO\.FileAttributes\]::ReparsePoint/);
    assert.match(installedWindowsAppTest, /New-Object IO\.FileStream\(/);
    assert.doesNotMatch(installedWindowsAppTest, /Get-ChildItem[^\n]*smoke|ReadAll|ReadToEnd/);
    const smokeEventAllowlist = installedWindowsAppTest.match(
      /\$smokeEventCodes = \[ordered\]@\{([\s\S]*?)\n\}/,
    );
    assert.ok(smokeEventAllowlist);
    assert.deepEqual([...smokeEventAllowlist[1].matchAll(/^\s+'([^']+)' = '[A-Z_]+'$/gm)].map(match => match[1]), [
      'desktop.app.ready',
      'desktop.renderer.mvp_flows.ready',
      'desktop.renderer.layout.ready',
      'desktop.renderer.ready',
      'desktop.app.start_failed',
      'desktop.main_process.uncaught_exception',
      'desktop.log.write_failed',
    ]);
    assert.match(installedWindowsAppTest, /ConvertFrom-Json -InputObject \$line -ErrorAction Stop/);
    assert.match(installedWindowsAppTest, /\$smokeEventCodes\.Contains\(\$eventProperty\.Value\)/);
    assert.match(
      installedWindowsAppTest,
      /PROPR_WINDOWS_INSTALLED_SMOKE:EVIDENCE:\{0\}['"] -f \(\$summary -join ','\)/,
    );
    assert.doesNotMatch(installedWindowsAppTest, /Write-Host[^\n]*(?:\$line|\$text|\$record|\$filePath|\$eventProperty)/);
    assert.match(installedWindowsAppTest, /\$requiredSmokeEvents = @\([\s\S]*desktop\.renderer\.mvp_flows\.ready[\s\S]*desktop\.renderer\.layout\.ready[\s\S]*desktop\.renderer\.ready/);
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
      /catch \{\n\s+\$waitFailure = \$_\n\s+\} finally \{\n\s+try \{\n\s+\$applicationProcess\.Dispose\(\)\n\s+\} finally \{\n\s+\$applicationProcess = \$null/,
    );
    assert.ok(
      applicationExitSection.indexOf('Wait-BoundedProcess `')
        < applicationExitSection.indexOf('$applicationProcess.Dispose()'),
      'the application process must be disposed only after its bounded wait completes or fails',
    );
    assert.ok(
      applicationExitSection.indexOf('$applicationProcess.Dispose()')
        < applicationExitSection.indexOf('Get-SmokeEventEvidence $smokeUserDataDirectory $testUserSid'),
      'the application process must release redirected-stream handles before evidence inspection',
    );
    assert.match(
      applicationExitSection,
      /\} finally \{\n\s+if \(\$null -ne \$applicationProcess\) \{ \$applicationProcess\.Dispose\(\) \}/,
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
      /\} finally \{\n\s+\$cleanupFailed = \$false[\s\S]*Invoke-Msi @\('\/x'[\s\S]*Remove-SmokeUserDataDirectory \$smokeUserDataDirectory/,
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

  test('configures signed updates only for macOS and never advertises a Windows update feed', () => {
    const production = job('release-package', 'release-finalize');
    assert.match(production, /Require macOS signed-update runtime configuration\n\s+if: matrix\.platform == 'darwin'/);
    assert.doesNotMatch(workflow, /PROPR_DESKTOP_WINDOWS_(?:X64|ARM64)_FEED_URL/);
    assert.doesNotMatch(workflow, /Require signed-update runtime configuration\n\s+if: matrix\.platform != 'linux'/);
  });
});
