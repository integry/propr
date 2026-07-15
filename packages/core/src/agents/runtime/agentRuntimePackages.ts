import crypto from 'node:crypto';
import logger from '../../utils/logger.js';
import { getConfig, saveConfig } from '../../config/configStore.js';
import { executeDockerCommand } from '../../claude/docker/dockerExecutor.js';

export const AGENT_RUNTIME_BUILD_QUEUE_NAME = 'agent-runtime-build';
const CONFIG_KEY = 'agent_runtime_packages';
const MAX_PACKAGES = 100;
const PACKAGE_SPEC = /^[a-z0-9][a-z0-9+.-]*(?::[a-z0-9][a-z0-9-]*)?(?:=[A-Za-z0-9.+:~_-]+)?$/;
const IMAGE_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._/:@-]*$/;
const SAFE_USER = /^[A-Za-z0-9_.:-]+$/;
const INSTALLATION_ID = /^[a-z0-9-]{1,64}$/;
const baseImageInspectionCache = new Map<string, AgentRuntimeBaseImageInspection>();

export type AgentRuntimeBuildStatus = 'disabled' | 'pending' | 'building' | 'ready' | 'failed';
export type AgentRuntimePackageManager = 'apt' | 'apk';

export interface AgentRuntimeBaseImageInspection {
    id: string;
    user: string;
    packageManager: AgentRuntimePackageManager;
    packageSourceFingerprint: string;
    osName: string;
}

export interface AgentRuntimeImageRecord {
    baseImage: string;
    baseImageId: string;
    image: string;
    packageManager: AgentRuntimePackageManager;
    builtAt: string;
}

export interface AgentRuntimePackageState {
    installationId: string;
    packages: string[];
    activePackages: string[];
    status: AgentRuntimeBuildStatus;
    buildId?: string;
    images: Record<string, AgentRuntimeImageRecord>;
    error?: string;
    buildLog?: string;
    updatedAt: string;
}

export interface AgentRuntimeBuildJobData {
    buildId: string;
    installationId?: string;
    packages: string[];
    baseImages: string[];
}

export interface RuntimePackageValidation {
    valid: boolean;
    packages: string[];
    errors: string[];
}

const defaultState = (): AgentRuntimePackageState => ({
    installationId: crypto.randomUUID(),
    packages: [],
    activePackages: [],
    status: 'disabled',
    images: {},
    updatedAt: new Date(0).toISOString()
});

function normalizePackageList(packages: unknown): string[] {
    if (!Array.isArray(packages)) return [];
    return [...new Set(packages
        .filter((value): value is string => typeof value === 'string')
        .map(value => {
            const trimmed = value.trim();
            const separator = trimmed.indexOf('=');
            if (separator === -1) return trimmed.toLowerCase();
            return `${trimmed.slice(0, separator).toLowerCase()}=${trimmed.slice(separator + 1)}`;
        })
        .filter(Boolean))].sort();
}

export function validateAgentRuntimePackages(packages: unknown): RuntimePackageValidation {
    if (!Array.isArray(packages)) {
        return { valid: false, packages: [], errors: ['packages must be an array of system package names'] };
    }
    const normalized = normalizePackageList(packages);
    const errors: string[] = [];
    if (normalized.length > MAX_PACKAGES) errors.push(`at most ${MAX_PACKAGES} packages may be configured`);
    for (const packageSpec of normalized) {
        if (!PACKAGE_SPEC.test(packageSpec)) errors.push(`invalid package spec: ${packageSpec}`);
    }
    return { valid: errors.length === 0, packages: normalized, errors };
}

function normalizeState(value: unknown): AgentRuntimePackageState {
    if (!value || typeof value !== 'object') return defaultState();
    const raw = value as Partial<AgentRuntimePackageState>;
    const packages = normalizePackageList(raw.packages);
    const activePackages = normalizePackageList(raw.activePackages);
    const validStatuses: AgentRuntimeBuildStatus[] = ['disabled', 'pending', 'building', 'ready', 'failed'];
    return {
        installationId: typeof raw.installationId === 'string' && INSTALLATION_ID.test(raw.installationId)
            ? raw.installationId
            : crypto.randomUUID(),
        packages,
        activePackages,
        status: validStatuses.includes(raw.status as AgentRuntimeBuildStatus)
            ? raw.status as AgentRuntimeBuildStatus
            : activePackages.length > 0 ? 'ready' : 'disabled',
        buildId: typeof raw.buildId === 'string' ? raw.buildId : undefined,
        images: raw.images && typeof raw.images === 'object' ? raw.images : {},
        error: typeof raw.error === 'string' ? raw.error : undefined,
        buildLog: typeof raw.buildLog === 'string' ? raw.buildLog : undefined,
        updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : new Date(0).toISOString()
    };
}

