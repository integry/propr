import crypto from 'node:crypto';
import fs from 'node:fs';
import type { AgentConfig } from '../../agents/types.js';
import { buildAgentContainerResourceArgs } from '../../agents/agentContainerResources.js';
import { executeDockerCommand, type DockerCommandOptions } from '../../claude/docker/dockerExecutor.js';
import { resolveConfigPath } from '../../config/configManager.js';
import type { GoalRuntimeExecution } from './goalRuntimeTypes.js';

export type GoalDockerExecutor = (
  command: string,
  args: string[],
  options?: DockerCommandOptions
) => ReturnType<typeof executeDockerCommand>;

export interface GoalDockerContainer {
  id: string;
  name: string;
}

const CONFIG_TARGETS: Record<AgentConfig['type'], string> = {
  claude: '/home/node/.claude',
  codex: '/home/node/.codex',
  antigravity: '/home/node/.gemini',
  opencode: '/home/node/.config/opencode',
  vibe: '/home/node/.vibe',
};

export class GoalDockerContainerManager {
  constructor(private readonly execute: GoalDockerExecutor = executeDockerCommand) {}

  async ensure(
    execution: GoalRuntimeExecution,
    config: AgentConfig,
    githubToken: string
  ): Promise<GoalDockerContainer> {
    const existing = await this.inspect(execution.executionId);
    if (existing) return existing;
    const name = containerName(execution.executionId, config.type);
    const configPath = resolveConfigPath(config.configPath);
    if (!fs.existsSync(execution.workspace.worktreePath)) {
      throw new Error(`Persisted goal worktree is missing: ${execution.workspace.worktreePath}`);
    }
    if (!fs.existsSync(configPath)) throw new Error(`Agent configuration path is missing: ${configPath}`);
    const result = await this.execute('docker', [
      'run', '-d', ...buildAgentContainerResourceArgs(), '--name', name,
      '--label', `propr.goal.execution=${execution.executionId}`,
      '--label', `propr.goal.id=${execution.goalId}`,
      '--label', `propr.goal.agent=${config.type}`,
      '--security-opt', 'no-new-privileges', '--cap-add', 'CHOWN', '--network', 'bridge',
      '--user', '0:0',
      '-v', `${execution.workspace.worktreePath}:/home/node/workspace:rw`,
      '-v', `${configPath}:${CONFIG_TARGETS[config.type]}:rw`,
      '-e', `GH_TOKEN=${githubToken}`, '-e', `GITHUB_TOKEN=${githubToken}`,
      ...Object.entries(config.envVars ?? {}).flatMap(([key, value]) => ['-e', `${key}=${value}`]),
      '-w', '/home/node/workspace', config.dockerImage, 'sleep', 'infinity',
    ], { timeout: 60_000 });
    if (result.exitCode !== 0 || !result.stdout.trim()) {
      throw new Error(`Failed to create native goal container: ${result.stderr}`);
    }
    return { id: result.stdout.trim(), name };
  }

  async signal(containerId: string, signal: 'INT' | 'TERM'): Promise<void> {
    const result = await this.execute('docker', [
      'exec', containerId, '/bin/sh', '-c', `pkill -${signal} -f 'claude|codex|agy' || true`,
    ], { timeout: 10_000 });
    if (result.exitCode !== 0) throw new Error(`Failed to signal goal runtime: ${result.stderr}`);
  }

  async terminate(containerId: string): Promise<void> {
    const result = await this.execute('docker', ['stop', '--time', '5', containerId], { timeout: 10_000 });
    if (result.exitCode !== 0 && !result.stderr.includes('No such container')) {
      throw new Error(`Failed to terminate goal container: ${result.stderr}`);
    }
  }

  executeInContainer(
    containerId: string,
    args: string[],
    options: DockerCommandOptions = {}
  ) {
    return this.execute('docker', ['exec', '-i', containerId, ...args], options);
  }

  private async inspect(executionId: string): Promise<GoalDockerContainer | null> {
    const result = await this.execute('docker', [
      'ps', '-a', '--filter', `label=propr.goal.execution=${executionId}`,
      '--format', '{{.ID}}:{{.Names}}:{{.State}}',
    ], { timeout: 10_000 });
    if (result.exitCode !== 0) throw new Error(`Failed to inspect goal container: ${result.stderr}`);
    const line = result.stdout.split('\n').map(value => value.trim()).find(Boolean);
    if (!line) return null;
    const [id, name, state] = line.split(':');
    if (!id || !name) throw new Error('Malformed Docker goal container inspection');
    if (state !== 'running') throw new Error(`Persisted goal container '${name}' is not running`);
    return { id, name };
  }
}

function containerName(executionId: string, provider: string): string {
  const digest = crypto.createHash('sha256').update(executionId).digest('hex').slice(0, 20);
  return `propr-goal-${provider}-${digest}`;
}
