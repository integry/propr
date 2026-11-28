import { API_BASE_URL, apiFetch } from './apiClient';

/** How the instance signs browsers in (GET /api/auth/sign-in-method). */
export type SignInMethod = 'github' | 'connect' | 'device' | 'disabled' | 'demo';

export interface DeviceSignInStart {
  attempt: string;
  userCode: string;
  verificationUri: string;
  expiresAt: string;
  interval: number;
}

export type DeviceSignInPoll =
  | { status: 'pending'; interval: number; retryAfterMs: number }
  | { status: 'complete' }
  | { status: 'failed'; error: string; message: string };

export class DeviceSignInRequestError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'DeviceSignInRequestError';
  }
}

const GENERIC_FAILURE = 'GitHub sign-in could not be completed. Try again.';

export const getSignInMethod = async (): Promise<SignInMethod | null> => {
  try {
    const response = await apiFetch(`${API_BASE_URL}/api/auth/sign-in-method`, { credentials: 'include' });
    if (!response.ok) return null;
    const body = await response.json() as { mode?: unknown };
    return typeof body.mode === 'string' ? body.mode as SignInMethod : null;
  } catch {
    // Older APIs do not have the route; the redirect sign-in still works there.
    return null;
  }
};

const postJson = async (path: string, body: unknown): Promise<{ ok: boolean; body: Record<string, unknown> }> => {
  const response = await apiFetch(`${API_BASE_URL}${path}`, {
    method: 'POST',
    credentials: 'include',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  let parsed: Record<string, unknown> = {};
  try {
    parsed = await response.json() as Record<string, unknown>;
  } catch { /* fall through to the generic failure */ }
  return { ok: response.ok, body: parsed };
};

const failureFrom = (body: Record<string, unknown>): DeviceSignInRequestError => new DeviceSignInRequestError(
  typeof body.error === 'string' ? body.error : 'device_login_failed',
  typeof body.message === 'string' ? body.message : GENERIC_FAILURE,
);

export const startDeviceSignIn = async (): Promise<DeviceSignInStart> => {
  const { ok, body } = await postJson('/api/auth/device/start', {});
  if (!ok || typeof body.attempt !== 'string' || typeof body.userCode !== 'string') throw failureFrom(body);
  return body as unknown as DeviceSignInStart;
};

export const pollDeviceSignIn = async (attempt: string): Promise<DeviceSignInPoll> => {
  const { body } = await postJson('/api/auth/device/poll', { attempt });
  if (body.status === 'pending') {
    return {
      status: 'pending',
      interval: typeof body.interval === 'number' ? body.interval : 5,
      retryAfterMs: typeof body.retryAfterMs === 'number' ? body.retryAfterMs : 5_000,
    };
  }
  if (body.status === 'complete') return { status: 'complete' };
  const failure = failureFrom(body);
  return { status: 'failed', error: failure.code, message: failure.message };
};

export const cancelDeviceSignIn = async (): Promise<void> => {
  await postJson('/api/auth/device/cancel', {}).catch(() => undefined);
};
