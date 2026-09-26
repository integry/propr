/* eslint-disable max-lines -- voice session state and lifecycle remain centralized in this controller */
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type {
  VoiceBriefingItem,
  VoiceBriefingResponse,
  VoiceBriefingScope,
} from '@propr/shared';
import {
  abortGeneration,
  abortRefinement,
  getDraftWithPlan,
  postTaskFollowup,
  refinePlan,
  stopTaskExecution,
} from '../api/proprApi';
import { useVoicePreference, subscribeVoicePreference } from './useVoicePreference';
import { subscribeDesktopConnectionScope } from '../api/apiClient';
import { isDesktopRuntime } from '../config/runtimeMode';
import { getVoiceBriefing } from '../api/voiceApi';
import {
  BrowserSpeechError,
  getBrowserSpeechCapabilities,
  listenOnce,
  normalizeBrowserSpeechError,
  speakOnce,
  type BrowserSpeechCapabilities,
  type CancellableSpeech,
} from '../voice/browserSpeech';
import {
  parseVoiceCommand,
  type ParsedVoiceCommand,
} from '../voice/voiceCommands';

export type VoiceBriefingPhase =
  | 'idle'
  | 'loading'
  | 'speaking'
  | 'listening'
  | 'confirming'
  | 'executing'
  | 'error';

export type PendingVoiceBriefingAction = Extract<
  ParsedVoiceCommand,
  { type: 'pending_action' }
>;

export interface UseVoiceBriefingOptions {
  /** BCP 47 language tag used for both browser speech APIs. */
  language?: string;
  recognitionTimeoutMs?: number;
  /** Called for a resolved, server-provided application path. */
  onOpenItem?: (item: VoiceBriefingItem) => void;
}

export interface VoiceBriefingController {
  phase: VoiceBriefingPhase;
  briefing: VoiceBriefingResponse | null;
  pendingAction: PendingVoiceBriefingAction | null;
  transcript: string | null;
  error: string | null;
  capabilities: BrowserSpeechCapabilities;
  requestBriefing: (scope?: VoiceBriefingScope) => Promise<void>;
  repeatBriefing: () => Promise<void>;
  startListening: () => Promise<void>;
  handleTranscript: (transcript: string) => Promise<void>;
  confirmPendingAction: () => Promise<void>;
  cancelPendingAction: () => void;
  /** Stop browser audio and abandon any still-loading interaction. */
  stopAudio: () => void;
  clearError: () => void;
}

