import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const apiMocks = vi.hoisted(() => ({
  getAgentTankStatus: vi.fn(),
  updateAgentTankSettings: vi.fn(),
}));

vi.mock('../../api/revertApi', () => apiMocks);

import { STATUS_PROBE_DELAY, useAgentTankSettings } from './useAgentTankSettings';

/** Long enough for a probe scheduled at click time to have fired already. */
const pastProbeDelay = () => new Promise(resolve => setTimeout(resolve, STATUS_PROBE_DELAY + 100));

beforeEach(() => {
  // Fake timers only so the probe delay can be discarded between tests: a probe
  // still on the clock when a test ends would otherwise answer the next test's
  // mocks. `shouldAdvanceTime` keeps everything else running in real time.
  vi.useFakeTimers({ shouldAdvanceTime: true });
  apiMocks.getAgentTankStatus.mockReset().mockResolvedValue({ available: true });
  apiMocks.updateAgentTankSettings.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

test.each(['', ' \t '])('an external URL draft %j stays local until a non-blank edit', async (url) => {
  const reportError = vi.fn();
  const { result } = renderHook(() => useAgentTankSettings(reportError));
  await act(async () => result.current.adopt({ mode: 'external', enabled: true, url: 'http://legacy:3456' }));
  apiMocks.getAgentTankStatus.mockClear();

  await act(async () => result.current.change({ mode: 'external', enabled: true, url }));
  await act(async () => { await vi.advanceTimersByTimeAsync(STATUS_PROBE_DELAY + 100); });

  expect(apiMocks.updateAgentTankSettings).not.toHaveBeenCalled();
  expect(apiMocks.getAgentTankStatus).not.toHaveBeenCalled();
  expect(reportError).not.toHaveBeenCalledWith(expect.any(String));
  expect(result.current.settings.url).toBe(url);
  expect(result.current.available).toBeNull();
  expect(result.current.checkingStatus).toBe(false);

  await act(async () => result.current.change({ mode: 'external', enabled: true, url: 'http://replacement:3456' }));
  expect(apiMocks.updateAgentTankSettings).toHaveBeenCalledExactlyOnceWith({ mode: 'external', url: 'http://replacement:3456' });
  await act(async () => { await vi.advanceTimersByTimeAsync(STATUS_PROBE_DELAY); });
  expect(result.current.settings.url).toBe('http://replacement:3456');
  expect(result.current.available).toBe(true);
  expect(reportError).not.toHaveBeenCalledWith(expect.any(String));
});

test.each([false, true])('a blank draft survives an earlier write completing (rejected: %s)', async (rejected) => {
  let releaseWrite = () => {};
  const writeGate = new Promise<void>(resolve => { releaseWrite = resolve; });
  apiMocks.updateAgentTankSettings.mockImplementationOnce(async () => {
    await writeGate;
    if (rejected) throw new Error('Earlier write failed');
  });
  const reportError = vi.fn();
  const { result } = renderHook(() => useAgentTankSettings(reportError));
  await act(async () => result.current.adopt({ mode: 'external', enabled: true, url: 'http://legacy:3456' }));
  apiMocks.getAgentTankStatus.mockClear();
  await act(async () => result.current.change({ mode: 'external', enabled: true, url: 'h' }));
  await act(async () => result.current.change({ mode: 'external', enabled: true, url: '' }));
  await act(async () => { releaseWrite(); });
  await act(async () => { await vi.advanceTimersByTimeAsync(STATUS_PROBE_DELAY + 100); });

  expect(apiMocks.updateAgentTankSettings).toHaveBeenCalledTimes(1);
  expect(result.current.settings.url).toBe('');
  expect(reportError).not.toHaveBeenCalledWith(expect.any(String));
  expect(apiMocks.getAgentTankStatus).not.toHaveBeenCalled();
  expect(result.current.available).toBeNull();
  expect(result.current.checkingStatus).toBe(false);

  // The draft never becomes rollback evidence, even when the older write
  // succeeds while it is displayed. Only a confirmed write is persisted.
  apiMocks.updateAgentTankSettings.mockRejectedValueOnce(new Error('Replacement failed'));
  await act(async () => result.current.change({ mode: 'external', enabled: true, url: 'http://replacement:3456' }));
  expect(result.current.settings.url).toBe(rejected ? 'http://legacy:3456' : 'h');
  expect(reportError).toHaveBeenCalledWith('Replacement failed');
});

test('a blank draft ignores an already running availability probe', async () => {
  let releaseProbe: (status: { available: boolean }) => void = () => {};
  apiMocks.getAgentTankStatus.mockReturnValueOnce(new Promise(resolve => { releaseProbe = resolve; }));
  const { result } = renderHook(() => useAgentTankSettings(vi.fn()));
  act(() => result.current.adopt({ mode: 'external', enabled: true, url: 'http://legacy:3456' }));

  await act(async () => result.current.change({ mode: 'external', enabled: true, url: '' }));
  await act(async () => { releaseProbe({ available: true }); });

  expect(result.current.settings.url).toBe('');
  expect(result.current.available).toBeNull();
  expect(result.current.checkingStatus).toBe(false);
});

test.each(['disabled', 'bundled'] as const)('leaving a blank external draft for %s preserves the URL when returning to External', async (mode) => {
  const { result } = renderHook(() => useAgentTankSettings(vi.fn()));
  await act(async () => result.current.adopt({ mode: 'external', enabled: true, url: 'http://legacy:3456' }));
  await act(async () => result.current.change({ mode: 'external', enabled: true, url: '' }));
  await act(async () => result.current.change({ mode, enabled: mode !== 'disabled', url: '' }));

  expect(apiMocks.updateAgentTankSettings).toHaveBeenCalledExactlyOnceWith({ mode, url: 'http://legacy:3456' });
  expect(result.current.settings.mode).toBe(mode);
  expect(result.current.settings.url).toBe('http://legacy:3456');
  await act(async () => result.current.change({ ...result.current.settings, mode: 'external', enabled: true }));
  expect(apiMocks.updateAgentTankSettings).toHaveBeenLastCalledWith({ mode: 'external', url: 'http://legacy:3456' });
  expect(result.current.settings.mode).toBe('external');
});

test('a rejected mode change is reported and the shown mode goes back to what is persisted', async () => {
  // An older backend cannot store bundled mode, so the client refuses the
  // write. Leaving "bundled" selected would claim a change that never happened.
  apiMocks.updateAgentTankSettings.mockRejectedValue(new Error('Backend too old'));
  const reportError = vi.fn();
  const { result } = renderHook(() => useAgentTankSettings(reportError));
  act(() => result.current.adopt({ mode: 'external', enabled: true, url: 'http://legacy:3456' }));

  act(() => result.current.change({ mode: 'bundled', enabled: true, url: 'http://legacy:3456' }));

  await waitFor(() => expect(reportError).toHaveBeenCalledWith('Backend too old'));
  expect(result.current.settings.mode).toBe('external');
});

test('an accepted mode change sticks and clears any previous error', async () => {
  const reportError = vi.fn();
  const { result } = renderHook(() => useAgentTankSettings(reportError));

  act(() => result.current.change({ mode: 'bundled', enabled: true, url: '' }));

  await waitFor(() => expect(apiMocks.updateAgentTankSettings).toHaveBeenCalledWith({ mode: 'bundled', url: '' }));
  expect(reportError).toHaveBeenCalledWith(null);
  expect(reportError).not.toHaveBeenCalledWith(expect.any(String));
  expect(result.current.settings.mode).toBe('bundled');
});

test('a slow bundled write cannot overtake a later "disabled" selection', async () => {
  // Turning tracking off is the write that must win: a bundled POST landing
  // after it would let usage requests start containers the operator declined.
  // The bundled write is held open the way the real compatibility GET holds it.
  const persisted: string[] = [];
  let releaseBundled = () => {};
  const bundledGate = new Promise<void>(resolve => { releaseBundled = resolve; });
  apiMocks.updateAgentTankSettings.mockImplementation(async ({ mode }: { mode: string }) => {
    if (mode === 'bundled') await bundledGate;
    persisted.push(mode);
  });
  const { result } = renderHook(() => useAgentTankSettings(vi.fn()));
  act(() => result.current.adopt({ mode: 'disabled', enabled: false, url: '' }));

  act(() => result.current.change({ mode: 'bundled', enabled: true, url: '' }));
  act(() => result.current.change({ mode: 'disabled', enabled: false, url: '' }));

  // The queued "disabled" write must wait behind the bundled one rather than
  // racing ahead of it and being overwritten when it finally completes.
  expect(persisted).toEqual([]);
  await act(async () => { releaseBundled(); });

  await waitFor(() => expect(persisted).toEqual(['bundled', 'disabled']));
  expect(result.current.settings.mode).toBe('disabled');
});

test('an older failed write does not replace a newer successful selection', async () => {
  let releaseBundled = () => {};
  const bundledGate = new Promise<void>(resolve => { releaseBundled = resolve; });
  apiMocks.updateAgentTankSettings.mockImplementation(async ({ mode }: { mode: string }) => {
    if (mode === 'bundled') { await bundledGate; throw new Error('Backend too old'); }
  });
  const reportError = vi.fn();
  const { result } = renderHook(() => useAgentTankSettings(reportError));
  act(() => result.current.adopt({ mode: 'external', enabled: true, url: 'http://legacy:3456' }));

  act(() => result.current.change({ mode: 'bundled', enabled: true, url: 'http://legacy:3456' }));
  act(() => result.current.change({ mode: 'disabled', enabled: false, url: 'http://legacy:3456' }));
  await act(async () => { releaseBundled(); });

  await waitFor(() => expect(apiMocks.updateAgentTankSettings).toHaveBeenCalledTimes(2));
  // The rollback belongs to the bundled selection, which the operator replaced;
  // restoring "external" would resurrect a mode nobody selected.
  expect(result.current.settings.mode).toBe('disabled');
  expect(reportError).not.toHaveBeenCalledWith('Backend too old');
});

test('availability is fetched only after the selected mode has been saved', async () => {
  // `updateAgentTankSettings` awaits a compatibility GET before POSTing bundled.
  // A probe sent while that GET is open reaches a backend that still stores
  // "disabled", so its "not available" would label the bundled selection
  // unavailable without bundled ever having been tried.
  let persistedMode = 'disabled';
  let releaseWrite = () => {};
  const writeGate = new Promise<void>(resolve => { releaseWrite = resolve; });
  const probedModes: string[] = [];
  apiMocks.updateAgentTankSettings.mockImplementation(async ({ mode }: { mode: string }) => {
    await writeGate;
    persistedMode = mode;
  });
  apiMocks.getAgentTankStatus.mockImplementation(async () => {
    probedModes.push(persistedMode);
    return { available: persistedMode === 'bundled' };
  });
  const { result } = renderHook(() => useAgentTankSettings(vi.fn()));
  act(() => result.current.adopt({ mode: 'disabled', enabled: false, url: '' }));

  act(() => result.current.change({ mode: 'bundled', enabled: true, url: '' }));
  await pastProbeDelay();

  expect(probedModes).toEqual([]);
  // The operator sees the check as still running rather than as a verdict.
  expect(result.current.checkingStatus).toBe(true);
  await act(async () => { releaseWrite(); });

  await waitFor(() => expect(probedModes).toEqual(['bundled']), { timeout: 2000 });
  await waitFor(() => expect(result.current.available).toBe(true));
  expect(result.current.checkingStatus).toBe(false);
});

test('a selection waiting behind an earlier write is probed only once it is persisted', async () => {
  // The external selection is queued behind the held bundled write, so the
  // backend keeps answering for "disabled" until that queue drains.
  let persistedMode = 'disabled';
  let releaseBundled = () => {};
  const bundledGate = new Promise<void>(resolve => { releaseBundled = resolve; });
  const probedModes: string[] = [];
  apiMocks.updateAgentTankSettings.mockImplementation(async ({ mode }: { mode: string }) => {
    if (mode === 'bundled') await bundledGate;
    persistedMode = mode;
  });
  apiMocks.getAgentTankStatus.mockImplementation(async () => {
    probedModes.push(persistedMode);
    return { available: true };
  });
  const { result } = renderHook(() => useAgentTankSettings(vi.fn()));
  act(() => result.current.adopt({ mode: 'disabled', enabled: false, url: '' }));

  act(() => result.current.change({ mode: 'bundled', enabled: true, url: '' }));
  act(() => result.current.change({ mode: 'external', enabled: true, url: 'http://legacy:3456' }));
  await pastProbeDelay();

  expect(probedModes).toEqual([]);
  await act(async () => { releaseBundled(); });

  // Only the surviving selection is probed, and only against its own mode: the
  // superseded bundled selection never owned the indicator.
  await waitFor(() => expect(probedModes).toEqual(['external']), { timeout: 2000 });
  expect(result.current.settings.mode).toBe('external');
});

test('a refused selection reports no availability for the mode that was never stored', async () => {
  // Rolling back to "disabled" and then letting the refused selection's probe
  // land would claim a working Agent Tank for a mode the backend rejected.
  apiMocks.updateAgentTankSettings.mockRejectedValue(new Error('Backend too old'));
  const reportError = vi.fn();
  const { result } = renderHook(() => useAgentTankSettings(reportError));
  act(() => result.current.adopt({ mode: 'disabled', enabled: false, url: '' }));

  act(() => result.current.change({ mode: 'bundled', enabled: true, url: '' }));
  await waitFor(() => expect(reportError).toHaveBeenCalledWith('Backend too old'));
  await pastProbeDelay();

  expect(result.current.settings.mode).toBe('disabled');
  expect(apiMocks.getAgentTankStatus).not.toHaveBeenCalled();
  expect(result.current.available).toBeNull();
  expect(result.current.checkingStatus).toBe(false);
});

test('a refused selection restores the availability of the mode that is persisted', async () => {
  // The rollback puts "external" back on screen, so the indicator has to
  // describe external instead of staying blank on the spinner it raised.
  apiMocks.updateAgentTankSettings.mockImplementation(async ({ mode }: { mode: string }) => {
    if (mode === 'bundled') throw new Error('Backend too old');
  });
  const { result } = renderHook(() => useAgentTankSettings(vi.fn()));
  act(() => result.current.adopt({ mode: 'external', enabled: true, url: 'http://legacy:3456' }));
  await waitFor(() => expect(apiMocks.getAgentTankStatus).toHaveBeenCalledTimes(1));

  act(() => result.current.change({ mode: 'bundled', enabled: true, url: 'http://legacy:3456' }));

  await waitFor(() => expect(result.current.settings.mode).toBe('external'));
  await waitFor(() => expect(result.current.available).toBe(true));
  expect(result.current.checkingStatus).toBe(false);
});

test.each(['disabled', 'bundled'] as const)('a queued %s save preserves the URL confirmed by the preceding write', async (mode) => {
  let release = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  apiMocks.updateAgentTankSettings.mockImplementationOnce(() => gate);
  const { result } = renderHook(() => useAgentTankSettings(vi.fn()));
  await act(async () => result.current.adopt({ mode: 'external', enabled: true, url: 'http://legacy:3456' }));
  await act(async () => result.current.change({ mode: 'external', enabled: true, url: '  http://replacement:3456  ' }));
  await act(async () => result.current.change({ mode: 'external', enabled: true, url: '' }));
  await act(async () => result.current.change({ mode, enabled: mode !== 'disabled', url: '' }));
  await act(async () => { release(); });
  expect(apiMocks.updateAgentTankSettings).toHaveBeenLastCalledWith({ mode, url: 'http://replacement:3456' });
  expect(result.current.settings.url).toBe('http://replacement:3456');
  await act(async () => result.current.change({ ...result.current.settings, mode: 'external', enabled: true }));
  expect(apiMocks.updateAgentTankSettings).toHaveBeenLastCalledWith({ mode: 'external', url: 'http://replacement:3456' });
});
