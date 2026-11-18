import { describe, expect, it } from 'vitest';
import type { PluginView } from '../../api/pluginsApi';
import { describePluginContributions, neededConnections, pluginBadge, safeHttpsUrl, secretAcknowledgementText } from './pluginUi';
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

  it('ignores optional connections left unset: a correctly configured plugin is Enabled, not Degraded', () => {
    // Like Discord with only its default webhook set: extra webhook URLs are optional tokens no server uses.
    const withOptional = (view: PluginView, oauthRequired?: boolean): PluginView => ({
      ...view,
      manifest: {
        ...view.manifest!,
        connections: [
          ...view.manifest!.connections.map(c => (c.type === 'oauth' && oauthRequired !== undefined ? { ...c, required: oauthRequired } : c)),
          { type: 'token', name: 'webhook-2', label: 'Webhook URL 2', help: 'Optional.', helpUrl: 'https://example.com/docs/webhooks' },
        ],
      },
      connections: [...view.connections, { name: 'webhook-2', type: 'token', label: 'Webhook URL 2', state: 'not_connected', required: false }],
    });
    const enabled = withOptional(exampleAt('enabled'));
    expect(pluginBadge(enabled)).toBe('enabled');
    expect(neededConnections(enabled).map(c => c.name)).toEqual(['example-account', 'example-token']);
    expect(pluginBadge(withOptional(exampleAt('connected')))).toBe('off');
    // A required connection still counts.
    expect(pluginBadge(withOptional(exampleAt('installed')))).toBe('needs_connection');
    const unset = (view: PluginView, name: string): PluginView => ({ ...view, connections: view.connections.map(c => (c.name === name ? { ...c, state: 'not_connected' as const } : c)) });
    // The sign-in a contributed server uses is needed unless the manifest marks it optional (Sentry's agent sign-in).
    expect(pluginBadge(unset(enabled, 'example-account'))).toBe('degraded');
    const optionalSignIn = withOptional(exampleAt('enabled'), false);
    expect(pluginBadge(unset(optionalSignIn, 'example-account'))).toBe('enabled');
    // A sign-in whose refresh failed is degraded even when optional.
    expect(pluginBadge({ ...optionalSignIn, connections: optionalSignIn.connections.map(c => (c.name === 'example-account' ? { ...c, state: 'needs_sign_in' as const } : c)) })).toBe('degraded');
  });

  it('describes what the plugin adds in plain words', () => {
    expect(describePluginContributions(examplePlugin().manifest!)).toEqual([
      'Adds 1 MCP server the agent can read from',
      'Runs 1 local server inside the task container',
      'Adds 1 skill the agent reads when relevant: example-notes',
      'Adds 1 automation template: example-weekly-digest',
      'Adds the /example-notes command',
      'Sends requests to api.example.com',
    ]);
  });

  it('names the URL settings whose hosts a plugin may call', () => {
    const manifest = examplePlugin().manifest!;
    const webhooks = {
      ...manifest, outboundHosts: [], outboundHostsFromSettings: ['greeting', 'unknownKey'],
      contributes: { ...manifest.contributes, mcpServers: [], skills: [], automationTemplates: [], commands: [], subscriptions: ['pull_request.merged'] },
    };
    expect(describePluginContributions(webhooks)).toEqual([
      'Receives ProPR events: pull_request.merged',
      'Sends requests to the hosts of the URLs you enter in Greeting, unknownKey, and nowhere else',
    ]);
  });

  it('names the hosts the webhook URL connections accept', () => {
    const manifest = examplePlugin().manifest!;
    const chat = {
      ...manifest, outboundHosts: [],
      connections: [
        { type: 'token' as const, name: 'default-webhook', label: 'Default webhook URL', help: 'x', helpUrl: 'https://example.com', secretUrl: { hosts: ['discord.com', 'discordapp.com'] } },
        { type: 'token' as const, name: 'webhook-2', label: 'Webhook URL 2', help: 'x', helpUrl: 'https://example.com', secretUrl: { hosts: ['discord.com'] } },
      ],
      contributes: { ...manifest.contributes, mcpServers: [], skills: [], automationTemplates: [], commands: [], subscriptions: ['pull_request.merged'] },
    };
    expect(describePluginContributions(chat)).toEqual([
      'Receives ProPR events: pull_request.merged',
      'Posts to the webhook URLs you enter under Connections, which must be on discord.com, discordapp.com',
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
