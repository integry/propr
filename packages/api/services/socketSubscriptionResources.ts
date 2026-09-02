export const MAX_RESOURCE_ROOMS_PER_SOCKET = 100;
export const RESOURCE_ROOM_PREFIXES = ['task:', 'task:live:', 'draft:', 'indexing:', 'goal:'];

const USER_ROOM_PREFIX = 'user:';
const MAX_RESOURCE_ID_LENGTH = 512;

export function normalizeSocketResourceId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > MAX_RESOURCE_ID_LENGTH) return null;
  for (const char of normalized) {
    const codePoint = char.codePointAt(0) ?? 0;
    if (codePoint <= 31 || codePoint === 127) return null;
  }
  return normalized;
}

export function normalizeRepositorySubscription(value: unknown): string | null {
  const normalized = normalizeSocketResourceId(value);
  if (!normalized || !/^[^/\s]+\/[^/\s]+$/.test(normalized)) return null;
  return normalized;
}

export function userRoom(userId: string): string {
  return `${USER_ROOM_PREFIX}${userId}`;
}

export function taskRoom(taskId: string): string {
  return `task:${encodeURIComponent(taskId)}`;
}

export function goalRoom(goalId: string): string {
  return `goal:${encodeURIComponent(goalId)}`;
}
