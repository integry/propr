import { executeDockerCommand, type ExecutionResult } from '../../claude/docker/dockerExecutor.js';
import {
    getAgentRuntimeImageTag,
    validateAgentRuntimePackages,
    type AgentRuntimePackageState
} from './agentRuntimePackages.js';
import {
    validateAgentRuntimePackageAvailability,
    type AgentRuntimePackageAvailabilityResult
} from './agentRuntimePackageCatalog.js';

const DEFAULT_VERIFY_COMMAND_TIMEOUT_MS = 30_000;
const MISSING_IMAGE = /no such (?:image|object)|not found/i;

export type AgentRuntimeVerificationStatus = 'healthy' | 'unhealthy' | 'disabled';

export type AgentRuntimeVerificationIssueCode =
    | 'invalid_configuration'
    | 'catalog_validation_failed'
    | 'desired_active_drift'
    | 'base_image_missing'
    | 'base_image_inspection_failed'
    | 'base_image_inspection_timeout'
    | 'stale_base_image_lineage'
    | 'image_record_missing'
    | 'derived_image_missing'
    | 'derived_image_inspection_failed'
    | 'derived_image_inspection_timeout'
    | 'derived_image_tag_mismatch'
    | 'resolved_image_mismatch'
    | 'runtime_label_mismatch'
    | 'installation_label_mismatch'
    | 'final_user_mismatch'
    | 'non_root_user_required'
    | 'package_check_failed'
    | 'package_check_timeout'
    | 'package_missing'
    | 'package_version_mismatch';

export interface AgentRuntimeVerificationIssue {
    code: AgentRuntimeVerificationIssueCode;
    message: string;
    package?: string;
    expected?: string;
    actual?: string;
}

export interface AgentRuntimePackageCheck {
    package: string;
    name: string;
    installed: boolean;
    expectedVersion?: string;
    actualVersion?: string;
    healthy: boolean;
}

export interface AgentRuntimeImageVerification {
    baseImage: string;
    currentBaseImageId?: string;
    recordedBaseImageId?: string;
    expectedImage?: string;
    recordedImage?: string;
    resolvedImage: string;
    finalUser?: string;
    expectedFinalUser?: string;
    labels?: Record<string, string>;
    packages: AgentRuntimePackageCheck[];
    issues: AgentRuntimeVerificationIssue[];
    healthy: boolean;
}

export interface AgentRuntimePackageVerificationResult {
    status: AgentRuntimeVerificationStatus;
    healthy: boolean;
    disabled: boolean;
    checkedAt: string;
    desiredPackages: string[];
    activePackages: string[];
    desiredActiveDrift: boolean;
    configurationValid: boolean;
    configurationErrors: string[];
    issues: AgentRuntimeVerificationIssue[];
    images: AgentRuntimeImageVerification[];
    remediation?: string;
}

type DockerExecutor = typeof executeDockerCommand;

export interface AgentRuntimePackageVerificationOptions {
    executeDocker?: DockerExecutor;
    validateAvailability?: (
        packages: unknown,
        baseImages: string[]
    ) => Promise<AgentRuntimePackageAvailabilityResult>;
    commandTimeoutMs?: number;
}

interface ImageMetadata {
    id: string;
    user: string;
    labels: Record<string, string>;
}

function issue(
    code: AgentRuntimeVerificationIssueCode,
    message: string,
    details: Partial<Pick<AgentRuntimeVerificationIssue, 'package' | 'expected' | 'actual'>> = {}
): AgentRuntimeVerificationIssue {
    return { code, message, ...details };
}

function samePackages(left: string[], right: string[]): boolean {
    return left.length === right.length && left.every((value, index) => value === right[index]);
}

function commandError(result: ExecutionResult): string {
    return `${result.stderr}\n${result.stdout}`.trim() || `Docker exited with code ${result.exitCode ?? 'unknown'}`;
}

function parseJsonString(value: string): string {
    try {
        const parsed = JSON.parse(value) as unknown;
        return typeof parsed === 'string' ? parsed : '';
    } catch {
        return '';
    }
}

function parseLabels(value: string): Record<string, string> {
    try {
        const parsed = JSON.parse(value) as unknown;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
        return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
    } catch {
        return {};
    }
}

