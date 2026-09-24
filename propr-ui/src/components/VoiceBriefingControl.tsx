/* eslint-disable max-lines -- voice disclosure, controls, and briefing text share one panel */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  AlertTriangle,
  AudioLines,
  Check,
  LoaderCircle,
  Mic,
  RotateCcw,
  Sparkles,
  Square,
  Volume2,
  X,
} from 'lucide-react';
import type { VoiceBriefingItem } from '@propr/shared';
import { useVoicePreference } from '../hooks/useVoicePreference';
import { isDesktopRuntime } from '../config/runtimeMode';
import { useVoiceBriefing, type VoiceBriefingPhase } from '../hooks/useVoiceBriefing';

export const VOICE_RECOGNITION_DISCLOSURE_STORAGE_KEY =
  'propr.voice-recognition-disclosure.v1';

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function hasAcknowledgedDisclosure(): boolean {
  try {
    return window.localStorage.getItem(VOICE_RECOGNITION_DISCLOSURE_STORAGE_KEY) === 'acknowledged';
  } catch {
    return false;
  }
}

function phaseMessage(phase: VoiceBriefingPhase, hasBriefing: boolean, error: string | null): string {
  if (error !== null) return error;
  switch (phase) {
    case 'loading': return 'Loading your briefing.';
    case 'speaking': return 'Speaking your briefing.';
    case 'listening': return isDesktopRuntime() ? 'Checking microphone access.' : 'Listening for one short command.';
    case 'confirming': return 'Action awaiting confirmation.';
    case 'executing': return 'Applying the confirmed action.';
    case 'error': return 'The voice briefing encountered an error.';
    default: return hasBriefing ? 'Briefing ready.' : 'Ready for a briefing.';
  }
}

function statusTone(status: string): string {
  if (/fail|error|blocked|attention/i.test(status)) return 'bg-red-50 text-red-700';
  if (/running|execut|generat|refin/i.test(status)) return 'bg-blue-50 text-blue-700';
  return 'bg-slate-100 text-slate-600';
}

