import { validatePrReviewModelValue } from '@propr/core';

interface SettingFields {
  auto_followup_score_threshold?: unknown;
  auto_resolve_merge_conflicts?: unknown;
  pr_review_model?: unknown;
  ultrafix_rating_goal?: unknown;
  ultrafix_max_cycles?: unknown;
  ultrafix_pause_seconds?: unknown;
}

export type SettingSaveName =
  | 'auto_followup_score_threshold'
  | 'auto_resolve_merge_conflicts'
  | 'pr_review_model'
  | 'ultrafix_rating_goal'
  | 'ultrafix_max_cycles'
  | 'ultrafix_pause_seconds';

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

export async function extractSettingSaves(fields: SettingFields): Promise<{ error?: string; saves: LabeledSaveDescriptor[]; normalized: Record<string, unknown> }> {
  const saves: LabeledSaveDescriptor[] = [];
  const normalized: Record<string, unknown> = {};

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

  return { saves, normalized };
}
