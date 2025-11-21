const MODEL_ALIASES = {
    // Aliases to full model IDs (Claude 4.x models only)
    'opus': 'claude-opus-4-1',                  // Claude Opus 4.1
    'opus4': 'claude-opus-4-1',                 // Claude Opus 4.1
    'opus-4-0': 'claude-opus-4-1',              // Official alias
    'claude-opus': 'claude-opus-4-1',           // From llm-claude-opus label
    'claude-opus-4-0': 'claude-opus-4-1',       // Official alias

    'sonnet': 'claude-sonnet-4-5',              // Claude Sonnet 4.5 (default)
    'sonnet4': 'claude-sonnet-4-5',             // Claude Sonnet 4.5
    'sonnet-4-0': 'claude-sonnet-4-5',          // Official alias
    'claude-sonnet': 'claude-sonnet-4-5',       // From llm-claude-sonnet label
    'claude-sonnet-4-0': 'claude-sonnet-4-5',   // Official alias

    'haiku': 'claude-haiku-4-5',                // Claude Haiku 4.5 (default)
    'haiku45': 'claude-haiku-4-5',              // Claude Haiku 4.5
    'haiku4': 'claude-haiku-4-5',               // Claude Haiku 4.5
    'claude-haiku': 'claude-haiku-4-5',         // From llm-claude-haiku label
    'claude-haiku-4-0': 'claude-haiku-4-5',     // Official alias
    'claude-4-5-haiku': 'claude-haiku-4-5'      // Incorrect order variant (from settings)
};

// Default model to use when none specified
const DEFAULT_MODEL_ALIAS = 'sonnet';

function resolveModelAlias(modelNameOrAlias) {
    if (!modelNameOrAlias) {
        return MODEL_ALIASES[DEFAULT_MODEL_ALIAS];
    }
    
    // Check if it's an alias
    const lowerCaseModel = modelNameOrAlias.toLowerCase();
    if (MODEL_ALIASES[lowerCaseModel]) {
        return MODEL_ALIASES[lowerCaseModel];
    }
    
    // If it's not an alias, return as-is (might be a full model ID)
    return modelNameOrAlias;
}

function getDefaultModel() {
    return MODEL_ALIASES[DEFAULT_MODEL_ALIAS];
}

export {
    MODEL_ALIASES,
    DEFAULT_MODEL_ALIAS,
    resolveModelAlias,
    getDefaultModel
};