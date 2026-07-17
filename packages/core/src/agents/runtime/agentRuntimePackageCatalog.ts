import { executeDockerCommand } from '../../claude/docker/dockerExecutor.js';
import {
    inspectAgentRuntimeBaseImage,
    validateAgentRuntimePackages,
    type AgentRuntimeBaseImageInspection
} from './agentRuntimePackages.js';

const SEARCH_QUERY = /^[a-z0-9+.-]{1,80}$/;
const CATALOG_PACKAGE = /^[a-z0-9][a-z0-9+.-]*$/;
const catalogCache = new Map<string, Promise<Set<string>>>();

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
    catalogCache.set(environment.key, loading);
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
    const command = `apt-get update -qq && apt-get install --simulate -y --no-install-recommends ${packageSpec}`;
    const result = await executeDockerCommand('docker', [
        'run', '--rm', '--user', 'root', '--entrypoint', 'sh', environment.image, '-c', command
    ], { timeout: 2 * 60 * 1000 });
    if (result.exitCode === 0) return null;
    return conciseCommandError(`${result.stderr}\n${result.stdout}`);
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
    const availability: AgentRuntimePackageAvailability[] = [];
    for (const packageSpec of syntax.packages) {
        const packageName = packageNameFromSpec(packageSpec);
        const unavailableOn = catalogs
            .filter(catalog => !catalog.packages.has(packageName))
            .map(catalog => catalog.environment.inspection.osName);
        for (const environment of uniqueEnvironments) {
            if (unavailableOn.includes(environment.inspection.osName)) continue;
            const versionError = await validatePinnedPackage(environment, packageSpec);
            if (versionError) unavailableOn.push(`${environment.inspection.osName}: ${versionError}`);
        }
        availability.push({ package: packageSpec, available: unavailableOn.length === 0, unavailableOn });
    }
    const errors = availability
        .filter(result => !result.available)
        .map(result => `${result.package} is unavailable on ${result.unavailableOn.join(', ')}`);
    return { valid: errors.length === 0, packages: syntax.packages, errors, availability, sources };
}

export function clearAgentRuntimePackageCatalogCache(): void {
    catalogCache.clear();
}
