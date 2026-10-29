// OpenCode rotates the free models its server serves, and a retired one fails
// with "Model not found". Saved selections, aliases and labels of a retired
// free model run on a current one. Routes are deliberately absent from the
// selectable catalog.
const RETIRED_OPENCODE_FREE_MODELS: ReadonlyArray<readonly [id: string, shortAlias: string, successor: string]> = [
    // Retired by OpenCode CLI 1.19.5.
    ['opencode-ling-3.0-flash-fin-free', 'ling30-flash-fin-free', 'opencode-deepseek-v4.1-flash-free'],
    ['opencode-mimo-v2.5-free', 'mimo-v25-free', 'opencode-mimo-v2.6-flash-free'],
    ['opencode-muse-spark-1.2-contributor-free', 'muse-spark12-free', 'opencode-big-pickle'],
    ['opencode-muse-spark-1.3-contributor-free', 'muse-spark13-free', 'opencode-big-pickle'],
    ['opencode-nemotron-3-ultra-free', 'nemotron-3-ultra-free', 'opencode-nemotron-3.5-super-vl-free'],
    // Retired by earlier OpenCode CLI updates.
    ['opencode-minimax-m3-free', 'minimax-m3-free', 'opencode-big-pickle'],
    ['opencode-deepseek-v4-flash-free', 'deepseek-v4-flash-free', 'opencode-deepseek-v4.1-flash-free'],
    ['opencode-laguna-s-2.1-free', 'laguna-s21-free', 'opencode-big-pickle'],
    ['opencode-ling-3.0-flash-free', 'ling30-flash-free', 'opencode-deepseek-v4.1-flash-free'],
    ['opencode-north-mini-code-free', 'north-mini-code-free', 'opencode-big-pickle'],
];

/** Retired OpenCode model ID → the current free model it runs on. */
export const OPENCODE_RETIRED_MODEL_ROUTES: Record<string, string> = Object.create(null);
/** Retired `opencode-<shortAlias>` (its GitHub label without `llm-`) → the current free model. */
export const OPENCODE_RETIRED_MODEL_ALIASES: Record<string, string> = Object.create(null);
for (const [id, shortAlias, successor] of RETIRED_OPENCODE_FREE_MODELS) {
    OPENCODE_RETIRED_MODEL_ROUTES[id] = successor;
    OPENCODE_RETIRED_MODEL_ALIASES[`opencode-${shortAlias}`] = successor;
}

/** The current model a saved OpenCode ID runs on (`opencode:`, `opencode/` forms included); other IDs are returned unchanged. */
export function currentOpenCodeModel(id: string): string {
    const clean = id.toLowerCase().replace(/^opencode:/, '').replace(/^opencode\//, 'opencode-');
    return OPENCODE_RETIRED_MODEL_ROUTES[clean] ?? id;
}
