import type { SocketPrincipal } from '../auth.js';
import type { QueueDependencies } from './socketService.js';

export async function taskExists(
  getDependencies: () => QueueDependencies | null,
  taskId: string
): Promise<boolean> {
  const dependencies = getDependencies();
  if (!dependencies) return false;
  try {
    const stateKey = `${dependencies.workerStateOptions?.keyPrefix ?? 'worker:state:'}${taskId}`;
    if (await dependencies.redisClient.get(stateKey)) return true;
    return Boolean(await dependencies.db('tasks').select('task_id').where({ task_id: taskId }).first());
  } catch (error) {
    console.error(`[SocketService] Failed to authorize task subscription for ${taskId}:`, error);
    return false;
  }
}

export async function ownsDraft(
  getDependencies: () => QueueDependencies | null,
  principal: SocketPrincipal,
  draftId: string
): Promise<boolean> {
  try {
    const dependencies = getDependencies();
    if (!dependencies) return false;
    const draft = await dependencies.db('task_drafts').select('user_id')
      .where({ draft_id: draftId }).first() as { user_id?: string } | undefined;
    return draft?.user_id === principal.user.id;
  } catch (error) {
    console.error(`[SocketService] Failed to authorize draft subscription for ${draftId}:`, error);
    return false;
  }
}

export async function canAccessRepositoryIndexing(
  getDependencies: () => QueueDependencies | null,
  principal: SocketPrincipal,
  repository: string
): Promise<boolean> {
  if (!principal.authorization.permissions.includes('instance.manage_settings')) return false;
  try {
    const dependencies = getDependencies();
    if (!dependencies) return false;
    return Boolean(await dependencies.db('repositories').select('full_name')
      .where({ full_name: repository }).first());
  } catch (error) {
    console.error(`[SocketService] Failed to authorize indexing subscription for ${repository}:`, error);
    return false;
  }
}
