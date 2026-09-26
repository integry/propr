import assert from 'node:assert/strict';
import { test } from 'node:test';
import knex from 'knex';
import { down, up } from '../packages/core/src/db/migrations/20260902000000_create_goals.js';
import { down as downHardening, up as upHardening } from '../packages/core/src/db/migrations/20260902010000_harden_native_goals.js';
import { down as downCheckpoints, up as upCheckpoints } from '../packages/core/src/db/migrations/20260903000000_add_direct_goal_checkpoints.js';
import { down as downDeclarations, up as upDeclarations } from '../packages/core/src/db/migrations/20260906000000_add_goal_checkpoint_declarations.js';
import { down as downGoalTitles, up as upGoalTitles } from '../packages/core/src/db/migrations/20260907000000_add_goal_titles.js';
import { down as downGoalAttachments, up as upGoalAttachments } from '../packages/core/src/db/migrations/20260908000000_add_goal_attachments.js';
import { down as downGoalAttachmentsRepair, up as upGoalAttachmentsRepair } from '../packages/core/src/db/migrations/20260908010000_ensure_goal_attachments.js';
import { down as downGoalInputDisplayBody, up as upGoalInputDisplayBody } from '../packages/core/src/db/migrations/20260923000000_add_goal_input_display_body.js';

test('goal migration stores only the durable owner/session execution envelope', async () => {
    const database = knex({
        client: 'better-sqlite3',
        connection: { filename: ':memory:' },
        useNullAsDefault: true,
        });
    try {
        await up(database);
        await upHardening(database);
        const base = {
            goal_id: 'goal-1', owner_id: 'owner-1', owner_login: 'alice', repository: 'acme/repo',
            objective: 'Ship it', launch_strategy: 'direct', initial_prompt: '/goal Ship it',
            agent_id: 'agent-1', agent_alias: 'codex', agent_type: 'codex',
            requested_model: 'gpt-5.6', current_task_id: 'goal-task-1',
        };
        await database('goals').insert(base);
        await upCheckpoints(database);
        await upDeclarations(database);
        await upGoalTitles(database);
        await upGoalAttachments(database);
        await upGoalAttachmentsRepair(database);
        await upGoalInputDisplayBody(database);
        const columns = await database('goals').columnInfo();
        assert.deepEqual(
            ['goal_id', 'owner_id', 'repository', 'title', 'objective', 'launch_strategy', 'initial_prompt', 'agent_id', 'requested_model', 'desired_state', 'current_task_id', 'session_id', 'worktree_path']
                .filter(column => !columns[column]),
            [],
        );
        assert.deepEqual(
            ['run_claim', 'claimed_at', 'attempt_heartbeat_at', 'active_turn_id', 'pause_confirmed_at', 'resume_requested', 'create_idempotency_key', 'create_idempotency_operation', 'create_payload_hash', 'control_generation', 'control_ack_generation', 'task_reconciled_at', 'failure_reason', 'artifact_stats']
                .filter(column => !columns[column]),
            [],
        );
        const inputColumns = await database('goal_inputs').columnInfo();
        assert.deepEqual(
            ['sequence', 'input_id', 'goal_id', 'owner_id', 'idempotency_key', 'operation', 'payload_hash', 'kind', 'message', 'display_message', 'attachment_count', 'state', 'delivered_generation', 'delivered_claim', 'delivered_turn_id', 'delivery_error']
                .filter(column => !inputColumns[column]),
            [],
        );
        assert.deepEqual(
            ['checkpoint_interval_minutes', 'last_checkpoint_at', 'last_checkpoint_commit_sha', 'checkpoint_count', 'checkpoint_error']
                .filter(column => !columns[column]),
            [],
        );
        assert.ok(columns.attachments);
        const checkpointColumns = await database('goal_checkpoints').columnInfo();
        assert.deepEqual(
            ['checkpoint_id', 'goal_id', 'owner_id', 'idempotency_key', 'operation', 'payload_hash', 'kind', 'commit_message', 'include_paths', 'exclude_paths', 'summary', 'state', 'requested_generation', 'requested_claim', 'delivered_turn_id', 'commit_sha', 'pr_number', 'pr_url', 'error']
                .filter(column => !checkpointColumns[column]),
            [],
        );
        assert.equal(columns.output, undefined);
        assert.equal(columns.events, undefined);
        assert.equal(columns.todos, undefined);
        assert.equal(columns.token_usage, undefined);
        const migrated = await database('goals').where({ goal_id: 'goal-1' }).first();
        assert.equal(migrated.checkpoint_interval_minutes, 15);
        assert.ok(migrated.last_checkpoint_at);
        await assert.rejects(
            database('goals').insert({ ...base, goal_id: 'goal-2' }),
            /unique/i,
        );
        await downGoalInputDisplayBody(database);
        assert.equal((await database('goal_inputs').columnInfo()).display_message, undefined);
        await downGoalAttachmentsRepair(database);
        await downGoalAttachments(database);
        await downGoalTitles(database);
        await downDeclarations(database);
        await downCheckpoints(database);
        await downHardening(database);
        await down(database);
        assert.equal(await database.schema.hasTable('goals'), false);
    } finally {
        await database.destroy();
    }
});

test('goal attachment repair migration restores a missing attachments column', async () => {
    const database = knex({
        client: 'better-sqlite3',
        connection: { filename: ':memory:' },
        useNullAsDefault: true,
    });
    try {
        await up(database);
        await upHardening(database);
        await database('goals').insert({
            goal_id: 'goal-without-attachments',
            owner_id: 'owner-1',
            owner_login: 'alice',
            repository: 'acme/repo',
            objective: 'Ship it',
            launch_strategy: 'direct',
            initial_prompt: '/goal Ship it',
            agent_id: 'agent-1',
            agent_alias: 'codex',
            agent_type: 'codex',
            requested_model: 'gpt-5.6',
            current_task_id: 'goal-task-1',
        });

        assert.equal(await database.schema.hasColumn('goals', 'attachments'), false);
        await upGoalAttachmentsRepair(database);
        assert.equal(await database.schema.hasColumn('goals', 'attachments'), true);
        assert.equal(
            (await database('goals').where({ goal_id: 'goal-without-attachments' }).first()).attachments,
            '[]',
        );

        await upGoalAttachmentsRepair(database);
        await downGoalAttachmentsRepair(database);
        assert.equal(await database.schema.hasColumn('goals', 'attachments'), true);
    } finally {
        await database.destroy();
    }
});
