/**
 * Minimal PyPI JSON client for Python-distributed agent CLIs.
 */

export interface PyPiPackageInfo {
    info: {
        version: string;
    };
    releases: Record<string, Array<{ upload_time_iso_8601?: string }>>;
}

async function getPackageInfo(packageName: string): Promise<PyPiPackageInfo> {
    const response = await fetch(`https://pypi.org/pypi/${encodeURIComponent(packageName)}/json`);
    if (!response.ok) {
        throw new Error(`PyPI request failed for ${packageName}: ${response.status} ${response.statusText}`);
    }
    return response.json() as Promise<PyPiPackageInfo>;
}

export async function getLatestPyPiVersion(packageName: string): Promise<string> {
    const info = await getPackageInfo(packageName);
    return info.info.version;
}

export async function getRecentPyPiVersions(
    packageName: string,
    limit: number = 10
): Promise<Array<{ version: string; publishedAt: string }>> {
    const info = await getPackageInfo(packageName);
    return Object.entries(info.releases)
        .map(([version, files]) => ({
            version,
            publishedAt: files[0]?.upload_time_iso_8601 || ''
        }))
        .filter(release => release.publishedAt)
        .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
        .slice(0, limit);
}

export async function resolvePyPiVersionSpec(packageName: string, versionSpec: string): Promise<string> {
    if (versionSpec === 'latest') {
        return getLatestPyPiVersion(packageName);
    }

    const info = await getPackageInfo(packageName);
    if (!info.releases[versionSpec]) {
        throw new Error(`Version '${versionSpec}' not found for package ${packageName}`);
    }
    return versionSpec;
}
