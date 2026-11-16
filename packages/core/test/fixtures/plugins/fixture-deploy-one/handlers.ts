import type { PluginCommandInput, PluginContext } from '@propr/shared';

/**
 * Test fixture handler for packages/core/test/pluginCommandDelivery.test.ts:
 * records each command delivery in `ctx.state` key `seen` and comments back
 * on the issue or pull request it was run on. `/deploy fail` throws, for the
 * retry path. Imports only @propr/shared types.
 */
type Seen = { id: string; command: string; args: string; repository: string; number: number; target: string; actor: string; attempt: number }[];

export async function deploy(input: PluginCommandInput, ctx: PluginContext) {
  const seen = (await ctx.state.get<Seen>('seen')) ?? [];
  seen.push({ id: input.deliveryId, command: input.command, args: input.args, repository: input.repository, number: input.number, target: input.target, actor: input.actor, attempt: input.attempt });
  await ctx.state.set('seen', seen);
  if (input.args === 'fail') throw new Error('deploy failed on purpose');
  const body = `Deploying for @${input.actor} (/${input.command})`;
  if (input.target === 'pull_request') await ctx.propr.commentOnPullRequest(input.repository, input.number, body);
  else await ctx.propr.commentOnIssue(input.repository, input.number, body);
  ctx.log.info(`/${input.command} on ${input.repository}#${input.number}`);
  return { deployed: true };
}

/** `/deploy-one-status`: a handler command of the same kind as /deploy that is not one of its specific commands. */
export async function status(input: PluginCommandInput, ctx: PluginContext) {
  ctx.log.info(`/${input.command} status on ${input.repository}#${input.number}`);
  return { status: 'idle' };
}
