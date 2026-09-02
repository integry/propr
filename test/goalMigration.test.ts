import assert from 'node:assert/strict';
import { test } from 'node:test';
import knex from 'knex';
import { down, up } from '../packages/core/src/db/migrations/20260902000000_create_goals.js';

test('goal migration stores only the durable owner/session execution envelope', async () => {
    const database = knex({
        client: 'better-sqlite3',
        connection: { filename: ':memory:' },
        useNullAsDefault: true,
    });
    try {
        await up(database);
        const columns = await database('goals').columnInfo();
        assert.deepEqual(
            ['goal_id', 'owner_id', 'repository', 'objective', 'launch_strategy', 'initial_prompt', 'agent_id', 'requested_model', 'desired_state', 'current_task_id', 'session_id', 'worktree_path']
                .filter(column => !columns[column]),
            [],
        );
        assert.equal(columns.output, undefined);
        assert.equal(columns.events, undefined);
        assert.equal(columns.todos, undefined);
        assert.equal(columns.token_usage, undefined);

        const base = {
            goal_id: 'goal-1', owner_id: 'owner-1', owner_login: 'alice', repository: 'acme/repo',
            objective: 'Ship it', launch_strategy: 'direct', initial_prompt: '/goal Ship it',
            agent_id: 'agent-1', agent_alias: 'codex', agent_type: 'codex',
            requested_model: 'gpt-5.6', current_task_id: 'goal-task-1',
        };
        await database('goals').insert(base);
        await assert.rejects(
            database('goals').insert({ ...base, goal_id: 'goal-2' }),
            /unique/i,
        );
        await down(database);
        assert.equal(await database.schema.hasTable('goals'), false);
    } finally {
        await database.destroy();
    }
});
