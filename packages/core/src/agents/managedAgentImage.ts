import logger from '../utils/logger.js';
import { executeDockerCommand } from '../claude/docker/dockerExecutor.js';
import { AGENT_TYPES } from './constants.js';
import { managedAgentVersionDifferences, readManagedAgentPin, type ManagedAgentPin } from './managedAgentPin.js';
import type { AgentCliVersionMatrix } from './version/versionService.js';

/** Mirrors the release verification in apps/desktop/scripts/desktop-runtime-manifest.mjs. */
const IMAGE_SOURCE = 'https://github.com/integry/propr';
const MANAGED_AGENT_PLATFORM = 'linux/amd64';
const pendingPulls = new Map<string, Promise<string | null>>();
const reportedDifferences = new Set<string>();

interface ManagedAgentImageResolution {
    image?: string;
    imageTag: string;
    error?: string;
}

interface InspectedImage {
    platform: string;
    labels: Record<string, string>;
}

// `docker images -q` cannot match a repo:tag@digest reference, so presence
// and metadata both come from inspecting the exact pinned reference.
async function inspectPinnedImage(image: string): Promise<InspectedImage | null> {
    const result = await executeDockerCommand('docker', [
        'image', 'inspect', '--format', '{{.Os}}/{{.Architecture}}\t{{json .Config.Labels}}', image,
    ], { timeout: 30000 });
    if (result.exitCode !== 0) return null;
    const [platform = '', encodedLabels = 'null'] = result.stdout.trim().split('\t');
    try {
        const labels = JSON.parse(encodedLabels) as unknown;
        return { platform, labels: labels && typeof labels === 'object' ? labels as Record<string, string> : {} };
    } catch {
        return { platform, labels: {} };
    }
}

/** Pull by digest at most once per process at a time; returns the failure, if any. */
function pullPinnedImage(image: string): Promise<string | null> {
    const pending = pendingPulls.get(image);
    if (pending) return pending;
    const pull = executeDockerCommand('docker', ['pull', image], { timeout: 10 * 60 * 1000 })
        .then(result => result.exitCode === 0 ? null
            : [result.stderr, result.stdout].map(stream => stream?.trim()).filter(Boolean).join('\n') || `exit code ${result.exitCode}`)
        .catch((error: Error) => error.message)
        .finally(() => pendingPulls.delete(image));
    pendingPulls.set(image, pull);
    return pull;
}

function verificationFailure(pin: ManagedAgentPin, inspected: InspectedImage, versions: AgentCliVersionMatrix): string | null {
    const { labels } = inspected;
    if (inspected.platform !== MANAGED_AGENT_PLATFORM) return `platform ${inspected.platform || 'unknown'} is not ${MANAGED_AGENT_PLATFORM}`;
    if (labels['dev.propr.agent-bundle'] !== 'true') return 'it is not a unified agent bundle';
    if (labels['org.opencontainers.image.source'] !== IMAGE_SOURCE) return 'its source label does not name the ProPR repository';
    if (labels['org.opencontainers.image.revision'] !== pin.sourceRevision) return `its revision label does not match ${pin.sourceRevision}`;
    const mismatched = AGENT_TYPES.filter(type => labels[`dev.propr.agent.${type}.version`] !== versions[type]);
    return mismatched.length ? `its CLI version labels do not match the configured ${mismatched.join(', ')} versions` : null;
}

/**
 * Resolves the published managed agent image for a Desktop runtime. Returns
 * null when no pin is bound or the configured CLI matrix legitimately needs a
 * generated bundle, so callers keep their existing behavior. A matching pin is
 * only ever pulled by digest (worker-owned path) and verified; it is never
 * rebuilt or retagged, and a failed verification is reported, not bypassed.
 */
export async function resolveManagedAgentImage(
    versions: AgentCliVersionMatrix,
    prepareImages: boolean,
): Promise<ManagedAgentImageResolution | null> {
    const pin = readManagedAgentPin();
    if (!pin) return null;
    const differences = managedAgentVersionDifferences(versions);
    if (differences.length) {
        const key = differences.map(type => `${type}=${versions[type]}`).join(',');
        if (!reportedDifferences.has(key)) {
            reportedDifferences.add(key);
            logger.info({ managedAgentImage: pin.image, customVersions: Object.fromEntries(differences.map(type => [type, versions[type]])) },
                'Configured agent CLI versions differ from the published managed agent image; a derived agent image is required. '
                + 'Set those agents to the default CLI version to use the published image instead.');
        }
        return null;
    }

    let inspected = await inspectPinnedImage(pin.image);
    if (!inspected && prepareImages) {
        const pullError = await pullPinnedImage(pin.image);
        if (pullError) return { imageTag: pin.image, error: `Managed agent image ${pin.image} could not be pulled: ${pullError}` };
        inspected = await inspectPinnedImage(pin.image);
    }
    if (!inspected) {
        return { imageTag: pin.image, error: `Managed agent image ${pin.image} has not been prepared by the worker` };
    }
    const failure = verificationFailure(pin, inspected, versions);
    if (failure) return { imageTag: pin.image, error: `Managed agent image ${pin.image} failed verification: ${failure}` };
    return { image: pin.image, imageTag: pin.image };
}
