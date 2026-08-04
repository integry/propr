import { ConfigRouteError, type ConfigLockContext } from './configHelpers.js';

interface SaveThenPublishConfigUpdateOptions {
  save: () => Promise<unknown>;
  publish: () => Promise<void>;
  lock?: ConfigLockContext;
  publicationContext: string;
  committedErrorMessage: string;
  successBody: Record<string, unknown>;
}

export async function saveThenPublishConfigUpdate({
  save,
  publish,
  lock,
  publicationContext,
  committedErrorMessage,
  successBody
}: SaveThenPublishConfigUpdateOptions): Promise<{ status: number; body: Record<string, unknown> }> {
  await lock?.assertLockHeld();
  const saveResult = await save();
  if (saveResult === false) {
    throw new ConfigRouteError(500, {
      error: 'Configuration update was not persisted. No update notification was published.'
    });
  }
  // Persistence is durable once save resolves. Record that before any
  // post-commit notification so a lock loss cannot make the write look retryable.
  lock?.markCommitted();
  try {
    await publish();
  } catch (error) {
    console.error('Post-commit configuration publication failed:', {
      operation: publicationContext,
      committed: true,
    }, error);
    return { status: 500, body: { error: committedErrorMessage, committed: true } };
  }
  return { status: 200, body: successBody };
}
