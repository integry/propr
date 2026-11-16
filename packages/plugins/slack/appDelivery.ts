import { PluginDeliveryError, type PluginContext, type PluginEventInput } from '@propr/shared';
import { MUTED_DESTINATION, type ChatDeliveryResult } from '../_shared/chatDelivery.js';
import { eventName } from '../_shared/eventSelection.js';
import { NOTIFICATION_SETTINGS, buildNotification } from '../_shared/notifications.js';
import { SlackApiError, deliveryFailure, postMessage } from './api.js';
import { slackMessage } from './format.js';
import { repositoryChannel } from './mentions.js';
import { findThread, forgetThread, rememberThread } from './threads.js';

/**
 * Slack app mode, outbound: each selected event is posted with the bot token
 * (`chat.postMessage`) to the repository's channel, in one thread per pull
 * request. The first message about a pull request starts its thread (or, for
 * an issue created from a mention, the mention's thread is used); later
 * events about it reply there. The message itself is the same as in
 * incoming-webhook mode.
 */

/** Whether Repository destinations mutes the repository (`none`); the webhook names in it do not apply to app mode. */
function muted(ctx: PluginContext, repository: string): boolean {
  const map = ctx.settings[NOTIFICATION_SETTINGS.repositoryDestinations];
  const name = repository.toLowerCase();
  const entry = map && typeof map === 'object' && !Array.isArray(map) ? Object.entries(map).find(([key]) => key.toLowerCase() === name)?.[1] : undefined;
  return typeof entry === 'string' && entry.trim().toLowerCase() === MUTED_DESTINATION;
}

export interface AppDeliveryResult extends ChatDeliveryResult { thread: 'new' | 'reused' | null }

export async function deliverAppNotification(input: PluginEventInput, ctx: PluginContext): Promise<AppDeliveryResult> {
  const { event } = input;
  const name = eventName(event);
  const notification = buildNotification(event, ctx.settings);
  if (!notification) return { event: name, kind: null, destination: null, skipped: 'not_selected', thread: null };
  if (muted(ctx, event.repository)) return { event: name, kind: notification.kind, destination: null, skipped: 'muted', thread: null };

  const found = await findThread(ctx, event.repository, event.prNumber, event.issueNumber);
  const channel = found?.thread.c ?? repositoryChannel(ctx.settings, event.repository);
  if (!channel) {
    throw new PluginDeliveryError(`No Slack channel is set for ${notification.repository}. Map it in Repository channels or set Default channel`, { permanent: true });
  }
  const message = slackMessage(notification) as { text: string; blocks: never };
  let posted;
  let reused = Boolean(found);
  try {
    posted = await postMessage(ctx, channel, message, found?.thread.t);
  } catch (error) {
    if (!(found && error instanceof SlackApiError && error.code === 'thread_not_found')) throw deliveryFailure(error, `the message to channel ${channel}`);
    // The thread's first message was deleted: forget it and start a new thread.
    await forgetThread(ctx, event.repository, (found.via === 'pull_request' ? event.prNumber : event.issueNumber)!, found.via);
    reused = false;
    try { posted = await postMessage(ctx, repositoryChannel(ctx.settings, event.repository) ?? channel, message); } catch (retry) { throw deliveryFailure(retry, `the message to channel ${channel}`); }
  }
  const root = reused ? found!.thread.t : posted.ts;
  // The pull request keeps the thread it was first posted in; an issue's thread is reused by its pull request.
  if (event.prNumber !== null && (!reused || found!.via === 'issue')) await rememberThread(ctx, event.repository, event.prNumber, 'pull_request', posted.channel, root);
  else if (event.prNumber === null && event.issueNumber !== null && !reused) await rememberThread(ctx, event.repository, event.issueNumber, 'issue', posted.channel, root);
  ctx.log.info(`Posted ${notification.kind} to Slack${reused ? ' in its thread' : ''}`, { channel: posted.channel, threaded: reused });
  return { event: name, kind: notification.kind, destination: posted.channel, skipped: null, thread: reused ? 'reused' : 'new' };
}
