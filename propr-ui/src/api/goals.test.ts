import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGoal, getGoalVisualPreviews, sendGoalInput } from './goals';

describe('goal attachment API', () => {
  afterEach(() => vi.restoreAllMocks());

  it('sends new-goal files as multipart data without overriding the browser boundary', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ goal: {} }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    }));
    const file = new File(['reference'], 'reference.txt', { type: 'text/plain' });
    await createGoal({
      repository: 'acme/web', objective: 'Ship it', launchStrategy: 'direct',
      agentId: 'agent-1', model: 'gpt-5.6-sol',
    }, [file]);

    const [, init] = fetchMock.mock.calls[0];
    expect(init?.body).toBeInstanceOf(FormData);
    expect(new Headers(init?.headers).has('Content-Type')).toBe(false);
    expect((init?.body as FormData).get('files')).toBe(file);
    expect(JSON.parse(String((init?.body as FormData).get('payload')))).toMatchObject({ objective: 'Ship it' });
  });

  it('sends running-goal correction files through the same multipart contract', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ goal: {} }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    }));
    const file = new File(['reference'], 'reference.txt', { type: 'text/plain' });
    await sendGoalInput('goal-1', { message: 'Use this.' }, [file]);

    const [, init] = fetchMock.mock.calls[0];
    expect(init?.body).toBeInstanceOf(FormData);
    expect((init?.body as FormData).get('files')).toBe(file);
    expect(JSON.parse(String((init?.body as FormData).get('payload')))).toEqual({ message: 'Use this.' });
  });

  it('accepts only allowlisted GitHub attachment URLs for goal previews', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      previews: [
        { type: 'image', title: 'Dashboard', url: 'https://github.com/user-attachments/assets/preview-1' },
        { type: 'image', title: 'Tracker', url: 'https://example.com/tracker.png' },
        { type: 'video', title: 'Injected', url: 'javascript:alert(1)' },
      ],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    await expect(getGoalVisualPreviews('goal-1')).resolves.toEqual({
      previews: [{
        type: 'image',
        title: 'Dashboard',
        url: 'https://github.com/user-attachments/assets/preview-1',
      }],
    });
  });
});
