import { db, logger, handleError } from '@propr/core';

// The generated context and the cached per-file preview (`context_config.contextCache`)
// are only needed while a draft is being actively planned/refined. Both are optional
// enrichment at read time and are regenerated on demand, so we reclaim them once a draft
// has been idle past the TTL. This keeps per-draft storage bounded instead of open-ended.
const DRAFT_CONTEXT_TTL_HOURS = parseInt(process.env.DRAFT_CONTEXT_TTL_HOURS || '24', 10);

/**
 * Null out `generated_context` and drop `context_config.contextCache` on drafts that have
 * been idle (no update) for longer than the TTL. Idempotent — drafts already swept no
 * longer match the predicate. Returns the number of rows reclaimed.
 */
export async function sweepDraftContext(): Promise<number> {
    try {
        const affected = await db('task_drafts')
            .where('updated_at', '<', db.raw(`datetime('now', ?)`, [`-${DRAFT_CONTEXT_TTL_HOURS} hours`]))
            .andWhere(function () {
                this.whereNotNull('generated_context')
                    .orWhereRaw(`json_extract(context_config, '$.contextCache') IS NOT NULL`);
            })
            .update({
                generated_context: null,
                context_config: db.raw(`json_remove(context_config, '$.contextCache')`),
            });

        if (affected > 0) {
            // Hand the now-free pages back to the OS. No-op unless the DB is in
            // auto_vacuum=INCREMENTAL mode (see the set_incremental_auto_vacuum migration).
            await db.raw('PRAGMA incremental_vacuum;');
            logger.info({ reclaimed: affected, ttlHours: DRAFT_CONTEXT_TTL_HOURS }, 'Swept stale draft context');
        } else {
            logger.debug({ ttlHours: DRAFT_CONTEXT_TTL_HOURS }, 'Draft context sweep found nothing to reclaim');
        }
        return affected;
    } catch (error) {
        handleError(error, 'Failed to sweep stale draft context');
        return 0;
    }
}