function BriefingItem({ item, onOpen }: { item: VoiceBriefingItem; onOpen: () => void }) {
  return (
    <li className="rounded-lg border border-slate-200 bg-white p-3 shadow-sm">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex h-7 min-w-7 items-center justify-center rounded-md bg-slate-100 px-1.5 text-[10px] font-bold uppercase text-slate-600">
          {item.kind.slice(0, 1)}{item.position}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-start gap-2">
            <Link
              to={item.href}
              onClick={onOpen}
              className="min-w-0 flex-1 text-sm font-semibold text-slate-900 hover:text-primary-700 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
            >
              {item.title}
            </Link>
            <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${statusTone(item.status)}`}>
              {item.status}
            </span>
          </div>
          {item.repository && <p className="mt-0.5 truncate text-xs text-slate-500">{item.repository}</p>}
          <p className="mt-1 text-xs leading-5 text-slate-600">{item.summary}</p>
          <p className="mt-1 text-[11px] font-medium text-slate-600">Say “{item.reference}” in a command</p>
        </div>
      </div>
    </li>
  );
}

export default function VoiceBriefingControl() {
  const { enabled, key, connection } = useVoicePreference();
  return enabled ? <EnabledVoiceBriefingControl key={`${key}:${connection?.transportScope}`} /> : null;
}

// The branching mirrors the controller's finite UI phases and capability fallbacks.
// eslint-disable-next-line complexity
function EnabledVoiceBriefingControl() {
  const navigate = useNavigate();
  const [isOpen, setIsOpen] = useState(false);
  const [isDisclosureVisible, setIsDisclosureVisible] = useState(false);
  const [disclosureAcknowledged, setDisclosureAcknowledged] = useState(hasAcknowledgedDisclosure);
  const launcherRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  const handleVoiceNavigation = useCallback((item: VoiceBriefingItem) => {
    setIsOpen(false);
    navigate(item.href);
  }, [navigate]);

  const voice = useVoiceBriefing({ onOpenItem: handleVoiceNavigation });
  const { stopAudio } = voice;
  const busy = voice.phase === 'loading' || voice.phase === 'listening' || voice.phase === 'executing';
  const statusMessage = useMemo(
    () => phaseMessage(voice.phase, Boolean(voice.briefing), voice.error),
    [voice.briefing, voice.error, voice.phase],
  );

  const openPanel = useCallback(() => {
    const acknowledged = disclosureAcknowledged || hasAcknowledgedDisclosure();
    setDisclosureAcknowledged(acknowledged);
    setIsDisclosureVisible(!acknowledged);
    setIsOpen(true);
  }, [disclosureAcknowledged]);

  const closePanel = useCallback(() => {
    stopAudio();
    setIsOpen(false);
  }, [stopAudio]);

  const acknowledgeDisclosure = () => {
    try {
      window.localStorage.setItem(
        VOICE_RECOGNITION_DISCLOSURE_STORAGE_KEY,
        'acknowledged',
      );
    } catch {
      // Storage can be unavailable in private modes; acknowledgement still
      // applies for the lifetime of this mounted application shell.
    }
    setDisclosureAcknowledged(true);
    setIsDisclosureVisible(false);
  };

  const startListening = () => {
    if (!disclosureAcknowledged) {
      setIsDisclosureVisible(true);
      return;
    }
    void voice.startListening();
  };

  useEffect(() => {
    if (!isOpen) return;
    const launcher = launcherRef.current;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialogRef.current?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closePanel();
        return;
      }
      if (event.key !== 'Tab' || !dialogRef.current) return;
      const focusable = [...dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)];
      if (focusable.length === 0) {
        event.preventDefault();
        dialogRef.current.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (document.activeElement === dialogRef.current
        || !dialogRef.current.contains(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', handleKeyDown);
      launcher?.focus();
    };
  }, [closePanel, isOpen]);

  return (
    <>
      <button
        ref={launcherRef}
        type="button"
        onClick={openPanel}
        className="fixed bottom-[calc(var(--mobile-bottom-navigation-height)+0.75rem)] right-[max(0.75rem,env(safe-area-inset-right))] z-30 inline-flex min-h-11 items-center gap-2 rounded-full border border-white/10 bg-slate-900 px-3.5 py-2.5 text-sm font-semibold text-white shadow-2xl transition hover:bg-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 md:bottom-5 md:right-5"
        aria-haspopup="dialog"
        aria-expanded={isOpen}
        aria-label="Voice briefing"
      >
        <AudioLines className="h-5 w-5" aria-hidden="true" />
        <span className="hidden sm:inline">Voice briefing</span>
        <span className="sm:hidden">Briefing</span>
      </button>

      {isOpen && (
        <div className="fixed inset-0 z-[70] flex items-end bg-slate-950/50 pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] pt-[max(1rem,env(safe-area-inset-top))] md:items-center md:justify-center md:p-5">
          <div
            className="absolute inset-0 h-full w-full cursor-default"
            onClick={closePanel}
            aria-hidden="true"
          />
          <div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="voice-briefing-title"
            aria-describedby="voice-briefing-description"
            tabIndex={-1}
            className="relative flex max-h-[calc(100dvh-max(1rem,env(safe-area-inset-top)))] w-full flex-col overflow-hidden rounded-t-2xl bg-slate-50 shadow-2xl focus:outline-none md:max-h-[min(90vh,46rem)] md:max-w-xl md:rounded-2xl"
          >
            <header className="flex items-start gap-3 border-b border-slate-200 bg-white px-4 py-4 sm:px-5">
              <div className="flex h-10 w-10 flex-none items-center justify-center rounded-xl bg-primary-50 text-primary-700">
                <AudioLines className="h-5 w-5" aria-hidden="true" />
              </div>
              <div className="min-w-0 flex-1">
                <h2 id="voice-briefing-title" className="text-base font-semibold text-slate-950">Voice briefing{isDesktopRuntime() ? ' · Experimental' : ''}</h2>
                <p id="voice-briefing-description" className="mt-0.5 text-xs leading-5 text-slate-500">
                  {isDesktopRuntime() ? 'Review a briefing of your work.' : 'Review your work or issue one short voice command.'}
                </p>
              </div>
              <button
                type="button"
                onClick={closePanel}
                className="rounded-lg p-2 text-slate-500 hover:bg-slate-100 hover:text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
                aria-label="Close voice briefing"
              >
                <X className="h-5 w-5" aria-hidden="true" />
              </button>
            </header>

            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:p-5">
              {isDisclosureVisible && (
                <section aria-labelledby="voice-privacy-title" className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950">
                  <div className="flex gap-3">
                    <AlertTriangle className="mt-0.5 h-5 w-5 flex-none text-amber-700" aria-hidden="true" />
                    <div>
                      <h3 id="voice-privacy-title" className="font-semibold">{isDesktopRuntime() ? 'Desktop microphone access' : 'Before you use voice recognition'}</h3>
                      <p className="mt-1.5 text-xs leading-5 text-amber-900">
                        {isDesktopRuntime()
                          ? 'Voice commands are unavailable in this desktop runtime. The microphone check opens the microphone and immediately releases it, without recording or sending audio.'
                          : 'Your browser or operating system may send microphone audio to its speech-recognition vendor. ProPR does not receive raw audio or store the recognition transcript. If you confirm a spoken follow-up, its instruction is sent to ProPR.'}
                      </p>
                      <p className="mt-1.5 text-xs leading-5 text-amber-900">
                        {isDesktopRuntime()
                          ? 'Choose Check microphone, then Allow microphone in the desktop prompt. You can deny or cancel; each check requires new consent.'
                          : 'A microphone request can only begin after you acknowledge this notice and select Listen.'}
                      </p>
                      <div className="mt-3 flex flex-wrap gap-2">
                        <button
                          type="button"
                          onClick={acknowledgeDisclosure}
                          className="inline-flex min-h-10 items-center gap-2 rounded-lg bg-amber-900 px-3 py-2 text-xs font-semibold text-white hover:bg-amber-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-700 focus-visible:ring-offset-2"
                        >
                          <Check className="h-4 w-4" aria-hidden="true" />
                          I understand
                        </button>
                        <button
                          type="button"
                          onClick={() => setIsDisclosureVisible(false)}
                          className="min-h-10 rounded-lg px-3 py-2 text-xs font-semibold text-amber-900 hover:bg-amber-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-700"
                        >
                          Continue without voice commands
                        </button>
                      </div>
                      <p className="mt-2 text-xs leading-5 text-amber-900">
                        Catch me up may still play the briefing aloud when spoken playback is supported.
                      </p>
                    </div>
                  </div>
                </section>
              )}

              <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
                <button
                  type="button"
                  onClick={() => void voice.requestBriefing()}
                  disabled={busy}
                  className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-primary-600 px-3 py-2 text-sm font-semibold text-white hover:bg-primary-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:bg-slate-300"
                >
                  {voice.phase === 'loading'
                    ? <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />
                    : <Sparkles className="h-4 w-4" aria-hidden="true" />}
                  Catch me up
                </button>
                <button
                  type="button"
                  onClick={startListening}
                  disabled={(isDesktopRuntime() ? !window.proprDesktop?.voice : !voice.capabilities.speechRecognition) || busy || voice.phase === 'speaking'}
                  aria-describedby={!voice.capabilities.speechRecognition ? 'voice-recognition-unavailable' : undefined}
                  className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-400"
                >
                  <Mic className="h-4 w-4" aria-hidden="true" />
                  {voice.phase === 'listening'
                    ? (isDesktopRuntime() ? 'Checking microphone…' : 'Listening…')
                    : (isDesktopRuntime() ? 'Check microphone' : 'Listen')}
                </button>
                {voice.briefing && (
                  <button
                    type="button"
                    onClick={() => void voice.repeatBriefing()}
                    disabled={!voice.capabilities.speechSynthesis || busy || voice.phase === 'speaking'}
                    className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-400"
                  >
                    <RotateCcw className="h-4 w-4" aria-hidden="true" />
                    Repeat
                  </button>
                )}
                {(voice.phase === 'speaking' || voice.phase === 'listening') && (
                  <button
                    type="button"
                    onClick={voice.stopAudio}
                    className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm font-semibold text-red-700 hover:bg-red-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500"
                  >
                    <Square className="h-3.5 w-3.5 fill-current" aria-hidden="true" />
                    {voice.phase === 'listening' ? 'Cancel' : 'Stop speaking'}
                  </button>
                )}
              </div>

              {!voice.capabilities.speechRecognition && (
                <p id="voice-recognition-unavailable" className="rounded-lg bg-slate-100 px-3 py-2 text-xs leading-5 text-slate-600">
                  {isDesktopRuntime()
                    ? 'Voice commands are unavailable in this desktop runtime. Check microphone tests access only; it does not record or send audio. Use Catch me up for text, or voice commands in a supported browser.'
                    : 'Voice commands aren’t supported by this browser. You can still use Catch me up and review the briefing as text.'}
                </p>
              )}
              {!voice.capabilities.speechSynthesis && (
                <p className="rounded-lg bg-slate-100 px-3 py-2 text-xs leading-5 text-slate-600">
                  Spoken playback isn’t supported by this browser. Briefings will remain available as text.
                </p>
              )}

              {voice.transcript && (
                <div className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-600">
                  <span className="font-semibold text-slate-800">Heard:</span> “{voice.transcript}”
                </div>
              )}

              {voice.error && (
                <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs leading-5 text-red-700">
                  <AlertTriangle className="mt-0.5 h-4 w-4 flex-none" aria-hidden="true" />
                  <span className="flex-1">{voice.error}</span>
                  <button type="button" onClick={voice.clearError} className="font-semibold underline">Dismiss</button>
                </div>
              )}

              {voice.pendingAction && (
                <section aria-labelledby="voice-confirm-title" className="rounded-xl border-2 border-amber-300 bg-white p-4 shadow-sm">
                  <h3 id="voice-confirm-title" className="text-sm font-semibold text-slate-950">
                    Confirm {voice.pendingAction.action === 'stop' ? 'stop request' : 'follow-up'}
                  </h3>
                  <dl className="mt-3 space-y-2 text-sm">
                    <div>
                      <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">{voice.pendingAction.item.kind} title</dt>
                      <dd className="mt-0.5 font-semibold text-slate-950">{voice.pendingAction.item.title}</dd>
                    </div>
                    {voice.pendingAction.action === 'follow_up' && (
                      <div>
                        <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">Follow-up instruction</dt>
                        <dd className="mt-0.5 whitespace-pre-wrap text-slate-800">{voice.pendingAction.instruction}</dd>
                      </div>
                    )}
                  </dl>
                  <div className="mt-4 grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={() => void voice.confirmPendingAction()}
                      className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-red-600 px-3 py-2 text-sm font-semibold text-white hover:bg-red-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 focus-visible:ring-offset-2"
                    >
                      <Check className="h-4 w-4" aria-hidden="true" />
                      Confirm
                    </button>
                    <button
                      type="button"
                      onClick={voice.cancelPendingAction}
                      className="min-h-11 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
                    >
                      Cancel
                    </button>
                  </div>
                </section>
              )}

              {voice.briefing ? (
                <section aria-labelledby="briefing-headline">
                  <div className="rounded-xl bg-slate-900 p-4 text-white">
                    <div className="flex items-center gap-2 text-xs font-medium text-slate-300">
                      <Volume2 className="h-4 w-4" aria-hidden="true" />
                      Latest briefing
                    </div>
                    <h3 id="briefing-headline" className="mt-2 text-base font-semibold">{voice.briefing.headline}</h3>
                    <p className="mt-2 text-sm leading-6 text-slate-200">{voice.briefing.speechText}</p>
                    <div className="mt-3 flex flex-wrap gap-2 text-[11px] font-medium text-slate-300">
                      <span>{voice.briefing.counts.running} running</span>
                      <span aria-hidden="true">·</span>
                      <span>{voice.briefing.counts.queued} queued</span>
                      <span aria-hidden="true">·</span>
                      <span>{voice.briefing.counts.attention} need attention</span>
                    </div>
                  </div>
                  {voice.briefing.items.length > 0 ? (
                    <ol className="mt-3 space-y-2" aria-label="Briefing items">
                      {voice.briefing.items.map(item => (
                        <BriefingItem key={`${item.kind}:${item.id}`} item={item} onOpen={closePanel} />
                      ))}
                    </ol>
                  ) : (
                    <p className="mt-3 rounded-lg border border-dashed border-slate-300 p-4 text-center text-sm text-slate-500">No matching work needs your attention.</p>
                  )}
                </section>
              ) : (
                <div className="rounded-xl border border-dashed border-slate-300 bg-white px-5 py-8 text-center">
                  <Sparkles className="mx-auto h-6 w-6 text-slate-400" aria-hidden="true" />
                  <p className="mt-2 text-sm font-medium text-slate-700">Your briefing is ready when you are.</p>
                  <p className="mt-1 text-xs leading-5 text-slate-500">Catch me up always provides a visual summary, with speech when supported.</p>
                </div>
              )}
            </div>

            <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
              {statusMessage}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
