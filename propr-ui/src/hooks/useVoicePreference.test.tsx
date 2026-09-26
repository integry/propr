import type { ReactNode } from 'react';
import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VoiceBriefingResponse } from '@propr/shared';
import { AuthProvider } from '../contexts/AuthContext';
import { DesktopContext, type DesktopContextValue } from '../desktop/DesktopContext';
import { API_BASE_URL, getDesktopConnectionScope, setDesktopConnectionScope } from '../api/apiClient';
import type { CurrentUser } from '../api/proprTypes';
import * as runtimeMode from '../config/runtimeMode';
import { getVoiceBriefing } from '../api/voiceApi';
import { getDraftWithPlan, refinePlan, stopTaskExecution } from '../api/proprApi';
import { listenOnce, speakOnce } from '../voice/browserSpeech';
import VoiceBriefingControl from '../components/VoiceBriefingControl';
import VoiceSettingsSection from '../pages/SettingsPage/VoiceSettingsSection';
import { useVoiceBriefing } from './useVoiceBriefing';
import { saveVoicePreference, useVoicePreference } from './useVoicePreference';
import { browserVoicePreferenceKey, voicePreferenceKey } from '../voice/voicePreferenceKey';

vi.mock('../api/voiceApi', () => ({ getVoiceBriefing: vi.fn() }));
vi.mock('../api/proprApi', () => ({
  getDraftWithPlan: vi.fn(), refinePlan: vi.fn(), stopTaskExecution: vi.fn(),
  abortGeneration: vi.fn(), abortRefinement: vi.fn(), postTaskFollowup: vi.fn(),
}));
vi.mock('../voice/browserSpeech', async importOriginal => ({
  ...await importOriginal<typeof import('../voice/browserSpeech')>(),
  getBrowserSpeechCapabilities: () => ({ speechSynthesis: true, speechRecognition: false }),
  speakOnce: vi.fn(), listenOnce: vi.fn(),
}));

const profile = { id: 'local', name: 'Local instance', baseUrl: 'http://localhost:4400', kind: 'local' as const };
const user = { id: 'account-a', username: 'example', permissions: [] } as unknown as CurrentUser;
const key = voicePreferenceKey(profile.id, profile.baseUrl, user.id);
// The browser scope follows the instance the Web UI is actually signed in to.
const browserKey = (userId = user.id) => browserVoicePreferenceKey(API_BASE_URL || window.location.origin, userId);
let activeUser: CurrentUser | null;
let desktop: DesktopContextValue | null;
const briefing = {
  scope: 'all', headline: 'Your briefing', speechText: 'One running task.',
  counts: { total: 1, running: 1, queued: 0, attention: 0, plans: 0 },
  items: [{ kind: 'task', id: 'task-1', reference: 'task 1', position: 1, title: 'Review changes',
    href: '/tasks/task-1', status: 'running', actions: ['stop', 'follow_up', 'open'] }],
} as VoiceBriefingResponse;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function Wrapper({ children }: { children: ReactNode }) {
  return <DesktopContext.Provider value={desktop}><AuthProvider user={activeUser}>
    <MemoryRouter>{children}</MemoryRouter>
  </AuthProvider></DesktopContext.Provider>;
}
function switchToBrowserRuntime() {
  vi.mocked(runtimeMode.isDesktopRuntime).mockReturnValue(false);
  desktop = null;
  act(() => setDesktopConnectionScope(null));
}
function enable() { act(() => saveVoicePreference(key, true)); }
function disable() { act(() => saveVoicePreference(key, false)); }