function messageFrom(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function desktopVoiceBridge() {
  return isDesktopRuntime() ? window.proprDesktop?.voice : undefined;
}

/** Consent and device availability are checked without invoking a transcription service. */
async function checkDesktopMicrophone(
  voice: NonNullable<Window['proprDesktop']>['voice'],
  signal: AbortSignal,
): Promise<void> {
  if (!voice) throw new BrowserSpeechError('service-unavailable');
  const allowed = await voice.requestMicrophone();
  if (signal.aborted) throw new BrowserSpeechError('cancelled');
  if (!allowed) throw new BrowserSpeechError('permission-denied');
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  stream.getTracks().forEach(track => track.stop());
  if (signal.aborted) throw new BrowserSpeechError('cancelled');
}

function desktopMicrophoneError(error: unknown): string {
  const normalized = normalizeBrowserSpeechError(error);
  return normalized.message + (normalized.category === 'permission-denied'
    ? ' Check your operating system microphone privacy settings. On macOS, restart ProPR after changing a denied permission.' : '');
}

function confirmationPrompt(action: PendingVoiceBriefingAction): string {
  if (action.action === 'stop') {
    return `Stop ${action.item.reference}, ${action.item.title}? Say confirm to stop it, or cancel.`;
  }
  return `Follow up on ${action.item.reference} with: ${action.instruction}. Say confirm to send it, or cancel.`;
}

function taskMutationTarget(item: VoiceBriefingItem): string | null {
  if (item.kind !== 'task') return null;
  return item.href === `/tasks/${encodeURIComponent(item.id)}` ? item.id : null;
}

function planMutationTarget(item: VoiceBriefingItem): string | null {
  if (item.kind !== 'plan') return null;
  return item.href === `/studio/${encodeURIComponent(item.id)}` ? item.id : null;
}

function mutationTarget(item: VoiceBriefingItem): string | null {
  return taskMutationTarget(item) ?? planMutationTarget(item);
}

function missingMutationTargetMessage(action: PendingVoiceBriefingAction): string {
  const actionName = action.action === 'follow_up' ? 'follow up on' : 'stop';
  const targetName = action.item.kind === 'plan' ? 'plan draft' : 'task execution';
  return `Cannot ${actionName} ${action.item.reference} because it does not identify a ${targetName}.`;
}

function unsupportedPlanStopMessage(action: PendingVoiceBriefingAction): string | null {
  if (action.action !== 'stop' || action.item.kind !== 'plan') return null;
  if (action.item.status === 'generating' || action.item.status === 'refining') return null;
  if (action.item.status === 'executing') {
    return `Cannot stop ${action.item.reference} because the briefing does not identify its task execution.`;
  }
  return `Cannot stop ${action.item.reference} while its plan status is ${action.item.status}.`;
}

async function executePlanAction(
  action: PendingVoiceBriefingAction,
  draftId: string,
  isCurrent: () => boolean,
): Promise<void> {
  if (action.action === 'follow_up') {
    const draft = await getDraftWithPlan(draftId);
    if (isCurrent()) await refinePlan(draftId, draft.plan_json, action.instruction);
    return;
  }

  switch (action.item.status) {
    case 'generating':
      await abortGeneration(draftId);
      return;
    case 'refining':
      await abortRefinement(draftId);
      return;
    default:
      throw new Error(unsupportedPlanStopMessage(action) ?? 'The plan cannot be stopped.');
  }
}

/**
 * Coordinate one on-demand briefing and one-shot browser speech interactions.
 * The hook deliberately owns no socket, interval, or task-completion polling.
 */
export function useVoiceBriefing(
  options: UseVoiceBriefingOptions = {},
): VoiceBriefingController {
  const preference = useVoicePreference();
  const preferenceRef = useRef(preference);
  preferenceRef.current = preference;
  const [phase, setPhaseState] = useState<VoiceBriefingPhase>('idle');
  const [briefing, setBriefing] = useState<VoiceBriefingResponse | null>(null);
  const [pendingAction, setPendingAction] = useState<PendingVoiceBriefingAction | null>(null);
  const [transcript, setTranscript] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const capabilities = useMemo(getBrowserSpeechCapabilities, []);

  const mountedRef = useRef(true);
  const sessionRunRef = useRef(0);
  const briefingRequestRef = useRef<AbortController | null>(null);
  const activityAllowed = useCallback(() => mountedRef.current && preferenceRef.current.isEnabled(), []);
  const phaseRef = useRef<VoiceBriefingPhase>('idle');
  const briefingRef = useRef<VoiceBriefingResponse | null>(null);
  const pendingActionRef = useRef<PendingVoiceBriefingAction | null>(null);
  const scopeRef = useRef<VoiceBriefingScope>('all');
  const speechRef = useRef<CancellableSpeech | null>(null);
  const speechRunRef = useRef(0);
  const suppressSpeechRef = useRef(false);
  const recognitionRef = useRef<AbortController | null>(null);
  const mutationInFlightRef = useRef(false);
  const requestRunRef = useRef(0);
  const unresolvedBriefingRequestRunRef = useRef<number | null>(null);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const setPhase = useCallback((next: VoiceBriefingPhase) => {
    phaseRef.current = next;
    if (mountedRef.current) setPhaseState(next);
  }, []);

  const cancelSpeech = useCallback(() => {
    speechRunRef.current += 1;
    const speech = speechRef.current;
    speechRef.current = null;
    speech?.cancel();
  }, []);

  const cancelRecognition = useCallback(() => {
    const recognition = recognitionRef.current;
    recognitionRef.current = null;
    recognition?.abort();
  }, []);

  const showError = useCallback((message: string) => {
    if (!mountedRef.current) return;
    setError(message);
    setPhase('error');
  }, [setPhase]);

  const speak = useCallback(async (
    text: string,
    settledPhase: VoiceBriefingPhase,
    exposeSpeakingPhase = true,
  ): Promise<void> => {
    if (!activityAllowed()) return;
    cancelSpeech();
    if (suppressSpeechRef.current
      || !capabilities.speechSynthesis
      || document.visibilityState === 'hidden') {
      setPhase(settledPhase);
      return;
    }

    const run = speechRunRef.current;
    const speech = speakOnce(text, { lang: optionsRef.current.language });
    speechRef.current = speech;
    setPhase(exposeSpeakingPhase ? 'speaking' : settledPhase);
    try {
      await speech.promise;
    } catch (speechError) {
      if (!(speechError instanceof BrowserSpeechError && speechError.category === 'cancelled')) {
        // Speech is an enhancement; keep the structured content usable visually.
        if (mountedRef.current && speechRunRef.current === run) {
          setError(messageFrom(speechError, 'The briefing could not be spoken.'));
        }
      }
    } finally {
      if (speechRunRef.current === run) {
        speechRef.current = null;
        setPhase(settledPhase);
      }
    }
  }, [activityAllowed, cancelSpeech, capabilities.speechSynthesis, setPhase]);

  const storeBriefing = useCallback((next: VoiceBriefingResponse) => {
    briefingRef.current = next;
    scopeRef.current = next.scope;
    if (mountedRef.current) setBriefing(next);
  }, []);

  const requestBriefing = useCallback(async (
    scope: VoiceBriefingScope = 'all',
  ): Promise<void> => {
    if (!activityAllowed() || mutationInFlightRef.current) return;
    suppressSpeechRef.current = false;
    const run = requestRunRef.current + 1;
    requestRunRef.current = run;
    unresolvedBriefingRequestRunRef.current = run;
    cancelRecognition();
    cancelSpeech();
    pendingActionRef.current = null;
    if (mountedRef.current) {
      setPendingAction(null);
      setError(null);
    }
    setPhase('loading');

    briefingRequestRef.current?.abort();
    const controller = new AbortController();
    briefingRequestRef.current = controller;
    let next: VoiceBriefingResponse;
    try {
      next = await getVoiceBriefing(scope, controller.signal);
    } catch (requestError) {
      if (!activityAllowed() || requestRunRef.current !== run) return;
      showError(messageFrom(requestError, 'The voice briefing could not be loaded.'));
      return;
    } finally {
      if (briefingRequestRef.current === controller) briefingRequestRef.current = null;
      if (unresolvedBriefingRequestRunRef.current === run) {
        unresolvedBriefingRequestRunRef.current = null;
      }
    }

    if (!activityAllowed() || requestRunRef.current !== run) return;
    storeBriefing(next);
    await speak(next.speechText, 'idle');
  }, [activityAllowed, cancelRecognition, cancelSpeech, setPhase, showError, speak, storeBriefing]);

  const repeatBriefing = useCallback(async (): Promise<void> => {
    if (!activityAllowed() || mutationInFlightRef.current) return;
    suppressSpeechRef.current = false;
    cancelRecognition();
    const latest = briefingRef.current;
    if (!latest) {
      showError('Get a briefing first so it can be repeated.');
      return;
    }
    if (mountedRef.current) setError(null);
    await speak(latest.speechText, pendingActionRef.current ? 'confirming' : 'idle');
  }, [activityAllowed, cancelRecognition, showError, speak]);

  const cancelPendingAction = useCallback(() => {
    cancelRecognition();
    cancelSpeech();
    pendingActionRef.current = null;
    if (mountedRef.current) {
      setPendingAction(null);
      setError(null);
    }
    if (!mutationInFlightRef.current) setPhase('idle');
  }, [cancelRecognition, cancelSpeech, setPhase]);

  const confirmPendingAction = useCallback(async (): Promise<void> => {
    const action = pendingActionRef.current;
    if (!activityAllowed() || !action || mutationInFlightRef.current) return;
    const session = sessionRunRef.current;
    const isCurrent = () => activityAllowed() && sessionRunRef.current === session;
    suppressSpeechRef.current = false;
    const unsupportedMessage = unsupportedPlanStopMessage(action);
    if (unsupportedMessage) {
      showError(unsupportedMessage);
      return;
    }
    const targetId = mutationTarget(action.item);
    if (!targetId) {
      showError(missingMutationTargetMessage(action));
      return;
    }

    mutationInFlightRef.current = true;
    cancelRecognition();
    cancelSpeech();
    pendingActionRef.current = null;
    if (mountedRef.current) {
      setPendingAction(null);
      setError(null);
    }
    setPhase('executing');

    try {
      if (action.item.kind === 'plan') {
        await executePlanAction(action, targetId, isCurrent);
      } else if (action.action === 'stop') {
        await stopTaskExecution(targetId);
      } else {
        await postTaskFollowup(targetId, action.instruction);
      }
    } catch (mutationError) {
      if (!isCurrent()) return;
      showError(messageFrom(mutationError, 'The action could not be completed.'));
      mutationInFlightRef.current = false;
      return;
    }

    if (!isCurrent()) return;

    const controller = new AbortController();
    briefingRequestRef.current?.abort();
    briefingRequestRef.current = controller;
    try {
      // This is a single fresh snapshot, not task-completion polling.
      const refreshed = await getVoiceBriefing(scopeRef.current, controller.signal);
      if (!isCurrent() || controller.signal.aborted) return;
      storeBriefing(refreshed);
      // The mutation and its required refresh are settled before optional speech.
      // This lets hidden-tab cancellation return the controller to idle immediately.
      mutationInFlightRef.current = false;
      await speak(refreshed.speechText, 'idle');
    } catch (refreshError) {
      if (isCurrent() && !controller.signal.aborted) {
        showError(messageFrom(
          refreshError,
          'The task action completed, but the briefing could not be refreshed.',
        ));
      }
    } finally {
      if (briefingRequestRef.current === controller) briefingRequestRef.current = null;
      if (isCurrent()) mutationInFlightRef.current = false;
    }
  }, [activityAllowed, cancelRecognition, cancelSpeech, setPhase, showError, speak, storeBriefing]);

  const handleTranscript = useCallback(async (spokenText: string): Promise<void> => {
    if (!activityAllowed()
      || mutationInFlightRef.current
      || unresolvedBriefingRequestRunRef.current !== null) return;
    setTranscript(spokenText);
    setError(null);
    const command = parseVoiceCommand(spokenText, briefingRef.current);

    if (pendingActionRef.current && command.type !== 'confirm' && command.type !== 'cancel') {
      setPhase('confirming');
      setError('Say confirm to execute the pending action, or cancel.');
      return;
    }

    switch (command.type) {
      case 'briefing':
        await requestBriefing(command.scope);
        return;
      case 'repeat':
        await repeatBriefing();
        return;
      case 'open':
        optionsRef.current.onOpenItem?.(command.item);
        setPhase('idle');
        return;
      case 'pending_action':
        {
          const unsupportedMessage = unsupportedPlanStopMessage(command);
          if (unsupportedMessage) {
            showError(unsupportedMessage);
            return;
          }
        }
        if (!mutationTarget(command.item)) {
          showError(missingMutationTargetMessage(command));
          return;
        }
        pendingActionRef.current = command;
        setPendingAction(command);
        await speak(confirmationPrompt(command), 'confirming');
        return;
      case 'confirm':
        if (!pendingActionRef.current) {
          showError('There is no pending action to confirm.');
          return;
        }
        await confirmPendingAction();
        return;
      case 'cancel':
        cancelPendingAction();
        return;
      case 'invalid':
        showError(command.reason);
    }
  }, [
    activityAllowed,
    cancelPendingAction,
    confirmPendingAction,
    repeatBriefing,
    requestBriefing,
    setPhase,
    showError,
    speak,
  ]);

  const startListening = useCallback(async (): Promise<void> => {
    if (!activityAllowed()
      || recognitionRef.current
      || mutationInFlightRef.current
      || unresolvedBriefingRequestRunRef.current !== null) return;
    suppressSpeechRef.current = false;
    if (document.visibilityState === 'hidden') {
      setPhase(pendingActionRef.current ? 'confirming' : 'idle');
      return;
    }
    cancelSpeech();
    if (mountedRef.current) setError(null);
    setPhase('listening');
    const controller = new AbortController();
    recognitionRef.current = controller;

    const isCurrentRecognition = () => activityAllowed() && recognitionRef.current === controller;
    const desktopVoice = desktopVoiceBridge();
    const revokeMicrophone = () => { void desktopVoice?.revokeMicrophone().catch(() => undefined); };
    controller.signal.addEventListener('abort', revokeMicrophone, { once: true });
    let spokenText: string;
    try {
      if (isDesktopRuntime()) {
        await checkDesktopMicrophone(desktopVoice, controller.signal);
        if (isCurrentRecognition()) {
          recognitionRef.current = null;
          showError('Microphone access is allowed. Voice commands are unavailable in this desktop runtime. Use Catch me up for text, or voice commands in a supported browser.');
        }
        return;
      }
      // listenOnce starts recognition synchronously here, preserving user-gesture activation.
      spokenText = await listenOnce({
        signal: controller.signal,
        lang: optionsRef.current.language,
        timeoutMs: optionsRef.current.recognitionTimeoutMs,
      });
      if (!isCurrentRecognition()) return;
      recognitionRef.current = null;
    } catch (recognitionError) {
      if (!isCurrentRecognition()) return;
      recognitionRef.current = null;
      if (recognitionError instanceof BrowserSpeechError
        && recognitionError.category === 'cancelled') {
        setPhase(pendingActionRef.current ? 'confirming' : 'idle');
        return;
      }
      showError(isDesktopRuntime()
        ? desktopMicrophoneError(recognitionError)
        : messageFrom(recognitionError, 'The voice command could not be recognized.'));
      return;
    } finally {
      controller.signal.removeEventListener('abort', revokeMicrophone);
      // Cancellation already revoked this grant. A late completion must not
      // revoke a newer attempt that began after cancellation.
      if (!controller.signal.aborted) revokeMicrophone();
    }

    try {
      await handleTranscript(spokenText);
    } catch (commandError) {
      if (mountedRef.current) {
        showError(messageFrom(commandError, 'The voice command could not be processed.'));
      }
    }
  }, [activityAllowed, cancelSpeech, handleTranscript, setPhase, showError]);

  const stopAudio = useCallback(() => {
    // Suppress speech that an already-running confirmed mutation may otherwise
    // start after its refresh completes. Explicit future actions opt back in.
    suppressSpeechRef.current = true;
    requestRunRef.current += 1;
    unresolvedBriefingRequestRunRef.current = null;
    // A normal panel close retains the confirmed action's refresh lifecycle.
    // Opt-out/account reset clears mutationInFlight first and aborts it too.
    if (!mutationInFlightRef.current) {
      briefingRequestRef.current?.abort();
      briefingRequestRef.current = null;
    }
    cancelRecognition();
    cancelSpeech();
    if (!mutationInFlightRef.current) {
      setPhase(pendingActionRef.current ? 'confirming' : 'idle');
    }
  }, [cancelRecognition, cancelSpeech, setPhase]);

  const clearError = useCallback(() => {
    if (mountedRef.current) setError(null);
    setPhase(pendingActionRef.current ? 'confirming' : 'idle');
  }, [setPhase]);

  const resetSession = useCallback(() => {
    sessionRunRef.current += 1;
    mutationInFlightRef.current = false;
    pendingActionRef.current = null;
    briefingRef.current = null;
    scopeRef.current = 'all';
    stopAudio();
    if (mountedRef.current) {
      setBriefing(null);
      setPendingAction(null);
      setTranscript(null);
      setError(null);
      setPhase('idle');
    }
  }, [setPhase, stopAudio]);

  // Subscribe directly as well as rendering the preference. Opt-out must cancel
  // work synchronously, before React commits the hidden entry points.
  useLayoutEffect(() => {
    const unsubscribePreference = subscribeVoicePreference(() => {
      if (!preferenceRef.current.isEnabled()) resetSession();
    });
    const unsubscribeConnection = subscribeDesktopConnectionScope(resetSession);
    return () => { unsubscribePreference(); unsubscribeConnection(); };
  }, [resetSession]);

  useLayoutEffect(() => {
    resetSession();
  }, [preference.enabled, preference.key, preference.connection, resetSession]);

  useLayoutEffect(() => {
    mountedRef.current = true;
    const handleVisibilityChange = () => {
      if (document.visibilityState !== 'hidden') return;
      suppressSpeechRef.current = true;
      cancelRecognition();
      cancelSpeech();
      if (!mutationInFlightRef.current && phaseRef.current !== 'loading') {
        setPhase(pendingActionRef.current ? 'confirming' : 'idle');
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      mountedRef.current = false;
      requestRunRef.current += 1;
      sessionRunRef.current += 1;
      briefingRequestRef.current?.abort();
      briefingRequestRef.current = null;
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      cancelRecognition();
      cancelSpeech();
    };
  }, [cancelRecognition, cancelSpeech, setPhase]);

  return {
    phase,
    briefing,
    pendingAction,
    transcript,
    error,
    capabilities,
    requestBriefing,
    repeatBriefing,
    startListening,
    handleTranscript,
    confirmPendingAction,
    cancelPendingAction,
    stopAudio,
    clearError,
  };
}
