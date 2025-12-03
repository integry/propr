const MODEL_ALIASES = {
    'opus': 'claude-opus-4-5',
    'opus4': 'claude-opus-4-5',
    'opus-4-0': 'claude-opus-4-5',
    'claude-opus': 'claude-opus-4-5',
    'claude-opus-4-0': 'claude-opus-4-5',

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
    'claude-opus-4-5': 'anthropic/claude-opus-4.5',
    'claude-sonnet-4-5': 'anthropic/claude-sonnet-4.5',
    'claude-haiku-4-5': 'anthropic/claude-haiku-4.5',

    'gpt-4o': 'openai/gpt-4o',
    'gpt-4o-mini': 'openai/gpt-4o-mini',
    'o1': 'openai/o1',
    'o1-mini': 'openai/o1-mini',
    'o3-mini': 'openai/o3-mini',
};

function getOpenRouterId(internalModelId) {
    return OPENROUTER_MODEL_MAP[internalModelId] || internalModelId;
}

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
    getDefaultModel,
    getOpenRouterId
};