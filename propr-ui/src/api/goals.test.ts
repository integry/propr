import { afterEach, describe, expect, it, vi } from 'vitest';
import { GOAL_LIST_PAGE_SIZE, createGoal, getGoalVisualPreviews, listGoals, sendGoalInput } from './goals';

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

describe('goal list API', () => {
  afterEach(() => vi.restoreAllMocks());

  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

  it('walks explicit pages and orders every goal by its latest update', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ goals: [{ id: 'a', updatedAt: '2026-11-01T00:00:00Z' }, { id: 'b', updatedAt: '2026-11-03T00:00:00Z' }], nextOffset: 200 }))
      .mockResolvedValueOnce(json({ goals: [{ id: 'b', updatedAt: '2026-11-03T00:00:00Z' }, { id: 'c', updatedAt: '2026-11-02T00:00:00Z' }], nextOffset: null }));

    const { goals } = await listGoals();

    expect(goals.map(goal => goal.id)).toEqual(['b', 'c', 'a']);
    const urls = fetchMock.mock.calls.map(([url]) => new URL(String(url), 'http://localhost'));
    expect(urls.map(url => [url.pathname, url.searchParams.get('offset'), url.searchParams.get('limit')])).toEqual([
      ['/api/goals', '0', String(GOAL_LIST_PAGE_SIZE)],
      ['/api/goals', '200', String(GOAL_LIST_PAGE_SIZE)],
    ]);
  });

  it('keeps walking past fifty pages until the server stops continuing', async () => {
    const pages = 51;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const offset = Number(new URL(String(input), 'http://localhost').searchParams.get('offset'));
      const index = offset / GOAL_LIST_PAGE_SIZE;
      const goals = Array.from({ length: index === pages - 1 ? 1 : GOAL_LIST_PAGE_SIZE }, (_, item) => ({
        id: `g${offset + item}`, updatedAt: new Date(Date.UTC(2026, 0, 1) + (offset + item) * 1000).toISOString(),
      }));
      return json({ goals, nextOffset: index === pages - 1 ? null : offset + GOAL_LIST_PAGE_SIZE });
    });

    const { goals } = await listGoals();

    expect(fetchMock).toHaveBeenCalledTimes(pages);
    expect(goals).toHaveLength(50 * GOAL_LIST_PAGE_SIZE + 1);
    expect(goals[0].id).toBe(`g${50 * GOAL_LIST_PAGE_SIZE}`);
  });

  it.each([
    ['does not advance', { goals: [{ id: 'b', updatedAt: '2026-11-02T00:00:00Z' }], nextOffset: 0 }],
    ['follows an empty page', { goals: [], nextOffset: 400 }],
  ])('fails instead of returning a partial list when the continuation %s', async (_label, second) => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ goals: [{ id: 'a', updatedAt: '2026-11-01T00:00:00Z' }], nextOffset: 200 }))
      .mockResolvedValueOnce(json(second));
    await expect(listGoals()).rejects.toThrow(/could not be read completely/);
  });

  it('stops on a server that does not page', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ goals: [{ id: 'a', updatedAt: '2026-11-01T00:00:00Z' }] }));
    await expect(listGoals()).resolves.toEqual({ goals: [{ id: 'a', updatedAt: '2026-11-01T00:00:00Z' }] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
