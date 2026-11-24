import type { AgentRunEnvVar, AgentRunMount, AgentRunResources, AgentRunSpec } from './types.js';

/** A `--mount` field, CSV-quoted when it contains a comma or quote. */
export function dockerMountField(key: string, value: string): string {
    return /[",]/.test(value)
        ? `"${key}=${value.replace(/"/g, '""')}"`
        : `${key}=${value}`;
}

export function renderDockerResourceArgs(resources: AgentRunResources): string[] {
    return [
        ...(resources.init ? ['--init'] : []),
        '--memory', resources.memory,
        '--memory-swap', resources.memorySwap,
        '--cpus', resources.cpus,
        '--pids-limit', resources.pidsLimit,
    ];
}

export function renderDockerEnvArgs(variables: ReadonlyArray<Pick<AgentRunEnvVar, 'name' | 'value'>>): string[] {
    return variables.flatMap(variable => ['-e', variable.value === undefined ? variable.name : `${variable.name}=${variable.value}`]);
}

export function renderDockerMountArgs(mount: AgentRunMount): string[] {
    if (mount.type === 'tmpfs') return ['--tmpfs', `${mount.target}:${mount.options}`];
    if (mount.syntax === 'mount') {
        return ['--mount', [
            'type=bind', dockerMountField('source', mount.source), dockerMountField('target', mount.target),
            ...(mount.readOnly ? ['readonly'] : []),
        ].join(',')];
    }
    return ['-v', `${mount.source}:${mount.target}:${mount.readOnly ? 'ro' : 'rw'}`];
}

/** Mounts, variables and env files in the order the provider declared them. */
function renderOrderedContainerOptions(spec: AgentRunSpec): string[] {
    const entries: Array<{ order: number; args: string[] }> = [
        ...spec.mounts.map(mount => ({ order: mount.order, args: renderDockerMountArgs(mount) })),
        ...spec.env.map(variable => ({ order: variable.order, args: renderDockerEnvArgs([variable]) })),
        ...spec.envFiles.map(file => ({ order: file.order, args: ['--env-file', file.path] })),
    ];
    return entries.sort((a, b) => a.order - b.order).flatMap(entry => entry.args);
}

function renderLabelArgs(labels: Record<string, string>): string[] {
    return Object.entries(labels).flatMap(([key, value]) => ['--label', `${key}=${value}`]);
}

/**
 * Render an {@link AgentRunSpec} to the `docker run` argv (without the
 * `docker` executable). Launch-time additions that belong to the Docker
 * transport — attempt labels, extension mounts, egress socket mounts and the
 * workflow deadline — are applied by the Docker executor afterwards.
 */
export function renderDockerRunArgs(spec: AgentRunSpec): string[] {
    const { security, repoSetup } = spec;
    const entrypoint = repoSetup ? repoSetup.shell : spec.entrypoint;
    return [
        'run',
        ...(spec.resources ? renderDockerResourceArgs(spec.resources) : []),
        ...(repoSetup ? renderDockerEnvArgs(repoSetup.env) : []),
        '--rm',
        ...(spec.stdin ? ['-i'] : []),
        '--name', spec.name,
        ...renderLabelArgs(spec.labels),
        ...(security.noNewPrivileges ? ['--security-opt', 'no-new-privileges'] : []),
        ...security.securityOpts.flatMap(option => ['--security-opt', option]),
        ...security.capAdd.flatMap(capability => ['--cap-add', capability]),
        '--network', spec.network.name,
        ...(spec.user ? ['--user', spec.user] : []),
        ...(security.readOnlyRootFilesystem ? ['--read-only'] : []),
        ...security.capDrop.map(capability => `--cap-drop=${capability}`),
        ...renderOrderedContainerOptions(spec),
        '-w', spec.workdir,
        ...(entrypoint ? ['--entrypoint', entrypoint] : []),
        spec.profile.image,
        ...(repoSetup ? ['-lc', repoSetup.script, repoSetup.providerEntrypoint] : []),
        ...spec.args,
    ];
}
