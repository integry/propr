import { executeDockerCommand } from '../../claude/docker/dockerExecutor.js';
import { assertAgentImageBuildCapacity } from '../agentImageBuildCapacity.js';
import { withAgentImageBuildSlot } from '../agentImageBuildLock.js';
import type {
    AgentRuntimeBaseImageInspection,
    AgentRuntimeImageRecord,
} from './agentRuntimePackages.js';

async function imageExists(image: string): Promise<boolean> {
    const result = await executeDockerCommand('docker', ['image', 'inspect', image], { timeout: 30000 });
    return result.exitCode === 0;
}

export async function buildAgentRuntimeImage(options: {
    baseImage: string;
    packages: string[];
    installationId: string;
    inspection: AgentRuntimeBaseImageInspection;
    image: string;
    buildDockerfile: (baseImage: string, packages: string[], finalUser: string) => string;
}): Promise<{ record: AgentRuntimeImageRecord; log: string }> {
    const { baseImage, packages, installationId, inspection, image, buildDockerfile } = options;
    const { id: baseImageId, user, packageManager } = inspection;
    return withAgentImageBuildSlot(async () => {
        if (await imageExists(image)) {
            return {
                record: { baseImage, baseImageId, image, packageManager, builtAt: new Date().toISOString() },
                log: `${image} already exists locally`,
            };
        }
        await assertAgentImageBuildCapacity();
        const result = await executeDockerCommand('docker', [
            'build', '--pull=false',
            '--label', `dev.propr.agent-runtime.installation=${installationId}`,
            '-t', image, '-',
        ], {
            timeout: 20 * 60 * 1000,
            stdinData: buildDockerfile(baseImage, packages, user),
        });
        const log = `${result.stdout}\n${result.stderr}`.trim();
        if (result.exitCode !== 0) throw new Error(log || `Docker build exited with code ${result.exitCode}`);
        return {
            record: { baseImage, baseImageId, image, packageManager, builtAt: new Date().toISOString() },
            log,
        };
    });
}
