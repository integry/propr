import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useSystemReadiness } from './useSystemReadiness';

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(res => { resolve = res; });
  return { promise, resolve };
};

const Probe = ({ name }: { name: string }) => {
  const readiness = useSystemReadiness();
  return (
    <div data-testid={name}>
      {readiness.isLoading ? 'loading' : readiness.error ? 'error' : readiness.hasTasks ? 'populated' : 'empty'}
    </div>
  );
};

afterEach(() => vi.restoreAllMocks());

describe('useSystemReadiness shared startup state', () => {
  it('keeps two consumers loading through an empty response while issuing one read per contract', async () => {
    const tasks = deferred<Response>();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(url => {
      if (String(url).includes('/api/instance/catalog')) {
        return Promise.resolve(new Response(JSON.stringify({ agents: [], repositories: [] })));
      }
      if (String(url).includes('/api/tasks?')) return tasks.promise;
      throw new Error(`Unexpected URL: ${String(url)}`);
    });

    render(<><Probe name="layout" /><Probe name="dashboard" /></>);

    expect(screen.getByTestId('layout')).toHaveTextContent('loading');
    expect(screen.getByTestId('dashboard')).toHaveTextContent('loading');
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));
    expect(fetchSpy.mock.calls.filter(([url]) => String(url).includes('/api/instance/catalog'))).toHaveLength(1);
    expect(fetchSpy.mock.calls.filter(([url]) => String(url).includes('limit=1'))).toHaveLength(1);

    await act(async () => {
      tasks.resolve(new Response(JSON.stringify({ tasks: [], total: 0 })));
    });

    await waitFor(() => expect(screen.getByTestId('layout')).toHaveTextContent('empty'));
    expect(screen.getByTestId('dashboard')).toHaveTextContent('empty');
  });
});