function parseImageMetadata(stdout: string): ImageMetadata | undefined {
    const [encodedId, encodedUser, encodedLabels] = stdout.trim().split('\t');
    if (!encodedId || encodedUser === undefined || encodedLabels === undefined) return undefined;
    const id = parseJsonString(encodedId);
    if (!id) return undefined;
    return { id, user: parseJsonString(encodedUser), labels: parseLabels(encodedLabels) };
}

async function inspectImage(
    image: string,
    executeDocker: DockerExecutor,
    timeout: number
): Promise<{ result: ExecutionResult; metadata?: ImageMetadata }> {
    const result = await executeDocker('docker', [
        'image', 'inspect', image,
        '--format', '{{json .Id}}\t{{json .Config.User}}\t{{json .Config.Labels}}'
    ], { timeout });
    return { result, metadata: result.exitCode === 0 ? parseImageMetadata(result.stdout) : undefined };
}

function packageParts(packageSpec: string): { name: string; expectedVersion?: string } {
    const separator = packageSpec.indexOf('=');
    return separator === -1
        ? { name: packageSpec }
        : { name: packageSpec.slice(0, separator), expectedVersion: packageSpec.slice(separator + 1) };
}

const PACKAGE_QUERY_SCRIPT = `set -u
if ! command -v dpkg-query >/dev/null 2>&1; then
  echo "dpkg-query is unavailable" >&2
  exit 4
fi
for package_name do
  if record="$(dpkg-query -W -f='\${Status}|\${Version}' -- "$package_name" 2>/dev/null)"; then
    status="\${record%|*}"
    version="\${record##*|}"
    if [ "$status" = "install ok installed" ]; then
      printf '%s|%s\n' "$package_name" "$version"
      continue
    fi
  fi
  printf '%s|\n' "$package_name"
done`;

function parseInstalledPackages(stdout: string): Map<string, string> {
    const installed = new Map<string, string>();
    for (const line of stdout.split('\n')) {
        const separator = line.indexOf('|');
        if (separator < 1) continue;
        installed.set(line.slice(0, separator), line.slice(separator + 1));
    }
    return installed;
}

function inspectionFailure(
    result: ExecutionResult,
    target: 'base' | 'derived',
    image: string
): AgentRuntimeVerificationIssue {
    if (result.timedOut) {
        return issue(
            target === 'base' ? 'base_image_inspection_timeout' : 'derived_image_inspection_timeout',
            `Timed out while inspecting ${target} image ${image}`
        );
    }
    const error = commandError(result);
    if (MISSING_IMAGE.test(error)) {
        return issue(
            target === 'base' ? 'base_image_missing' : 'derived_image_missing',
            `${target === 'base' ? 'Base' : 'Derived'} image ${image} is not available locally`
        );
    }
    return issue(
        target === 'base' ? 'base_image_inspection_failed' : 'derived_image_inspection_failed',
        `Could not inspect ${target} image ${image}: ${error}`
    );
}

