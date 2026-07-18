import { executeDockerCommand } from '../../claude/docker/dockerExecutor.js';
import {
    inspectAgentRuntimeBaseImage,
    validateAgentRuntimePackages,
    type AgentRuntimeBaseImageInspection
} from './agentRuntimePackages.js';

const SEARCH_QUERY = /^[a-z0-9+.-]{1,80}$/;
const CATALOG_PACKAGE = /^[a-z0-9][a-z0-9+.-]*$/;
const PINNED_VALIDATION_CONCURRENCY = 4;
const PINNED_ENV_VALIDATION_CONCURRENCY = 2;
const CACHE_LIMIT = 128;
const catalogCache = new Map<string, Promise<Set<string>>>();
const pinnedPackageValidationCache = new Map<string, Promise<string | null>>();

interface PackageEnvironment {
    image: string;
    inspection: AgentRuntimeBaseImageInspection;
    key: string;
}

export interface AgentRuntimePackageSource {
    packageManager: 'apt';
    osName: string;
    images: string[];
}

export interface AgentRuntimePackageSearchResult {
    query: string;
    suggestions: string[];
    sources: AgentRuntimePackageSource[];
}

export interface AgentRuntimePackageAvailability {
    package: string;
    available: boolean;
    unavailableOn: string[];
}

export interface AgentRuntimePackageAvailabilityResult {
    valid: boolean;
    packages: string[];
    errors: string[];
    availability: AgentRuntimePackageAvailability[];
    sources: AgentRuntimePackageSource[];
}

function catalogCommand(): string {
    return 'apt-get update -qq && apt-cache pkgnames';
}

function rememberCacheValue<K, V>(cache: Map<K, V>, key: K, value: V): void {
    if (!cache.has(key) && cache.size >= CACHE_LIMIT) {
        cache.delete(cache.keys().next().value as K);
    }
    cache.set(key, value);
}

async function inspectEnvironments(baseImages: string[]): Promise<PackageEnvironment[]> {
    const environments = await Promise.all([...new Set(baseImages)].sort().map(async image => {
        const inspection = await inspectAgentRuntimeBaseImage(image);
        return {
            image,
            inspection,
            key: `${inspection.packageManager}:${inspection.packageSourceFingerprint}`
        };
    }));
    return environments;
}

function groupSources(environments: PackageEnvironment[]): AgentRuntimePackageSource[] {
    const grouped = new Map<string, AgentRuntimePackageSource>();
    for (const environment of environments) {
        const source = grouped.get(environment.key) || {
            packageManager: environment.inspection.packageManager,
            osName: environment.inspection.osName,
            images: []
        };
        source.images.push(environment.image);
        grouped.set(environment.key, source);
    }
    return [...grouped.values()].map(source => ({ ...source, images: source.images.sort() }));
}

async function loadCatalog(environment: PackageEnvironment): Promise<Set<string>> {
    const cached = catalogCache.get(environment.key);
    if (cached) return cached;

    const loading = (async () => {
        const result = await executeDockerCommand('docker', [
            'run', '--rm', '--user', 'root', '--entrypoint', 'sh', environment.image,
            '-c', catalogCommand()
        ], { timeout: 2 * 60 * 1000 });
        if (result.exitCode !== 0) {
            throw new Error(
                `Could not load the ${environment.inspection.osName} package catalog: `
                + (result.stderr.trim() || `command exited with code ${result.exitCode}`)
            );
        }
        return new Set(result.stdout
            .split('\n')
            .map(value => value.trim().toLowerCase())
            .filter(value => CATALOG_PACKAGE.test(value)));
    })();
    rememberCacheValue(catalogCache, environment.key, loading);
    try {
        return await loading;
    } catch (error) {
        catalogCache.delete(environment.key);
        throw error;
    }
}

async function uniqueCatalogs(environments: PackageEnvironment[]): Promise<Array<{ environment: PackageEnvironment; packages: Set<string> }>> {
    const unique = [...new Map(environments.map(environment => [environment.key, environment])).values()];
    return Promise.all(unique.map(async environment => ({ environment, packages: await loadCatalog(environment) })));
}

