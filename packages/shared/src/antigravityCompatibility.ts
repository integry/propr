import { ANTIGRAVITY_MODELS } from './modelDefinitions.js';
import { getReasoningLevelsForAgentType, type ModelReasoningLevel } from './reasoningLevels.js';

// Compatibility routes are deliberately absent from the selectable catalog.
export const ANTIGRAVITY_COMPATIBILITY_ROUTES: Record<string, { model: string; effort: ModelReasoningLevel }> = Object.create(null);
export const ANTIGRAVITY_COMPATIBILITY_ALIASES: Record<string, string> = Object.create(null);
for (const model of ANTIGRAVITY_MODELS) {
    for (const effort of getReasoningLevelsForAgentType('antigravity', model.id)) {
        const id = `${model.id}-${effort}`;
        ANTIGRAVITY_COMPATIBILITY_ROUTES[id] = { model: model.id, effort };
        ANTIGRAVITY_COMPATIBILITY_ALIASES[`antigravity-${model.shortAlias}-${effort}`] = id;
    }
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

