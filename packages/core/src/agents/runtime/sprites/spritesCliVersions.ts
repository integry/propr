import type { AgentConfig, AgentType } from '../../types.js';
import { AGENT_DEFAULT_VERSIONS } from '../../version/types.js';
import { selectedAgentRuntimeName } from '../runtimeSelection.js';
import { readSpritesCliPins, type SpritesCliPins } from './spritesProvisioning.js';

/**
 * A Sprite runs one version of each CLI: the one its setup revision pins
 * (`Dockerfile.agent`'s defaults, installed by `scripts/sprites-agent-setup.sh`).
 * An agent that selects any other version is refused, both when its
 * configuration is saved and before a run launches, rather than silently run
 * on the pinned version.
 */

export type SpritesCliVersionSelection = Pick<AgentConfig, 'type'>
    & Partial<Pick<AgentConfig, 'id' | 'alias' | 'enabled' | 'runtime' | 'cliVersionType' | 'cliVersion' | 'cliVersionResolved'>>;

/** The version of `type`'s CLI a Sprite runs, or undefined when setup installs none. */
export function spritesProvidedCliVersion(type: AgentType, pins: SpritesCliPins = readSpritesCliPins()): string | undefined {
    if (type === 'claude') return pins.CLAUDE_CLI_VERSION;
    if (type === 'codex') return pins.CODEX_CLI_VERSION;
    if (type === 'antigravity') return pins.ANTIGRAVITY_CLI_VERSION;
    return undefined;
}

/**
 * Why the Sprites runtime cannot run the agent's selected CLI version, or
 * undefined when it runs exactly that version. The selection is the resolved
 * version (as the Docker image matrix uses it), else the requested specific
 * version, else the default; an unresolved tag or custom spec is refused.
 * Agent types setup installs no CLI for are refused at launch instead.
 */
export function spritesCliVersionRefusal(agent: SpritesCliVersionSelection, pins: SpritesCliPins = readSpritesCliPins()): string | undefined {
    const provided = spritesProvidedCliVersion(agent.type, pins);
    if (!provided) return undefined;
    const requested = agent.cliVersionType !== undefined && agent.cliVersionType !== 'default';
    const selected = agent.cliVersionResolved?.trim()
        || (requested ? (agent.cliVersionType === 'specific' ? agent.cliVersion?.trim() : undefined) : AGENT_DEFAULT_VERSIONS[agent.type]);
    if (selected === provided) return undefined;
    const label = agent.alias || agent.id || agent.type;
    const selection = selected ?? `${agent.cliVersionType} ${agent.cliVersion ?? ''}`.trim();
    return `Agent '${label}' selects ${agent.type} CLI ${selection}, but the Sprites runtime runs only ${agent.type} CLI ${provided} (the version Dockerfile.agent pins). Use the default CLI version on Sprites, or the Docker runtime for other versions`;
}

/** The first enabled agent that selects the Sprites runtime with a CLI version it cannot run, as a refusal. */
export function spritesAgentConfigRefusal(
    agents: readonly SpritesCliVersionSelection[],
    environment: NodeJS.ProcessEnv = process.env,
    pins?: SpritesCliPins,
): string | undefined {
    for (const agent of agents) {
        if (agent.enabled === false || selectedAgentRuntimeName(agent, environment) !== 'sprites') continue;
        const refusal = spritesCliVersionRefusal(agent, pins ?? (pins = readSpritesCliPins()));
        if (refusal) return refusal;
    }
    return undefined;
}
