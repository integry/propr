import { definePluginHandler, type PluginEventInput } from '@propr/shared';

/**
 * Example handler: remembers the newest journal event seen per repository (a
 * cursor in `ctx.state`) and, for a task event, logs the task's current state.
 * It only reads, so the plugin's `events.read` and `tasks.read` permissions
 * are enough.
 */
export const recordEvent = definePluginHandler<PluginEventInput, { repository: string; cursor: number }>(async (input, ctx) => {
  const { event } = input;
  const key = `cursor:${event.repository}`;
  const previous = await ctx.state.get<number>(key);
  const cursor = Math.max(previous ?? 0, event.seq);
  await ctx.state.set(key, cursor);
  if (event.domain === 'task' && event.entityId) {
    const task = await ctx.propr.getTask(event.entityId);
    ctx.log.info(`${ctx.settings.greeting ?? 'hello'}: task ${task.taskId} is ${task.state ?? 'unknown'}`, { repository: event.repository, type: event.type });
  } else {
    ctx.log.info(`${event.domain} ${event.type}`, { repository: event.repository, seq: event.seq });
  }
  return { repository: event.repository, cursor };
});
