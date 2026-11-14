/**
 * Bookkeeping of one admission attempt's wait: the reason the acquire did not
 * admit (logged and reported on every change) and the report-only detail of
 * its token (alias, task, reason; see `agentAdmissionDetailsKey`), which the
 * capacity report reads. No admission decision depends on anything here, and
 * a failed detail write is ignored.
 */
import logger from '../utils/logger.js';

/** Why an acquire attempt did not admit: the global limit, the alias's own
 * ceiling, or a holder whose removal is still unconfirmed. */
export type AgentAdmissionWaitReason = 'global_limit' | 'alias_limit' | 'recovering';
const WAIT_REASONS: Record<number, AgentAdmissionWaitReason> = { 0: 'recovering', 2: 'global_limit', 3: 'alias_limit' };

const DETAIL_SCRIPT = `if ARGV[1] == 'set' then return redis.call('HSET', KEYS[1], ARGV[2], ARGV[3]) end
return redis.call('HDEL', KEYS[1], ARGV[2])`;

export type AdmissionDetailWriter = (token: string, detail?: Record<string, unknown>) => Promise<void>;

/** Sets (or, without a detail, removes) a token's detail. Best effort. */
export function admissionDetailWriter(client: { eval(script: string, keys: number, ...args: (string | number)[]): Promise<unknown> }, key: string): AdmissionDetailWriter {
    return async (token, detail) => {
        try { await client.eval(DETAIL_SCRIPT, 1, key, detail ? 'set' : 'del', token, detail ? JSON.stringify(detail) : ''); }
        catch (error) { logger.debug({ error: String(error) }, 'Could not record agent admission detail'); }
    };
}

export interface AdmissionWaitTrackerOptions {
    token: string;
    alias: string;
    taskId?: string;
    /** Fields of the waiting log line: instance, limits and the alias. */
    fields: Record<string, string | number | null>;
    write: AdmissionDetailWriter;
    onWaiting?: (reason: AgentAdmissionWaitReason) => void;
}

export function admissionWaitTracker(options: AdmissionWaitTrackerOptions) {
    const { token, write } = options;
    const base = { ...(options.alias ? { alias: options.alias } : {}), ...(options.taskId ? { taskId: options.taskId } : {}) };
    const since = Date.now();
    let current: AgentAdmissionWaitReason | undefined;
    // The current detail: the last reason (none yet: starting) and the original start.
    const detail = () => ({ ...base, since, ...(current ? { reason: current } : {}) });
    return {
        /**
         * Call after each join or refresh of the waiting set: republishes the
         * current detail. The report drops details of tokens it finds neither
         * waiting nor holding, so a token whose waiting entry lapsed during an
         * awaited step (a recovery's Docker removal can outlast the entry's
         * deadline) is reported again with its alias, task and reason here,
         * even when its next refusal has the same reason.
         */
        async joined() { await write(token, detail()); },
        /** Maps a non-admitting acquire reply to its reason; logs, reports and records each change. */
        async observe(result: unknown) {
            const reason = WAIT_REASONS[result as number];
            if (!reason) throw new Error('Unexpected agent admission reply');
            if (reason === current) return;
            current = reason;
            // `reason` is kept for existing log queries; `waitReason` names the same value.
            logger.info({ ...options.fields, reason, waitReason: reason }, 'Physical agent admission waiting');
            options.onWaiting?.(reason);
            await write(token, detail());
        },
        /** A holder now: recorded before the token leaves the waiting set. */
        async admitted() { await write(token, { ...base, since: Date.now() }); },
        /** For the admitted log line: the last reason waited for (null: admitted at once) and for how long. */
        summary: () => ({ waitReason: current ?? null, waitedMs: Date.now() - since }),
    };
}
