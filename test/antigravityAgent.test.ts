import { after, describe, test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeConnection } from '../packages/core/src/db/connection.js';
import { AntigravityAgent } from '../packages/core/src/agents/impl/AntigravityAgent.js';
import type { AgentConfig } from '../packages/core/src/agents/types.js';

process.env.NODE_ENV = 'test';

after(async () => {
    await closeConnection();
});

function createAgent(configPath: string): AntigravityAgent {
    const config: AgentConfig = {
        id: 'antigravity-test',
        type: 'antigravity',
        alias: 'antigravity',
        enabled: true,
        dockerImage: 'propr/agent-antigravity:latest',
        configPath,
        supportedModels: ['antigravity-gemini-3.5-flash-high'],
        defaultModel: 'antigravity-gemini-3.5-flash-high'
    };
    return new AntigravityAgent(config);
}

describe('AntigravityAgent Docker args', () => {
    test('mounts sibling .gemini auth directory when legacy .antigravity config is configured', () => {
        const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'propr-antigravity-home-'));
        const legacyPath = path.join(tempHome, '.antigravity');
        const geminiPath = path.join(tempHome, '.gemini');
        fs.mkdirSync(legacyPath, { recursive: true });
        fs.mkdirSync(geminiPath, { recursive: true });

        try {
            const agent = createAgent(legacyPath);
            const args = (agent as unknown as {
                buildDockerArgs(params: {
                    worktreePath: string;
                    githubToken: string;
                    modelName?: string;
                    issueNumber: number;
                }): string[];
            }).buildDockerArgs({
                worktreePath: '/tmp/worktree',
                githubToken: '',
                modelName: 'antigravity-gemini-3.5-flash-high',
                issueNumber: 42
            });

            assert.ok(args.includes(`${geminiPath}:/home/node/.gemini:rw`));
            assert.ok(!args.includes(`${legacyPath}:/home/node/.gemini:rw`));
        } finally {
            fs.rmSync(tempHome, { recursive: true, force: true });
        }
    });
});
