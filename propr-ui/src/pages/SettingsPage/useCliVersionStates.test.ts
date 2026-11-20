import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentCliVersionState } from '../../api/proprApi';

const getAgents = vi.fn();
vi.mock('../../api/proprApi', () => ({ getAgents: () => getAgents() }));

const { CLI_VERSION_POLL_INTERVAL_MS, useCliVersionStates } = await import('./useCliVersionStates');

const state = (overrides: Partial<AgentCliVersionState>): AgentCliVersionState => ({
  agentId: 'codex-1', alias: 'codex', type: 'codex', configuredVersion: '0.170.0', effectiveVersion: '0.171.0', status: 'preparing', ...overrides,
});

const circuitOpen = state({ status: 'failed', error: 'npm install failed', automaticRetry: true, nextRetryAt: '2026-11-20T18:35:00Z' });
const ready = state({ status: 'ready', effectiveVersion: '0.170.0' });

describe('useCliVersionStates', () => {
  beforeEach(() => { vi.useFakeTimers(); getAgents.mockReset(); });
  afterEach(() => { vi.useRealTimers(); });

  it('keeps polling through a recoverable circuit-open failure and reports the version once it is ready', async () => {
    getAgents.mockResolvedValueOnce({ agents: [], cliVersionStates: [circuitOpen] })
      .mockResolvedValue({ agents: [], cliVersionStates: [ready] });
    const { result } = renderHook(() => useCliVersionStates());
    act(() => result.current.update([circuitOpen]));

    await act(async () => { await vi.advanceTimersByTimeAsync(CLI_VERSION_POLL_INTERVAL_MS); });
    expect(getAgents).toHaveBeenCalledTimes(1);
    expect(result.current.stateFor('codex-1')?.status).toBe('failed');

    await act(async () => { await vi.advanceTimersByTimeAsync(CLI_VERSION_POLL_INTERVAL_MS); });
    expect(getAgents).toHaveBeenCalledTimes(2);
    expect(result.current.stateFor('codex-1')?.status).toBe('ready');
    expect(result.current.becameReady.has('codex-1')).toBe(true);

    // Nothing is outstanding any more, so polling stops.
    await act(async () => { await vi.advanceTimersByTimeAsync(CLI_VERSION_POLL_INTERVAL_MS * 3); });
    expect(getAgents).toHaveBeenCalledTimes(2);
  });

  it('keeps polling a recoverable failure even without a retry time', async () => {
    getAgents.mockResolvedValue({ agents: [], cliVersionStates: [ready] });
    const { result } = renderHook(() => useCliVersionStates());
    act(() => result.current.update([state({ status: 'failed', automaticRetry: true })]));
    await act(async () => { await vi.advanceTimersByTimeAsync(CLI_VERSION_POLL_INTERVAL_MS); });
    expect(result.current.stateFor('codex-1')?.status).toBe('ready');
  });

  it('does not poll a failure that needs an operator', async () => {
    const { result } = renderHook(() => useCliVersionStates());
    act(() => result.current.update([state({ status: 'failed', error: 'no space left on device', automaticRetry: false })]));
    await act(async () => { await vi.advanceTimersByTimeAsync(CLI_VERSION_POLL_INTERVAL_MS * 3); });
    expect(getAgents).not.toHaveBeenCalled();
  });

  it('ignores a poll response that started before a save marked a newer version pending', async () => {
    let deliverReadyA: (value: unknown) => void = () => undefined;
    getAgents.mockReturnValueOnce(new Promise(resolve => { deliverReadyA = resolve; }));
    const { result } = renderHook(() => useCliVersionStates());
    act(() => result.current.update([state({ configuredVersion: '0.170.0' })]));

    // The poll for A is in flight when the save response marks B pending.
    await act(async () => { await vi.advanceTimersByTimeAsync(CLI_VERSION_POLL_INTERVAL_MS); });
    expect(getAgents).toHaveBeenCalledTimes(1);
    const pendingB = state({ configuredVersion: '0.169.0', effectiveVersion: '0.170.0' });
    act(() => result.current.update([pendingB]));

    await act(async () => { deliverReadyA({ agents: [], cliVersionStates: [ready] }); });
    expect(result.current.stateFor('codex-1')).toEqual(pendingB);
    expect(result.current.becameReady.has('codex-1')).toBe(false);

    // Polling continues and reports B once it is in effect.
    const readyB = state({ configuredVersion: '0.169.0', effectiveVersion: '0.169.0', status: 'ready' });
    getAgents.mockResolvedValue({ agents: [], cliVersionStates: [readyB] });
    await act(async () => { await vi.advanceTimersByTimeAsync(CLI_VERSION_POLL_INTERVAL_MS); });
    expect(getAgents).toHaveBeenCalledTimes(2);
    expect(result.current.stateFor('codex-1')).toEqual(readyB);
    expect(result.current.becameReady.has('codex-1')).toBe(true);
  });

  it('ignores an older poll response that arrives after a newer one', async () => {
    let deliverOld: (value: unknown) => void = () => undefined;
    let deliverNew: (value: unknown) => void = () => undefined;
    getAgents.mockReturnValueOnce(new Promise(resolve => { deliverOld = resolve; }))
      .mockReturnValueOnce(new Promise(resolve => { deliverNew = resolve; }));
    const { result } = renderHook(() => useCliVersionStates());
    act(() => result.current.update([state({})]));

    await act(async () => { await vi.advanceTimersByTimeAsync(CLI_VERSION_POLL_INTERVAL_MS * 2); });
    expect(getAgents).toHaveBeenCalledTimes(2);
    await act(async () => { deliverNew({ agents: [], cliVersionStates: [ready] }); });
    await act(async () => { deliverOld({ agents: [], cliVersionStates: [state({})] }); });
    expect(result.current.stateFor('codex-1')?.status).toBe('ready');
    expect(result.current.becameReady.has('codex-1')).toBe(true);
  });
});
