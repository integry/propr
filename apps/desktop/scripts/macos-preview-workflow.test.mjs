import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, test } from 'node:test';

const workflow = await readFile(
  new URL('../../../.github/workflows/desktop-macos-preview.yml', import.meta.url),
  'utf8',
);
const linuxWorkflow = await readFile(
  new URL('../../../.github/workflows/desktop-linux-preview.yml', import.meta.url),
  'utf8',
);

// Exact top-level jobs, each sliced up to the next job header.
const jobs = Object.fromEntries([...workflow.slice(workflow.indexOf('\njobs:\n'))
  .matchAll(/\n  ([a-z][a-z-]*):\n[\s\S]*?(?=\n(?:  #[^\n]*\n)*  [a-z][a-z-]*:\n|$)/g)].map(match => [match[1], match[0]]));
const runScripts = block => [...block.matchAll(/\n( +)run: [|>]?-?\n?([\s\S]*?)(?=\n\1(?:- |[a-z-]+:)|\n {0,4}[a-z]|$)/g)]
  .map(match => match[2]).join('\n');

describe('desktop macOS unsigned preview workflow', () => {
  test('has exactly the staged pipeline jobs in dependency order', () => {
    assert.deepEqual(Object.keys(jobs), [
      'identity', 'runtime-preflight', 'package', 'finalize', 'attest', 'stage-draft', 'publish',
    ]);
    assert.match(jobs['runtime-preflight'], /needs: identity\n/);
    assert.match(jobs.package, /needs: \[identity, runtime-preflight\]/);
    assert.match(jobs.finalize, /needs: \[identity, package\]/);
    assert.match(jobs.attest, /needs: \[identity, finalize\]/);
    assert.match(jobs['stage-draft'], /needs: \[identity, finalize, attest\]/);
    assert.match(jobs.publish, /needs: \[identity, stage-draft\]/);
  });

  test('is manual-only and binds identity to main with the script shared with the Linux preview', () => {
    assert.match(workflow, /^on:\n  workflow_dispatch:\n/m);
    assert.doesNotMatch(workflow, /^  (?:push|pull_request|pull_request_target|workflow_run|schedule|release):/m);
    for (const input of ['source_revision', 'runtime_app_image', 'runtime_ui_image', 'runtime_agent_image']) {
      assert.match(workflow, new RegExp(`\\n      ${input}:\\n        description: [^\\n]+\\n        required: true\\n        type: string\\n`), input);
    }
    assert.match(workflow, /runtime_app_image:\n\s+description: propr\/app:<source SHA>@sha256:<digest> published multi-arch/);
    assert.match(workflow, /runtime_ui_image:\n\s+description: propr\/ui:<source SHA>@sha256:<digest> published multi-arch/);
    assert.match(workflow, /runtime_agent_image:\n\s+description: propr\/agent:<source SHA>@sha256:<digest> published linux\/amd64/);
    const identity = jobs.identity;
    assert.match(identity, /DISPATCH_REF: \$\{\{ github\.ref \}\}\n\s+run: \|\n\s+if \[ "\$DISPATCH_REF" != refs\/heads\/main \]/);
    assert.match(identity, /ref: \$\{\{ github\.sha \}\}\n\s+fetch-depth: 0\n\s+persist-credentials: false/);
    assert.match(identity, /WORKFLOW_SHA: \$\{\{ github\.sha \}\}/);
    assert.match(identity, /REQUESTED_SHA: \$\{\{ inputs\.source_revision \}\}/);
    for (const name of ['APP', 'UI', 'AGENT']) {
      assert.match(identity, new RegExp(`RUNTIME_${name}_IMAGE: \\$\\{\\{ inputs\\.runtime_${name.toLowerCase()}_image \\}\\}`));
    }
    assert.match(identity, /node apps\/desktop\/scripts\/desktop-preview-identity\.mjs --channel macos >> "\$GITHUB_OUTPUT"/);
    assert.match(linuxWorkflow, /node apps\/desktop\/scripts\/desktop-preview-identity\.mjs --channel linux >> "\$GITHUB_OUTPUT"/);
  });

  test('verifies and embeds the three pinned runtime digests from the identity outputs only', () => {
    const preflight = jobs['runtime-preflight'];
    assert.match(preflight, /ref: \$\{\{ needs\.identity\.outputs\.release_sha \}\}/);
    assert.match(preflight, /desktop-runtime-manifest\.mjs verify-release[\s\S]+--app-image "\$RUNTIME_APP_IMAGE"[\s\S]+--ui-image "\$RUNTIME_UI_IMAGE"[\s\S]+--agent-image "\$RUNTIME_AGENT_IMAGE"/);
    const packageJob = jobs.package;
    assert.match(packageJob, /desktop-runtime-manifest\.mjs release[\s\S]+--agent-image "\$RUNTIME_AGENT_IMAGE"[\s\S]+PROPR_DESKTOP_RUNTIME_MANIFEST=/);
    assert.match(packageJob, /PROPR_DESKTOP_RUNTIME_AGENT_IMAGE: \$\{\{ needs\.identity\.outputs\.runtime_agent_image \}\}/);
    assert.match(packageJob, /Contents\/Resources\/manifest\.json"/);
    assert.match(packageJob, /distribution: "published"/);
    assert.match(jobs.finalize, /--runtime-app-image "\$RUNTIME_APP_IMAGE"[\s\S]+--runtime-ui-image "\$RUNTIME_UI_IMAGE"[\s\S]+--runtime-agent-image "\$RUNTIME_AGENT_IMAGE"/);
    // Runtime pins only flow from the validated identity outputs.
    for (const [name, block] of Object.entries(jobs)) {
      if (name !== 'identity') assert.doesNotMatch(block, /inputs\.runtime_/, name);
    }
  });

  test('builds DMG and ZIP natively for darwin x64 and arm64 from the frozen source and fails closed', () => {
    const packageJob = jobs.package;
    assert.match(packageJob, /- arch: x64\n\s+runner: macos-15-intel\n/);
    assert.match(packageJob, /- arch: arm64\n\s+runner: macos-15\n/);
    assert.equal(workflow.match(/runs-on: \$\{\{ matrix\.runner \}\}/g)?.length, 1);
    assert.match(packageJob, /fail-fast: true/);
    assert.doesNotMatch(workflow, /continue-on-error/);
    assert.match(packageJob, /ref: \$\{\{ needs\.identity\.outputs\.release_sha \}\}/);
    assert.match(packageJob, /process\.platform!=="darwin"\|\|process\.arch!==process\.env\.EXPECTED_ARCH/);
    assert.match(packageJob, /npm run desktop:typecheck\n\s+npm run desktop:test/);
    assert.match(packageJob, /npm run make -w @propr\/desktop -- --arch="\$PREVIEW_ARCH"/);
    assert.match(packageJob, /npm run make:dmg -w @propr\/desktop -- --arch="\$PREVIEW_ARCH"/);
    assert.match(packageJob, /--profile macos-preview-v1/);
    assert.match(packageJob, /--platform darwin/);
  });

  test('applies the existing local ad-hoc signature and runs the unsigned-package acceptance checks', () => {
    const packageJob = jobs.package;
    assert.match(packageJob, /if: matrix\.arch == 'arm64'\n[\s\S]+PROPR_DESKTOP_TEST_LOCAL_SIGNATURE_APP: apps\/desktop\/out\/propr-desktop-darwin-arm64\/propr-desktop\.app\n\s+run: node --test apps\/desktop\/scripts\/sign-darwin-local-package\.test\.mjs/);
    assert.match(packageJob, /npm run desktop:smoke:inspect/);
    assert.match(packageJob, /verify-darwin-image\.mjs/);
    assert.match(packageJob, /unzip -t/);
    assert.match(packageJob, /icons:verify-packaged -w @propr\/desktop -- darwin/);
    assert.match(packageJob, /probe-dmg-private-snapshot-isolation/);
    assert.match(packageJob, /run-packaged-darwin-connect-smoke\.sh \\\n\s+"\$PREVIEW_ARCH" native-lifecycle/);
    assert.match(packageJob, /CFBundleShortVersionString/);
    assert.match(packageJob, /must not carry a Developer ID signature/);
  });

  test('has no secrets, Apple credentials, or update channel anywhere; tokens only where publishing', () => {
    assert.doesNotMatch(workflow, /secrets\./);
    assert.doesNotMatch(workflow, /notarytool|stapler|osxSign|security import|PROPR_DESKTOP_MAC_SIGNING_IDENTITY=|APPLE_API_KEY_P8/);
    assert.doesNotMatch(workflow, /PROPR_DESKTOP_(?:ENABLE_UPDATES|CODE_SIGNED|PRODUCTION_RELEASE|REQUIRE_SIGNED_ARTIFACTS)(?:=1|: )/);
    assert.doesNotMatch(workflow, /environment:\n\s+name: desktop-release(?:-preflight)?\n/);
    assert.match(workflow, /^permissions:\n  contents: read\n/m);
    assert.match(jobs.package, /Prove preview packaging has no signing, notarization, or update configuration/);
    assert.match(jobs.package, /PROPR_DESKTOP_\(\?:MAC_\|APPLE_\|WINDOWS_CERTIFICATE\|UPDATE_\|ENABLE_UPDATES\|CODE_SIGNED\|PRODUCTION_RELEASE/);
    assert.match(jobs.package, /test -z "\$\{PROPR_DESKTOP_ENABLE_UPDATES:-\}"/);
    for (const name of ['identity', 'runtime-preflight', 'package', 'finalize']) {
      assert.doesNotMatch(jobs[name], /github\.token|GITHUB_TOKEN|GH_TOKEN|id-token|contents: write/, name);
      assert.doesNotMatch(jobs[name], /permissions:\n(?:\s+[a-z-]+: (?:read|write)\n)*\s+[a-z-]+: write/, name);
    }
    for (const block of Object.values(jobs)) {
      assert.doesNotMatch(block, /persist-credentials: true/);
      for (const checkout of block.matchAll(/uses: actions\/checkout@[^\n]+\n\s+with:\n((?:\s{10}[^\n]+\n?)+)/g)) {
        assert.match(checkout[1], /persist-credentials: false/);
      }
    }
  });

  test('produces SHA256SUMS over every asset and a provenance attestation for every artifact', () => {
    const finalize = jobs.finalize;
    assert.match(finalize, /release-artifacts\.mjs finalize[\s\S]+--profile macos-preview-v1/);
    assert.match(finalize, /macos-preview-release\.mjs prepare/);
    assert.match(finalize, /sha256sum --check --strict SHA256SUMS/);
    assert.match(finalize, /test ! -e desktop-macos-preview-final\/desktop-release\.json\n/);
    assert.match(finalize, /test ! -e desktop-macos-preview-final\/desktop-release\.json\.sig/);
    const attest = jobs.attest;
    assert.match(attest, /id-token: write/);
    assert.match(attest, /attestations: write/);
    assert.doesNotMatch(attest, /contents: write/);
    // The OIDC job runs no repository code: no checkout, setup, or npm.
    assert.doesNotMatch(attest, /actions\/checkout|setup-node|npm |node /);
    assert.match(attest, /sha256sum --check --strict SHA256SUMS/);
    assert.match(attest, /test "\$\(find \. -mindepth 1 \| wc -l\)" -eq 7/);
    assert.match(attest, /uses: actions\/attest-build-provenance@[a-f0-9]{40} # v\d+\.\d+\.\d+\n\s+with:\n\s+subject-path: desktop-macos-preview-final\/\*\n/);
    assert.equal(workflow.match(/id-token: write/g)?.length, 1);
    assert.equal(workflow.match(/attest-build-provenance/g)?.length, 1);
  });

  test('stages a draft first and publishes only a pre-release, never latest, from a protected environment', () => {
    const stage = jobs['stage-draft'];
    assert.match(stage, /contents: write/);
    assert.match(stage, /ref: \$\{\{ github\.sha \}\}/);
    assert.match(stage, /macos-preview-release\.mjs stage-draft/);
    assert.doesNotMatch(stage, /environment:|publish-draft/);
    const publish = jobs.publish;
    assert.match(publish, /environment:\n\s+name: desktop-macos-preview-publication\n/);
    assert.equal(workflow.match(/environment:/g)?.length, 1);
    assert.match(publish, /AUTHORIZED: \$\{\{ vars\.PROPR_DESKTOP_MACOS_PREVIEW_PUBLICATION_AUTHORIZED \}\}\n\s+run: test "\$AUTHORIZED" = 1/);
    assert.match(publish, /gh attestation verify "\$asset"[\s\S]+--signer-workflow "\$REPOSITORY\/\.github\/workflows\/desktop-macos-preview\.yml"[\s\S]+--source-ref refs\/heads\/main[\s\S]+--deny-self-hosted-runners/);
    assert.match(publish, /macos-preview-release\.mjs publish-draft/);
    assert.ok(publish.indexOf('gh attestation verify') < publish.indexOf('publish-draft'));
    assert.doesNotMatch(workflow, /make_latest|gh release (?:create|edit)|--latest/);
    assert.equal(workflow.match(/publish-draft/g)?.length, 1);
  });

  test('keeps workflow-controlled values out of inline scripts', () => {
    const scripts = runScripts(workflow);
    assert.ok(scripts.length > 1000);
    assert.doesNotMatch(scripts, /\$\{\{ (?:inputs|github\.event|matrix|needs)\./);
  });
});
