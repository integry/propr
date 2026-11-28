import type { PiThinkingLevel } from '../../config/configManagerReasoning.js';

/**
 * ProPR stores Pi models as `pi-<provider>/<model>[:<thinking>]` so they never
 * collide with another agent's catalog, and runs them as
 * `pi --model <provider>/<model> --thinking <level>`: the suffix is one input
 * to the run's thinking level, never sent inside `--model`.
 */
export const PI_MODEL_PREFIX = 'pi-';

const PI_THINKING_LEVELS: ReadonlySet<string> = new Set<PiThinkingLevel>(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

export function isPiModelId(modelId: string): boolean {
    const lower = modelId.toLowerCase();
    return lower.startsWith(PI_MODEL_PREFIX) && lower.indexOf('/') > PI_MODEL_PREFIX.length;
}

/** Drops an `<agent alias>:` routing prefix (e.g. `pi:pi-anthropic/...`). */
function withoutRoutePrefix(modelId: string): string {
    const separator = modelId.indexOf(':');
    if (separator <= 0) return modelId;
    const rest = modelId.slice(separator + 1);
    return isPiModelId(rest) ? rest : modelId;
}

/** Adds the ProPR `pi-` prefix to a native `provider/model` reference. */
export function toProprPiModelId(modelId: string): string {
    const model = withoutRoutePrefix(modelId.trim());
    return isPiModelId(model) ? model : `${PI_MODEL_PREFIX}${model}`;
}

export interface PiCliModel {
    /** `provider/model` passed to `--model`. */
    model: string;
    provider: string;
    /** A `:<thinking>` suffix configured on the model id, if any. */
    thinking?: PiThinkingLevel;
}

/** Converts a ProPR Pi model id to the `--model` value and its parts. */
export function toPiCliModel(modelId: string): PiCliModel {
    let model = withoutRoutePrefix(modelId.trim());
    if (model.toLowerCase().startsWith(PI_MODEL_PREFIX)) model = model.slice(PI_MODEL_PREFIX.length);
    let thinking: PiThinkingLevel | undefined;
    const suffixAt = model.lastIndexOf(':');
    if (suffixAt > 0 && PI_THINKING_LEVELS.has(model.slice(suffixAt + 1).toLowerCase())) {
        thinking = model.slice(suffixAt + 1).toLowerCase() as PiThinkingLevel;
        model = model.slice(0, suffixAt);
    }
    const slash = model.indexOf('/');
    if (slash <= 0 || slash === model.length - 1) {
        throw new Error(`Pi model "${modelId}" must name a provider and model, e.g. pi-anthropic/claude-sonnet-5-5`);
    }
    // Pi provider ids are lowercase; the model part keeps its case.
    const provider = model.slice(0, slash).toLowerCase();
    return { model: `${provider}${model.slice(slash)}`, provider, ...(thinking && { thinking }) };
}

/** The `:<thinking>` suffix configured on a Pi model id, if the id is a valid Pi model. */
export function piModelThinkingSuffix(modelId: string): PiThinkingLevel | undefined {
    try { return toPiCliModel(modelId).thinking; } catch { return undefined; }
}

export interface PiThinkingSources {
    /** The task's explicit reasoning level (already mapped to Pi), if any. */
    explicit?: PiThinkingLevel | null;
    /** The agent's reasoning setting for this model, if any. */
    agentModel?: PiThinkingLevel | null;
    /** The ProPR model id, whose `:<thinking>` suffix pins a level. */
    modelId: string;
    /** The global reasoning default, if any. */
    globalDefault?: PiThinkingLevel | null;
}

/**
 * The one thinking level a Pi run uses, sent as `--thinking` (the suffix is
 * stripped from `--model`): the task's explicit level, then the agent's
 * setting for the model, then the model id's suffix, then the global default.
 */
export function resolvePiThinkingLevel(sources: PiThinkingSources): PiThinkingLevel | null {
    return sources.explicit || sources.agentModel || piModelThinkingSuffix(sources.modelId) || sources.globalDefault || null;
}

/**
 * OpenRouter slug for pricing a Pi model that is not in the curated catalog.
 * Only OpenRouter-routed models map one to one; other providers' native ids
 * have no reliable OpenRouter equivalent.
 */
export function toPiOpenRouterId(modelId: string): string | undefined {
    if (!isPiModelId(withoutRoutePrefix(modelId))) return undefined;
    try {
        const { provider, model } = toPiCliModel(modelId);
        return provider === 'openrouter' ? model.slice('openrouter/'.length) : undefined;
    } catch {
        return undefined;
    }
}