const mediaDescriptor = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices');
beforeEach(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
  localStorage.clear();
  vi.spyOn(runtimeMode, 'isDesktopRuntime').mockReturnValue(true);
  activeUser = user;
  setDesktopConnectionScope({ profileId: profile.id, transportScope: 'transport-a', bridge: {} as never });
  desktop = { isDesktop: true, profile, platform: 'linux',
    connection: { status: 'ready', transportScope: 'transport-a' },
  } as DesktopContextValue;
  vi.mocked(getVoiceBriefing).mockResolvedValue(briefing);
  vi.mocked(speakOnce).mockReturnValue({ promise: Promise.resolve(), cancel: vi.fn() });
  window.proprDesktop = { voice: { requestMicrophone: vi.fn().mockResolvedValue(true), revokeMicrophone: vi.fn().mockResolvedValue(undefined) } } as never;
});
afterEach(() => {
  delete window.proprDesktop;
  if (mediaDescriptor) Object.defineProperty(navigator, 'mediaDevices', mediaDescriptor);
  else Reflect.deleteProperty(navigator, 'mediaDevices');
  act(() => setDesktopConnectionScope(null));
});

describe('experimental voice briefing preference', () => {
  it.each([null, 'false', 'yes', '1', '{broken'])('defaults off with stored value %s, including existing disclosure acknowledgement', async stored => {
    if (stored !== null) localStorage.setItem(key, stored);
    localStorage.setItem('propr.voice-recognition-disclosure.v1', 'acknowledged');
    render(<><VoiceSettingsSection /><VoiceBriefingControl /></>, { wrapper: Wrapper });
    expect(screen.getByRole('checkbox', { name: 'Enable voice briefings' })).not.toBeChecked();
    expect(screen.queryByRole('button', { name: /Voice Briefing/i })).not.toBeInTheDocument();
    const { result } = renderHook(useVoiceBriefing, { wrapper: Wrapper });
    await act(async () => {
      await result.current.requestBriefing();
      await result.current.repeatBriefing();
      await result.current.startListening();
      await result.current.handleTranscript('catch me up');
      await result.current.confirmPendingAction();
    });
    expect(getVoiceBriefing).not.toHaveBeenCalled();
    expect(speakOnce).not.toHaveBeenCalled();
    expect(listenOnce).not.toHaveBeenCalled();
    expect(window.proprDesktop!.voice!.requestMicrophone).not.toHaveBeenCalled();
  });

  it('persists explicit opt-in and opt-out across remounts without starting voice on enable', () => {
    const view = render(<><VoiceSettingsSection /><VoiceBriefingControl /></>, { wrapper: Wrapper });
    const toggle = screen.getByRole('checkbox');
    expect(toggle).toHaveAccessibleDescription(/Off by default/);
    fireEvent.click(toggle);
    expect(toggle).toBeChecked();
    expect(localStorage.getItem(key)).toBe('true');
    expect(screen.getByRole('button', { name: /Voice Briefing/i })).toBeInTheDocument();
    expect(getVoiceBriefing).not.toHaveBeenCalled();
    expect(speakOnce).not.toHaveBeenCalled();
    expect(window.proprDesktop!.voice!.requestMicrophone).not.toHaveBeenCalled();
    view.unmount();
    const reloaded = render(<><VoiceSettingsSection /><VoiceBriefingControl /></>, { wrapper: Wrapper });
    expect(screen.getByRole('checkbox')).toBeChecked();
    fireEvent.click(screen.getByRole('checkbox'));
    expect(screen.queryByRole('button', { name: /Voice Briefing/i })).not.toBeInTheDocument();
    reloaded.unmount();
    render(<VoiceSettingsSection />, { wrapper: Wrapper });
    expect(screen.getByRole('checkbox')).not.toBeChecked();
  });

  it('stays off by default in the browser runtime until the signed-in user opts in', async () => {
    switchToBrowserRuntime();
    localStorage.setItem('propr.voice-recognition-disclosure.v1', 'acknowledged');
    render(<><VoiceSettingsSection /><VoiceBriefingControl /></>, { wrapper: Wrapper });
    const toggle = screen.getByRole('checkbox', { name: 'Enable voice briefings' });
    expect(toggle).not.toBeChecked();
    expect(screen.queryByRole('button', { name: /Voice briefing/i })).not.toBeInTheDocument();

    const { result } = renderHook(useVoiceBriefing, { wrapper: Wrapper });
    await act(async () => {
      await result.current.requestBriefing();
      await result.current.repeatBriefing();
      await result.current.startListening();
      await result.current.handleTranscript('catch me up');
    });
    expect(getVoiceBriefing).not.toHaveBeenCalled();
    expect(speakOnce).not.toHaveBeenCalled();
    expect(listenOnce).not.toHaveBeenCalled();

    fireEvent.click(toggle);
    expect(toggle).toBeChecked();
    expect(localStorage.getItem(browserKey())).toBe('true');
    expect(screen.getByRole('button', { name: /Voice briefing/i })).toBeInTheDocument();
    // Opting in reveals the entry point without starting any voice activity.
    expect(getVoiceBriefing).not.toHaveBeenCalled();
    expect(speakOnce).not.toHaveBeenCalled();

    fireEvent.click(toggle);
    expect(screen.queryByRole('button', { name: /Voice briefing/i })).not.toBeInTheDocument();
  });

  it('does not reuse a browser opt-in for another signed-in account', () => {
    switchToBrowserRuntime();
    act(() => saveVoicePreference(browserKey(), true));
    const hook = renderHook(useVoicePreference, { wrapper: Wrapper });
    expect(hook.result.current.enabled).toBe(true);
    activeUser = { ...user, id: 'account-b' };
    hook.rerender();
    expect(hook.result.current.enabled).toBe(false);
    activeUser = null;
    hook.rerender();
    expect(hook.result.current.enabled).toBe(false);
    expect(hook.result.current.available).toBe(false);
    act(() => saveVoicePreference(browserKey(), false));
  });

  it('cancels an in-flight browser briefing when the preference is turned off', async () => {
    switchToBrowserRuntime();
    act(() => saveVoicePreference(browserKey(), true));
    const pending = deferred<VoiceBriefingResponse>();
    vi.mocked(getVoiceBriefing).mockReturnValue(pending.promise);
    const { result } = renderHook(useVoiceBriefing, { wrapper: Wrapper });
    let operation!: Promise<void>;
    act(() => { operation = result.current.requestBriefing(); });
    const signal = vi.mocked(getVoiceBriefing).mock.calls[0][1]!;
    act(() => {
      saveVoicePreference(browserKey(), false);
      expect(signal.aborted).toBe(true);
    });
    await act(async () => { pending.resolve(briefing); await operation; });
    expect(result.current.briefing).toBeNull();
    expect(speakOnce).not.toHaveBeenCalled();
    expect(result.current.phase).toBe('idle');
  });

  it('aborts an in-flight briefing immediately and rejects late results even after re-enabling', async () => {
    enable();
    const pending = deferred<VoiceBriefingResponse>();
    vi.mocked(getVoiceBriefing).mockReturnValue(pending.promise);
    const { result } = renderHook(useVoiceBriefing, { wrapper: Wrapper });
    let operation!: Promise<void>;
    act(() => { operation = result.current.requestBriefing(); });
    const signal = vi.mocked(getVoiceBriefing).mock.calls[0][1]!;
    act(() => {
      saveVoicePreference(key, false);
      expect(signal.aborted).toBe(true);
    });
    enable();
    await act(async () => { pending.resolve(briefing); await operation; });
    expect(result.current.briefing).toBeNull();
    expect(speakOnce).not.toHaveBeenCalled();
    expect(result.current.phase).toBe('idle');
  });

  it('cancels active speech immediately and clears briefing and pending actions', async () => {
    enable();
    const playback = deferred<void>();
    const cancel = vi.fn(() => playback.resolve());
    vi.mocked(speakOnce).mockReturnValue({ promise: playback.promise, cancel });
    const { result } = renderHook(useVoiceBriefing, { wrapper: Wrapper });
    let operation!: Promise<void>;
    await act(async () => { operation = result.current.requestBriefing(); });
    expect(result.current.phase).toBe('speaking');
    act(() => {
      saveVoicePreference(key, false);
      expect(cancel).toHaveBeenCalledOnce();
    });
    await act(async () => operation);
    expect(result.current.briefing).toBeNull();
    expect(result.current.pendingAction).toBeNull();
    expect(result.current.phase).toBe('idle');
  });

  it('revokes pending microphone consent and never opens media after late approval', async () => {
    enable();
    const consent = deferred<boolean>();
    vi.mocked(window.proprDesktop!.voice!.requestMicrophone).mockReturnValue(consent.promise);
    const getUserMedia = vi.fn();
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } });
    const { result } = renderHook(useVoiceBriefing, { wrapper: Wrapper });
    let operation!: Promise<void>;
    act(() => { operation = result.current.startListening(); });
    disable();
    expect(window.proprDesktop!.voice!.revokeMicrophone).toHaveBeenCalled();
    enable();
    await act(async () => { consent.resolve(true); await operation; });
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(result.current.error).toBeNull();
  });

  it('releases every track from a late microphone acquisition after opt-out', async () => {
    enable();
    const media = deferred<MediaStream>();
    const getUserMedia = vi.fn().mockReturnValue(media.promise);
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } });
    const { result } = renderHook(useVoiceBriefing, { wrapper: Wrapper });
    let operation!: Promise<void>;
    await act(async () => { operation = result.current.startListening(); });
    expect(getUserMedia).toHaveBeenCalledOnce();
    disable();
    const stop = vi.fn();
    await act(async () => { media.resolve({ getTracks: () => [{ stop }, { stop }] } as unknown as MediaStream); await operation; });
    expect(stop).toHaveBeenCalledTimes(2);
    expect(result.current.error).toBeNull();
    expect(listenOnce).not.toHaveBeenCalled();
  });

  it('does not refresh or play a completed mutation after disabling', async () => {
    enable();
    const mutation = deferred<void>();
    vi.mocked(stopTaskExecution).mockReturnValue(mutation.promise as never);
    const { result } = renderHook(useVoiceBriefing, { wrapper: Wrapper });
    await act(async () => result.current.requestBriefing());
    await act(async () => result.current.handleTranscript('stop task 1'));
    let operation!: Promise<void>;
    act(() => { operation = result.current.confirmPendingAction(); });
    disable();
    enable();
    await act(async () => { mutation.resolve(); await operation; });
    expect(getVoiceBriefing).toHaveBeenCalledOnce();
    expect(result.current.briefing).toBeNull();
    expect(result.current.phase).toBe('idle');
  });

  it('does not send a deferred plan refinement after opt-out', async () => {
    enable();
    const draft = deferred<Awaited<ReturnType<typeof getDraftWithPlan>>>();
    vi.mocked(getDraftWithPlan).mockReturnValue(draft.promise);
    vi.mocked(getVoiceBriefing).mockResolvedValue({ ...briefing, items: [{ ...briefing.items[0], kind: 'plan', reference: 'plan 1', id: 'draft-1', href: '/studio/draft-1', status: 'review' }] });
    const { result } = renderHook(useVoiceBriefing, { wrapper: Wrapper });
    await act(async () => result.current.requestBriefing());
    await act(async () => result.current.handleTranscript('follow up on plan 1: add tests'));
    let operation!: Promise<void>;
    act(() => { operation = result.current.confirmPendingAction(); });
    disable();
    await act(async () => { draft.resolve({ plan_json: {} } as never); await operation; });
    expect(refinePlan).not.toHaveBeenCalled();
  });

  it('aborts a mutation refresh and rejects its late result', async () => {
    enable();
    const refresh = deferred<VoiceBriefingResponse>();
    vi.mocked(getVoiceBriefing).mockResolvedValueOnce(briefing).mockReturnValueOnce(refresh.promise);
    const { result } = renderHook(useVoiceBriefing, { wrapper: Wrapper });
    await act(async () => result.current.requestBriefing());
    await act(async () => result.current.handleTranscript('stop task 1'));
    let operation!: Promise<void>;
    await act(async () => { operation = result.current.confirmPendingAction(); });
    const signal = vi.mocked(getVoiceBriefing).mock.calls[1][1]!;
    disable();
    expect(signal.aborted).toBe(true);
    enable();
    await act(async () => { refresh.resolve(briefing); await operation; });
    expect(result.current.briefing).toBeNull();
    expect(speakOnce).toHaveBeenCalledTimes(2); // Original briefing and confirmation only.
  });

  it('clears a pending command when the authenticated account changes without a transport change', async () => {
    enable();
    const hook = renderHook(useVoiceBriefing, { wrapper: Wrapper });
    await act(async () => hook.result.current.requestBriefing());
    await act(async () => hook.result.current.handleTranscript('stop task 1'));
    expect(hook.result.current.pendingAction).not.toBeNull();
    activeUser = { ...user, id: 'account-b' };
    hook.rerender();
    expect(hook.result.current.pendingAction).toBeNull();
    expect(hook.result.current.briefing).toBeNull();
    await act(async () => hook.result.current.confirmPendingAction());
    expect(stopTaskExecution).not.toHaveBeenCalled();
  });

  it('does not reuse an opt-in for a changed instance URL', () => {
    enable();
    const hook = renderHook(useVoicePreference, { wrapper: Wrapper });
    expect(hook.result.current.enabled).toBe(true);
    desktop = { ...desktop!, profile: { ...profile, baseUrl: 'https://another.example.test' } };
    hook.rerender();
    expect(hook.result.current.enabled).toBe(false);
  });

  it('fails closed and reports a persistence failure without leaving audio running', async () => {
    enable();
    const playback = deferred<void>();
    const cancel = vi.fn(() => playback.resolve());
    vi.mocked(speakOnce).mockReturnValue({ promise: playback.promise, cancel });
    const hook = renderHook(useVoiceBriefing, { wrapper: Wrapper });
    render(<VoiceSettingsSection />, { wrapper: Wrapper });
    let operation!: Promise<void>;
    await act(async () => { operation = hook.result.current.requestBriefing(); });
    const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Unavailable'); });
    fireEvent.click(screen.getByRole('checkbox'));
    expect(cancel).toHaveBeenCalledOnce();
    expect(screen.getByRole('checkbox')).not.toBeChecked();
    expect(screen.getByRole('alert')).toHaveTextContent('Could not save');
    await act(async () => operation);
    write.mockRestore();
    disable();
  });

  it('isolates account opt-ins, clears old state, and aborts before a connection switch renders', async () => {
    enable();
    const pending = deferred<VoiceBriefingResponse>();
    vi.mocked(getVoiceBriefing).mockReturnValue(pending.promise);
    const hook = renderHook(() => ({ voice: useVoiceBriefing(), preference: useVoicePreference() }), { wrapper: Wrapper });
    let operation!: Promise<void>;
    act(() => { operation = hook.result.current.voice.requestBriefing(); });
    const signal = vi.mocked(getVoiceBriefing).mock.calls[0][1]!;
    act(() => {
      setDesktopConnectionScope({ ...getDesktopConnectionScope()!, transportScope: 'transport-b' });
      expect(signal.aborted).toBe(true);
    });
    activeUser = { ...user, id: 'account-b' };
    desktop = { ...desktop!, connection: { status: 'ready', transportScope: 'transport-b' } };
    hook.rerender();
    expect(hook.result.current.preference.enabled).toBe(false);
    await act(async () => { pending.resolve(briefing); await operation; });
    expect(hook.result.current.voice.briefing).toBeNull();
    expect(speakOnce).not.toHaveBeenCalled();
    activeUser = user;
    hook.rerender();
    expect(hook.result.current.preference.enabled).toBe(true);
    expect(hook.result.current.voice.briefing).toBeNull();
    activeUser = null;
    hook.rerender();
    expect(hook.result.current.preference.enabled).toBe(false);
  });
});
