import { describe, test } from 'node:test';
import assert from 'node:assert';
import { getPlanIssueDefaultSelection } from '../packages/core/src/config/planIssueDefaultSelection.ts';

describe('getPlanIssueDefaultSelection', () => {
    const agents = [
        {
            alias: 'claude-prod',
            enabled: true,
            supportedModels: ['claude-haiku-4-5'],
            defaultModel: 'claude-haiku-4-5'
        },
        {
            alias: 'codex-prod',
            enabled: true,
            supportedModels: ['gpt-5.4'],
            defaultModel: 'gpt-5.4'
        }
    ];

    test('returns the configured default implementation agent and model', () => {
        assert.deepStrictEqual(
            getPlanIssueDefaultSelection(agents, 'codex-prod', 'claude-prod'),
            {
                agent_alias: 'codex-prod',
                model_name: 'gpt-5.4'
            }
        );
    });

    test('falls back to the registry default agent and its first valid model when configured default is unavailable', () => {
        assert.deepStrictEqual(
            getPlanIssueDefaultSelection([
                {
                    alias: 'default',
                    enabled: true,
                    supportedModels: ['claude-sonnet-4-6']
                }
            ], 'missing-agent', 'default'),
            {
                agent_alias: 'default',
                model_name: 'claude-sonnet-4-6'
            }
        );
    });

    test('falls back to the first enabled agent when no configured or registry default is available', () => {
        assert.deepStrictEqual(
            getPlanIssueDefaultSelection(agents, null, null),
            {
                agent_alias: 'claude-prod',
                model_name: 'claude-haiku-4-5'
            }
        );
    });
});