// This is deliberately a single read-only verification state machine so every
// early Docker failure returns the diagnostics accumulated up to that point.
// eslint-disable-next-line complexity
async function verifyImage(baseImage: string, context: {
    state: AgentRuntimePackageState;
    configuredPackages: string[];
    executeDocker: DockerExecutor;
    timeout: number;
}): Promise<AgentRuntimeImageVerification> {
    const { state, configuredPackages, executeDocker, timeout } = context;
    const record = state.images[baseImage];
    const result: AgentRuntimeImageVerification = {
        baseImage,
        recordedBaseImageId: record?.baseImageId,
        recordedImage: record?.image,
        resolvedImage: baseImage,
        packages: [],
        issues: [],
        healthy: false
    };

    let baseInspection: Awaited<ReturnType<typeof inspectImage>>;
    try {
        baseInspection = await inspectImage(baseImage, executeDocker, timeout);
    } catch (error) {
        result.issues.push(issue('base_image_inspection_failed', `Could not inspect base image ${baseImage}: ${(error as Error).message}`));
        return result;
    }
    if (baseInspection.result.exitCode !== 0 || !baseInspection.metadata) {
        result.issues.push(baseInspection.result.exitCode !== 0
            ? inspectionFailure(baseInspection.result, 'base', baseImage)
            : issue('base_image_inspection_failed', `Docker returned invalid metadata for base image ${baseImage}`));
        return result;
    }

    const baseMetadata = baseInspection.metadata;
    result.currentBaseImageId = baseMetadata.id;
    result.expectedFinalUser = baseMetadata.user;
    result.expectedImage = state.activePackages.length === 0
        ? baseImage
        : getAgentRuntimeImageTag(baseImage, baseMetadata.id, state.activePackages, state.installationId);
    if (!baseMetadata.user || ['0', 'root'].includes(baseMetadata.user.split(':', 1)[0])) {
        result.issues.push(issue('non_root_user_required', `Base image ${baseImage} does not declare the expected non-root final user`, {
            expected: 'non-root user', actual: baseMetadata.user || '(empty)'
        }));
    }
    if (!record) {
        result.issues.push(issue('image_record_missing', `No runtime image is recorded for current base image ${baseImage}`));
        return result;
    }
    if (record.baseImageId !== baseMetadata.id) {
        result.issues.push(issue('stale_base_image_lineage', `Base image ${baseImage} was replaced after the runtime image was built`, {
            expected: baseMetadata.id, actual: record.baseImageId
        }));
    }
    if (record.image !== result.expectedImage) {
        result.issues.push(issue('derived_image_tag_mismatch', `Recorded runtime image tag does not match the current active profile for ${baseImage}`, {
            expected: result.expectedImage, actual: record.image
        }));
    }

    let derivedInspection: Awaited<ReturnType<typeof inspectImage>>;
    try {
        derivedInspection = await inspectImage(record.image, executeDocker, timeout);
    } catch (error) {
        result.issues.push(issue('derived_image_inspection_failed', `Could not inspect derived image ${record.image}: ${(error as Error).message}`));
        return result;
    }
    if (derivedInspection.result.exitCode !== 0 || !derivedInspection.metadata) {
        result.issues.push(derivedInspection.result.exitCode !== 0
            ? inspectionFailure(derivedInspection.result, 'derived', record.image)
            : issue('derived_image_inspection_failed', `Docker returned invalid metadata for derived image ${record.image}`));
        return result;
    }

    const derivedMetadata = derivedInspection.metadata;
    result.finalUser = derivedMetadata.user;
    result.labels = derivedMetadata.labels;
    // This is the exact non-building decision used by resolveAgentRuntimeImage.
    result.resolvedImage = state.activePackages.length > 0 && record.baseImageId === baseMetadata.id
        ? record.image
        : baseImage;
    if (result.resolvedImage !== result.expectedImage) {
        result.issues.push(issue('resolved_image_mismatch', `Execution does not currently resolve the expected runtime image for ${baseImage}`, {
            expected: result.expectedImage, actual: result.resolvedImage
        }));
    }
    if (derivedMetadata.labels['dev.propr.agent-runtime'] !== 'true') {
        result.issues.push(issue('runtime_label_mismatch', `Derived image ${record.image} is missing the ProPR runtime label`, {
            expected: 'true', actual: derivedMetadata.labels['dev.propr.agent-runtime'] || '(missing)'
        }));
    }
    if (derivedMetadata.labels['dev.propr.agent-runtime.installation'] !== state.installationId) {
        result.issues.push(issue('installation_label_mismatch', `Derived image ${record.image} has the wrong ProPR installation label`, {
            expected: state.installationId,
            actual: derivedMetadata.labels['dev.propr.agent-runtime.installation'] || '(missing)'
        }));
    }
    if (derivedMetadata.user !== baseMetadata.user) {
        result.issues.push(issue('final_user_mismatch', `Derived image ${record.image} does not preserve the base image final user`, {
            expected: baseMetadata.user || '(empty)', actual: derivedMetadata.user || '(empty)'
        }));
    }
    if (!derivedMetadata.user || ['0', 'root'].includes(derivedMetadata.user.split(':', 1)[0])) {
        result.issues.push(issue('non_root_user_required', `Derived image ${record.image} does not use a non-root final user`, {
            expected: 'non-root user', actual: derivedMetadata.user || '(empty)'
        }));
    }

    const names = configuredPackages.map(packageSpec => packageParts(packageSpec).name);
    let packageResult: ExecutionResult;
    try {
        packageResult = await executeDocker('docker', [
            'run', '--rm', '--network', 'none', '--entrypoint', 'sh', record.image,
            '-c', PACKAGE_QUERY_SCRIPT, 'propr-runtime-verify', ...names
        ], { timeout });
    } catch (error) {
        result.issues.push(issue('package_check_failed', `Could not check packages in ${record.image}: ${(error as Error).message}`));
        return result;
    }
    if (packageResult.exitCode !== 0) {
        result.issues.push(issue(
            packageResult.timedOut ? 'package_check_timeout' : 'package_check_failed',
            packageResult.timedOut
                ? `Timed out while checking packages in ${record.image}`
                : `Could not check packages in ${record.image}: ${commandError(packageResult)}`
        ));
        return result;
    }

    const installed = parseInstalledPackages(packageResult.stdout);
    result.packages = configuredPackages.map(packageSpec => {
        const { name, expectedVersion } = packageParts(packageSpec);
        const actualVersion = installed.get(name) || undefined;
        const packageCheck: AgentRuntimePackageCheck = {
            package: packageSpec,
            name,
            installed: Boolean(actualVersion),
            expectedVersion,
            actualVersion,
            healthy: Boolean(actualVersion) && (!expectedVersion || actualVersion === expectedVersion)
        };
        if (!actualVersion) {
            result.issues.push(issue('package_missing', `${packageSpec} is not installed in ${record.image}`, { package: packageSpec }));
        } else if (expectedVersion && actualVersion !== expectedVersion) {
            result.issues.push(issue('package_version_mismatch', `${name} has version ${actualVersion}, expected ${expectedVersion}`, {
                package: packageSpec, expected: expectedVersion, actual: actualVersion
            }));
        }
        return packageCheck;
    });
    result.healthy = result.issues.length === 0;
    return result;
}

