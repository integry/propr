import { installGoalLifecycleTriggers } from './20261004000000_create_goal_events.js';

export async function up(knex) {
  await installGoalLifecycleTriggers(knex, true);
}

export async function down(knex) {
  await installGoalLifecycleTriggers(knex);
}
