// PR review context budgeting shared by the worker, API validation, CLI, MCP and
// Settings UI. The worker is the only component that measures prompt text; the
// UI uses the same capacity table to preview the effective allowance.
import { MODEL_INFO_MAP, type AgentType } from './modelDefinitions.js';

export const REVIEW_CONTEXT_BUDGET_PERCENT_MIN = 10;
export const REVIEW_CONTEXT_BUDGET_PERCENT_MAX = 100;
export const REVIEW_CONTEXT_BUDGET_PERCENT_STEP = 10;
/** New and automatic settings use all of the resolved SAFE input capacity. */
export const DEFAULT_REVIEW_CONTEXT_BUDGET_PERCENT = 100;
export const REVIEW_CONTEXT_BUDGET_PERCENT_OPTIONS: readonly number[] = Array.from(
  { length: REVIEW_CONTEXT_BUDGET_PERCENT_MAX / REVIEW_CONTEXT_BUDGET_PERCENT_STEP },
  (_, index) => (index + 1) * REVIEW_CONTEXT_BUDGET_PERCENT_STEP,
);

/**
 * Legacy absolute cap (`pr_review_max_context_tokens`). `0` means no cap. A
 * positive value is still honoured: the effective ceiling is the lower of the
 * percentage allowance and this cap, so neither a model change nor the new
 * percentage setting can silently raise a limit an operator chose.
 */
export const REVIEW_LEGACY_MAX_CONTEXT_TOKENS_MIN = 10000;
export const REVIEW_LEGACY_MAX_CONTEXT_TOKENS_MAX = 2000000;

export function isValidReviewContextBudgetPercent(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isInteger(value)
    && value >= REVIEW_CONTEXT_BUDGET_PERCENT_MIN
    && value <= REVIEW_CONTEXT_BUDGET_PERCENT_MAX
    && value % REVIEW_CONTEXT_BUDGET_PERCENT_STEP === 0;
}

/** Missing, `0` (the old automatic value) and unreadable values mean 100%. */
export function normalizeReviewContextBudgetPercent(value: unknown): number {
  return isValidReviewContextBudgetPercent(value) ? value : DEFAULT_REVIEW_CONTEXT_BUDGET_PERCENT;
}

export function isValidLegacyReviewMaxContextTokens(value: unknown): value is number {
  return value === 0 || (
    typeof value === 'number'
    && Number.isInteger(value)
    && value >= REVIEW_LEGACY_MAX_CONTEXT_TOKENS_MIN
    && value <= REVIEW_LEGACY_MAX_CONTEXT_TOKENS_MAX
  );
}

export function normalizeLegacyReviewMaxContextTokens(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : 0;
}

/**
 * Where a context window came from:
 * - `runtime-verified`: read from the model catalog bundled with the agent
 *   runtime version ProPR deploys (see the tables below).
 * - `catalog`: ProPR's model catalog for a runtime whose own limits have not
 *   been verified; a larger proportional runtime reserve is applied.
 * - `fallback`: the model is not known for this runtime; a conservative
 *   documented window is used.
 */
export type ReviewCapacitySource = 'runtime-verified' | 'catalog' | 'fallback';

/** Token-counting profile the worker uses for a reviewer. */
export type ReviewTokenizerProfile = 'openai-o200k' | 'anthropic-calibrated' | 'generic-calibrated';

export interface ReviewRouteDescriptor {
  /** Physical agent runtime type (claude, codex, ...). Unknown when omitted. */
  agentType?: AgentType | string;
  model: string;
  /** Agent container environment; only runtime context switches are read. */
  runtimeEnv?: Record<string, string | undefined>;
}

export interface ReviewInputCapacity {
  agentType?: string;
  model: string;
  /** Runtime context window the review request must fit in. */
  contextWindow: number;
  /** Held back for the review response, including reasoning. */
  outputReserve: number;
  /** Held back for runtime system prompts, tool schemas and compaction headroom. */
  runtimeOverheadReserve: number;
  /** contextWindow - outputReserve - runtimeOverheadReserve. 100% of the slider. */
  safeInputTokens: number;
  source: ReviewCapacitySource;
  /** Plain-language explanation for logs and the Settings UI. */
  basis: string;
  tokenizerProfile: ReviewTokenizerProfile;
}

/** Response and reasoning allowance kept outside the review input. */
export const REVIEW_OUTPUT_TOKEN_RESERVE = 32000;
/** Conservative window for a model the routed runtime does not know. */
export const REVIEW_FALLBACK_CONTEXT_WINDOW = 200000;

