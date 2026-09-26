#!/usr/bin/env node

// Build the workspace packages the desktop main process and renderer consume,
// at most once per identical source state.
//
// `prepare:renderer` is a pre-script of `package`, `typecheck`, `test`, `make`
// and `test:native-durability`, so a single packaging job ran these four `tsc`
// builds up to four times over byte-identical sources. This records a stamp
// keyed to the exact inputs and skips the rebuild only when that key still
// matches and every declared output is present.
//
// The key is content-derived, never a timestamp: it covers the source files of
// every built workspace (as git reports them, so generated and ignored output
// is excluded), the assets the CLI build copies in, the root manifest and
// lockfile, and the running toolchain. Any changed byte, a different Node
// major or a different platform/arch produces a different key and rebuilds.
// A source that git still lists but that no longer exists on disk — a deletion
// or rename that has not been staged — is an ordinary changed input: it is
// keyed as absent so the next run rebuilds and lets the compiler judge the new
// tree, instead of aborting the hash before any build is attempted.
//
// Reuse also requires the generated tree to be exactly the one the recorded
// build produced. The stamp carries the complete inventory of every file under
// each workspace's output directory — nested modules, their declarations and
// the copied asset trees, not just the handful of entry points a later step
// loads by name — so removing any generated file rebuilds.
//
// The stamp lives under node_modules/.cache, so `npm ci`, a clean checkout and
// the self-hosted `git clean -ffdxq` all discard it. It is never uploaded,
// downloaded or shared: reuse is confined to one job on one machine.
//
//   node scripts/prepare-renderer.mjs           reuse a matching build
//   node scripts/prepare-renderer.mjs --force   always rebuild

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const STAMP_SCHEMA_VERSION = 2;
export const STAMP_PATH = join('node_modules', '.cache', 'propr', 'prepare-renderer.json');

// Built in dependency order. `outputDirectory` is everything the workspace
// build emits, recorded in full and revalidated before any reuse. `outputs`
// are the files a later step loads by name: they are additionally checked
// after every build, so a build that exits 0 without emitting them fails.
export const RENDERER_WORKSPACES = [
    {
        name: '@propr/shared',
        directory: 'packages/shared',
        outputDirectory: 'packages/shared/dist',
        outputs: ['packages/shared/dist/index.js', 'packages/shared/dist/index.d.ts'],
    },
    {
        name: '@propr/local-setup',
        directory: 'packages/local-setup',
        outputDirectory: 'packages/local-setup/dist',
        outputs: ['packages/local-setup/dist/index.js', 'packages/local-setup/dist/index.d.ts'],
    },
    {
        name: '@propr/cli',
        directory: 'packages/cli',
        outputDirectory: 'packages/cli/dist',
        outputs: [
            'packages/cli/dist/index.js',
            'packages/cli/dist/index.d.ts',
            // Copied in by packages/cli/scripts/copy-assets.mjs, not by tsc.
            'packages/cli/dist/assets/env.example.txt',
            'packages/cli/dist/orchestrator/orchestrator.mjs',
            'packages/cli/dist/orchestrator/manifest.json',
            'packages/cli/dist/skill/propr/SKILL.md',
            'packages/cli/dist/native/prebuilds/darwin-arm64/directory-operations.node',
            'packages/cli/dist/native/prebuilds/darwin-x64/directory-operations.node',
            'packages/cli/dist/native/prebuilds/linux-arm64/directory-operations.node',
            'packages/cli/dist/native/prebuilds/linux-x64/directory-operations.node',
        ],
    },
    {
        name: '@propr/client',
        directory: 'packages/client',
        outputDirectory: 'packages/client/dist',
        outputs: ['packages/client/dist/index.js', 'packages/client/dist/index.d.ts'],
    },
];

// Everything the four builds read. `docker/launcher` and `.env.example` are
// copied into the CLI package at build time, so they are inputs too.
export const RENDERER_INPUT_PATHS = [
    ...RENDERER_WORKSPACES.map(workspace => workspace.directory),
    'docker/launcher',
    '.env.example',
    'package.json',
    'package-lock.json',
    'tsconfig.json',
];

