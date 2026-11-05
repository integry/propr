import type { Knex } from 'knex';
import {
  isUsageTipEventId, parseUsageTipCandidates, parseUsageTipsSettings, resolveUsageTips, USAGE_TIPS_BY_ID,
  type UsageTipSelection, type UsageTipDismissal, type UsageTipsResponse,
} from '@propr/shared';

function validateSelection(selection: UsageTipSelection): UsageTipSelection {
  if (!Number.isSafeInteger(selection.rotationEpoch) || selection.rotationEpoch < 0
    || !Number.isSafeInteger(selection.generatedAt) || selection.generatedAt < 0
    || !['model', 'heuristic'].includes(selection.source)
    || (selection.model !== null && (typeof selection.model !== 'string' || !selection.model.trim() || selection.model.length > 512))
    || (selection.source === 'model' && selection.model === null)
    || !selection.signals || typeof selection.signals !== 'object' || Array.isArray(selection.signals)
    || Object.values(selection.signals).some(v => v !== null && typeof v !== 'boolean' && !(typeof v === 'number' && Number.isFinite(v) && v >= 0))) {
    throw new Error('Invalid usage tip selection metadata');
  }
  return { ...selection, candidates: parseUsageTipCandidates(selection.candidates) };
}

export class UsageTipDismissalConflict extends Error {}
export function createUsageTipsStore(database: Knex, now = Date.now) {
  const settings = async () => {
    const rows = await database('system_configs').where({ key: 'usage_tips_enabled' }).select('key', 'value');
    return parseUsageTipsSettings(Object.fromEntries(rows.map(row => {
      try { return [row.key, JSON.parse(row.value)]; } catch { return [row.key, null]; }
    })));
  };
  const current = async (): Promise<UsageTipSelection | null> => {
    const row = await database('usage_tip_selection').where({ id: 1 }).first();
    if (!row) return null;
    try {
      return validateSelection({ candidates: JSON.parse(row.candidates), signals: JSON.parse(row.signals), model: row.model,
        source: row.source, generatedAt: row.generated_at, rotationEpoch: row.rotation_epoch });
    } catch { return null; }
  };
  return {
    settings, current,
    async get(userId: string): Promise<UsageTipsResponse> {
      const config = await settings();
      if (!config.enabled) return { enabled: false, tips: [] };
      const selection = await current();
      if (!selection) return { enabled: true, tips: [] };
      const ids = selection.candidates.map(c => c.id);
      const dismissals: UsageTipDismissal[] = ids.length ? await database('usage_tip_dismissals')
        .where({ user_id: userId }).whereIn('tip_id', ids).select('tip_id', 'dismissed_at', 'dismissal_count') : [];
      return { enabled: true, tips: resolveUsageTips(selection.candidates, dismissals, now()) };
    },
    async persist(selection: UsageTipSelection, previousEpoch: number | null): Promise<boolean> {
      selection = validateSelection(selection);
      // CAS fences stale workers even if a lease expires between checking and SQL.
      const row = { candidates: JSON.stringify(parseUsageTipCandidates(selection.candidates)), signals: JSON.stringify(selection.signals),
        model: selection.model, source: selection.source, generated_at: selection.generatedAt, rotation_epoch: selection.rotationEpoch };
      if (selection.rotationEpoch !== (previousEpoch ?? -1) + 1) throw new Error('Invalid next epoch');
      if (previousEpoch === null) {
        const result = await database('usage_tip_selection').insert({ id: 1, ...row }).onConflict('id').ignore().returning('id');
        return result.length > 0;
      }
      return (await database('usage_tip_selection').where({ id: 1, rotation_epoch: previousEpoch }).update(row)) === 1;
    },
    async dismiss(userId: string, tipId: string, eventId: string): Promise<void> {
      if (!userId.trim() || !USAGE_TIPS_BY_ID.has(tipId) || !isUsageTipEventId(eventId)) throw new Error('Invalid dismissal');
      await database.transaction(async trx => {
        const inserted = await trx('usage_tip_dismissal_events').insert({ user_id: userId, tip_id: tipId, event_id: eventId })
          .onConflict(['user_id', 'event_id']).ignore().returning('event_id');
        if (!inserted.length) {
          const previous = await trx('usage_tip_dismissal_events').where({ user_id: userId, event_id: eventId }).first('tip_id');
          if (previous.tip_id !== tipId) throw new UsageTipDismissalConflict('Event already belongs to a different tip');
          return;
        }
        const dismissedAt = now();
        await trx('usage_tip_dismissals').insert({ user_id: userId, tip_id: tipId, dismissed_at: dismissedAt, dismissal_count: 1 })
          .onConflict(['user_id', 'tip_id']).merge({ dismissed_at: dismissedAt, dismissal_count: trx.raw('dismissal_count + 1') });
      });
    },
  };
}
