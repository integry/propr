import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { selectRepositoryIcon } from '../packages/core/src/services/relevance/repositoryIconDiscovery.ts';

const files = (...paths: string[]) => paths.map(path => ({ path }));

describe('repository icon discovery', () => {
  test('preserves explicit priority over heuristic matches', () => {
    assert.equal(selectRepositoryIcon(files(
      'packages/web/public/favicon.avif',
      'docs/static/img/logo.svg',
      'public/favicon.svg',
      'src/assets/apple-touch-icon.webp',
    )), 'public/favicon.svg');
  });

  test('recognizes common nested web, desktop, mobile, and documentation icons', () => {
    assert.equal(selectRepositoryIcon(files('docs/static/img/logo.svg')), 'docs/static/img/logo.svg');
    assert.equal(selectRepositoryIcon(files('packages/web/src/assets/brand-mark.webp')), 'packages/web/src/assets/brand-mark.webp');
    assert.equal(selectRepositoryIcon(files('apps/desktop/src-tauri/icons/icon.png')), 'apps/desktop/src-tauri/icons/icon.png');
    assert.equal(
      selectRepositoryIcon(files('apps/android/app/src/main/res/mipmap-xxxhdpi/ic_launcher.png')),
      'apps/android/app/src/main/res/mipmap-xxxhdpi/ic_launcher.png',
    );
    assert.equal(selectRepositoryIcon(files('build/icon.png')), 'build/icon.png');
  });

  test('supports all expected image formats and uses deterministic format and lexical priority', () => {
    assert.equal(selectRepositoryIcon(files(
      'assets/logo.jpeg',
      'assets/logo.avif',
      'assets/logo.jpg',
      'assets/logo.webp',
      'assets/logo.ico',
      'assets/logo.svg',
      'assets/logo.png',
    )), 'assets/logo.png');

    assert.equal(selectRepositoryIcon(files(
      'packages/zeta/assets/logo.svg',
      'packages/alpha/assets/logo.svg',
    )), 'packages/alpha/assets/logo.svg');
  });

  test('filters false positives and ignored fallback directories', () => {
    assert.equal(selectRepositoryIcon(files(
      'src/assets/header-photo.png',
      'tests/assets/favicon.svg',
      'fixtures/logo.png',
      'examples/site/public/favicon.ico',
      'dist/logo.svg',
      'node_modules/package/icon.png',
      'vendor/brand-mark.webp',
      'generated/assets/app-icon.avif',
    )), null);
  });
});
