import { definePluginHandler, type PluginCommandInput, type PluginEventInput } from '@propr/shared';

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

/**
 * Example command handler (`/example-status`): logs who ran the command, on
 * which issue or pull request, and how long the argument was (the argument is
 * untrusted text, so it is not logged), and returns the context. It starts no
 * task and needs no permission.
 */
export const reportCommand = definePluginHandler<PluginCommandInput, { repository: string; number: number; target: string; actor: string }>(async (input, ctx) => {
  ctx.log.info(`/${input.command} by @${input.actor} on ${input.repository}#${input.number}`, { target: input.target, argumentLength: input.args.length, attempt: input.attempt });
  return { repository: input.repository, number: input.number, target: input.target, actor: input.actor };
});
