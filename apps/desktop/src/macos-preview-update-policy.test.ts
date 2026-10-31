import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import {
  requireProductionReleaseConfiguration,
  resolveTrustedUpdateBuildConfig,
  type Environment,
} from './release-config';
import { parseSignedUpdateManifest } from './signed-updates';

const workflow = readFileSync(
  new URL('../../../.github/workflows/desktop-macos-preview.yml', import.meta.url),
  'utf8',
);

// Every variable the unsigned macOS preview build job can see: the workflow
// env plus the package job env, with placeholder values for expressions.
const previewBuildEnvironment = (): Environment => {
  const packageJob = workflow.slice(workflow.indexOf('\n  package:'), workflow.indexOf('\n  finalize:'));
  const blocks = [
    workflow.slice(workflow.indexOf('\nenv:\n'), workflow.indexOf('\npermissions:\n')),
    packageJob.slice(packageJob.indexOf('\n    env:\n'), packageJob.indexOf('\n    steps:\n')),
  ];
  const env: Record<string, string> = {};
  for (const block of blocks) {
    for (const [, name, value] of block.matchAll(/^ {2,6}([A-Z][A-Z0-9_]*): (.+)$/gm)) {
      env[name!] = value!.includes('${{') ? 'placeholder' : value!;
    }
  }
  return env;
};

describe('unsigned macOS preview update policy', () => {
  test('the preview build environment configures no update channel, signing, or production release', () => {
    const env = previewBuildEnvironment();
    assert.ok('PROPR_DESKTOP_RELEASE_SHA' in env && 'PROPR_DESKTOP_RUNTIME_AGENT_IMAGE' in env);
    for (const name of Object.keys(env)) {
      assert.doesNotMatch(name, /UPDATE|ENABLE_UPDATES|CODE_SIGNED|PRODUCTION_RELEASE|MAC_SIGNING|APPLE_/, name);
    }
    assert.doesNotMatch(workflow, /secrets\.|PROPR_DESKTOP_(?:ENABLE_UPDATES|CODE_SIGNED|PRODUCTION_RELEASE)=1/);
    assert.deepEqual(resolveTrustedUpdateBuildConfig(env, 'darwin'), {
      enabled: false, manifestUrl: '', publicKey: '', signingIdentity: '', windowsSignerPins: [],
    });
  });

  test('enabling updates on an unsigned darwin build fails the build instead of embedding a channel', () => {
    const env = {
      ...previewBuildEnvironment(),
      PROPR_DESKTOP_ENABLE_UPDATES: '1',
      PROPR_DESKTOP_UPDATE_MANIFEST_URL: 'https://updates.example.test/stable/desktop-release.json',
      PROPR_DESKTOP_UPDATE_PUBLIC_KEY: 'unused',
      PROPR_DESKTOP_UPDATE_SIGNING_IDENTITY: 'TEAM123456',
    };
    assert.throws(() => resolveTrustedUpdateBuildConfig(env, 'darwin'), /PROPR_DESKTOP_CODE_SIGNED=1/);
    // An unsigned darwin build can never pass the production release gate.
    assert.throws(() => requireProductionReleaseConfiguration({
      platform: 'darwin', updateConfig: resolveTrustedUpdateBuildConfig({}, 'darwin'),
    }), /signing, notarization, and signed updates/);
  });

  test('the packaged main process gets an empty update manifest URL, so it never checks for updates', () => {
    const env = { ...previewBuildEnvironment(), PATH: process.env.PATH, HOME: process.env.HOME };
    const output = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
      const { default: config } = await import(${JSON.stringify(new URL('../vite.main.config.ts', import.meta.url).href)});
      const { define } = config({ command: 'serve', mode: 'production' });
      process.stdout.write(JSON.stringify({
        manifestUrl: define.__PROPR_DESKTOP_UPDATE_MANIFEST_URL__,
        publicKey: define.__PROPR_DESKTOP_UPDATE_PUBLIC_KEY__,
        signingIdentity: define.__PROPR_DESKTOP_UPDATE_SIGNING_IDENTITY__,
      }));
    `], { encoding: 'utf8', cwd: new URL('../', import.meta.url), env });
    // main.ts only builds an update config (and calls checkForSignedUpdates)
    // when __PROPR_DESKTOP_UPDATE_MANIFEST_URL__ is non-empty.
    assert.deepEqual(JSON.parse(output), { manifestUrl: '""', publicKey: '""', signingIdentity: '""' });
  });

  test('signed update clients reject preview-profile metadata outright', () => {
    for (const [releaseProfile, channel] of [['macos-preview-v1', 'validation'], ['macos-preview-v1', 'stable']]) {
      assert.throws(() => parseSignedUpdateManifest(Buffer.from(JSON.stringify({
        schemaVersion: 2, releaseProfile, channel, version: '1.2.4', tag: 'desktop-v1.2.4', feeds: {},
      }))), /unsupported|profile/i);
    }
  });
});