export async function loadAgentRuntimePackageState(): Promise<AgentRuntimePackageState> {
    const raw = await getConfig<unknown>(CONFIG_KEY, defaultState());
    const state = normalizeState(raw);
    if (!raw || typeof raw !== 'object' || (raw as Partial<AgentRuntimePackageState>).installationId !== state.installationId) {
        await saveConfig(CONFIG_KEY, state);
    }
    return state;
}

export async function saveAgentRuntimePackageState(state: AgentRuntimePackageState): Promise<void> {
    await saveConfig(CONFIG_KEY, normalizeState(state));
}

export async function requestAgentRuntimePackageBuild(
    packages: unknown,
    baseImages: string[]
): Promise<AgentRuntimeBuildJobData> {
    const validation = validateAgentRuntimePackages(packages);
    if (!validation.valid) throw new Error(validation.errors.join('; '));
    const current = await loadAgentRuntimePackageState();
    const buildId = crypto.randomUUID();
    const state: AgentRuntimePackageState = {
        ...current,
        packages: validation.packages,
        status: 'pending',
        buildId,
        error: undefined,
        buildLog: undefined,
        updatedAt: new Date().toISOString()
    };
    await saveAgentRuntimePackageState(state);
    return {
        buildId,
        installationId: state.installationId,
        packages: validation.packages,
        baseImages: [...new Set(baseImages.filter(Boolean))].sort()
    };
}

export async function inspectAgentRuntimeBaseImage(baseImage: string): Promise<AgentRuntimeBaseImageInspection> {
    if (!IMAGE_REFERENCE.test(baseImage)) throw new Error(`Invalid agent image reference: ${baseImage}`);
    const result = await executeDockerCommand('docker', [
        'image', 'inspect', baseImage, '--format', '{{.Id}}\t{{json .Config.User}}'
    ], { timeout: 30000 });
    if (result.exitCode !== 0) throw new Error(`Agent image ${baseImage} is not available: ${result.stderr.trim()}`);
    const [id, encodedUser = '""'] = result.stdout.trim().split('\t');
    let user = '';
    try {
        const parsed = JSON.parse(encodedUser) as unknown;
        user = typeof parsed === 'string' ? parsed : '';
    } catch { user = ''; }
    if (user && !SAFE_USER.test(user)) throw new Error(`Agent image ${baseImage} has an unsupported USER value`);
    const cached = baseImageInspectionCache.get(id);
    if (cached) return { ...cached, user };

    const environment = await executeDockerCommand('docker', [
        'run', '--rm', '--user', 'root', '--entrypoint', 'sh', baseImage, '-c',
        `set -eu
if command -v apt-get >/dev/null 2>&1; then
  echo apt
  cat /etc/os-release 2>/dev/null || true
  cat /etc/apt/sources.list /etc/apt/sources.list.d/* 2>/dev/null || true
elif command -v apk >/dev/null 2>&1; then
  echo apk
  cat /etc/os-release 2>/dev/null || true
  cat /etc/apk/repositories 2>/dev/null || true
else
  echo unsupported
  exit 3
fi`
    ], { timeout: 30000 });
    if (environment.exitCode !== 0) {
        throw new Error(`Agent image ${baseImage} does not provide a supported package manager (apt or apk)`);
    }
    const [managerLine, ...metadataLines] = environment.stdout.trim().split('\n');
    if (managerLine !== 'apt' && managerLine !== 'apk') {
        throw new Error(`Agent image ${baseImage} reported an unsupported package manager: ${managerLine || 'unknown'}`);
    }
    const metadata = metadataLines.join('\n');
    const prettyName = metadataLines.find(line => line.startsWith('PRETTY_NAME='))?.slice('PRETTY_NAME='.length);
    const inspection: AgentRuntimeBaseImageInspection = {
        id,
        user,
        packageManager: managerLine,
        packageSourceFingerprint: crypto.createHash('sha256').update(`${managerLine}\n${metadata}`).digest('hex').slice(0, 16),
        osName: prettyName?.replace(/^"|"$/g, '') || managerLine
    };
    baseImageInspectionCache.set(id, inspection);
    return inspection;
}

