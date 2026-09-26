import { DESKTOP_TRANSPORT_SCOPE_HEADER, voiceBriefingResponseSchema } from '@propr/shared';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { setApiBaseUrl, setDesktopConnectionScope } from './apiClient';
import { getVoiceBriefing, getVoiceCapabilities } from './voiceApi';

const capabilities = {
  mode: 'on_demand',
  serverAudio: false,
  persistentSession: false,
  rawAudioAccepted: false,
  transcriptStored: false,
} as const;

const briefing = voiceBriefingResponseSchema.parse({
  generatedAt: '2026-09-07T05:00:00.000Z',
  scope: 'attention',
  headline: 'One item needs attention.',
  speechText: 'One item needs attention.',
  counts: { running: 0, queued: 0, attention: 1, plans: 1, total: 1 },
  items: [{
    reference: 'plan 1',
    position: 1,
    kind: 'plan',
    id: 'plan-1',
    title: 'Plan for integry/propr',
    repository: 'integry/propr',
    status: 'review',
    summary: 'Plan for integry/propr is ready for review.',
    href: '/studio/plan-1',
    requiresAttention: true,
    actions: ['open', 'follow_up'],
    updatedAt: '2026-09-07T04:59:00.000Z',
  }],
});

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('voice API', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    setDesktopConnectionScope(null, '');
  });

  test('uses only the fixed authenticated GET routes and validates both responses', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse(capabilities))
      .mockResolvedValueOnce(jsonResponse(briefing));

    await expect(getVoiceCapabilities()).resolves.toEqual(capabilities);
    await expect(getVoiceBriefing('attention')).resolves.toEqual(briefing);

    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/voice/capabilities', {
      method: 'GET',
      credentials: 'include',
    });
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/voice/briefing?scope=attention', {
      method: 'GET',
      credentials: 'include',
    });
  });

  test('resolves both routes against activation and subsequent profile changes', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async input =>
      String(input).includes('/capabilities') ? jsonResponse(capabilities) : jsonResponse(briefing));
    setApiBaseUrl('http://127.0.0.1:4400');
    await getVoiceCapabilities();
    await getVoiceBriefing('attention');
    setApiBaseUrl('https://second.example.test');
    await getVoiceCapabilities();
    await getVoiceBriefing('attention');
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'http://127.0.0.1:4400/api/voice/capabilities',
      'http://127.0.0.1:4400/api/voice/briefing?scope=attention',
      'https://second.example.test/api/voice/capabilities',
      'https://second.example.test/api/voice/briefing?scope=attention',
    ]);
  });

  test('does not retain a nonempty instance origin captured when the module first loads', async () => {
    vi.resetModules();
    const client = await import('./apiClient');
    client.setApiBaseUrl('https://first.example.test');
    const voice = await import('./voiceApi');
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(capabilities));
    try {
      client.setApiBaseUrl('https://second.example.test');
      await voice.getVoiceCapabilities();
      expect(fetchMock.mock.calls[0][0]).toBe('https://second.example.test/api/voice/capabilities');
    } finally { client.setApiBaseUrl(''); vi.resetModules(); }
  });

  test('carries the active desktop transport scope to the selected backend', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(briefing));
    setDesktopConnectionScope({
      bridge: {} as never, profileId: 'local', transportScope: 'scope-2264',
    }, 'http://127.0.0.1:4400');
    await getVoiceBriefing('attention');
    expect(fetchMock.mock.calls[0][0]).toBe('http://127.0.0.1:4400/api/voice/briefing?scope=attention');
    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get(DESKTOP_TRANSPORT_SCOPE_HEADER)).toBe('scope-2264');
  });

  test.each([getVoiceCapabilities, () => getVoiceBriefing()])(
    'reports missing backend routes without retrying another origin or hiding auth failures', async request => {
      const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('Not Found', { status: 404 }));
      await expect(request()).rejects.toMatchObject({ code: 'VOICE_BACKEND_UNAVAILABLE' });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 }));
      await expect(request()).rejects.toThrow('Forbidden');
    },
  );

  test('rejects response drift through the shared schemas', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ ...capabilities, serverAudio: true }))
      .mockResolvedValueOnce(jsonResponse({
        ...briefing,
        items: [{ ...briefing.items[0], href: 'https://example.test/plan-1' }],
      }));

    await expect(getVoiceCapabilities()).rejects.toThrow(/browser-audio capability contract/);
    await expect(getVoiceBriefing('attention')).rejects.toThrow(/item\.href/);
  });

  test('validates a complete briefing body with cancellation enabled', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(briefing));
    await expect(getVoiceBriefing('attention', new AbortController().signal)).resolves.toEqual(briefing);
  });

  test('aborts a briefing fetch before headers arrive', async () => {
    const controller = new AbortController();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')));
      }));
    const request = getVoiceBriefing('all', controller.signal);
    const rejected = expect(request).rejects.toThrow(/cancelled/i);
    expect(fetchMock).toHaveBeenCalledOnce();
    controller.abort();
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
    await rejected;
  });

  test('cancels the response stream when disabled after headers arrive', async () => {
    const controller = new AbortController();
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ cancel }));
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response);
    const request = getVoiceBriefing('all', controller.signal);
    const rejected = expect(request).rejects.toThrow();
    await vi.waitFor(() => expect(response.body?.locked).toBe(true));
    controller.abort();
    await rejected;
    expect(cancel).toHaveBeenCalledOnce();
  });

  test('rejects an invalid scope before making a request', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');

    expect(() => getVoiceBriefing('queued' as never)).toThrow(/voiceBriefing\.scope/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