export function buildCommand(workspaceName, platform = process.platform) {
    return [platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build', '-w', workspaceName]];
}

export function toolchainKey(runtime = process) {
    return {
        node: runtime.version,
        platform: runtime.platform,
        arch: runtime.arch,
    };
}

// tsc's incremental state is build output, not a build input, and it is
// rewritten by every build. Hashing it would tie the key to the previous
// build's bookkeeping instead of to the sources.
const DERIVED_FILE_PATTERN = /\.tsbuildinfo$/;

// git is the authority on what is source: `--cached --others --exclude-standard`
// lists tracked files plus new untracked ones while omitting every ignored
// path. That matters because the CLI build writes generated assets back into
// packages/cli/src; hashing those would change the key on every build and
// defeat reuse entirely.
export function listSourceFiles(root, paths = RENDERER_INPUT_PATHS, runGit = defaultGit) {
    const result = runGit(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...paths]);
    if (result.status !== 0 || typeof result.stdout !== 'string') return null;
    return result.stdout
        .split('\0')
        .filter(entry => entry !== '' && !DERIVED_FILE_PATTERN.test(entry))
        .sort((a, b) => a.localeCompare(b));
}

function defaultGit(root, args) {
    return spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

// `git ls-files --cached` still lists a tracked file that has been deleted or
// renamed without staging the removal, so a listed input can be absent. That is
// a changed input like any other: it is keyed as absent, which invalidates the
// stamp and rebuilds, leaving the compiler to judge the new tree. Every other
// read failure — a permission denial, a directory where a file is expected, an
// I/O error — still throws, because a key that cannot be computed honestly must
// never be allowed to match a previous one.
function hashInput(root, file) {
    try {
        return createHash('sha256').update(readFileSync(join(root, file))).digest();
    } catch (error) {
        if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null;
        throw error;
    }
}

// `vanished` collects the listed inputs that no longer exist, purely so the
// rebuild can say why. The key itself already distinguishes them.
export function computeInputKey(root, files, toolchain, vanished = []) {
    const digest = createHash('sha256');
    digest.update(`schema:${STAMP_SCHEMA_VERSION}\n`);
    digest.update(`toolchain:${JSON.stringify(toolchain)}\n`);
    digest.update(`workspaces:${RENDERER_WORKSPACES.map(workspace => workspace.name).join(',')}\n`);
    for (const file of files) {
        const content = hashInput(root, file);
        digest.update(`${file}\0`);
        if (content === null) {
            vanished.push(file);
            digest.update('absent');
        } else {
            digest.update(content);
        }
        digest.update('\n');
    }
    return digest.digest('hex');
}

export function missingOutputs(root, workspaces = RENDERER_WORKSPACES) {
    return workspaces.flatMap(workspace => workspace.outputs).filter(output => !existsSync(join(root, output)));
}

// The complete inventory of what the builds emitted: every file under every
// workspace output directory, with its size. A hand-picked list of entry points
// cannot detect that an imported sibling module, a nested declaration or one
// file of a copied asset tree was removed, and a dist tree with a hole in it
// must rebuild rather than be reused.
export function listOutputFiles(root, workspaces = RENDERER_WORKSPACES) {
    const inventory = [];
    for (const workspace of workspaces) collectOutputFiles(root, workspace.outputDirectory, inventory);
    return inventory.sort((a, b) => a.path.localeCompare(b.path));
}

function collectOutputFiles(root, directory, inventory) {
    let entries;
    try {
        entries = readdirSync(join(root, directory), { withFileTypes: true });
    } catch (error) {
        // A directory that is absent contributes nothing; the recorded
        // inventory is what reports its files as missing.
        if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return;
        throw error;
    }
    for (const entry of entries) {
        // Always POSIX-separated: the inventory is compared against a stamp
        // written on the same machine, but paths stay readable and stable.
        const path = `${directory}/${entry.name}`;
        if (entry.isDirectory()) {
            collectOutputFiles(root, path, inventory);
            continue;
        }
        // Incremental state, not output: `tsc --noEmit` rewrites it too.
        if (DERIVED_FILE_PATTERN.test(entry.name)) continue;
        inventory.push({ path, size: lstatSync(join(root, path)).size });
    }
}

// Human-readable reasons the tree on disk is not the tree that was built.
// Empty means the generated output is exactly what the recorded build left.
export function outputDifferences(root, recorded, workspaces = RENDERER_WORKSPACES) {
    if (!Array.isArray(recorded)) return ['no recorded output inventory'];
    const current = new Map(listOutputFiles(root, workspaces).map(entry => [entry.path, entry.size]));
    const differences = [];
    for (const entry of recorded) {
        if (!current.has(entry.path)) differences.push(`missing ${entry.path}`);
        else if (current.get(entry.path) !== entry.size) differences.push(`changed ${entry.path}`);
        current.delete(entry.path);
    }
    for (const path of current.keys()) differences.push(`unexpected ${path}`);
    return differences;
}

// A stamp is only usable when it carries everything reuse is decided on: the
// schema it was written for, the key, and a well-formed output inventory. An
// older or hand-edited stamp is treated as no stamp at all.
export function readStamp(root) {
    try {
        const stamp = JSON.parse(readFileSync(join(root, STAMP_PATH), 'utf8'));
        if (stamp?.schemaVersion !== STAMP_SCHEMA_VERSION) return null;
        if (!Array.isArray(stamp.outputs)) return null;
        if (stamp.outputs.some(entry => typeof entry?.path !== 'string' || !Number.isInteger(entry?.size))) return null;
        return stamp;
    } catch {
        return null;
    }
}

function clearStamp(root) {
    rmSync(join(root, STAMP_PATH), { force: true });
}

function writeStamp(root, key, toolchain, outputs) {
    const path = join(root, STAMP_PATH);
    mkdirSync(dirname(path), { recursive: true });
    const stamp = { schemaVersion: STAMP_SCHEMA_VERSION, key, toolchain, outputs };
    writeFileSync(path, `${JSON.stringify(stamp, null, 2)}\n`);
}

function defaultRun(root, workspaceName) {
    const [command, args] = buildCommand(workspaceName);
    return spawnSync(command, args, { cwd: root, stdio: 'inherit' }).status ?? 1;
}

// Returns { reused, key, built }. Throws when a build fails, leaving no stamp
// behind, so a partially built tree can never be mistaken for a complete one.
export function prepareRenderer({
    root,
    force = false,
    run = defaultRun,
    log = console.log,
    runtime = process,
    listFiles = listSourceFiles,
} = {}) {
    const toolchain = toolchainKey(runtime);
    const files = listFiles(root);
    const vanished = [];
    const key = files === null ? null : computeInputKey(root, files, toolchain, vanished);

    if (!force && key !== null) {
        const stamp = readStamp(root);
        if (stamp?.key === key) {
            const absent = missingOutputs(root);
            // The declared entry points are named separately only for a clearer
            // message; the inventory covers them too.
            const differences = absent.length > 0
                ? absent.map(output => `missing ${output}`)
                : outputDifferences(root, stamp.outputs);
            if (differences.length === 0) {
                log(`prepare-renderer: reusing the build already made from these exact sources (${key.slice(0, 12)}).`);
                return { reused: true, key, built: [] };
            }
            log(`prepare-renderer: rebuilding, the generated tree no longer matches the recorded build`
                + ` (${differences.length} difference(s), first: ${differences[0]}).`);
        }
    }

    if (key === null) {
        log('prepare-renderer: rebuilding, the source file list could not be determined.');
    } else if (vanished.length > 0) {
        log(`prepare-renderer: rebuilding, ${vanished.length} listed source file(s) no longer exist,`
            + ` first: ${vanished[0]}.`);
    }

    // Removed before the first build so an interrupted run cannot leave a
    // stamp that claims outputs which were never produced.
    clearStamp(root);

    const built = [];
    for (const workspace of RENDERER_WORKSPACES) {
        const status = run(root, workspace.name);
        if (status !== 0) {
            throw new Error(`prepare-renderer: building ${workspace.name} failed with exit code ${status}`);
        }
        built.push(workspace.name);
    }

    const absent = missingOutputs(root);
    if (absent.length > 0) {
        throw new Error(`prepare-renderer: expected build output is missing: ${absent.join(', ')}`);
    }
    // Recorded after the last build, so the inventory describes the finished
    // tree that the key it is stored beside produced.
    if (key !== null) writeStamp(root, key, toolchain, listOutputFiles(root));
    return { reused: false, key, built };
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
    try {
        prepareRenderer({ root, force: process.argv.includes('--force') });
    } catch (error) {
        console.error(error instanceof Error ? error.message : error);
        process.exit(1);
    }
}