function packageNameFromSpec(packageSpec: string): string {
    const unpinned = packageSpec.split('=', 1)[0];
    return unpinned.split(':', 1)[0];
}

function conciseCommandError(output: string): string {
    const lines = output.split('\n').map(line => line.trim()).filter(Boolean);
    return (lines.find(line => /unable to|no such|not found|breaks:|conflicts:/i.test(line)) || lines.at(-1) || 'version is unavailable')
        .slice(0, 300);
}

async function validatePinnedPackage(environment: PackageEnvironment, packageSpec: string): Promise<string | null> {
    if (!packageSpec.includes('=')) return null;
    const cacheKey = `${environment.key}:${packageSpec}`;
    const cached = pinnedPackageValidationCache.get(cacheKey);
    if (cached) return cached;
    const validation = (async () => {
        const result = await executeDockerCommand('docker', [
            'run', '--rm', '--user', 'root', '--entrypoint', 'sh', environment.image, '-c',
            'apt-get update -qq && apt-get install --simulate -y --no-install-recommends "$1"',
            'propr-apt-validate', packageSpec
        ], { timeout: 2 * 60 * 1000 });
        if (result.exitCode === 0) return null;
        return conciseCommandError(`${result.stderr}\n${result.stdout}`);
    })();
    rememberCacheValue(pinnedPackageValidationCache, cacheKey, validation);
    try {
        return await validation;
    } catch (error) {
        pinnedPackageValidationCache.delete(cacheKey);
        throw error;
    }
}

async function validatePinnedPackageBatch(
    environment: PackageEnvironment,
    packageSpecs: string[]
): Promise<Array<{ packageSpec: string; osName: string; versionError: string | null }>> {
    const result = await executeDockerCommand('docker', [
        'run', '--rm', '--user', 'root', '--entrypoint', 'sh', environment.image, '-c',
        'apt-get update -qq && apt-get install --simulate -y --no-install-recommends "$@"',
        'propr-apt-validate', ...packageSpecs
    ], { timeout: 2 * 60 * 1000 });
    if (result.exitCode === 0) {
        return packageSpecs.map(packageSpec => ({
            packageSpec,
            osName: environment.inspection.osName,
            versionError: null
        }));
    }
    const batchError = conciseCommandError(`${result.stderr}\n${result.stdout}`);
    return mapWithConcurrency(packageSpecs, PINNED_VALIDATION_CONCURRENCY, async packageSpec => ({
        packageSpec,
        osName: environment.inspection.osName,
        versionError: await validatePinnedPackage(environment, packageSpec) || batchError
    }));
}

async function mapWithConcurrency<T, R>(
    values: T[],
    concurrency: number,
    mapper: (value: T) => Promise<R>
): Promise<R[]> {
    const results = new Array<R>(values.length);
    let nextIndex = 0;
    const workerCount = Math.min(Math.max(1, concurrency), values.length);
    await Promise.all(Array.from({ length: workerCount }, async () => {
        while (nextIndex < values.length) {
            const currentIndex = nextIndex++;
            results[currentIndex] = await mapper(values[currentIndex]);
        }
    }));
    return results;
}

export async function searchAgentRuntimePackages(
    query: string,
    baseImages: string[],
    limit = 20
): Promise<AgentRuntimePackageSearchResult> {
    const normalizedQuery = query.trim().toLowerCase();
    if (!SEARCH_QUERY.test(normalizedQuery)) {
        return { query: normalizedQuery, suggestions: [], sources: [] };
    }
    const environments = await inspectEnvironments(baseImages);
    const catalogs = await uniqueCatalogs(environments);
    const first = catalogs[0]?.packages || new Set<string>();
    const suggestions = [...first]
        .filter(packageName => packageName.includes(normalizedQuery))
        .filter(packageName => catalogs.every(catalog => catalog.packages.has(packageName)))
        .sort((left, right) => {
            const leftRank = left === normalizedQuery ? 0 : left.startsWith(normalizedQuery) ? 1 : 2;
            const rightRank = right === normalizedQuery ? 0 : right.startsWith(normalizedQuery) ? 1 : 2;
            return leftRank - rightRank || left.length - right.length || left.localeCompare(right);
        })
        .slice(0, Math.max(1, Math.min(limit, 50)));
    return { query: normalizedQuery, suggestions, sources: groupSources(environments) };
}

