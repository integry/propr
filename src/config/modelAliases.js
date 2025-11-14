const MODEL_ALIASES = {
    // Aliases to full model IDs (matching Anthropic's alias system)
    'opus': 'claude-opus-4-20250514',           // Claude Opus 4
    'opus4': 'claude-opus-4-20250514',          // Claude Opus 4
    'opus-4-0': 'claude-opus-4-20250514',       // Official alias
    'sonnet': 'claude-sonnet-4-5-20250929',       // Claude Sonnet 4.5 (default)
    'sonnet4': 'claude-sonnet-4-5-20250929',      // Claude Sonnet 4.5
    'sonnet-4-0': 'claude-sonnet-4-5-20250929',   // Official alias
    'sonnet37': 'claude-3-7-sonnet-20250219',   // Claude Sonnet 3.7
    'sonnet35': 'claude-3-5-sonnet-20241022',   // Claude Sonnet 3.5
    'haiku': 'claude-haiku-4-5',                // Claude Haiku 4.5 (default)
    'haiku45': 'claude-haiku-4-5',              // Claude Haiku 4.5
    'haiku35': 'claude-3-5-haiku-20241022',     // Claude Haiku 3.5
    'haiku3': 'claude-3-haiku-20240307',        // Claude Haiku 3
    
    // Official aliases from documentation
    'claude-opus-4-0': 'claude-opus-4-20250514',
    'claude-sonnet-4-0': 'claude-sonnet-4-5-20250929',
    'claude-3-7-sonnet-latest': 'claude-3-7-sonnet-20250219',
    'claude-3-5-sonnet-latest': 'claude-3-5-sonnet-20241022',
    'claude-3-5-haiku-latest': 'claude-3-5-haiku-20241022',
    
    // Legacy aliases for backward compatibility
    'claude-3-opus': 'claude-3-opus-20240229',
    'claude-3-5-sonnet': 'claude-3-5-sonnet-20241022',
    'claude-3-haiku': 'claude-3-haiku-20240307',
    'claude-3-sonnet': 'claude-3-sonnet-20240229'
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