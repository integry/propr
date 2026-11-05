import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * GHSA-g3hv-75wg-m249 (minimatch < 11.0.1) is fixed by scoped overrides in
 * package.json: Repomix and the desktop packager's @electron/asar 4 resolve
 * minimatch 11 (and glob 14, which needs it). These checks keep the lockfile
 * on patched versions and exercise the matching those consumers rely on.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
const PATCHED_MINIMATCH = [11, 0, 1];
const PATCHED_GLOB = [14, 0, 2];

function atLeast(version, minimum) {
    const parts = version.split(/[.+-]/).slice(0, 3).map(Number);
    for (let i = 0; i < 3; i++) {
        if (parts[i] !== minimum[i]) return parts[i] > minimum[i];
    }
    return true;
}

/** Resolve `name` from the lockfile entry at `from` with Node's nearest-node_modules lookup. */
function resolveInLock(from, name) {
    let dir = from;
    for (;;) {
        const key = `${dir ? `${dir}/` : ''}node_modules/${name}`;
        if (lock.packages[key]) return { key, ...lock.packages[key] };
        if (!dir) return undefined;
        const index = dir.lastIndexOf('/node_modules/');
        dir = index === -1 ? '' : dir.slice(0, index);
    }
}

const entries = name => Object.entries(lock.packages)
    .filter(([key]) => key === `node_modules/${name}` || key.endsWith(`/node_modules/${name}`));

test('no runtime dependency resolves a minimatch affected by GHSA-g3hv-75wg-m249', () => {
    const runtime = entries('minimatch').filter(([, entry]) => !entry.dev && !entry.devOptional);
    assert.ok(runtime.length > 0, 'Repomix should still resolve a runtime minimatch');
    for (const [key, entry] of runtime) {
        assert.ok(atLeast(entry.version, PATCHED_MINIMATCH), `${key}@${entry.version} is below 11.0.1`);
    }
});

test('Repomix and the desktop packager asar resolve patched minimatch and glob', () => {
    const repomix = entries('repomix');
    assert.equal(repomix.length, 1);
    assert.ok(atLeast(resolveInLock(repomix[0][0], 'minimatch').version, PATCHED_MINIMATCH));

    const asar4 = entries('@electron/asar').filter(([, entry]) => entry.version.startsWith('4.'));
    assert.ok(asar4.length > 0, '@electron/packager should use @electron/asar 4');
    for (const [key] of asar4) {
        const minimatch = resolveInLock(key, 'minimatch');
        const glob = resolveInLock(key, 'glob');
        assert.ok(atLeast(minimatch.version, PATCHED_MINIMATCH), `${key} -> ${minimatch.key}@${minimatch.version}`);
        assert.ok(atLeast(glob.version, PATCHED_GLOB), `${key} -> ${glob.key}@${glob.version}`);
        assert.ok(atLeast(resolveInLock(glob.key, 'minimatch').version, PATCHED_MINIMATCH));
    }
});

test('the minimatch Repomix loads matches its ignore and include patterns as before', () => {
    const requireFromRepomix = createRequire(createRequire(join(root, 'packages/core/package.json')).resolve('repomix'));
    const { minimatch, braceExpand, Minimatch } = requireFromRepomix('minimatch');
    const { version } = JSON.parse(readFileSync(
        join(dirname(requireFromRepomix.resolve('minimatch')), '..', '..', 'package.json'), 'utf8'));
    assert.ok(atLeast(version, PATCHED_MINIMATCH), `Repomix loads minimatch ${version}`);

    // Repomix's deferred ignore filter: `pattern` or `pattern/**`, always with dot: true.
    const ignored = (file, pattern) => minimatch(file, pattern, { dot: true }) ||
        minimatch(file, `${pattern}/**`, { dot: true });
    assert.equal(ignored('.gitignore', '.gitignore'), true);
    assert.equal(ignored('pkg/sub/.gitignore', '.gitignore'), false);
    assert.equal(ignored('pkg/sub/.ignore', '**/.ignore'), true);
    assert.equal(ignored('pkg/sub/.repomixignore', 'pkg/**/.repomixignore'), true);
    assert.equal(ignored('pkg/sub/.gitignore/x', 'pkg/sub/.gitignore'), true);
    assert.equal(ignored('src/.hidden/config.ts', 'src/**/*.ts'), true);
    assert.equal(minimatch('src/.hidden/config.ts', 'src/**/*.ts'), false, 'dotfiles still need dot: true');
    assert.equal(minimatch('src/lib/deep/util.test.ts', '**/*.{test,spec}.ts', { dot: true }), true);
    assert.equal(minimatch('src/lib/deep/util.ts', '**/*.{test,spec}.ts', { dot: true }), false);
    assert.equal(minimatch('weird/[brackets]/file{1,2}.md', 'weird/\\[brackets\\]/file\\{1,2\\}.md', { dot: true }), true);
    assert.deepEqual(braceExpand('src/{a,b}/../x'), ['src/a/../x', 'src/b/../x']);
    // asar 4 unpack: the desktop forge config pattern with matchBase.
    assert.equal(minimatch('/app/.vite/native/prebuilds/linux-x64/pty.node', '**/.vite/native/prebuilds/**', { matchBase: true }), true);
    assert.equal(minimatch('/app/.vite/native/other.node', '**/.vite/native/prebuilds/**', { matchBase: true }), false);
    assert.equal(new Minimatch('src/**/*.ts').match('src/a/b.ts'), true);
});
