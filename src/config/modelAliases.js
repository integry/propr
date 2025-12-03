const MODEL_ALIASES = {
    'opus': 'claude-opus-4-1',
    'opus4': 'claude-opus-4-1',
    'opus-4-0': 'claude-opus-4-1',
    'claude-opus': 'claude-opus-4-1',
    'claude-opus-4-0': 'claude-opus-4-1',

    'sonnet': 'claude-sonnet-4-5',
    'sonnet4': 'claude-sonnet-4-5',
    'sonnet-4-0': 'claude-sonnet-4-5',
    'claude-sonnet': 'claude-sonnet-4-5',
    'claude-sonnet-4-0': 'claude-sonnet-4-5',

    'haiku': 'claude-haiku-4-5',
    'haiku45': 'claude-haiku-4-5',
    'haiku4': 'claude-haiku-4-5',
    'claude-haiku': 'claude-haiku-4-5',
    'claude-haiku-4-0': 'claude-haiku-4-5',
    'claude-4-5-haiku': 'claude-haiku-4-5'
};

const OPENROUTER_MODEL_MAP = {
    'claude-opus-4-1': 'anthropic/claude-opus-4',
    'claude-opus-4-5': 'anthropic/claude-opus-4',
    'claude-sonnet-4-5': 'anthropic/claude-sonnet-4',
    'claude-sonnet-4-0': 'anthropic/claude-sonnet-4',
    'claude-haiku-4-5': 'anthropic/claude-haiku-4',
    'claude-haiku-4-0': 'anthropic/claude-haiku-4',
    'claude-3-5-sonnet-20241022': 'anthropic/claude-3.5-sonnet',
    'claude-3-5-haiku-20241022': 'anthropic/claude-3.5-haiku',
    'claude-3-opus-20240229': 'anthropic/claude-3-opus',
    'claude-3-sonnet-20240229': 'anthropic/claude-3-sonnet',
    'claude-3-haiku-20240307': 'anthropic/claude-3-haiku',
    'claude-3-7-sonnet-20250219': 'anthropic/claude-3.7-sonnet',
    'claude-sonnet-4-5-20250929': 'anthropic/claude-sonnet-4',
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

function getOpenRouterId(internalModelId) {
    return OPENROUTER_MODEL_MAP[internalModelId] || internalModelId;
}

export {
    MODEL_ALIASES,
    DEFAULT_MODEL_ALIAS,
    OPENROUTER_MODEL_MAP,
    resolveModelAlias,
    getDefaultModel,
    getOpenRouterId
};