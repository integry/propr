#!/usr/bin/env node
/**
 * Shared, conservative CI change classification.
 *
 * Every workflow that wants to skip work asks this one script which surfaces a
 * pull request actually touches. The rules live here once so two workflows can
 * never disagree about what a path means.
 *
 * The policy is deliberately small and fails towards more validation:
 *
 *   - A path that matches no rule selects every surface.
 *   - Workflow, action, script and lockfile changes select every surface, so a
 *     change to the selector itself always runs the full matrix.
 *   - A manifest is compared structurally between the merge base and the head.
 *     Only a change confined to a named backend-focused test script is narrow;
 *     dependencies, engines, version, workspaces, lifecycle scripts and any
 *     field this script does not recognise select every surface.
 *   - An unresolvable diff, an unreadable manifest or any internal failure
 *     reports `status=fallback` with every surface selected. Callers must treat
 *     a missing or empty decision as "run it", never as "safe to skip".
 *
 * Usage:
 *   node scripts/ci-change-classification.mjs --base <sha> --head <sha> \
 *     [--event <name>] [--repo <dir>] [--json] [--github-output] [--summary] \
 *     [--require-resolution] [--diff <file>] [--no-fetch]
 */

import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Every surface a workflow can gate on. `broad` is not a surface: it is the
 * statement that all of them were selected.
 */
export const SURFACES = Object.freeze([
    'core',
    'api',
    'core_package',
    'ui',
    'cli',
    'connect',
    'desktop',
    'docs',
]);

/**
 * Paths whose blast radius this policy refuses to reason about. Anything here
 * selects every surface, including the classifier and the workflows that call
 * it: a selector must never be able to suppress its own validation.
 */
