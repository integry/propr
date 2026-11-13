/**
 * Path-only classifiers for changed files. Shared by review diff budgeting
 * (which deprioritizes lockfiles, generated files and docs) and the review
 * digest (which ranks changed files by risk). Dependency-free and browser-safe.
 */

function basename(filename: string): string {
    return (filename.split('/').pop() || filename).toLowerCase();
}

const LOCKFILES: ReadonlySet<string> = new Set([
    'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb',
    'composer.lock', 'poetry.lock', 'cargo.lock', 'gemfile.lock',
]);

/** Package manager lockfiles: generated, usually large, and pinned dependency versions. */
export function isLockfile(filename: string): boolean {
    return LOCKFILES.has(basename(filename));
}

/** Lockfiles that `isLockfile` keeps out of review-diff budgeting but that still pin dependencies. */
const ADDITIONAL_DEPENDENCY_LOCKS: ReadonlySet<string> = new Set(['go.sum', 'pipfile.lock', 'uv.lock', 'pdm.lock', 'flake.lock', 'packages.lock.json', 'mix.lock', 'pubspec.lock', 'podfile.lock', 'package.resolved']);

const DEPENDENCY_MANIFESTS: ReadonlySet<string> = new Set([
    'package.json', 'composer.json', 'pyproject.toml', 'pipfile', 'setup.py', 'setup.cfg', 'cargo.toml', 'go.mod',
    'gemfile', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts', 'pubspec.yaml',
    'mix.exs', 'podfile', 'package.swift', 'deno.json', 'deno.jsonc', 'flake.nix', 'directory.packages.props',
]);

/** Files that declare which third-party packages a project depends on. */
export function isDependencyManifest(filename: string): boolean {
    const name = basename(filename);
    return DEPENDENCY_MANIFESTS.has(name)
        || /^requirements(?:[-_.][\w.-]*)?\.(?:txt|in)$/.test(name)
        || /\.(?:csproj|fsproj|vbproj|gemspec)$/.test(name);
}

/** Lockfiles and other dependency pin files, including the ones review budgeting does not deprioritize. */
export function isDependencyLockfile(filename: string): boolean {
    return isLockfile(filename) || ADDITIONAL_DEPENDENCY_LOCKS.has(basename(filename));
}

export function isBinaryFile(filename: string): boolean {
    return /\.(png|jpe?g|gif|webp|avif|ico|bmp|tiff?|pdf|zip|tar|gz|tgz|bz2|xz|7z|rar|woff2?|ttf|eot|otf|mp4|mov|avi|webm|mp3|wav|flac|exe|dll|so|dylib|class|jar)$/i.test(filename);
}

export function isGeneratedOrVendorFile(filename: string): boolean {
    return /(^|\/)(dist|build|coverage|vendor|third_party|node_modules)\//.test(filename)
        || /\.min\.(js|css)$/i.test(filename)
        || /\.(generated|gen)\.[cm]?[jt]sx?$/i.test(filename)
        || /\.snap$/i.test(filename);
}

export function isDocumentationFile(filename: string): boolean {
    return /\.(md|mdx|rst|txt|adoc)$/i.test(filename)
        || /(^|\/)docs\//i.test(filename);
}

/** Test sources, fixtures and snapshots by conventional directory or file name. */
export function isTestFile(filename: string): boolean {
    // Name patterns run on the last path segment only, without an unanchored `[^/]+$` tail:
    // that form rescans to the end from every `-spec.`-like position (polynomial on long paths).
    const name = filename.slice(filename.lastIndexOf('/') + 1);
    return /(^|\/)(?:__tests__|__snapshots__|__mocks__|tests?|spec|specs|e2e|fixtures?|testdata)\//i.test(filename)
        || /[._-](?:test|spec)\../i.test(name)
        || /^test_.+\.py$/i.test(name)
        || /_test\.(?:go|py|rb|exs?)$/i.test(filename)
        || /\.snap$/i.test(filename);
}
