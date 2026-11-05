import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

/**
 * The installed `braces` comes from the committed tarball, while the
 * reviewable source lives in vendor/braces. These checks keep the three in
 * lockstep (readable source, shipped tarball, installed package) and exercise
 * the depth guard and ordinary expansion against the artifact consumers load.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const TARBALL = 'vendor/braces-3.0.4-depthguard.1.tgz';
const tarballPath = join(root, TARBALL);

/** Regular-file entries of a gzipped ustar archive, keyed by path without the `package/` prefix. */
function readTarball(path) {
    const archive = gunzipSync(readFileSync(path));
    const files = new Map();
    let longName = null;
    for (let offset = 0; offset + 512 <= archive.length;) {
        const header = archive.subarray(offset, offset + 512);
        if (header.every(byte => byte === 0)) break;
        const field = (start, length) => header.subarray(start, start + length).toString('utf8').replace(/\0.*$/s, '');
        const size = parseInt(field(124, 12).trim() || '0', 8);
        const type = field(156, 1) || '0';
        const prefix = field(345, 155);
        let name = longName ?? (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100));
        longName = null;
        const body = archive.subarray(offset + 512, offset + 512 + size);
        offset += 512 + Math.ceil(size / 512) * 512;
        if (type === 'L') { longName = body.toString('utf8').replace(/\0.*$/s, ''); continue; }
        if (type !== '0') continue;
        name = name.replace(/^package\//, '');
        files.set(name, Buffer.from(body));
    }
    return files;
}

function readTree(dir, base = dir, files = new Map()) {
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) readTree(full, base, files);
        else files.set(relative(base, full).split('\\').join('/'), readFileSync(full));
    }
    return files;
}

function assertSameFiles(actual, expected, label) {
    assert.deepEqual([...actual.keys()].sort(), [...expected.keys()].sort(), `${label}: file set differs from the tarball`);
    for (const [name, bytes] of expected) {
        assert.ok(actual.get(name).equals(bytes), `${label}: ${name} differs from the tarball`);
    }
}

// micromatch is the real consumer (via fast-glob, tailwindcss and repomix), so
// resolve braces from its location rather than the root.
const micromatchPath = createRequire(join(root, 'package.json')).resolve('micromatch');
const requireFromMicromatch = createRequire(micromatchPath);
const installedDir = dirname(requireFromMicromatch.resolve('braces/package.json'));

test('the committed tarball is byte-identical to the reviewable vendor/braces source', () => {
    assertSameFiles(readTree(join(root, 'vendor/braces')), readTarball(tarballPath), 'vendor/braces');
});

test('the lockfile pins the committed tarball by integrity', () => {
    const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
    const entry = lock.packages['node_modules/braces'];
    const integrity = `sha512-${createHash('sha512').update(readFileSync(tarballPath)).digest('base64')}`;
    assert.equal(entry.resolved, `file:${TARBALL}`);
    assert.equal(entry.integrity, integrity, 'regenerate the lockfile after repacking the tarball');
    assert.equal(entry.version, JSON.parse(readTarball(tarballPath).get('package.json').toString('utf8')).version);
});

test('the installed braces that micromatch loads is the shipped tarball', () => {
    const shipped = readTarball(tarballPath);
    const installed = readTree(installedDir);
    // npm may add bookkeeping files; every shipped file must be installed verbatim.
    for (const [name, bytes] of shipped) {
        assert.ok(installed.get(name)?.equals(bytes), `installed ${name} differs from the tarball`);
    }
});

test('the installed artifact expands ordinary patterns normally', () => {
    const braces = requireFromMicromatch('braces');
    assert.deepEqual(braces.expand('a/{b,c}/d'), ['a/b/d', 'a/c/d']);
    assert.deepEqual(braces.expand('{1..3}'), ['1', '2', '3']);
    assert.deepEqual(braces.expand('x{a,{b,c}}y'), ['xay', 'xby', 'xcy']);
    assert.deepEqual(braces('{a,b}'), ['(a|b)']);
    const micromatch = requireFromMicromatch('micromatch');
    assert.equal(micromatch.isMatch('src/jobs/a.ts', 'src/**/*.{ts,js}'), true);
    assert.equal(micromatch.isMatch('src/jobs/a.md', 'src/**/*.{ts,js}'), false);
});

test('the installed artifact rejects excessive nesting with a controlled error', () => {
    const braces = requireFromMicromatch('braces');
    const nested = depth => `${'{a,'.repeat(depth)}b${'}'.repeat(depth)}`;
    assert.equal(braces.expand(nested(100)).length, 101, 'nesting up to the limit still expands');
    assert.throws(() => braces.expand(nested(101)), { name: 'SyntaxError', message: /exceeds max depth \(100\)/ });
    assert.throws(() => braces(nested(2000)), { name: 'SyntaxError', message: /exceeds max depth/ },
        'deep input fails fast instead of exhausting the stack');
});
