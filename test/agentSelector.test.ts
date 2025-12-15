
import { test, describe, beforeEach, mock } from 'node:test';
import assert from 'node:assert';
import { resolveAgentFromLabels } from '../packages/core/src/utils/agentSelector.js';
import { AgentRegistry } from '../packages/core/src/agents/AgentRegistry.js';
import type { Agent, AgentConfig, ResolvedAgent } from '../packages/core/src/agents/types.js';
import logger from '../packages/core/src/utils/logger.js';

// Mock Agents
const mockClaudeConfig: AgentConfig = {
    id: 'claude-prod-id',
    alias: 'claude-prod',
    type: 'claude',
    enabled: true,
    supportedModels: ['claude-opus', 'claude-sonnet'],
    defaultModel: 'claude-sonnet',
};

const mockGeminiConfig: AgentConfig = {
    id: 'gemini-prod-id',
    alias: 'gemini-prod',
    type: 'gemini',
    enabled: true,
    supportedModels: ['gemini-1.5-pro', 'gemini-1.5-flash'],
    defaultModel: 'gemini-1.5-pro',
};


const mockClaudeAgent: Agent = {
    config: mockClaudeConfig,
    executeTask: async () => ({
        result: 'success',
        speculative: false,
        conversationLog: [],
        rawOutput: '',
    }),
    generateSpeculativeCommit: async () => ({ commitMessage: '', files: [] }),
    analyze: async () => ({ analysis: '', summary: '' }),
};

const mockGeminiAgent: Agent = {
    config: mockGeminiConfig,
    executeTask: async () => ({
        result: 'success',
        speculative: false,
        conversationLog: [],
        rawOutput: '',
    }),
    generateSpeculativeCommit: async () => ({ commitMessage: '', files: [] }),
    analyze: async () => ({ analysis: '', summary: '' }),
};


describe('resolveAgentFromLabels', () => {
    beforeEach(() => {
        mock.reset();
    });

    test('Test Case 1: Label llm-claude-prod exists -> Returns correct agent and default model', () => {
        const registryInstance = AgentRegistry.getInstance();
        mock.method(registryInstance, 'getAgentByAlias', (alias: string) => {
            if (alias === 'claude-prod') {
                return mockClaudeAgent;
            }
            return undefined;
        });
        
        const labels = ['bug', 'llm-claude-prod'];
        const result = resolveAgentFromLabels(labels);

        assert.ok(result, 'Result should not be null');
        assert.strictEqual(result.agent, mockClaudeAgent, 'Should return the claude agent');
        assert.strictEqual(result.model, 'claude-sonnet', 'Should return the default model');
    });

    test('Test Case 2: Label llm-unknown -> Returns null', () => {
        const registryInstance = AgentRegistry.getInstance();
        const loggerMock = mock.method(logger, 'warn', () => {});
        mock.method(registryInstance, 'getAgentByAlias', (alias: string) => {
            return undefined;
        });
        
        const labels = ['bug', 'llm-unknown'];
        const result = resolveAgentFromLabels(labels);

        assert.strictEqual(result, null, 'Result should be null for unknown agent');
        assert.strictEqual(loggerMock.mock.callCount(), 1, 'Should log a warning');
    });

    test('Test Case 3: Label llm-claude-prod AND model-opus -> Returns agent with specific model', () => {
        const registryInstance = AgentRegistry.getInstance();
        mock.method(registryInstance, 'getAgentByAlias', (alias: string) => {
            if (alias === 'claude-prod') {
                return mockClaudeAgent;
            }
            return undefined;
        });
        
        const labels = ['feature', 'llm-claude-prod', 'model-claude-opus'];
        const result = resolveAgentFromLabels(labels);

        assert.ok(result, 'Result should not be null');
        assert.strictEqual(result.agent, mockClaudeAgent, 'Should return the claude agent');
        assert.strictEqual(result.model, 'claude-opus', 'Should return the specified model');
    });

    test('Test Case 4: Label llm-claude-prod AND model-invalid -> Returns agent with default model', () => {
        const registryInstance = AgentRegistry.getInstance();
        const loggerMock = mock.method(logger, 'warn', () => {});
        mock.method(registryInstance, 'getAgentByAlias', (alias: string) => {
            if (alias === 'claude-prod') {
                return mockClaudeAgent;
            }
            return undefined;
        });

        const labels = ['llm-claude-prod', 'model-invalid-model'];
        const result = resolveAgentFromLabels(labels);

        assert.ok(result, 'Result should not be null');
        assert.strictEqual(result.agent, mockClaudeAgent, 'Should return the claude agent');
        assert.strictEqual(result.model, 'claude-sonnet', 'Should return the default model');
        assert.strictEqual(loggerMock.mock.callCount(), 1, 'Should log a warning about invalid model');
    });

    test('Test Case 5: No labels -> Returns null', () => {
        const labels: string[] = ['bug', 'documentation'];
        const result = resolveAgentFromLabels(labels);
        assert.strictEqual(result, null, 'Result should be null when no llm label is present');
    });

    test('Comment Case: llm-gemini-prod -> returns gemini agent with default model', () => {
        const registryInstance = AgentRegistry.getInstance();
        mock.method(registryInstance, 'getAgentByAlias', (alias: string) => {
            if (alias === 'gemini-prod') {
                return mockGeminiAgent;
            }
            return undefined;
        });

        const labels = ['llm-gemini-prod'];
        const result = resolveAgentFromLabels(labels);
        assert.ok(result, 'Result should not be null');
        assert.strictEqual(result.agent, mockGeminiAgent, 'Should return the gemini agent');
        assert.strictEqual(result.model, 'gemini-1.5-pro', 'Should return the default model');
    });
});