// Claude Code 2.1.280 (AGENT_DEFAULTS.claude.defaultCliVersion) bundled model
// catalog: models flagged `native_1m` run with a 1,000,000-token window; the
// other models run with the runtime's 200,000-token default unless the model
// name carries the `[1m]` suffix. ProPR does not add that suffix, and
// CLAUDE_CODE_DISABLE_1M_CONTEXT forces the 200,000-token window.
const CLAUDE_CODE_NATIVE_1M_MODELS = new Set([
  'claude-opus-4-7', 'claude-opus-4-8', 'claude-opus-5', 'claude-opus-5-5',
  'claude-sonnet-5', 'claude-fable-5', 'claude-fable-5-1', 'claude-mythos-5', 'claude-mythos-5-1',
]);
const CLAUDE_CODE_200K_MODELS = new Set([
  'claude-3-5-haiku', 'claude-3-5-sonnet', 'claude-3-7-sonnet', 'claude-haiku-4-5',
  'claude-sonnet-4-0', 'claude-sonnet-4-5', 'claude-sonnet-4-6',
  'claude-opus-4-0', 'claude-opus-4-1', 'claude-opus-4-5', 'claude-opus-4-6',
]);
const CLAUDE_CODE_1M_WINDOW = 1000000;
const CLAUDE_CODE_DEFAULT_WINDOW = 200000;
// System prompt, tool schemas and the buffer Claude Code keeps below the
// window before auto-compacting a session.
const CLAUDE_CODE_RUNTIME_RESERVE = 20000;

// Codex CLI 0.154.0 (AGENT_DEFAULTS.codex.defaultCliVersion) bundled
// models.json: every listed model has a default `context_window` of 272,000
// even where the provider advertises a larger model maximum (GPT-6 Astra lists
// `max_context_window` 872,000 and the ProPR catalog 1,050,000). The larger
// window is opt-in through `model_context_window`, which ProPR never sets, so
// the runtime default is the verified capacity.
const CODEX_RUNTIME_WINDOWS: Record<string, number> = {
  'gpt-6-astra': 272000,
  'gpt-5.6-sol': 272000,
  'gpt-5.6-terra': 272000,
  'gpt-5.6-luna': 272000,
  'gpt-5.5': 272000,
  'gpt-5.4': 272000,
  'gpt-5.4-mini': 272000,
  'gpt-5.2': 272000,
};
/** Historical Codex window, kept as the fallback for models the runtime does not list. */
const CODEX_FALLBACK_WINDOW = 272000;
// Base instructions and tool schemas, plus headroom for the runtime's
// auto-compaction: compacting mid-review would silently discard review input.
const CODEX_BASE_INSTRUCTIONS_RESERVE = 12000;
const RUNTIME_COMPACTION_HEADROOM_RATIO = 0.1;
const UNVERIFIED_RUNTIME_MIN_RESERVE = 16000;

function normalizeClaudeModelId(model: string): { id: string; oneMillionSuffix: boolean } {
  const lower = model.trim().toLowerCase();
  const oneMillionSuffix = /\[1m\]$/.test(lower);
  const base = lower.replace(/\[1m\]$/, '').replace(/-\d{8}$/, '');
  return { id: base, oneMillionSuffix };
}

function isTruthyEnv(value: string | undefined): boolean {
  return !!value && !['0', 'false', 'no', 'off', ''].includes(value.trim().toLowerCase());
}

function buildCapacity(
  route: ReviewRouteDescriptor,
  contextWindow: number,
  runtimeOverheadReserve: number,
  source: ReviewCapacitySource,
  basis: string,
  tokenizerProfile: ReviewTokenizerProfile,
): ReviewInputCapacity {
  const outputReserve = REVIEW_OUTPUT_TOKEN_RESERVE;
  return {
    agentType: route.agentType,
    model: route.model,
    contextWindow,
    outputReserve,
    runtimeOverheadReserve,
    safeInputTokens: Math.max(0, contextWindow - outputReserve - runtimeOverheadReserve),
    source,
    basis,
    tokenizerProfile,
  };
}

