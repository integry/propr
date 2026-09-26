import { isDesktopRuntime } from '../config/runtimeMode';

/**
 * One-shot adapters for the browser's built-in speech APIs.
 *
 * Speech recognition is supplied by the browser or operating system and may
 * use a vendor-operated service. This module does not describe recognition as
 * local, retain audio, or send audio through ProPR.
 */

export const DEFAULT_SPEECH_RECOGNITION_TIMEOUT_MS = 10_000;

export type BrowserSpeechErrorCategory =
  | 'unsupported'
  | 'service-unavailable'
  | 'permission-denied'
  | 'no-speech'
  | 'microphone-unavailable'
  | 'network'
  | 'language-unavailable'
  | 'cancelled'
  | 'timeout'
  | 'invalid-input'
  | 'unknown';

const ERROR_MESSAGES: Record<BrowserSpeechErrorCategory, string> = {
  unsupported: 'Speech is not supported by this browser.',
  'service-unavailable': 'The speech recognition service is unavailable in this runtime. Microphone permission does not enable a speech service. Use Catch me up for text, or use voice commands in a supported browser.',
  'permission-denied': 'Microphone access was not allowed.',
  'no-speech': 'No speech was detected. Please try again.',
  'microphone-unavailable': 'No available microphone was found.',
  network: 'The browser speech service could not be reached.',
  'language-unavailable': 'The selected speech language is not available.',
  cancelled: 'Speech was cancelled.',
  timeout: 'Listening timed out. Please try again.',
  'invalid-input': 'The speech request is invalid.',
  unknown: 'The browser could not complete the speech request.',
};

const ERROR_CATEGORIES_BY_TOKEN: Readonly<Record<string, BrowserSpeechErrorCategory>> = {
  notallowederror: 'permission-denied',
  securityerror: 'permission-denied',
  'not-allowed': 'permission-denied',
  'service-not-allowed': 'service-unavailable',
  'no-speech': 'no-speech',
  'audio-capture': 'microphone-unavailable',
  'audio-busy': 'microphone-unavailable',
  'audio-hardware': 'microphone-unavailable',
  network: 'network',
  'language-not-supported': 'language-unavailable',
  'language-unavailable': 'language-unavailable',
  'voice-unavailable': 'language-unavailable',
  aborterror: 'cancelled',
  aborted: 'cancelled',
  canceled: 'cancelled',
  cancelled: 'cancelled',
  interrupted: 'cancelled',
  notsupportederror: 'unsupported',
  'synthesis-unavailable': 'unsupported',
  invalidargumenterror: 'invalid-input',
  'invalid-argument': 'invalid-input',
  'text-too-long': 'invalid-input',
};

export class BrowserSpeechError extends Error {
  readonly category: BrowserSpeechErrorCategory;
  readonly cause?: unknown;

  constructor(category: BrowserSpeechErrorCategory, cause?: unknown) {
    super(ERROR_MESSAGES[category]);
    this.name = 'BrowserSpeechError';
    this.category = category;
    this.cause = cause;
  }
}

export interface BrowserSpeechCapabilities {
  speechSynthesis: boolean;
  speechRecognition: boolean;
}

export interface SpeakOnceOptions {
  signal?: AbortSignal;
  lang?: string;
  rate?: number;
  pitch?: number;
  volume?: number;
}

export interface CancellableSpeech {
  /** Settles on completion, cancellation, or synthesis failure. */
  promise: Promise<void>;
  cancel: () => void;
}

export interface ListenOnceOptions {
  signal?: AbortSignal;
  /** A BCP 47 language tag. The browser default is used when omitted. */
  lang?: string;
  timeoutMs?: number;
}

// SpeechRecognition remains experimental and is absent from some versions of
// lib.dom.d.ts. Keep its structural surface private so it cannot leak into the
// rest of the UI's browser types.
interface RecognitionAlternative {
  transcript: string;
}