export function getAgentRuntimeImageTag(
    baseImage: string,
    baseImageId: string,
    packages: string[],
    installationId = 'shared'
): string {
    const baseName = baseImage.split('/').pop()?.split(':')[0]?.replace(/[^a-z0-9_.-]/gi, '-') || 'agent';
    const hash = crypto.createHash('sha256')
        .update(JSON.stringify({ installationId, baseImageId, packages }))
        .digest('hex')
        .slice(0, 16);
    return `propr/runtime-${baseName}:${hash}`;
}

export function buildAgentRuntimeDockerfile(
    baseImage: string,
    packages: string[],
    finalUser: string,
    packageManager: AgentRuntimePackageManager = 'apt'
): string {
    if (packageManager === 'apk') {
        const lines = [
            `FROM ${baseImage}`,
            'LABEL dev.propr.agent-runtime="true"',
            'USER root',
            `RUN apk add --no-cache ${packages.join(' ')}`
        ];
        if (finalUser) lines.push(`USER ${finalUser}`);
        return `${lines.join('\n')}\n`;
    }
    const packageLines = packages.map(packageSpec => `        ${packageSpec} \\`).join('\n');
    const restoreUser = finalUser ? `\nUSER ${finalUser}` : '';
    return `FROM ${baseImage}\nLABEL dev.propr.agent-runtime="true"\nUSER root\nRUN apt-get update \\\n    && apt-get install -y --no-install-recommends \\\n${packageLines}\n    && rm -rf /var/lib/apt/lists/*${restoreUser}\n`;
}

async function imageExists(image: string): Promise<boolean> {
    const result = await executeDockerCommand('docker', ['image', 'inspect', image], { timeout: 30000 });
    return result.exitCode === 0;
}

async function buildRuntimeImage(
    baseImage: string,
    packages: string[],
    installationId: string
): Promise<{ record: AgentRuntimeImageRecord; log: string }> {
    const { id: baseImageId, user, packageManager } = await inspectAgentRuntimeBaseImage(baseImage);
    const image = getAgentRuntimeImageTag(baseImage, baseImageId, packages, installationId);
    if (await imageExists(image)) {
        return {
            record: { baseImage, baseImageId, image, packageManager, builtAt: new Date().toISOString() },
            log: `${image} already exists locally`
        };
    }
    const result = await executeDockerCommand('docker', [
        'build', '--pull=false',
        '--label', `dev.propr.agent-runtime.installation=${installationId}`,
        '-t', image, '-'
    ], {
        timeout: 20 * 60 * 1000,
        stdinData: buildAgentRuntimeDockerfile(baseImage, packages, user, packageManager)
    });
    const log = `${result.stdout}\n${result.stderr}`.trim();
    if (result.exitCode !== 0) throw new Error(log || `Docker build exited with code ${result.exitCode}`);
    return {
        record: { baseImage, baseImageId, image, packageManager, builtAt: new Date().toISOString() },
        log
    };
}

async function cleanupRuntimeImages(
    previous: Record<string, AgentRuntimeImageRecord>,
    active: Record<string, AgentRuntimeImageRecord>,
    installationId: string
): Promise<void> {
    const activeTags = new Set(Object.values(active).map(record => record.image));
    const listed = await executeDockerCommand('docker', [
        'image', 'ls',
        '--filter', 'label=dev.propr.agent-runtime=true',
        '--filter', `label=dev.propr.agent-runtime.installation=${installationId}`,
        '--format', '{{.Repository}}:{{.Tag}}'
    ], { timeout: 30000 });
    const labelledTags = listed.exitCode === 0
        ? listed.stdout.split('\n').map(value => value.trim()).filter(value => value && !value.endsWith(':<none>'))
        : [];
    const staleTags = [...new Set([
        ...Object.values(previous).map(record => record.image),
        ...labelledTags
    ].filter(image => !activeTags.has(image)))];
    for (const image of staleTags) {
        const result = await executeDockerCommand('docker', ['image', 'rm', image], { timeout: 60000 });
        if (result.exitCode !== 0) {
            logger.debug({ image, error: result.stderr.trim() }, 'Could not remove superseded agent runtime image');
        }
    }
}

function tailBuildLog(log: string, maxLength = 20000): string {
    return log.length <= maxLength ? log : log.slice(log.length - maxLength);
}