function resolveClaudeCodeCapacity(route: ReviewRouteDescriptor): ReviewInputCapacity {
  const { id, oneMillionSuffix } = normalizeClaudeModelId(route.model);
  const oneMillionDisabled = isTruthyEnv(route.runtimeEnv?.CLAUDE_CODE_DISABLE_1M_CONTEXT);
  const known = CLAUDE_CODE_NATIVE_1M_MODELS.has(id) || CLAUDE_CODE_200K_MODELS.has(id);
  const oneMillion = !oneMillionDisabled && known && (CLAUDE_CODE_NATIVE_1M_MODELS.has(id) || oneMillionSuffix);
  if (!known) {
    return buildCapacity(route, CLAUDE_CODE_DEFAULT_WINDOW, CLAUDE_CODE_RUNTIME_RESERVE, 'fallback',
      'Model not in the Claude Code runtime catalog; using its 200K default window.', 'anthropic-calibrated');
  }
  return buildCapacity(route, oneMillion ? CLAUDE_CODE_1M_WINDOW : CLAUDE_CODE_DEFAULT_WINDOW, CLAUDE_CODE_RUNTIME_RESERVE,
    'runtime-verified',
    oneMillion
      ? 'Claude Code runtime window (1M).'
      : oneMillionDisabled
        ? 'Claude Code runtime window (200K; 1M context disabled for this agent).'
        : 'Claude Code runtime window (200K without the [1m] model suffix).',
    'anthropic-calibrated');
}

function resolveCodexCapacity(route: ReviewRouteDescriptor): ReviewInputCapacity {
  const id = route.model.trim().toLowerCase();
  const verifiedWindow = CODEX_RUNTIME_WINDOWS[id];
  const contextWindow = verifiedWindow ?? CODEX_FALLBACK_WINDOW;
  const reserve = CODEX_BASE_INSTRUCTIONS_RESERVE + Math.ceil(contextWindow * RUNTIME_COMPACTION_HEADROOM_RATIO);
  return verifiedWindow
    ? buildCapacity(route, contextWindow, reserve, 'runtime-verified',
      'Codex runtime default window (272K; larger windows are opt-in and not enabled by ProPR).', 'openai-o200k')
    : buildCapacity(route, contextWindow, reserve, 'fallback',
      'Model not in the Codex runtime catalog; using the historical 272K Codex window.', 'openai-o200k');
}

function resolveUnverifiedRuntimeCapacity(route: ReviewRouteDescriptor): ReviewInputCapacity {
  const catalogWindow = MODEL_INFO_MAP[route.model]?.maxTokens;
  const contextWindow = catalogWindow && catalogWindow > 0 ? catalogWindow : REVIEW_FALLBACK_CONTEXT_WINDOW;
  const reserve = Math.max(UNVERIFIED_RUNTIME_MIN_RESERVE, Math.ceil(contextWindow * RUNTIME_COMPACTION_HEADROOM_RATIO));
  return catalogWindow
    ? buildCapacity(route, contextWindow, reserve, 'catalog',
      'Model catalog window; this runtime\'s own limit is unverified, so a larger runtime reserve applies.', 'generic-calibrated')
    : buildCapacity(route, contextWindow, reserve, 'fallback',
      'Unknown model or runtime; using a conservative 200K window.', 'generic-calibrated');
}

/**
 * Resolve the safe review INPUT capacity for one physical reviewer route. The
 * output and runtime reserves are subtracted exactly once; no provider-wide
 * multiplier is applied on top.
 */
export function resolveReviewInputCapacity(route: ReviewRouteDescriptor): ReviewInputCapacity {
  switch (route.agentType) {
    case 'claude': return resolveClaudeCodeCapacity(route);
    case 'codex': return resolveCodexCapacity(route);
    default: return resolveUnverifiedRuntimeCapacity(route);
  }
}

export type ReviewInputCeilingLimit = 'percentage' | 'legacy-cap';

export interface ReviewInputCeiling {
  /** Effective input-token ceiling for the assembled review request. */
  ceiling: number;
  percent: number;
  percentAllowance: number;
  legacyMaxContextTokens: number;
  limitedBy: ReviewInputCeilingLimit;
}

/**
 * Apply the percentage setting and any retained legacy absolute cap. The lower
 * value wins, so the percentage can only narrow a legacy cap, never raise it.
 */
export function resolveReviewInputCeiling(
  safeInputTokens: number,
  settings: { percent?: unknown; legacyMaxContextTokens?: unknown } = {},
): ReviewInputCeiling {
  const percent = normalizeReviewContextBudgetPercent(settings.percent);
  const legacyMaxContextTokens = normalizeLegacyReviewMaxContextTokens(settings.legacyMaxContextTokens);
  const percentAllowance = Math.floor(Math.max(0, safeInputTokens) * percent / 100);
  const legacyLimits = legacyMaxContextTokens > 0 && legacyMaxContextTokens < percentAllowance;
  return {
    ceiling: legacyLimits ? legacyMaxContextTokens : percentAllowance,
    percent,
    percentAllowance,
    legacyMaxContextTokens,
    limitedBy: legacyLimits ? 'legacy-cap' : 'percentage',
  };
}
