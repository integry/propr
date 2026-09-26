import {
  parseVoiceBriefingScope,
  voiceBriefingResponseSchema,
  voiceCapabilitiesResponseSchema,
  type RuntimeVoiceSchema,
  type VoiceBriefingResponse,
  type VoiceBriefingScope,
  type VoiceCapabilitiesResponse,
} from '@propr/shared';
import { apiFetch, handleApiResponse } from './apiClient';

export class VoiceBackendUnavailableError extends Error {
  readonly code = 'VOICE_BACKEND_UNAVAILABLE';

  constructor() {
    super('Voice briefings are unavailable on the connected server (HTTP 404). Update the server runtime to a version with voice briefings, then reconnect. Updating the desktop app alone does not update the server.');
    this.name = 'VoiceBackendUnavailableError';
  }
}

// The shared client settles its fetch at headers. Keep body consumption
// cancellable too, so opt-out closes a briefing that is still downloading.
async function readVoiceJson(response: Response, signal?: AbortSignal): Promise<unknown> {
  if (!signal || !response.body) return response.json();
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    if (signal.aborted) cancel();
    signal.throwIfAborted();
    const decoder = new TextDecoder();
    let text = '';
    while (true) {
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) break;
      text += decoder.decode(chunk.value, { stream: true });
    }
    return JSON.parse(text + decoder.decode()) as unknown;
  } finally {
    signal.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
}

async function getValidatedJson<T>(
  path: string,
  schema: RuntimeVoiceSchema<T>,
  signal?: AbortSignal,
): Promise<T> {
  const response = await apiFetch(`/api/voice${path}`, {
    method: 'GET',
    credentials: 'include',
    ...(signal ? { signal } : {}),
  });
  if (response.status === 404) throw new VoiceBackendUnavailableError();
  await handleApiResponse(response);
  return schema.parse(await readVoiceJson(response, signal));
}

/** Fetch the fixed privacy and browser-audio capability contract. */
export function getVoiceCapabilities(): Promise<VoiceCapabilitiesResponse> {
  return getValidatedJson('/capabilities', voiceCapabilitiesResponseSchema);
}

/** Fetch one authenticated, server-built briefing snapshot. */
export function getVoiceBriefing(
  scope: VoiceBriefingScope = 'all',
  signal?: AbortSignal,
): Promise<VoiceBriefingResponse> {
  // Keep even runtime JavaScript callers inside the shared closed scope set.
  const validatedScope = parseVoiceBriefingScope(scope);
  const query = new URLSearchParams({ scope: validatedScope });
  return getValidatedJson(`/briefing?${query.toString()}`, voiceBriefingResponseSchema, signal);
}