const BROAD_RULES = [
    { pattern: /^\.github\//, rule: 'workflow, composite action or CI configuration' },
    { pattern: /^scripts\//, rule: 'shared build, release or CI script' },
    { pattern: /^test\/ci[A-Z][^/]*$/, rule: 'CI and workflow regression test' },
    { pattern: /(^|\/)package-lock\.json$/, rule: 'dependency lockfile' },
    { pattern: /^\.propr\//, rule: 'repository automation setup' },
    { pattern: /^(config|docker|dockerhub)\//, rule: 'deployment or image configuration' },
    { pattern: /^Dockerfile[^/]*$/, rule: 'container image definition' },
    { pattern: /^docker-compose[^/]*\.ya?ml$/, rule: 'compose stack definition' },
    { pattern: /^\.(nvmrc|gitattributes|gitignore|dockerignore)$/, rule: 'toolchain or checkout configuration' },
    { pattern: /^(tsconfig\.json|eslint\.config\.js|knexfile\.ts)$/, rule: 'shared toolchain configuration' },
    { pattern: /^wrangler[^/]*\.toml$/, rule: 'deployment configuration' },
    { pattern: /^\.env\.example$/, rule: 'runtime configuration contract' },
];

/**
 * Path to surface rules, first match wins. The surface lists are dependency
 * statements: a shared runtime change activates its downstream consumers, and a
 * renderer change still activates the packaged desktop app that embeds it.
 */
const PATH_RULES = [
    {
        pattern: /^apps\/desktop\//,
        surfaces: ['desktop'],
        rule: 'desktop application source',
    },
    {
        pattern: /^packages\/api\/src\//,
        surfaces: ['api', 'connect'],
        rule: 'API implementation, which the Connect discovery proofs exercise',
    },
    {
        pattern: /^packages\/api\//,
        surfaces: ['api'],
        rule: 'API package',
    },
    {
        pattern: /^packages\/core\//,
        surfaces: ['core', 'api', 'core_package', 'connect'],
        rule: '@propr/core, consumed by the service, the API and the Connect proofs',
    },
    {
        pattern: /^packages\/shared\//,
        surfaces: ['core', 'api', 'core_package', 'ui', 'cli', 'connect', 'desktop'],
        rule: '@propr/shared runtime, consumed by every surface',
    },
    {
        pattern: /^packages\/client\//,
        surfaces: ['ui', 'connect', 'desktop'],
        rule: '@propr/client transport, consumed by the UI and the packaged desktop app',
    },
    {
        pattern: /^packages\/cli\//,
        surfaces: ['cli', 'connect', 'desktop'],
        rule: '@propr/cli, which the desktop app bundles',
    },
    {
        pattern: /^packages\/local-setup\//,
        surfaces: ['cli', 'connect', 'desktop'],
        rule: '@propr/local-setup, consumed by the CLI and the desktop app',
    },
    {
        pattern: /^propr-ui\//,
        surfaces: ['ui', 'desktop'],
        rule: 'renderer shared with the packaged desktop app',
    },
    {
        pattern: /^src\//,
        surfaces: ['core'],
        rule: 'root orchestrator service',
    },
    {
        pattern: /^test\//,
        surfaces: ['core', 'api'],
        rule: 'root server test suite',
    },
    {
        pattern: /^docs\//,
        surfaces: ['docs'],
        rule: 'documentation site',
    },
    {
        pattern: /^(library_docs|media)\//,
        surfaces: ['docs'],
        rule: 'reference material',
    },
    {
        pattern: /^[^/]+\.md$/,
        surfaces: ['docs'],
        rule: 'repository documentation',
    },
    {
        pattern: /^(LICENSE|NOTICE)$/,
        surfaces: ['docs'],
        rule: 'repository documentation',
    },
];

/**
 * Files the Connect proof scripts name directly. They live under paths whose
 * rule would not otherwise select the Connect surface, so they are listed here
 * and a test keeps this list equal to what those scripts actually run.
 */
export const CONNECT_PROOF_FILES = Object.freeze([
    'packages/api/test/statusRoutes.test.ts',
    'test/nativeConnectAuthority.test.ts',
]);

/**
 * The only manifest scripts a change may be confined to without selecting every
 * surface. Each one names server-side test files and nothing in CI invokes it,
 * so editing it cannot change what a desktop, CLI or UI check does.
 */
export const NARROW_ROOT_TEST_SCRIPTS = Object.freeze({
    'test:mcp': ['api'],
    'test:unit': ['api', 'core'],
    'test:notifications:server': ['api', 'core'],
});

const MANIFEST_PATTERN = /(^|\/)package\.json$/;
const SHA_PATTERN = /^[0-9a-f]{40}$/;

export class ClassificationError extends Error {}

const emptySurfaces = () => Object.fromEntries(SURFACES.map(surface => [surface, false]));

function deepEqual(left, right) {
    if (left === right) return true;
    if (typeof left !== typeof right) return false;
    if (left === null || right === null) return false;
    if (Array.isArray(left) || Array.isArray(right)) {
        if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
        return left.every((value, index) => deepEqual(value, right[index]));
    }
    if (typeof left !== 'object') return false;
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    if (leftKeys.length !== rightKeys.length) return false;
    return leftKeys.every(key =>
        Object.hasOwn(right, key) && deepEqual(left[key], right[key]));
}

const isPlainObject = value =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

function changedKeys(base, head) {
    const keys = new Set([...Object.keys(base ?? {}), ...Object.keys(head ?? {})]);
    return [...keys].filter(key => !deepEqual(base?.[key], head?.[key])).sort();
}

/**
 * Structural comparison of one manifest between the merge base and the head.
 * Whitespace and key order are invisible because both sides are parsed first.
 */
export function classifyManifest({ path, status, baseText, headText }) {
    if (status !== 'M') {
        return { broad: true, surfaces: [], detail: `manifest ${status === 'A' ? 'added' : status === 'D' ? 'deleted' : 'renamed or copied'}` };
    }
    if (typeof baseText !== 'string' || typeof headText !== 'string') {
        return { broad: true, surfaces: [], detail: 'manifest content unavailable on one side of the diff' };
    }
    let base;
    let head;
    try {
        base = JSON.parse(baseText);
        head = JSON.parse(headText);
    } catch (error) {
        return { broad: true, surfaces: [], detail: `manifest could not be parsed (${error.message})` };
    }
    if (!isPlainObject(base) || !isPlainObject(head)) {
        return { broad: true, surfaces: [], detail: 'manifest is not a JSON object' };
    }
    if (deepEqual(base, head)) {
        return { broad: false, surfaces: [], detail: 'whitespace or key order only, no structural change' };
    }
    const changedFields = changedKeys(base, head);
    const nonScriptFields = changedFields.filter(field => field !== 'scripts');
    if (nonScriptFields.length > 0) {
        return {
            broad: true,
            surfaces: [],
            detail: `manifest fields changed: ${nonScriptFields.join(', ')}`,
        };
    }
    if (path !== 'package.json') {
        return {
            broad: true,
            surfaces: [],
            detail: 'workspace manifest scripts are not classified narrowly',
        };
    }
    if (!isPlainObject(base.scripts) || !isPlainObject(head.scripts)) {
        return { broad: true, surfaces: [], detail: 'scripts is missing or is not an object on one side' };
    }
    const changedScripts = changedKeys(base.scripts, head.scripts);
    const unknownScripts = changedScripts.filter(name => !Object.hasOwn(NARROW_ROOT_TEST_SCRIPTS, name));
    if (unknownScripts.length > 0) {
        return {
            broad: true,
            surfaces: [],
            detail: `scripts changed outside the known backend test scripts: ${unknownScripts.join(', ')}`,
        };
    }
    const surfaces = [...new Set(changedScripts.flatMap(name => NARROW_ROOT_TEST_SCRIPTS[name]))].sort();
    return {
        broad: false,
        surfaces,
        detail: `only known backend test scripts changed: ${changedScripts.join(', ')}`,
    };
}

function classifyPath(path) {
    for (const { pattern, rule } of BROAD_RULES) {
        if (pattern.test(path)) return { broad: true, surfaces: [], rule };
    }
    for (const { pattern, surfaces, rule } of PATH_RULES) {
        if (pattern.test(path)) {
            const selected = new Set(surfaces);
            if (CONNECT_PROOF_FILES.includes(path)) selected.add('connect');
            return { broad: false, surfaces: [...selected], rule };
        }
    }
    return { broad: true, surfaces: [], rule: 'path matches no classification rule' };
}

/**
 * Classify an already-resolved change set.
 *
 * @param {object} input
 * @param {Array<{status: string, path: string, previousPath?: string}>} input.files
 * @param {Record<string, {base: string|null, head: string|null}>} input.manifests
 * @param {string} input.eventName
 * @param {string[]} input.notes  Resolution notes to surface in the reasons.
 */
export function classifyChanges({ files = [], manifests = {}, eventName = 'pull_request', notes = [] } = {}) {
    const surfaces = emptySurfaces();
    const selectedFiles = Object.fromEntries(SURFACES.map(surface => [surface, []]));
    const corePackageSourceFiles = [];
    const reasons = [];
    let broad = false;

    const selectAll = detail => {
        broad = true;
        for (const surface of SURFACES) surfaces[surface] = true;
        reasons.push({ path: null, decision: 'broad', detail });
    };

    for (const note of notes) reasons.push({ path: null, decision: 'note', detail: note });

    if (eventName !== 'pull_request') {
        selectAll(`event '${eventName}' is not a pull request, so every surface is validated`);
    }

    if (files.length === 0 && !broad) {
        selectAll('no changed files were resolved, which is never treated as safe to skip');
    }

    for (const file of files) {
        const path = file.path;
        if (typeof path !== 'string' || path.length === 0) {
            selectAll('a changed path was missing or malformed');
            continue;
        }
        let result;
        if (MANIFEST_PATTERN.test(path)) {
            const contents = manifests[path] ?? {};
            const manifest = classifyManifest({
                path,
                status: file.status,
                baseText: contents.base,
                headText: contents.head,
            });
            result = { broad: manifest.broad, surfaces: manifest.surfaces, rule: manifest.detail };
        } else {
            result = classifyPath(path);
        }
        if (result.broad) {
            broad = true;
            for (const surface of SURFACES) surfaces[surface] = true;
        }
        for (const surface of result.surfaces) {
            if (!SURFACES.includes(surface)) {
                selectAll(`rule for ${path} named the unknown surface '${surface}'`);
                continue;
            }
            surfaces[surface] = true;
        }
        reasons.push({
            path,
            decision: result.broad ? 'broad' : (result.surfaces.length > 0 ? result.surfaces.join(', ') : 'no surface'),
            detail: result.rule,
        });
        if (['A', 'M'].includes(file.status) && /^packages\/core\/src\/.*\.(js|ts)$/.test(path)) {
            corePackageSourceFiles.push(path);
        }
    }

    // Per-surface file lists stay useful for the broad case too: a job that
    // wants "which files" must still see them when everything is selected.
    for (const file of files) {
        if (typeof file.path !== 'string') continue;
        for (const surface of SURFACES) {
            if (!surfaces[surface]) continue;
            if (surfaceMatches(surface, file, manifests)) selectedFiles[surface].push(file.path);
        }
    }

    return {
        status: 'ok',
        broad,
        eventName,
        surfaces,
        files: selectedFiles,
        core_package_source: corePackageSourceFiles.length > 0,
        core_package_source_files: corePackageSourceFiles,
        reasons,
    };
}

/**
 * Whether this individual file belongs to a surface, used only to build the
 * per-surface file lists the build job lints from.
 */
function surfaceMatches(surface, file, manifests) {
    const path = file.path;
    if (MANIFEST_PATTERN.test(path)) {
        const contents = manifests[path] ?? {};
        const manifest = classifyManifest({
            path,
            status: file.status,
            baseText: contents.base,
            headText: contents.head,
        });
        return manifest.broad || manifest.surfaces.includes(surface);
    }
    const result = classifyPath(path);
    return result.broad || result.surfaces.includes(surface);
}

/** A classification that selects everything because resolution failed. */
export function fallbackClassification(detail, eventName = 'pull_request') {
    const surfaces = Object.fromEntries(SURFACES.map(surface => [surface, true]));
    return {
        status: 'fallback',
        broad: true,
        eventName,
        surfaces,
        files: Object.fromEntries(SURFACES.map(surface => [surface, []])),
        core_package_source: true,
        core_package_source_files: [],
        reasons: [{ path: null, decision: 'broad', detail }],
    };
}

function runGit(repository, args) {
    return execFileSync('git', ['-C', repository, ...args], {
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
}

function tryGit(repository, args) {
    try {
        return { ok: true, stdout: runGit(repository, args) };
    } catch (error) {
        return { ok: false, error };
    }
}

function parseNameStatus(output) {
    const tokens = output.split('\0');
    const files = [];
    let index = 0;
    while (index < tokens.length) {
        const status = tokens[index];
        if (!status) {
            index += 1;
            continue;
        }
        const code = status[0];
        if (code === 'R' || code === 'C') {
            const previousPath = tokens[index + 1];
            const path = tokens[index + 2];
            if (previousPath === undefined || path === undefined) {
                throw new ClassificationError('git name-status output ended inside a rename record');
            }
            // Both sides of a rename are changes: the destination gains the
            // content and the source loses it, and they can land in different
            // surfaces.
            files.push({ status: 'D', path: previousPath, renamedTo: path });
            files.push({ status: 'A', path, previousPath });
            index += 3;
            continue;
        }
        const path = tokens[index + 1];
        if (path === undefined) {
            throw new ClassificationError('git name-status output ended without a path');
        }
        files.push({ status: code, path });
        index += 2;
    }
    return files;
}

function isShallow(repository) {
    const result = tryGit(repository, ['rev-parse', '--is-shallow-repository']);
    return result.ok && result.stdout.trim() === 'true';
}

function shallowBoundary(repository) {
    const result = tryGit(repository, ['rev-parse', '--git-dir']);
    if (!result.ok) return new Set();
    const gitDir = result.stdout.trim();
    const absolute = join(isAbsolute(gitDir) ? gitDir : join(repository, gitDir), 'shallow');
    if (!existsSync(absolute)) return new Set();
    try {
        return new Set(readFileSync(absolute, 'utf8').split('\n').map(line => line.trim()).filter(Boolean));
    } catch {
        return new Set();
    }
}

function hasCommit(repository, sha) {
    return tryGit(repository, ['cat-file', '-e', `${sha}^{commit}`]).ok;
}

/**
 * Resolve the pull request's own contribution: the merge base of the captured
 * base and head, not `HEAD^` and not the last commit, so multi-commit pull
 * requests and an advancing base branch are both handled. A shallow checkout is
 * deepened explicitly until the merge base is a real commit rather than a
 * grafted boundary.
 */
export function resolveChanges({ repository, baseSha, headSha, allowFetch = true, notes = [] }) {
    for (const [name, sha] of [['base', baseSha], ['head', headSha]]) {
        if (typeof sha !== 'string' || !SHA_PATTERN.test(sha)) {
            throw new ClassificationError(`${name} commit '${sha ?? ''}' is missing or is not a full commit sha`);
        }
    }
    if (!tryGit(repository, ['rev-parse', '--git-dir']).ok) {
        throw new ClassificationError('not a git repository');
    }

    const deepen = reason => {
        if (!allowFetch) return false;
        for (const args of [
            ['fetch', '--no-tags', '--deepen=200', 'origin'],
            ['fetch', '--no-tags', '--deepen=1000', 'origin'],
            ['fetch', '--no-tags', '--unshallow', 'origin'],
        ]) {
            const result = tryGit(repository, args);
            if (result.ok) {
                notes.push(`deepened the shallow checkout (${reason}) with: git ${args.join(' ')}`);
                return true;
            }
        }
        return false;
    };

    for (const sha of [baseSha, headSha]) {
        if (hasCommit(repository, sha)) continue;
        if (allowFetch) {
            const fetched = tryGit(repository, ['fetch', '--no-tags', '--depth=1', 'origin', sha]);
            if (fetched.ok) notes.push(`fetched ${sha} that the checkout did not contain`);
        }
        if (!hasCommit(repository, sha)) {
            deepen(`${sha} was not present`);
        }
        if (!hasCommit(repository, sha)) {
            throw new ClassificationError(`commit ${sha} is not available in this checkout`);
        }
    }

    let mergeBase = null;
    for (let attempt = 0; attempt < 4; attempt += 1) {
        const result = tryGit(repository, ['merge-base', baseSha, headSha]);
        if (result.ok) {
            const candidate = result.stdout.trim();
            // A grafted commit has no parents recorded, so a merge base landing
            // on the shallow boundary may not be the real one.
            if (!isShallow(repository) || !shallowBoundary(repository).has(candidate)) {
                mergeBase = candidate;
                break;
            }
            notes.push(`merge base ${candidate} is a shallow boundary commit`);
        }
        if (!deepen('the merge base was not reachable')) break;
    }
    if (!mergeBase) {
        throw new ClassificationError(`no merge base between ${baseSha} and ${headSha} is reachable in this checkout`);
    }

    const diff = tryGit(repository, [
        'diff', '--name-status', '-z', '--find-renames', '--no-color', mergeBase, headSha, '--',
    ]);
    if (!diff.ok) {
        throw new ClassificationError(`git diff between ${mergeBase} and ${headSha} failed`);
    }
    const files = parseNameStatus(diff.stdout);

    const manifests = {};
    const read = (sha, path) => {
        const result = tryGit(repository, ['show', `${sha}:${path}`]);
        return result.ok ? result.stdout : null;
    };
    for (const file of files) {
        if (!MANIFEST_PATTERN.test(file.path) || manifests[file.path]) continue;
        manifests[file.path] = { base: read(mergeBase, file.path), head: read(headSha, file.path) };
    }

    return { mergeBase, files, manifests, notes };
}

/** Collapse a rename pair back into a single record per path for reporting. */
export function classifyRepository({ repository, baseSha, headSha, eventName, allowFetch = true }) {
    const notes = [];
    try {
        const resolved = resolveChanges({ repository, baseSha, headSha, allowFetch, notes });
        notes.unshift(`merge base ${resolved.mergeBase}, head ${headSha}, ${resolved.files.length} changed path(s)`);
        return classifyChanges({
            files: resolved.files,
            manifests: resolved.manifests,
            eventName,
            notes,
        });
    } catch (error) {
        return fallbackClassification(
            `change resolution failed, so every surface is validated: ${error.message}`,
            eventName,
        );
    }
}

export function renderSummary(decision) {
    const lines = [];
    lines.push('## CI change classification');
    lines.push('');
    lines.push(`Status: \`${decision.status}\` · Broad validation: \`${decision.broad}\``);
    lines.push('');
    lines.push('| Surface | Selected |');
    lines.push('| --- | --- |');
    for (const surface of SURFACES) {
        lines.push(`| \`${surface}\` | ${decision.surfaces[surface] ? '✅ run' : '⏭️ not applicable'} |`);
    }
    lines.push('');
    lines.push('### Why');
    lines.push('');
    for (const reason of decision.reasons) {
        lines.push(reason.path
            ? `- \`${reason.path}\` → **${reason.decision}** (${reason.detail})`
            : `- ${reason.detail}`);
    }
    lines.push('');
    return lines.join('\n');
}

function writeOutputs(decision, file) {
    const entries = [
        ['status', decision.status],
        ['broad', String(decision.broad)],
        ['core_package_source', String(decision.core_package_source)],
        ['core_package_source_files', JSON.stringify(decision.core_package_source_files)],
    ];
    for (const surface of SURFACES) {
        entries.push([surface, String(decision.surfaces[surface])]);
        entries.push([`${surface}_files`, JSON.stringify(decision.files[surface] ?? [])]);
    }
    appendFileSync(file, entries.map(([key, value]) => `${key}=${value}\n`).join(''));
}

function parseArguments(argv) {
    const options = {
        base: process.env.PROPR_CLASSIFY_BASE_SHA ?? '',
        head: process.env.PROPR_CLASSIFY_HEAD_SHA ?? '',
        event: process.env.PROPR_CLASSIFY_EVENT ?? process.env.GITHUB_EVENT_NAME ?? 'pull_request',
        repository: process.cwd(),
        json: false,
        githubOutput: false,
        summary: false,
        requireResolution: false,
        allowFetch: true,
    };
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        const next = () => {
            const value = argv[index + 1];
            if (value === undefined) throw new ClassificationError(`${argument} needs a value`);
            index += 1;
            return value;
        };
        switch (argument) {
            case '--base': options.base = next(); break;
            case '--head': options.head = next(); break;
            case '--event': options.event = next(); break;
            case '--repo': options.repository = next(); break;
            case '--json': options.json = true; break;
            case '--github-output': options.githubOutput = true; break;
            case '--summary': options.summary = true; break;
            case '--require-resolution': options.requireResolution = true; break;
            case '--no-fetch': options.allowFetch = false; break;
            default:
                throw new ClassificationError(`unknown argument ${argument}`);
        }
    }
    return options;
}

export function main(argv = process.argv.slice(2), environment = process.env) {
    let decision;
    let options;
    try {
        options = parseArguments(argv);
        decision = classifyRepository({
            repository: options.repository,
            baseSha: options.base,
            headSha: options.head,
            eventName: options.event,
            allowFetch: options.allowFetch,
        });
    } catch (error) {
        // The arguments may not have parsed at all, so honour the reporting
        // flags straight from argv: a malformed invocation must still emit the
        // conservative decision rather than nothing.
        options ??= {
            json: argv.includes('--json'),
            githubOutput: argv.includes('--github-output'),
            summary: argv.includes('--summary'),
            requireResolution: argv.includes('--require-resolution'),
        };
        decision = fallbackClassification(
            `the classifier could not run, so every surface is validated: ${error.message}`,
        );
    }

    for (const reason of decision.reasons) {
        process.stdout.write(reason.path
            ? `${reason.path}: ${reason.decision} (${reason.detail})\n`
            : `${reason.detail}\n`);
    }
    process.stdout.write(`decision: status=${decision.status} broad=${decision.broad} ${
        SURFACES.map(surface => `${surface}=${decision.surfaces[surface]}`).join(' ')}\n`);

    if (options.json) process.stdout.write(`${JSON.stringify(decision, null, 2)}\n`);
    if (options.githubOutput && environment.GITHUB_OUTPUT) writeOutputs(decision, environment.GITHUB_OUTPUT);
    if (options.summary && environment.GITHUB_STEP_SUMMARY) {
        appendFileSync(environment.GITHUB_STEP_SUMMARY, `${renderSummary(decision)}\n`);
    }
    if (options.requireResolution && decision.status !== 'ok') {
        process.stderr.write('Change resolution failed and --require-resolution was set.\n');
        return 1;
    }
    return 0;
}

const invokedDirectly = process.argv[1]
    && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
    process.exitCode = main();
}
