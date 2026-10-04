async function backfillEventReferences(knex, event) {
  const target = JSON.parse(event.target_json);
  const metadata = JSON.parse(event.metadata_json || '{}');
  let taskId = target.taskId || metadata.completedImplementationTaskId;
  if (!taskId && (event.kind === 'pull_request' || event.kind === 'review')) {
    // The event timestamp is the source task transition timestamp. Requiring
    // both that transition and the PR identity avoids linking old fixes to
    // a newer implementation or a different repository's PR with the same number.
    const matches = await knex('tasks as task')
      .join('task_history as history', 'history.task_id', 'task.task_id')
      .where('task.repository', target.repository)
      .where('history.timestamp', event.occurred_at)
      .where('history.state', 'completed')
      .whereRaw(`COALESCE(task.pr_number,
        json_extract(task.initial_job_data, '$.pullRequestNumber'),
        json_extract(task.initial_job_data, '$.prNumber'),
        json_extract(history.metadata, '$.prResult.prNumber'),
        json_extract(history.metadata, '$.prNumber')) = ?`, [target.prNumber])
      .whereRaw(`(task.task_type = 'review' OR json_extract(history.metadata, '$.commandMode') IS 'review') = ?`, [event.kind === 'review' ? 1 : 0])
      .distinct('task.task_id').limit(2);
    if (matches.length === 1) {
      taskId = matches[0].task_id;
      if (event.kind === 'review') target.taskId = taskId;
      else metadata.completedImplementationTaskId = taskId;
    }
  }
  if (taskId && !metadata.goalId) {
    const task = await knex('tasks').where({ task_id: taskId, repository: target.repository, task_type: 'goal' }).first();
    const goalId = task && JSON.parse(task.initial_job_data || '{}').goalId;
    if (typeof goalId === 'string' && goalId.trim()) metadata.goalId = goalId;
  }
  const targetJson = JSON.stringify(target);
  const metadataJson = Object.keys(metadata).length ? JSON.stringify(metadata) : event.metadata_json;
  if (targetJson !== event.target_json || metadataJson !== event.metadata_json) {
    await knex('notification_events').where({ event_id: event.event_id })
      .update({ target_json: targetJson, metadata_json: metadataJson });
  }
}

/** Recover producer references without guessing from the latest task on a PR. */
export async function up(knex) {
  const triggerName = 'notification_events_immutable_update';
  const trigger = await knex('sqlite_master').where({ type: 'trigger', name: triggerName }).first();
  if (!trigger?.sql) throw new Error(`Missing required trigger ${triggerName}`);
  await knex.raw(`DROP TRIGGER ${triggerName}`);
  try {
    let after = '';
    for (;;) {
      const events = await knex('notification_events')
        .whereIn('kind', ['task', 'review', 'pull_request'])
        .where('event_id', '>', after).orderBy('event_id').limit(250);
      if (!events.length) break;
      for (const event of events) {
        await backfillEventReferences(knex, event);
      }
      after = events[events.length - 1].event_id;
    }
  } finally {
    await knex.raw(trigger.sql);
  }
}

// Recovered references remain valid for older clients; do not discard audit context.
export async function down() {}
