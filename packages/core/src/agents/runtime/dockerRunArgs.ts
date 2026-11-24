import { WORKSPACE_DIRECT_AGENT_LAUNCH, cloneRunStartsAsRoot } from '../../git/workspaceTransportScript.js';
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
 * Entrypoint and the arguments between the image and the provider CLI. A
 * clone-mode workspace adds its transport wrapper outside the repository
 * setup wrapper: `bash -lc <transport> <setup> <provider entrypoint> ...`.
 * Without a setup wrapper the transport wrapper starts the explicit
 * entrypoint as the unprivileged agent user itself.
 */
function renderEntrypoint(spec: AgentRunSpec): { entrypoint?: string; wrapperArgs: string[] } {
    const { repoSetup } = spec;
    const clone = spec.workspace.mode === 'clone' ? spec.workspace.clone : undefined;
    if (spec.workspace.mode === 'clone' && !clone) throw new Error(`Agent run ${spec.name} uses the clone workspace transport but was not prepared by it`);
    // The transport wrapper holds a repository token; it must not share a user ID with the agent.
    if (clone && !cloneRunStartsAsRoot(spec.user)) throw new Error(`Agent run ${spec.name} uses the clone workspace transport but does not start as root`);
    if (!clone) {
        return { entrypoint: repoSetup ? repoSetup.shell : spec.entrypoint, wrapperArgs: repoSetup ? ['-lc', repoSetup.script, repoSetup.providerEntrypoint] : [] };
    }
    if (repoSetup) {
        // The root-started provider entrypoint drops to the agent user only to run a command;
        // without one it opens a root shell next to the credential-holding wrapper.
        if (spec.args.length === 0) throw new Error(`Agent run ${spec.name} uses the clone workspace transport but gives its provider entrypoint no command to run as the agent user`);
        return { entrypoint: repoSetup.shell, wrapperArgs: ['-lc', clone.script, repoSetup.script, repoSetup.providerEntrypoint] };
    }
    if (!spec.entrypoint) throw new Error(`Agent run ${spec.name} needs an explicit entrypoint for the clone workspace transport`);
    return { entrypoint: '/bin/bash', wrapperArgs: ['-lc', clone.script, WORKSPACE_DIRECT_AGENT_LAUNCH, spec.entrypoint] };
}

/**
 * Render an {@link AgentRunSpec} to the `docker run` argv (without the
 * `docker` executable). Launch-time additions that belong to the Docker
 * transport — attempt labels, extension mounts, egress socket mounts and the
 * workflow deadline — are applied by the Docker executor afterwards.
 */
export function renderDockerRunArgs(spec: AgentRunSpec): string[] {
    const { security, repoSetup } = spec;
    const { entrypoint, wrapperArgs } = renderEntrypoint(spec);
    return [
        'run',
        ...(spec.resources ? renderDockerResourceArgs(spec.resources) : []),
        ...(repoSetup ? renderDockerEnvArgs(repoSetup.env) : []),
        // A clone-mode run is kept after it exits so its result files can be read; its handle removes it.
        ...(spec.workspace.mode === 'clone' ? [] : ['--rm']),
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
        ...wrapperArgs,
        ...spec.args,
    ];
}
