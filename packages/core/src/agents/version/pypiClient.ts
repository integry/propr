/**
 * Minimal PyPI JSON client for Python-distributed agent CLIs.
 */

export interface PyPiPackageInfo {
    info: {
        version: string;
    };
    releases: Record<string, Array<{ upload_time_iso_8601?: string; yanked?: boolean }>>;
}

const PYPI_REQUEST_TIMEOUT_MS = 10000;
const PYPI_CACHE_TTL_MS = 300000;
const packageInfoCache = new Map<string, { expiresAt: number; info: PyPiPackageInfo }>();

export function clearPyPiPackageInfoCache(): void {
    packageInfoCache.clear();
}

async function getPackageInfo(packageName: string): Promise<PyPiPackageInfo> {
    const cached = packageInfoCache.get(packageName);
    if (cached && cached.expiresAt > Date.now()) {
        return cached.info;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PYPI_REQUEST_TIMEOUT_MS);
    try {
        const response = await fetch(`https://pypi.org/pypi/${encodeURIComponent(packageName)}/json`, {
            signal: controller.signal
        });
        if (!response.ok) {
            throw new Error(`PyPI request failed for ${packageName}: ${response.status} ${response.statusText}`);
        }
        const info = await response.json() as PyPiPackageInfo;
        packageInfoCache.set(packageName, { expiresAt: Date.now() + PYPI_CACHE_TTL_MS, info });
        return info;
    } catch (error) {
        if ((error as Error).name === 'AbortError') {
            throw new Error(`PyPI request timed out for ${packageName}`);
        }
        throw error;
    } finally {
        clearTimeout(timeout);
    }
}

export async function getLatestPyPiVersion(packageName: string): Promise<string> {
    const info = await getPackageInfo(packageName);
    return info.info.version;
}

function getActiveFiles(files: Array<{ upload_time_iso_8601?: string; yanked?: boolean }>): Array<{ upload_time_iso_8601?: string; yanked?: boolean }> {
    return files.filter(file => !file.yanked);
}

function getLatestUploadTime(files: Array<{ upload_time_iso_8601?: string; yanked?: boolean }>): string {
    return files.reduce((latest, file) => {
        const uploadTime = file.upload_time_iso_8601 || '';
        const timestamp = Date.parse(uploadTime);
        if (!uploadTime || Number.isNaN(timestamp)) {
            return latest;
        }
        return timestamp > latest.timestamp ? { value: uploadTime, timestamp } : latest;
    }, { value: '', timestamp: Number.NEGATIVE_INFINITY }).value;
}

export async function getRecentPyPiVersions(
    packageName: string,
    limit: number = 10
): Promise<Array<{ version: string; publishedAt: string }>> {
    const info = await getPackageInfo(packageName);
    return Object.entries(info.releases)
        .map(([version, files]) => ({ version, publishedAt: getLatestUploadTime(getActiveFiles(files)) }))
        .filter(release => release.publishedAt)
        .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt))
        .slice(0, limit);
}

export async function resolvePyPiVersionSpec(packageName: string, versionSpec: string): Promise<string> {
    if (versionSpec === 'latest') {
        return getLatestPyPiVersion(packageName);
    }

    const info = await getPackageInfo(packageName);
    const activeFiles = getActiveFiles(info.releases[versionSpec] || []);
    if (activeFiles.length === 0) {
        throw new Error(`Version '${versionSpec}' not found for package ${packageName}`);
    }
    return versionSpec;
}