export async function validateAgentRuntimePackageAvailability(
    packages: unknown,
    baseImages: string[]
): Promise<AgentRuntimePackageAvailabilityResult> {
    const syntax = validateAgentRuntimePackages(packages);
    if (!syntax.valid) {
        return { ...syntax, availability: [], sources: [] };
    }
    if (syntax.packages.length === 0) {
        return { ...syntax, availability: [], sources: [] };
    }
    if (baseImages.length === 0) {
        return {
            ...syntax,
            valid: false,
            errors: ['No agent base images are configured'],
            availability: [],
            sources: []
        };
    }

    const environments = await inspectEnvironments(baseImages);
    const catalogs = await uniqueCatalogs(environments);
    const sources = groupSources(environments);
    const uniqueEnvironments = [...new Map(environments.map(environment => [environment.key, environment])).values()];
    const availability = syntax.packages.map(packageSpec => {
        const packageName = packageNameFromSpec(packageSpec);
        const unavailableOn = catalogs
            .filter(catalog => !catalog.packages.has(packageName))
            .map(catalog => catalog.environment.inspection.osName);
        return { package: packageSpec, available: unavailableOn.length === 0, unavailableOn };
    });
    const byPackage = new Map(availability.map(result => [result.package, result]));
    const pinnedChecksByEnvironment = new Map<string, { environment: PackageEnvironment; packageSpecs: string[] }>();
    for (const packageSpec of syntax.packages) {
        if (!packageSpec.includes('=')) continue;
        const packageName = packageNameFromSpec(packageSpec);
        for (const environment of uniqueEnvironments) {
            const catalog = catalogs.find(candidate => candidate.environment.key === environment.key);
            if (!catalog?.packages.has(packageName)) continue;
            const checks = pinnedChecksByEnvironment.get(environment.key) || { environment, packageSpecs: [] };
            checks.packageSpecs.push(packageSpec);
            pinnedChecksByEnvironment.set(environment.key, checks);
        }
    }
    const pinnedResultGroups = await mapWithConcurrency(
        [...pinnedChecksByEnvironment.values()],
        PINNED_ENV_VALIDATION_CONCURRENCY,
        async ({ environment, packageSpecs }) => validatePinnedPackageBatch(environment, packageSpecs)
    );
    const pinnedResults = pinnedResultGroups.flat();
    for (const result of pinnedResults) {
        if (!result.versionError) continue;
        byPackage.get(result.packageSpec)?.unavailableOn.push(`${result.osName}: ${result.versionError}`);
    }
    for (const result of availability) {
        result.available = result.unavailableOn.length === 0;
    }
    const errors = availability
        .filter(result => !result.available)
        .map(result => `${result.package} is unavailable on ${result.unavailableOn.join(', ')}`);
    return { valid: errors.length === 0, packages: syntax.packages, errors, availability, sources };
}

/**
 * Best-effort, fire-and-forget catalog cache warm-up. Loading a cold catalog
 * spawns a container running `apt-get update` (up to minutes), so callers that
 * know a search is likely (e.g. an admin opening the runtime packages settings)
 * can start the load early instead of paying for it on the first search request.
 */
export function warmAgentRuntimePackageCatalog(baseImages: string[]): void {
    void (async () => {
        const environments = await inspectEnvironments(baseImages);
        await uniqueCatalogs(environments);
    })().catch(() => {
        /* Warming is best-effort; searches load the catalog on demand. */
    });
}

export function clearAgentRuntimePackageCatalogCache(): void {
    catalogCache.clear();
    pinnedPackageValidationCache.clear();
}
