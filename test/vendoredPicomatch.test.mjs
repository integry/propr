import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

/**
 * GHSA-fc5q-39xc-vjpf has no patched picomatch release, so both picomatch
 * lines are installed from reviewed, vendored tarballs (see
 * vendor/picomatch/README.md and vendor/picomatch-v2/README.md). These checks
 * keep each readable source, shipped tarball, lockfile entry and installed
 * package in lockstep, and exercise the guard and ordinary matching against
 * the copies the real consumers load.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const V4 = { source: 'vendor/picomatch', tarball: 'vendor/picomatch-4.0.8-extglobguard.1.tgz' };
const V2 = { source: 'vendor/picomatch-v2', tarball: 'vendor/picomatch-4.0.8-v2.3.2-extglobguard.1.tgz' };
// The 2.x consumers (chokidar's anymatch and readdirp, fast-glob's micromatch)
// get nested copies of the 2.x build; everything else shares the root 4.x build.
const V2_CONSUMERS = ['anymatch', 'micromatch', 'readdirp'];
const lockEntries = {
    'node_modules/picomatch': V4,
    ...Object.fromEntries(V2_CONSUMERS.map(name => [`node_modules/${name}/node_modules/picomatch`, V2])),
};

/** Regular-file entries of a gzipped ustar archive, keyed by path without the `package/` prefix. */
function readTarball(path) {
    const archive = gunzipSync(readFileSync(join(root, path)));
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
        files.set(name.replace(/^package\//, ''), Buffer.from(body));
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

const requireFrom = name => createRequire(createRequire(join(root, 'package.json')).resolve(`${name}/package.json`));
const installedPicomatchDir = name => dirname(requireFrom(name).resolve('picomatch/package.json'));

/** Time one regex test; the unpatched builds take seconds to minutes on these inputs. */
function timedTest(regex, input) {
    const started = process.hrtime.bigint();
    const matched = regex.test(input);
    return { matched, ms: Number(process.hrtime.bigint() - started) / 1e6 };
}

for (const [label, { source, tarball }] of [['4.x', V4], ['2.x', V2]]) {
    test(`the ${label} tarball is byte-identical to its reviewable source`, () => {
        const shipped = readTarball(tarball);
        const tree = readTree(join(root, source));
        assert.deepEqual([...tree.keys()].sort(), [...shipped.keys()].sort(), `${source}: file set differs from the tarball`);
        for (const [name, bytes] of shipped) assert.ok(tree.get(name).equals(bytes), `${source}: ${name} differs from the tarball`);
    });
}

test('the lockfile pins every picomatch to a vendored tarball by integrity', () => {
    const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
    const installs = Object.entries(lock.packages).filter(([path, entry]) =>
        /(^|\/)node_modules\/picomatch$/.test(path) || entry.name === 'picomatch');
    assert.deepEqual(installs.map(([path]) => path).sort(), Object.keys(lockEntries).sort(),
        'a new picomatch install path appeared; route it to a vendored build');
    for (const [path, { tarball }] of Object.entries(lockEntries)) {
        const entry = lock.packages[path];
        const integrity = `sha512-${createHash('sha512').update(readFileSync(join(root, tarball))).digest('base64')}`;
        assert.equal(entry.resolved, `file:${tarball}`, path);
        assert.equal(entry.integrity, integrity, `${path}: regenerate the lockfile integrity after repacking`);
        assert.equal(entry.version, JSON.parse(readTarball(tarball).get('package.json').toString('utf8')).version, path);
    }
});

test('each consumer loads the vendored build meant for its major line', () => {
    const consumers = [['root', join(root, 'node_modules/picomatch'), V4],
        ...V2_CONSUMERS.map(name => [name, installedPicomatchDir(name), V2])];
    for (const [consumer, directory, { tarball }] of consumers) {
        const installed = readTree(directory);
        for (const [name, bytes] of readTarball(tarball)) {
            assert.ok(installed.get(name)?.equals(bytes), `${consumer}: installed picomatch ${name} differs from ${tarball}`);
        }
    }
});

const builds = [
    ['4.x', () => createRequire(join(root, 'package.json'))('picomatch')],
    ['2.x', () => requireFrom('micromatch')('picomatch')],
];

for (const [label, load] of builds) {
    test(`the ${label} build matches single-branch repeated extglobs literally instead of backtracking`, () => {
        const picomatch = load();
        const subject = `${'a'.repeat(32)}!`;
        for (const glob of ['+(*)', '+(*a)', '*(*a)', '+(a*)', '*(*.js)', '+(*a|b)', '+(a+)', '+([ab]*)', 'x/+(@(*a))']) {
            const regex = picomatch.makeRe(glob);
            const { matched, ms } = timedTest(regex, subject);
            assert.equal(matched, false, glob);
            assert.ok(ms < 500, `${glob} took ${ms.toFixed(0)} ms`);
            assert.equal(picomatch.isMatch(glob, glob), true, `${glob} still matches its literal text`);
        }
    });

    test(`the ${label} build keeps ordinary glob and extglob matching`, () => {
        const picomatch = load();
        assert.equal(picomatch.isMatch('src/jobs/a.ts', 'src/**/*.ts'), true);
        assert.equal(picomatch.isMatch('src/jobs/a.md', 'src/**/*.ts'), false);
        assert.equal(picomatch.isMatch('a.js', '*.@(js|ts)'), true);
        assert.equal(picomatch.isMatch('a.md', '!(*.md)'), false);
        assert.equal(picomatch.isMatch('v12', 'v+([0-9])'), true);
        assert.equal(picomatch.isMatch('abcabc', '+(abc)'), true);
        assert.equal(picomatch.isMatch('foobar', '*(foo|bar)'), true);
        assert.equal(picomatch.isMatch('fffooo', '*(*(f)*(o))'), true);
        assert.equal(picomatch.isMatch('foooofo', '*(f*(o))'), true);
        assert.equal(picomatch.isMatch('aaa', '+(+(a))', { maxExtglobRecursion: 1 }), true);
        // Escaped, quoted and bracketed stars are literal and do not trip the guard.
        assert.equal(picomatch.isMatch('*a*a', '+(\\*a)'), true);
        assert.equal(picomatch.isMatch('*a', '+([*]a)'), true);
    });
}

for (const [label, { source }] of [['4.x', V4], ['2.x', V2]]) {
    test(`the ${label} build unescapes globs in linear time with upstream's results`, () => {
        const require = createRequire(join(root, source, 'package.json'));
        const { REGEX_REMOVE_BACKSLASH } = require('./lib/constants.js');
        const { removeBackslashes } = require('./lib/utils.js');
        const upstream = str => str.replace(REGEX_REMOVE_BACKSLASH, match => (match === '\\' ? '' : match));
        const alphabet = ['[', ']', '\\', 'a', '\n', ' '];
        const visit = str => {
            assert.equal(removeBackslashes(str), upstream(str), JSON.stringify(str));
            if (str.length < 6) for (const char of alphabet) visit(str + char);
        };
        visit('');
        for (const str of ['a\\*b', '[\\]]\\*', '[a\\]b]\\c', '\\[x]', 'foo/\\(bar\\)/[\\*]/baz\\']) {
            assert.equal(removeBackslashes(str), upstream(str), str);
        }

        // Upstream's regex rescans the line from every unclosed `[` (about 1.6 s here).
        for (const subject of [`\\${'['.repeat(65_000)}`, `\\${'[\\'.repeat(32_000)}`]) {
            const started = process.hrtime.bigint();
            removeBackslashes(subject);
            const ms = Number(process.hrtime.bigint() - started) / 1e6;
            assert.ok(ms < 200, `${subject.length} characters took ${ms.toFixed(0)} ms`);
        }
        const picomatch = require('./index.js');
        assert.equal(picomatch.scan('a/\\*b/*.js', { unescape: true }).glob, '*.js');
        assert.equal(picomatch.scan('a/[\\*]\\b', { unescape: true }).glob, '[\\*]b');
    });
}

test('the real 2.x consumers match through the vendored build', () => {
    const micromatch = requireFrom('micromatch')('micromatch');
    assert.deepEqual(micromatch(['a.ts', 'b.js', 'c/d.ts'], '**/*.ts'), ['a.ts', 'c/d.ts']);
    assert.equal(micromatch.scan('src/**/*.ts').base, 'src');
    const anymatch = requireFrom('anymatch')('anymatch');
    assert.equal(anymatch(['**/node_modules/**'], 'a/node_modules/b.js'), true);
    assert.equal(anymatch(['+(*a)'], `${'a'.repeat(32)}!`), false);
});