function summarizeBuildError(message: string): string {
    const clean = message.replace(/\u001b\[[0-9;]*m/g, '');
    const lines = clean.split('\n').map(line => line.trim()).filter(Boolean);
    const preferredPatterns = [
        /unable to locate package/i,
        /no such package/i,
        /not found/i,
        /does not provide a supported package manager/i,
        /returned a non-zero code/i
    ];
    for (const pattern of preferredPatterns) {
        const line = [...lines].reverse().find(candidate => pattern.test(candidate));
        if (line) return line.slice(0, 500);
    }
    return (lines.at(-1) || 'Agent runtime image build failed').slice(0, 500);
}

export async function buildAgentRuntimePackageProfile(job: AgentRuntimeBuildJobData): Promise<AgentRuntimePackageState> {
    const validation = validateAgentRuntimePackages(job.packages);
    if (!validation.valid) throw new Error(validation.errors.join('; '));
    let current = await loadAgentRuntimePackageState();
    if (current.buildId !== job.buildId) {
        logger.info({ buildId: job.buildId, currentBuildId: current.buildId }, 'Skipping superseded agent runtime build');
        return current;
    }
    const installationId = job.installationId || current.installationId;

    current = {
        ...current,
        status: 'building',
        error: undefined,
        updatedAt: new Date().toISOString()
    };
    await saveAgentRuntimePackageState(current);

    if (validation.packages.length === 0) {
        const disabled: AgentRuntimePackageState = {
            ...current,
            activePackages: [],
            status: 'disabled',
            images: {},
            buildLog: 'Runtime package profile disabled',
            updatedAt: new Date().toISOString()
        };
        await saveAgentRuntimePackageState(disabled);
        await cleanupRuntimeImages(current.images, {}, installationId);
        return disabled;
    }

    const images: Record<string, AgentRuntimeImageRecord> = {};
    const logs: string[] = [];
    try {
        for (const baseImage of [...new Set(job.baseImages)].sort()) {
            const built = await buildRuntimeImage(baseImage, validation.packages, installationId);
            images[baseImage] = built.record;
            logs.push(`### ${baseImage}\n${built.log}`);
            const latest = await loadAgentRuntimePackageState();
            if (latest.buildId !== job.buildId) {
                await cleanupRuntimeImages(images, latest.images, installationId);
                return latest;
            }
        }
        const latest = await loadAgentRuntimePackageState();
        if (latest.buildId !== job.buildId) return latest;
        const ready: AgentRuntimePackageState = {
            ...latest,
            activePackages: validation.packages,
            status: 'ready',
            images,
            error: undefined,
            buildLog: tailBuildLog(logs.join('\n\n')),
            updatedAt: new Date().toISOString()
        };
        await saveAgentRuntimePackageState(ready);
        await cleanupRuntimeImages(current.images, images, installationId);
        return ready;
    } catch (error) {
        const latest = await loadAgentRuntimePackageState();
        if (latest.buildId !== job.buildId) return latest;
        const message = (error as Error).message;
        const failed: AgentRuntimePackageState = {
            ...latest,
            status: 'failed',
            error: summarizeBuildError(message),
            buildLog: tailBuildLog([...logs, message].join('\n\n')),
            updatedAt: new Date().toISOString()
        };
        await saveAgentRuntimePackageState(failed);
        throw error;
    }
}

export async function resolveAgentRuntimeImage(baseImage: string): Promise<string> {
    const state = await loadAgentRuntimePackageState();
    if (state.activePackages.length === 0) return baseImage;
    const activePackages = state.activePackages;
    const inspected = await inspectAgentRuntimeBaseImage(baseImage);
    const existing = state.images[baseImage];
    if (existing?.baseImageId === inspected.id && await imageExists(existing.image)) return existing.image;

    const built = await buildRuntimeImage(baseImage, activePackages, state.installationId);
    const latest = await loadAgentRuntimePackageState();
    if (latest.activePackages.join('\0') !== activePackages.join('\0')) {
        await cleanupRuntimeImages({ [baseImage]: built.record }, latest.images, state.installationId);
        return resolveAgentRuntimeImage(baseImage);
    }
    await saveAgentRuntimePackageState({
        ...latest,
        images: { ...latest.images, [baseImage]: built.record },
        buildLog: tailBuildLog([latest.buildLog, built.log].filter(Boolean).join('\n\n')),
        updatedAt: new Date().toISOString()
    });
    return built.record.image;
}
