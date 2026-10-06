import { isUsageTipsCooldownDays, MAX_RUN_COST_CAP_USD } from '@propr/shared';
import { validateModelReasoningLevel, validatePrReviewModelValue } from '@propr/core';

interface SettingFields {
  usage_tips_enabled?: unknown;
  usage_tips_dismissal_cooldown_days?: unknown;
  auto_followup_score_threshold?: unknown;
  auto_resolve_merge_conflicts?: unknown;
  dashboard_summary_enabled?: unknown;
  model_reasoning_level?: unknown;
  pr_review_model?: unknown;
  ultrafix_escalation_enabled?: unknown;
  ultrafix_escalation_models?: unknown;
  ultrafix_escalation_patience?: unknown;
  ultrafix_escalation_max_reasoning_levels?: unknown;
  ultrafix_rating_goal?: unknown;
  ultrafix_max_cycles?: unknown;
  ultrafix_pause_seconds?: unknown;
  default_max_cost_usd?: unknown;
  ultrafix_ci_wait_timeout_ms?: unknown;
}

export type SettingSaveName =
  | 'usage_tips_enabled'
  | 'usage_tips_dismissal_cooldown_days'
  | 'auto_followup_score_threshold'
  | 'auto_resolve_merge_conflicts'
  | 'dashboard_summary_enabled'
  | 'model_reasoning_level'
  | 'pr_review_model'
  | 'ultrafix_escalation_enabled'
  | 'ultrafix_escalation_models'
  | 'ultrafix_escalation_patience'
  | 'ultrafix_escalation_max_reasoning_levels'
  | 'ultrafix_rating_goal'
  | 'ultrafix_max_cycles'
  | 'ultrafix_pause_seconds'
  | 'default_max_cost_usd'
  | 'ultrafix_ci_wait_timeout_ms';

export interface LabeledSaveDescriptor {
  name: SettingSaveName;
}

function validateStrictInt(raw: unknown, min: number, max: number): number | null {
  const str = String(raw);
  if (!/^-?\d+$/.test(str)) return null;
  const value = Number(str);
  if (!Number.isSafeInteger(value)) return null;
  return value < min || value > max ? null : value;
}

/** A USD amount from 0 (no cap) up to the cap ceiling; an empty value or null clears the cap. */
export function validateCostCapUsd(raw: unknown): number | null {
  if (raw === null || raw === '') return 0;
  const value = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\s*\d+(?:\.\d+)?\s*$/.test(raw) ? Number(raw) : Number.NaN;
  return Number.isFinite(value) && value >= 0 && value <= MAX_RUN_COST_CAP_USD ? value : null;
}

async function validatePrReviewModel(raw: unknown): Promise<{ error?: string; value?: string }> {
  if (typeof raw !== 'string') return { error: 'pr_review_model must be a string' };
  const val = raw.trim();
  if (val === '' && raw.length > 0) {
    return { error: 'pr_review_model must not be whitespace-only; use an empty string to clear' };
  }
  const result = await validatePrReviewModelValue(val);
  if (!result.valid) return { error: result.error };
  return { value: val };
}

interface SettingSavesResult {
  error?: string;
  saves: LabeledSaveDescriptor[];
  normalized: Record<string, unknown>;
}

function extractUsageTipSettingSaves(fields: SettingFields): SettingSavesResult {
  const saves: LabeledSaveDescriptor[] = [];
  const normalized: Record<string, unknown> = {};

  if (fields.usage_tips_enabled !== undefined) {
    if (typeof fields.usage_tips_enabled !== 'boolean') return { error: 'usage_tips_enabled must be a boolean', saves: [], normalized };
    normalized.usage_tips_enabled = fields.usage_tips_enabled;
    saves.push({ name: 'usage_tips_enabled' });
  }
  if (fields.usage_tips_dismissal_cooldown_days !== undefined) {
    if (!isUsageTipsCooldownDays(fields.usage_tips_dismissal_cooldown_days)) return { error: 'usage_tips_dismissal_cooldown_days must be an integer from 1 to 365', saves: [], normalized };
    normalized.usage_tips_dismissal_cooldown_days = fields.usage_tips_dismissal_cooldown_days;
    saves.push({ name: 'usage_tips_dismissal_cooldown_days' });
  }

  return { saves, normalized };
}