/**
 * Read-only verification of the configured package profile and every base
 * image the agent registry currently resolves. Docker operations are limited
 * to image inspection and a network-disabled, automatically removed container.
 */
export async function verifyAgentRuntimePackageProfile(
    state: AgentRuntimePackageState,
    baseImages: string[],
    options: AgentRuntimePackageVerificationOptions = {}
): Promise<AgentRuntimePackageVerificationResult> {
    const checkedAt = new Date().toISOString();
    const syntax = validateAgentRuntimePackages(state.packages);
    const activeSyntax = validateAgentRuntimePackages(state.activePackages);
    const desiredPackages = syntax.packages;
    const activePackages = activeSyntax.packages;
    const disabled = desiredPackages.length === 0 && activePackages.length === 0;
    if (disabled) {
        return {
            status: 'disabled', healthy: true, disabled: true, checkedAt,
            desiredPackages, activePackages, desiredActiveDrift: false,
            configurationValid: syntax.valid && activeSyntax.valid,
            configurationErrors: [...syntax.errors, ...activeSyntax.errors],
            issues: [], images: []
        };
    }

    const globalIssues: AgentRuntimeVerificationIssue[] = [];
    const configurationErrors = [...syntax.errors];
    if (!activeSyntax.valid) configurationErrors.push(...activeSyntax.errors.map(error => `active profile: ${error}`));
    const desiredActiveDrift = !samePackages(desiredPackages, activePackages);
    if (desiredActiveDrift) {
        globalIssues.push(issue('desired_active_drift', 'Desired runtime packages differ from the active image profile'));
    }

    if (syntax.valid && desiredPackages.length > 0) {
        try {
            const availability = await (options.validateAvailability || validateAgentRuntimePackageAvailability)(desiredPackages, baseImages);
            if (!availability.valid) configurationErrors.push(...availability.errors);
        } catch (error) {
            configurationErrors.push(`Package catalog validation could not be completed: ${(error as Error).message}`);
            globalIssues.push(issue('catalog_validation_failed', configurationErrors.at(-1) as string));
        }
    }
    if (configurationErrors.length > 0) {
        globalIssues.push(issue('invalid_configuration', configurationErrors.join('; ')));
    }

    const executeDocker = options.executeDocker || executeDockerCommand;
    const timeout = options.commandTimeoutMs || DEFAULT_VERIFY_COMMAND_TIMEOUT_MS;
    const uniqueBaseImages = [...new Set(baseImages.filter(Boolean))].sort();
    const images = await Promise.all(uniqueBaseImages.map(baseImage => verifyImage(baseImage, {
        state, configuredPackages: desiredPackages, executeDocker, timeout
    })));
    const healthy = globalIssues.length === 0 && images.length > 0 && images.every(imageResult => imageResult.healthy);
    return {
        status: healthy ? 'healthy' : 'unhealthy',
        healthy,
        disabled: false,
        checkedAt,
        desiredPackages,
        activePackages,
        desiredActiveDrift,
        configurationValid: configurationErrors.length === 0,
        configurationErrors,
        issues: globalIssues,
        images,
        remediation: healthy ? undefined : 'Run `propr runtime packages apply --wait`, then verify again.'
    };
}
