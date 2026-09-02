import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import type {
    NativeGoalContainer,
    NativeGoalContainerRuntime,
    NativeGoalContainerSpec,
    NativeGoalWorktree,
} from './nativeGoalTypes.js';
import { NativeGoalSessionError } from './nativeGoalErrors.js';
import { buildAgentContainerResourceArgs } from '../agentContainerResources.js';

const execFileAsync = promisify(execFile);

export interface NativeGoalCommandResult { stdout: string; stderr: string }
export type NativeGoalCommandExecutor = (command: string, args: string[]) => Promise<NativeGoalCommandResult>;
export type NativeGoalWorktreeVerifier = (worktree: NativeGoalWorktree) => Promise<void>;
export type NativeGoalContainerEnvironmentResolver = (
    spec: NativeGoalContainerSpec,
) => Promise<Record<string, string> | undefined> | Record<string, string> | undefined;

const defaultExecutor: NativeGoalCommandExecutor = async (command, args) => {
    const result = await execFileAsync(command, args, { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
    return { stdout: result.stdout, stderr: result.stderr };
};

/** Verify rather than mutate: a replacement must mount the exact persisted worktree/branch. */
export const verifyNativeGoalWorktree: NativeGoalWorktreeVerifier = async worktree => {
    const { stdout } = await execFileAsync('git', ['-C', worktree.hostPath, 'branch', '--show-current'], { encoding: 'utf8' });
    if (stdout.trim() !== worktree.branch) {
        throw new NativeGoalSessionError(
            `Goal worktree branch changed: expected '${worktree.branch}', found '${stdout.trim() || '(detached)'}'`,
        );
    }
};

interface DockerInspection {
    Id?: string;
    State?: { Running?: boolean };
    Config?: { Labels?: Record<string, string> };
}

function identityHash(spec: NativeGoalContainerSpec): string {
    return createHash('sha256').update(JSON.stringify({
        goalId: spec.goalId,
        provider: spec.provider,
        image: spec.image,
        worktree: spec.worktree,
        writableMounts: spec.writableMounts,
    })).digest('hex');
}

function containerName(spec: NativeGoalContainerSpec): string {
    const provider = spec.provider.toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').slice(0, 24) || 'agent';
    const goal = createHash('sha256').update(spec.goalId).digest('hex').slice(0, 16);
    return `propr-goal-${provider}-${goal}`;
}

/** Docker implementation of the durable goal-scoped container identity contract. */
export class DockerNativeGoalContainerRuntime implements NativeGoalContainerRuntime {
    constructor(
        private readonly execute: NativeGoalCommandExecutor = defaultExecutor,
        private readonly verifyWorktree: NativeGoalWorktreeVerifier = verifyNativeGoalWorktree,
        private readonly resolveEnvironment?: NativeGoalContainerEnvironmentResolver,
    ) {}

    async ensure(spec: NativeGoalContainerSpec, previous?: NativeGoalContainer): Promise<NativeGoalContainer> {
        this.validate(spec);
        await this.verifyWorktree(spec.worktree);
        for (const mount of spec.writableMounts) await fs.mkdir(mount.hostPath, { recursive: true, mode: 0o700 });

        const name = containerName(spec);
        const expectedHash = identityHash(spec);
        const inspection = await this.inspect(name);
        if (inspection) {
            const labels = inspection.Config?.Labels ?? {};
            if (labels['propr.goal.id'] !== spec.goalId
                || labels['propr.goal.provider'] !== spec.provider
                || labels['propr.goal.identity'] !== expectedHash) {
                throw new NativeGoalSessionError(`Container '${name}' is not owned by goal '${spec.goalId}'`);
            }
            if (inspection.State?.Running && inspection.Id) {
                return {
                    id: inspection.Id,
                    name,
                    generation: labels['propr.goal.generation'] ?? previous?.generation ?? 'legacy',
                    replaced: false,
                };
            }
            await this.execute('docker', ['rm', name]);
        }

        const generation = randomUUID();
        const environment = spec.environment ?? await this.resolveEnvironment?.(spec);
        const args = [
            'run', '-d',
            ...buildAgentContainerResourceArgs(),
            '--name', name,
            '--label', `propr.goal.id=${spec.goalId}`,
            '--label', `propr.goal.provider=${spec.provider}`,
            '--label', `propr.goal.identity=${expectedHash}`,
            '--label', `propr.goal.generation=${generation}`,
            '--security-opt', 'no-new-privileges',
            '--cap-add', 'CHOWN',
            '--network', 'bridge',
            '--user', '0:0',
            '-v', `${spec.worktree.hostPath}:${spec.worktree.containerPath}:rw`,
            ...spec.writableMounts.flatMap(mount => ['-v', `${mount.hostPath}:${mount.containerPath}:rw`]),
            ...Object.entries(environment ?? {}).flatMap(([key, value]) => ['-e', `${key}=${value}`]),
            '-w', spec.worktree.containerPath,
            spec.image,
            'sleep', 'infinity',
        ];
        const result = await this.execute('docker', args);
        const id = result.stdout.trim();
        if (!id) throw new NativeGoalSessionError(`Docker did not return an ID for goal container '${name}'`);
        return { id, name, generation, replaced: Boolean(previous || inspection) };
    }

    private async inspect(name: string): Promise<DockerInspection | null> {
        try {
            const result = await this.execute('docker', ['inspect', name]);
            const parsed = JSON.parse(result.stdout) as DockerInspection[];
            return parsed[0] ?? null;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (message.includes('No such object') || message.includes('No such container')) return null;
            throw error;
        }
    }

    private validate(spec: NativeGoalContainerSpec): void {
        if (!spec.goalId.trim() || !spec.provider.trim() || !spec.image.trim()) {
            throw new NativeGoalSessionError('Goal container identity fields must not be empty');
        }
        const containerTargets = new Set([spec.worktree.containerPath]);
        for (const mount of spec.writableMounts) {
            if (containerTargets.has(mount.containerPath)) {
                throw new NativeGoalSessionError(`Duplicate goal container mount '${mount.containerPath}'`);
            }
            containerTargets.add(mount.containerPath);
        }
    }
}
