export interface DockerRootCommandResult {
    stdout: string;
    stderr: string;
    exitCode: number | null;
}

export type DockerRootExecutor = (
    command: string,
    args: string[],
    options?: { timeout?: number },
) => Promise<DockerRootCommandResult>;

export async function getDockerRootDir(executor?: DockerRootExecutor): Promise<string> {
    const commandExecutor = executor || (await import('./dockerExecutor.js')).executeDockerCommand as DockerRootExecutor;
    const result = await commandExecutor('docker', [
        'info', '--format', '{{.DockerRootDir}}',
    ], { timeout: 10_000 });
    const rootDir = result.stdout.trim();
    if (result.exitCode !== 0 || !rootDir || /[\r\n]/.test(rootDir)) {
        throw new Error(`Docker root directory could not be determined: ${result.stderr.trim() || 'docker info returned no usable DockerRootDir'}`);
    }
    return rootDir;
}