export async function extractSettingSaves(fields: SettingFields): Promise<SettingSavesResult> {
  const result = extractUsageTipSettingSaves(fields);
  if (result.error) return result;
  const { saves, normalized } = result;

  if (fields.auto_followup_score_threshold !== undefined) {
    const v = validateStrictInt(fields.auto_followup_score_threshold, 0, 9);
    if (v === null) return { error: 'auto_followup_score_threshold must be an integer between 0 and 9', saves: [], normalized };
    normalized.auto_followup_score_threshold = v;
    saves.push({ name: 'auto_followup_score_threshold' });
  }

  if (fields.auto_resolve_merge_conflicts !== undefined) {
    if (typeof fields.auto_resolve_merge_conflicts !== 'boolean') return { error: 'auto_resolve_merge_conflicts must be a boolean', saves: [], normalized };
    normalized.auto_resolve_merge_conflicts = fields.auto_resolve_merge_conflicts;
    saves.push({ name: 'auto_resolve_merge_conflicts' });
  }

  if (fields.dashboard_summary_enabled !== undefined) {
    if (typeof fields.dashboard_summary_enabled !== 'boolean') return { error: 'dashboard_summary_enabled must be a boolean', saves: [], normalized };
    normalized.dashboard_summary_enabled = fields.dashboard_summary_enabled;
    saves.push({ name: 'dashboard_summary_enabled' });
  }

  if (fields.model_reasoning_level !== undefined) {
    const result = validateModelReasoningLevel(fields.model_reasoning_level);
    if (!result.valid) return { error: result.error, saves: [], normalized };
    normalized.model_reasoning_level = result.value;
    saves.push({ name: 'model_reasoning_level' });
  }

  if (fields.pr_review_model !== undefined) {
    const result = await validatePrReviewModel(fields.pr_review_model);
    if (result.error) return { error: result.error, saves: [], normalized };
    normalized.pr_review_model = result.value!;
    saves.push({ name: 'pr_review_model' });
  }

  if (fields.ultrafix_rating_goal !== undefined) {
    const v = validateStrictInt(fields.ultrafix_rating_goal, 1, 10);
    if (v === null) return { error: 'ultrafix_rating_goal must be an integer between 1 and 10', saves: [], normalized };
    normalized.ultrafix_rating_goal = v;
    saves.push({ name: 'ultrafix_rating_goal' });
  }

  if (fields.ultrafix_max_cycles !== undefined) {
    const v = validateStrictInt(fields.ultrafix_max_cycles, 1, Infinity);
    if (v === null) return { error: 'ultrafix_max_cycles must be a positive integer', saves: [], normalized };
    normalized.ultrafix_max_cycles = v;
    saves.push({ name: 'ultrafix_max_cycles' });
  }

  if (fields.ultrafix_pause_seconds !== undefined) {
    const v = validateStrictInt(fields.ultrafix_pause_seconds, 0, Infinity);
    if (v === null) return { error: 'ultrafix_pause_seconds must be a non-negative integer', saves: [], normalized };
    normalized.ultrafix_pause_seconds = v;
    saves.push({ name: 'ultrafix_pause_seconds' });
  }

  const limitResult = extractRunLimitSettingSaves(fields, result);
  if (limitResult.error) return limitResult;
  return extractEscalationSettingSaves(fields, result);
}

function extractRunLimitSettingSaves(fields: SettingFields, result: SettingSavesResult): SettingSavesResult {
  const { saves, normalized } = result;
  if (fields.default_max_cost_usd !== undefined) {
    const v = validateCostCapUsd(fields.default_max_cost_usd);
    if (v === null) return { error: `default_max_cost_usd must be a number from 0 (no cap) to ${MAX_RUN_COST_CAP_USD}`, saves: [], normalized };
    normalized.default_max_cost_usd = v;
    saves.push({ name: 'default_max_cost_usd' });
  }
  if (fields.ultrafix_ci_wait_timeout_ms !== undefined) {
    const v = validateStrictInt(fields.ultrafix_ci_wait_timeout_ms, 1, Infinity);
    if (v === null) return { error: 'ultrafix_ci_wait_timeout_ms must be a positive integer', saves: [], normalized };
    normalized.ultrafix_ci_wait_timeout_ms = v;
    saves.push({ name: 'ultrafix_ci_wait_timeout_ms' });
  }
  return result;
}

async function extractEscalationSettingSaves(fields: SettingFields, result: SettingSavesResult): Promise<SettingSavesResult> {
  const { saves, normalized } = result;
  if (fields.ultrafix_escalation_enabled !== undefined) {
    if (typeof fields.ultrafix_escalation_enabled !== 'boolean') return { error: 'ultrafix_escalation_enabled must be a boolean', saves: [], normalized };
    normalized.ultrafix_escalation_enabled = fields.ultrafix_escalation_enabled;
    saves.push({ name: 'ultrafix_escalation_enabled' });
  }
  for (const [name, min] of [['ultrafix_escalation_patience', 1], ['ultrafix_escalation_max_reasoning_levels', 0]] as const) {
    if (fields[name] === undefined) continue;
    const value = validateStrictInt(fields[name], min, Infinity);
    if (value === null) return { error: `${name} must be a safe integer >= ${min}`, saves: [], normalized };
    normalized[name] = value;
    saves.push({ name });
  }
  if (fields.ultrafix_escalation_models !== undefined) {
    const models = fields.ultrafix_escalation_models;
    if (!Array.isArray(models) || models.some(m => typeof m !== 'string' || !m.trim())) return { error: 'ultrafix_escalation_models must be an ordered array of nonempty model names', saves: [], normalized };
    for (const model of models) {
      const result = await validatePrReviewModel(model);
      if (result.error) return { error: result.error.replaceAll('pr_review_model', 'ultrafix_escalation_models'), saves: [], normalized };
    }
    normalized.ultrafix_escalation_models = [...new Set(models.map(m => m.trim()))];
    saves.push({ name: 'ultrafix_escalation_models' });
  }

  return { saves, normalized };
}

interface IntegerSettingConfig {
  name: string;
  value: unknown;
  defaultValue: number;
  minimum: number;
  maximum?: number;
}
interface InvalidIntegerSetting {
  name: string;
  value: unknown;
}

function parseStoredIntegerSetting(value: unknown, minimum: number, maximum: number = Number.MAX_SAFE_INTEGER): number | null {
  if (value === undefined || value === null) return null;
  const candidate = typeof value === 'string' && /^-?\d+$/.test(value.trim()) ? Number(value.trim()) : value;
  return typeof candidate === 'number' && Number.isSafeInteger(candidate) && candidate >= minimum && candidate <= maximum ? candidate : null;
}
export function getIntegerSettingOrDefault({ name, value, defaultValue, minimum, maximum = Number.MAX_SAFE_INTEGER }: IntegerSettingConfig): { value: number; invalid?: InvalidIntegerSetting } {
  const parsed = parseStoredIntegerSetting(value, minimum, maximum);
  if (parsed !== null) return { value: parsed };
  if (value === undefined || value === null) return { value: defaultValue };
  return { value: defaultValue, invalid: { name, value } };
}