interface RecognitionResult {
  readonly isFinal: boolean;
  readonly length: number;
  readonly [index: number]: RecognitionAlternative;
}

interface RecognitionResultList {
  readonly length: number;
  readonly [index: number]: RecognitionResult;
}

interface RecognitionResultEvent {
  readonly resultIndex: number;
  readonly results: RecognitionResultList;
}

interface RecognitionErrorEvent {
  readonly error: string;
}

interface Recognition {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  maxAlternatives: number;
  onresult: ((event: RecognitionResultEvent) => void) | null;
  onerror: ((event: RecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

interface RecognitionConstructor {
  new (): Recognition;
}

type BrowserSpeechWindow = Window & typeof globalThis & {
  SpeechRecognition?: RecognitionConstructor;
  webkitSpeechRecognition?: RecognitionConstructor;
};

function speechWindow(): BrowserSpeechWindow | null {
  return typeof window === 'undefined' ? null : window as BrowserSpeechWindow;
}

function recognitionConstructor(): RecognitionConstructor | null {
  const browser = speechWindow();
  return browser?.SpeechRecognition ?? browser?.webkitSpeechRecognition ?? null;
}

/** Safe to call during render, including in SSR and unsupported browsers. */
export function getBrowserSpeechCapabilities(): BrowserSpeechCapabilities {
  const browser = speechWindow();
  return {
    speechSynthesis: Boolean(browser?.speechSynthesis && browser.SpeechSynthesisUtterance),
    // Standard Electron lacks the proprietary recognition service despite exposing the API.
    speechRecognition: !isDesktopRuntime() && recognitionConstructor() !== null,
  };
}

function errorToken(error: unknown): string {
  if (typeof error === 'string') return error;
  if (typeof error !== 'object' || error === null) return '';
  const value = error as { error?: unknown; name?: unknown };
  if (typeof value.error === 'string') return value.error;
  return typeof value.name === 'string' ? value.name : '';
}

/** Convert browser- and vendor-specific failures into stable UI categories. */
export function normalizeBrowserSpeechError(error: unknown): BrowserSpeechError {
  if (error instanceof BrowserSpeechError) return error;

  const token = errorToken(error).toLowerCase();
  const category = ERROR_CATEGORIES_BY_TOKEN[token] ?? 'unknown';
  return new BrowserSpeechError(category, error);
}

function rejectedSpeech(category: BrowserSpeechErrorCategory): CancellableSpeech {
  return {
    promise: Promise.reject(new BrowserSpeechError(category)),
    cancel: () => undefined,
  };
}

/**
 * Speak one utterance. Calling cancel (or aborting options.signal) cancels the
 * browser synthesizer and rejects the returned promise instead of leaving it
 * pending.
 */
export function speakOnce(text: string, options: SpeakOnceOptions = {}): CancellableSpeech {
  const browser = speechWindow();
  if (!browser?.speechSynthesis || !browser.SpeechSynthesisUtterance) {
    return rejectedSpeech('unsupported');
  }
  if (text.trim().length === 0) return rejectedSpeech('invalid-input');

  const synthesis = browser.speechSynthesis;
  let utterance: SpeechSynthesisUtterance;
  try {
    utterance = new browser.SpeechSynthesisUtterance(text);
    if (options.lang !== undefined) utterance.lang = options.lang;
    if (options.rate !== undefined) utterance.rate = options.rate;
    if (options.pitch !== undefined) utterance.pitch = options.pitch;
    if (options.volume !== undefined) utterance.volume = options.volume;
  } catch (error) {
    return {
      promise: Promise.reject(normalizeBrowserSpeechError(error)),
      cancel: () => undefined,
    };
  }

  let settled = false;
  let resolvePromise: () => void = () => undefined;
  let rejectPromise: (error: BrowserSpeechError) => void = () => undefined;

  const cleanup = () => {
    utterance.onend = null;
    utterance.onerror = null;
    options.signal?.removeEventListener('abort', cancel);
  };
  const finish = (error?: BrowserSpeechError) => {
    if (settled) return;
    settled = true;
    cleanup();
    if (error) rejectPromise(error);
    else resolvePromise();
  };
  const cancel = () => {
    if (settled) return;
    try {
      synthesis.cancel();
    } finally {
      finish(new BrowserSpeechError('cancelled'));
    }
  };

  const promise = new Promise<void>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });

  utterance.onend = () => finish();
  utterance.onerror = event => finish(normalizeBrowserSpeechError(event));

  if (options.signal?.aborted) {
    finish(new BrowserSpeechError('cancelled'));
  } else {
    options.signal?.addEventListener('abort', cancel, { once: true });
    try {
      synthesis.speak(utterance);
    } catch (error) {
      finish(normalizeBrowserSpeechError(error));
    }
  }

  return { promise, cancel };
}

function validTimeout(timeoutMs: number): boolean {
  return Number.isFinite(timeoutMs) && timeoutMs > 0;
}

/**
 * Start a single recognition attempt. Call this synchronously from a user
 * gesture (for example, a button click); browsers may reject any other start.
 * Recognition may be processed by the browser, OS, or a vendor service.
 */
export function listenOnce(options: ListenOnceOptions = {}): Promise<string> {
  if (isDesktopRuntime()) return Promise.reject(new BrowserSpeechError('service-unavailable'));
  const RecognitionClass = recognitionConstructor();
  if (!RecognitionClass) return Promise.reject(new BrowserSpeechError('unsupported'));

  const timeoutMs = options.timeoutMs ?? DEFAULT_SPEECH_RECOGNITION_TIMEOUT_MS;
  if (!validTimeout(timeoutMs)) return Promise.reject(new BrowserSpeechError('invalid-input'));
  if (options.signal?.aborted) return Promise.reject(new BrowserSpeechError('cancelled'));

  let recognition: Recognition;
  try {
    recognition = new RecognitionClass();
  } catch (error) {
    return Promise.reject(normalizeBrowserSpeechError(error));
  }
  recognition.continuous = false;
  recognition.interimResults = false;
  recognition.maxAlternatives = 1;
  if (options.lang !== undefined) recognition.lang = options.lang;

  return new Promise<string>((resolve, reject) => {
    let settled = false;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      options.signal?.removeEventListener('abort', abort);
      recognition.onresult = null;
      recognition.onerror = null;
      recognition.onend = null;
    };
    const finish = (
      result: { transcript: string } | { error: BrowserSpeechError },
      terminate?: 'abort' | 'stop',
    ) => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        if (terminate === 'abort') recognition.abort();
        if (terminate === 'stop') recognition.stop();
      } catch {
        // The object may already have stopped; the promise still must settle.
      }
      if ('error' in result) reject(result.error);
      else resolve(result.transcript);
    };
    const abort = () => finish({ error: new BrowserSpeechError('cancelled') }, 'abort');

    recognition.onresult = event => {
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        if (!result?.isFinal) continue;
        const transcript = result[0]?.transcript.trim() ?? '';
        if (transcript.length === 0) {
          finish({ error: new BrowserSpeechError('no-speech') }, 'abort');
        } else {
          finish({ transcript }, 'stop');
        }
        return;
      }
    };
    recognition.onerror = event => {
      finish({ error: normalizeBrowserSpeechError(event) }, 'abort');
    };
    recognition.onend = () => {
      finish({ error: new BrowserSpeechError('no-speech') });
    };

    options.signal?.addEventListener('abort', abort, { once: true });
    timeoutId = setTimeout(() => {
      finish({ error: new BrowserSpeechError('timeout') }, 'abort');
    }, timeoutMs);

    // start() remains in this synchronous call path so the caller can invoke
    // listenOnce directly from the user gesture required by browser policy.
    try {
      recognition.start();
    } catch (error) {
      finish({ error: normalizeBrowserSpeechError(error) }, 'abort');
    }
  });
}
