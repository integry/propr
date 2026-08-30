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
    assert.deepEqual(
      [...preflight.matchAll(/^\s+permission-([a-z-]+): (read|write)$/gm)].map(match => `${match[1]}:${match[2]}`),
      ['administration:read', 'contents:read'],
    );
    assert.match(preflight, /GITHUB_TOKEN: \$\{\{ steps\.preflight-app-token\.outputs\.token \}\}/);
    assert.equal(workflow.match(/steps\.preflight-app-token\.outputs\.token/g)?.length, 1);
    assert.equal(preflight.match(/secrets\./g)?.length, 1);
    assert.ok(!preflight.includes('PROPR_DESKTOP_UPDATE_PRIVATE_KEY'));
    assert.ok(!preflight.includes('PROPR_DESKTOP_MAC_CERTIFICATE'));
    assert.ok(!preflight.includes('PROPR_DESKTOP_WINDOWS_CERTIFICATE'));
    assert.ok(!preflight.includes('permission-administration: write'));
    assert.ok(!preflight.includes('permission-contents: write'));
    assert.ok(!preflight.includes('permission-actions:'));
    assert.match(production, /needs: preflight/);
    assert.match(production, /environment:\s+name: desktop-release/);
    assert.match(production, /ref: \$\{\{ needs\.preflight\.outputs\.release_sha \}\}/);
    assert.match(production, /gh api .*commits\/\$RELEASE_TAG/);
    assert.match(production, /! gh release view/);
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
    assert.match(production, /release-architecture\.mjs inspect[\s\S]*--kind nupkg[\s\S]*lib\/net45\/propr-desktop\.exe/);
    assert.ok(
      production.indexOf('release-architecture.mjs inspect') < production.indexOf('Expand-Archive'),
      'the complete NUPKG must be validated before any executable is extracted or inspected',
    );
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
    assert.match(releaseArchitecture, /'hdiutil', \['attach', '-readonly', '-nobrowse', '-mountpoint', directory, privatePath\]/);
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
});
