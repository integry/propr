import { ANTIGRAVITY_MODELS, ANTIGRAVITY_RETAINED_MODELS, MODEL_INFO_MAP, type ModelInfo } from './modelDefinitions.js';
import { REASONING_LEVELS, getReasoningLevelsForAgentType, type ModelReasoningLevel, type ReasoningLevel } from './reasoningLevels.js';

// Compatibility routes are deliberately absent from the selectable catalog.
export const ANTIGRAVITY_COMPATIBILITY_ROUTES: Record<string, { model: string; effort?: ModelReasoningLevel }> = Object.create(null);
export const ANTIGRAVITY_COMPATIBILITY_ALIASES: Record<string, string> = Object.create(null);
for (const model of ANTIGRAVITY_MODELS) {
    for (const effort of getReasoningLevelsForAgentType('antigravity', model.id)) {
        const id = `${model.id}-${effort}`;
        ANTIGRAVITY_COMPATIBILITY_ROUTES[id] = { model: model.id, effort };
        ANTIGRAVITY_COMPATIBILITY_ALIASES[`antigravity-${model.shortAlias}-${effort}`] = id;
    }
}
// Antigravity CLI 1.4.0 no longer serves Gemini 3.6 or 3.7 Flash, so saved
// selections, aliases and labels run on Gemini 3.8 Flash at the same effort.
const FLASH = 'antigravity-gemini-3.8-flash';
const FLASH_LEVELS = getReasoningLevelsForAgentType('antigravity', FLASH);
function flashEffort(effort: ReasoningLevel): ReasoningLevel {
    const index = REASONING_LEVELS.indexOf(effort);
    // The closest supported level at or below the saved one, else the lowest.
    return [...FLASH_LEVELS].reverse().find(level => REASONING_LEVELS.indexOf(level) <= index) ?? FLASH_LEVELS[0];
}
for (const model of ANTIGRAVITY_RETAINED_MODELS) {
    ANTIGRAVITY_COMPATIBILITY_ROUTES[model.id] = { model: FLASH };
    ANTIGRAVITY_COMPATIBILITY_ALIASES[`antigravity-${model.shortAlias}`] = FLASH;
    for (const effort of getReasoningLevelsForAgentType('antigravity', model.id)) {
        const id = `${model.id}-${effort}`;
        ANTIGRAVITY_COMPATIBILITY_ROUTES[id] = { model: FLASH, effort: flashEffort(effort) };
        ANTIGRAVITY_COMPATIBILITY_ALIASES[`antigravity-${model.shortAlias}-${effort}`] = id;
    }
}
// Antigravity CLI 1.4.0 dropped Gemini 3.1 Pro and serves Gemini 4 Argon in its
// place, so saved Pro selections and labels run on Argon.
const ARGON = 'antigravity-gemini-4-argon';
ANTIGRAVITY_COMPATIBILITY_ROUTES['antigravity-gemini-3.1-pro'] = { model: ARGON };
ANTIGRAVITY_COMPATIBILITY_ALIASES['antigravity-pro'] = ARGON;
for (const effort of ['low', 'high'] as const) {
    ANTIGRAVITY_COMPATIBILITY_ROUTES[`antigravity-gemini-3.1-pro-${effort}`] = { model: ARGON, effort };
    ANTIGRAVITY_COMPATIBILITY_ALIASES[`antigravity-pro-${effort}`] = `antigravity-gemini-3.1-pro-${effort}`;
}
for (const family of ['opus', 'sonnet']) {
    const id = `antigravity-claude-${family}-4.6-thinking`;
    ANTIGRAVITY_COMPATIBILITY_ROUTES[id] = { model: `antigravity-claude-${family}-5.5`, effort: 'high' };
    ANTIGRAVITY_COMPATIBILITY_ALIASES[`antigravity-${family}46-thinking`] = id;
}

export function getAntigravityCompatibilityRoute(id: string) {
    const clean = id.toLowerCase().replace(/^antigravity:/, '');
    return ANTIGRAVITY_COMPATIBILITY_ROUTES[clean];
}

export function antigravitySupportedModel(config: { type: string; supportedModels: string[] }, id: string): boolean {
    const base = config.type === 'antigravity' ? getAntigravityCompatibilityRoute(id)?.model ?? id : id;
    return config.supportedModels.some(model => model.toLowerCase() === base.toLowerCase());
}

/** Exact for other agents; Antigravity also accepts saved routes to a model it supports. */
export function agentSupportsSavedModel(config: { type: string; supportedModels: string[] }, id: string): boolean {
    return config.supportedModels.includes(id) || (config.type === 'antigravity' && antigravitySupportedModel(config, id));
}

/** A saved Antigravity base ID the CLI retired resolves to the model it now runs on; effort routes stay as saved. */
export function currentAntigravityModel(id: string): string {
    const route = getAntigravityCompatibilityRoute(id);
    return route && !route.effort ? route.model : id;
}

/** Resolve metadata for current models and saved Antigravity execution routes. */
export function getModelInfoWithAntigravityCompatibility(id: string): ModelInfo | undefined {
    const model = getAntigravityCompatibilityRoute(id)?.model ?? id;
    return MODEL_INFO_MAP[model] ?? ANTIGRAVITY_RETAINED_MODELS.find(candidate => candidate.id === model);
}
