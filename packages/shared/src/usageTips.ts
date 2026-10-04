import catalog from './usageTips.catalog.json' with { type: 'json' };

export const MAX_SELECTED_USAGE_TIPS = 3;
export const MAX_USAGE_TIP_CANDIDATES = 30;
export const DEFAULT_USAGE_TIPS_COOLDOWN_DAYS = 45;
export const USAGE_TIPS_DAY_MS = 86_400_000;
export const USAGE_TIP_KINDS = ['corrective', 'discovery'] as const;
export type UsageTipKind = typeof USAGE_TIP_KINDS[number];
export function isUsageTipKind(value: unknown): value is UsageTipKind {
  return value === 'corrective' || value === 'discovery';
}
export interface UsageTip {
  id: string; kind: UsageTipKind; topic: string; title: string; body: string; docPath: string; docUrl: string; signalHints: string[];
}
export const USAGE_TIPS_CATALOG: readonly UsageTip[] = catalog.map(tip => {
  if (!isUsageTipKind(tip.kind)) throw new Error(`Invalid usage tip kind: ${tip.id}`);
  return { ...tip, kind: tip.kind };
});
export const USAGE_TIPS_BY_ID = new Map(USAGE_TIPS_CATALOG.map(tip => [tip.id, tip]));
export function usageTipKind(id: string): UsageTipKind | undefined {
  return USAGE_TIPS_BY_ID.get(id)?.kind;
}
/** reason is the signal-grounded, user-facing recommendation and workflow benefit. */
export interface UsageTipCandidate { id: string; score: number; reason: string }
export interface UsageTipDismissal { tip_id: string; dismissed_at: number; dismissal_count: number }
export type UsageTipSignals = Record<string, number | boolean | null>;
export interface UsageTipSelection {
  candidates: UsageTipCandidate[];
  model: string | null;
  source: 'model' | 'heuristic';
  generatedAt: number;
  signals: UsageTipSignals;
  rotationEpoch: number;
}
export interface UsageTipsResponse { enabled: boolean; tips: UsageTip[] }
export function isUsageTipsCooldownDays(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 365;
}
export function parseUsageTipsSettings(values: Record<string, unknown>) {
  return {
    enabled: values.usage_tips_enabled !== false && values.usage_tips_enabled !== 'false',
    cooldownDays: isUsageTipsCooldownDays(values.usage_tips_dismissal_cooldown_days)
      ? values.usage_tips_dismissal_cooldown_days : DEFAULT_USAGE_TIPS_COOLDOWN_DAYS,
  };
}
export function usageTipCooldownDays(baseDays: number, count: number): number {
  if (!isUsageTipsCooldownDays(baseDays) || !Number.isSafeInteger(count) || count < 1) throw new Error('Invalid cooldown');
  return Math.min(3650, baseDays * 4 ** Math.min(count - 1, 6));
}
export function isUsageTipEligible(dismissal: UsageTipDismissal | undefined, baseDays: number, now: number): boolean {
  if (!dismissal) return true;
  if (!Number.isSafeInteger(dismissal.dismissed_at) || dismissal.dismissed_at < 0 || !Number.isSafeInteger(dismissal.dismissal_count) || dismissal.dismissal_count < 1) return false;
  return now >= dismissal.dismissed_at + usageTipCooldownDays(baseDays, dismissal.dismissal_count) * USAGE_TIPS_DAY_MS;
}
/** Strict shape validation; unknown catalog identities are safely discarded. */
export function parseUsageTipCandidates(raw: unknown): UsageTipCandidate[] {
  if (!Array.isArray(raw) || raw.length > MAX_USAGE_TIP_CANDIDATES) throw new Error('Invalid candidate pool');
  const seen = new Set<string>();
  const candidates: UsageTipCandidate[] = [];
  for (const value of raw) {
    if (!value || typeof value !== 'object' || typeof value.id !== 'string') throw new Error('Invalid candidate');
    if (!USAGE_TIPS_BY_ID.has(value.id)) continue;
    if (!Number.isInteger(value.score) || value.score < 1 || value.score > 100 || typeof value.reason !== 'string'
      || !value.reason.trim() || value.reason.length > 240) throw new Error('Invalid score or reason');
    if (!seen.has(value.id)) candidates.push({ id: value.id, score: value.score, reason: value.reason.trim() });
    seen.add(value.id);
  }
  return candidates;
}
export function rotateUsageTipCandidates(candidates: UsageTipCandidate[], epoch: number): UsageTipCandidate[] {
  if (!Number.isSafeInteger(epoch) || epoch < 0) throw new Error('Invalid rotation epoch');
  const bands = new Map<number, UsageTipCandidate[]>();
  for (const candidate of parseUsageTipCandidates(candidates)) {
    // Keep the existing ten-point bands, splitting the 71–80 boundary so an
    // urgent score of 80 never rotates behind a discovery score of 70–79.
    const band = Math.floor((candidate.score - 1) / 10) * 2 + Number(candidate.score >= 80);
    bands.set(band, [...(bands.get(band) ?? []), candidate]);
  }
  return [...bands.entries()].sort(([a], [b]) => b - a).flatMap(([, band]) => {
    band.sort((a, b) => a.id.localeCompare(b.id, 'en'));
    const offset = epoch % band.length;
    return [...band.slice(offset), ...band.slice(0, offset)];
  });
}
export function resolveUsageTips(candidates: UsageTipCandidate[], dismissals: UsageTipDismissal[], baseDays: number, now: number): UsageTip[] {
  const byId = new Map(dismissals.map(d => [d.tip_id, d]));
  const pool = parseUsageTipCandidates(candidates);
  const eligible = pool.filter(c => isUsageTipEligible(byId.get(c.id), baseDays, now));
  const selected = new Set<string>();
  // Derive slots from the saved pool before cooldowns, so dismissals retain
  // the same kind allocation across reads without recording display history.
  for (const slot of mixUsageTipKinds(pool)) {
    const next = eligible.find(c => !selected.has(c.id) && usageTipKind(c.id) === usageTipKind(slot.id));
    if (next) selected.add(next.id);
  }
  // Transfer unfilled slots only after exhausting their original kind.
  for (const candidate of eligible) {
    if (selected.size >= MAX_SELECTED_USAGE_TIPS) break;
    selected.add(candidate.id);
  }
  return eligible.filter(c => selected.has(c.id)).map(c => ({ ...USAGE_TIPS_BY_ID.get(c.id)!, body: c.reason }));
}
/** Reserve a slot for each eligible kind without reordering the rotated pool. */
export function mixUsageTipKinds(candidates: UsageTipCandidate[]): UsageTipCandidate[] {
  const kinds = new Set(candidates.map(c => usageTipKind(c.id)));
  const perKind = kinds.has('corrective') && kinds.has('discovery') ? MAX_SELECTED_USAGE_TIPS - 1 : MAX_SELECTED_USAGE_TIPS;
  const counts = new Map<UsageTipKind, number>();
  return candidates.filter(c => {
    const kind = usageTipKind(c.id);
    if (!kind || (counts.get(kind) ?? 0) >= perKind) return false;
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
    return true;
  }).slice(0, MAX_SELECTED_USAGE_TIPS);
}
export function isUsageTipEventId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
