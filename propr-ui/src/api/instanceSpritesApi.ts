import { API_BASE_URL, apiFetch, handleApiResponse } from './apiClient';

/** `GET /api/admin/sprites`: the Sprites this instance created (`propr-<marker>-*`). */
export interface InstanceSprites {
  configured: boolean;
  prefix: string | null;
  count: number;
  busy: number;
  sprites: Array<{ name: string; status: string | null; createdAt: string | null }>;
}

export interface InstanceSpritesRemoved {
  deleted: number;
  failed: string[];
}

/** Sprites API failures (502) carry a fixed, token-free message worth showing; other errors go through the shared handler. */
async function handle(response: Response): Promise<void> {
  if (response.status === 502) {
    const body = await response.clone().json().catch(() => null) as { error?: unknown; failed?: unknown } | null;
    if (typeof body?.error === 'string') {
      const failed = Array.isArray(body.failed) && body.failed.length ? `: ${body.failed.join(', ')}` : '';
      throw new Error(`${body.error}${failed}`);
    }
  }
  await handleApiResponse(response);
}

export async function getInstanceSprites(): Promise<InstanceSprites> {
  const response = await apiFetch(`${API_BASE_URL}/api/admin/sprites`, { credentials: 'include' });
  await handle(response);
  return response.json();
}

/** Removes every Sprite of this instance; `count` is the number the administrator confirmed. */
export async function removeInstanceSprites(count: number): Promise<InstanceSpritesRemoved> {
  const response = await apiFetch(`${API_BASE_URL}/api/admin/sprites/remove`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ count }),
  });
  await handle(response);
  return response.json();
}
