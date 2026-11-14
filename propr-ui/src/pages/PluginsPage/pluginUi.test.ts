import { describe, expect, it } from 'vitest';
import { describePluginContributions, pluginBadge, safeHttpsUrl, secretAcknowledgementText } from './pluginUi';
import { exampleAt, examplePlugin } from './pluginFixtures.testUtils';

describe('plugin page helpers', () => {
  it('follows each step with the state badge', () => {
    expect(pluginBadge(examplePlugin())).toBe('not_installed');
    expect(pluginBadge(exampleAt('installed'))).toBe('needs_connection');
    expect(pluginBadge(exampleAt('connected'))).toBe('off');
    expect(pluginBadge(exampleAt('enabled'))).toBe('enabled');
    const enabled = exampleAt('enabled');
    expect(pluginBadge({ ...enabled, connections: enabled.connections.map(c => ({ ...c, state: 'needs_sign_in' as const })) })).toBe('degraded');
    expect(pluginBadge({ ...enabled, available: false })).toBe('degraded');
    expect(pluginBadge({ ...enabled, needsApproval: true })).toBe('needs_approval');
  });

  it('describes what the plugin adds in plain words', () => {
    expect(describePluginContributions(examplePlugin().manifest!)).toEqual([
      'Adds 1 MCP server the agent can read from',
      'Runs 1 local server inside the task container',
      'Adds 1 skill the agent reads when relevant: example-notes',
      'Adds 1 automation template: example-weekly-digest',
      'Adds the /deploy command',
      'Sends requests to api.example.com',
    ]);
  });

  it('links only https URLs', () => {
    expect(safeHttpsUrl('https://example.com/docs')).toBe('https://example.com/docs');
    for (const url of ['http://example.com', 'javascript:alert(1)', 'data:text/html,x', 'not a url', undefined]) expect(safeHttpsUrl(url)).toBeNull();
  });

  it('names the package, exact version and variables in the acknowledgement', () => {
    expect(secretAcknowledgementText({ package: 'pkg', version: '1.2.3', secretEnv: ['A', 'B'] }))
      .toBe('I understand that pkg@1.2.3 receives the secret variables A, B, and that they are readable by the agent CLI, its shell tools and repository setup scripts inside the task container.');
  });
});
