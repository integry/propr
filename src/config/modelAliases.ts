export type ModelAlias = string;
export type ModelId = string;

const MODEL_ALIASES: Record<ModelAlias, ModelId> = {
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

const OPENROUTER_MODEL_MAP: Record<ModelId, string> = {
    'claude-opus-4-5': 'anthropic/claude-opus-4.5',
    'claude-sonnet-4-5': 'anthropic/claude-sonnet-4.5',
    'claude-haiku-4-5': 'anthropic/claude-haiku-4.5',
};

function getOpenRouterId(internalModelId: ModelId): string {
    return OPENROUTER_MODEL_MAP[internalModelId] ?? internalModelId;
}

const DEFAULT_MODEL_ALIAS: ModelAlias = 'sonnet';

function resolveModelAlias(modelNameOrAlias?: string | null): ModelId {
    if (!modelNameOrAlias) {
        return MODEL_ALIASES[DEFAULT_MODEL_ALIAS];
    }

    const lowerCaseModel = modelNameOrAlias.toLowerCase();
    if (MODEL_ALIASES[lowerCaseModel]) {
        return MODEL_ALIASES[lowerCaseModel];
    }

    return modelNameOrAlias;
}

function getDefaultModel(): ModelId {
    return MODEL_ALIASES[DEFAULT_MODEL_ALIAS];
}

export {
    MODEL_ALIASES,
    DEFAULT_MODEL_ALIAS,
    resolveModelAlias,
    getDefaultModel,
    getOpenRouterId
};
