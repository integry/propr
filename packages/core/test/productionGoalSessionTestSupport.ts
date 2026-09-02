import Database from 'better-sqlite3';
import knex from 'knex';
import type { GoalSessionRecoveryPort } from '../src/agents/goalSession/runtimePorts.js';

export const recovery: GoalSessionRecoveryPort = {
    inspectContainer: async () => ({ status: 'missing', reason: 'test' }),
    inspectRepository: async repository => ({ ...repository, exists: true }),
};

/** Runs the real #2018 foundation/replay migrations and the runtime leaf. */
export async function createProductionSchema(filename: string): Promise<void> {
    const client = knex({ client: 'better-sqlite3', connection: { filename }, useNullAsDefault: true });
    try {
        const foundation = await import('../src/db/migrations/20260831000000_create_goal_control_plane.js');
        const replay = await import('../src/db/migrations/20260901000000_add_durable_goal_replay.js');
        const runtime = await import('../src/db/migrations/20260902000000_extend_goal_control_provider_effects.js');
        await foundation.up(client);
        await replay.up(client);
        await runtime.up(client);
    } finally {
        await client.destroy();
    }
}

export function seedAuthoritativeGoal(
    database: Database.Database,
    options: { goalId: string; agent: string; model?: string; leaseEpoch?: number },
): void {
    const now = new Date().toISOString();
    database.prepare(`INSERT INTO goals
        (goal_id, owner_user_id, repository, objective, state, agent, requested_model,
            effective_model, lease_owner, lease_epoch, lease_expires_at, created_at, updated_at)
        VALUES (?, 'test-owner', 'integry/propr', 'runtime composition test', 'running', ?, ?, ?,
            'runtime-controller', ?, ?, ?, ?)`)
        .run(options.goalId, options.agent, options.model ?? 'model-a', options.model ?? 'model-a',
            options.leaseEpoch ?? 1, new Date(Date.now() + 60_000).toISOString(), now, now);
    database.prepare(`INSERT OR IGNORE INTO goal_event_state
        (goal_id, high_watermark, min_retained_sequence, projection_sequence, checkpoint_sequence, updated_at)
        VALUES (?, 0, 1, 0, 0, ?)`).run(options.goalId, now);
}
