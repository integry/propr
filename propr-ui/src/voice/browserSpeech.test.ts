import * as runtimeMode from '../config/runtimeMode';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BrowserSpeechError,
  getBrowserSpeechCapabilities,
  listenOnce,
  normalizeBrowserSpeechError,
  speakOnce,
} from './browserSpeech';

interface MockRecognitionResultEvent {
  resultIndex: number;
  results: {
    length: number;
    [index: number]: {
      isFinal: boolean;
      length: number;
      [index: number]: { transcript: string };
    };
  };
}

class MockSpeechRecognition {
  static instances: MockSpeechRecognition[] = [];

  continuous = true;
  interimResults = true;
  lang = '';
  maxAlternatives = 0;
  onresult: ((event: MockRecognitionResultEvent) => void) | null = null;
  onerror: ((event: { error: string }) => void) | null = null;
  onend: (() => void) | null = null;
  start = vi.fn();
  stop = vi.fn();
  abort = vi.fn();

  constructor() {
    MockSpeechRecognition.instances.push(this);
  }
}

class MockSpeechSynthesisUtterance {
  lang = '';
  rate = 1;
  pitch = 1;
  volume = 1;
  onend: (() => void) | null = null;
  onerror: ((event: { error: string }) => void) | null = null;

  constructor(readonly text: string) {}
}

const synthesis = {
  speak: vi.fn<(utterance: MockSpeechSynthesisUtterance) => void>(),
  cancel: vi.fn(),
};

function setWindowProperty(name: string, value: unknown) {
  Object.defineProperty(window, name, {
    configurable: true,
    writable: true,
    value,
  });
}

function finalResult(transcript: string): MockRecognitionResultEvent {
  return {
    resultIndex: 0,
    results: {
      0: {
        0: { transcript },
        isFinal: true,
        length: 1,
      },
      length: 1,
    },
  };
}

describe('browser speech adapters', () => {
  it('does not claim Electron recognition support from API presence or start its service', async () => {
    const runtime = vi.spyOn(runtimeMode, 'isDesktopRuntime').mockReturnValue(true);
    try {
      expect(getBrowserSpeechCapabilities().speechRecognition).toBe(false);
      await expect(listenOnce()).rejects.toMatchObject({ category: 'service-unavailable' });
      expect(MockSpeechRecognition.instances).toHaveLength(0);
    } finally { runtime.mockRestore(); }
  });

  it('distinguishes speech service rejection from microphone denial', () => {
    expect(normalizeBrowserSpeechError({ error: 'service-not-allowed' }).category).toBe('service-unavailable');
    expect(normalizeBrowserSpeechError({ error: 'not-allowed' }).category).toBe('permission-denied');
  });
  const originalRecognition = Object.getOwnPropertyDescriptor(window, 'SpeechRecognition');
  const originalWebkitRecognition = Object.getOwnPropertyDescriptor(window, 'webkitSpeechRecognition');
  const originalSynthesis = Object.getOwnPropertyDescriptor(window, 'speechSynthesis');
  const originalUtterance = Object.getOwnPropertyDescriptor(window, 'SpeechSynthesisUtterance');

  beforeEach(() => {
    MockSpeechRecognition.instances = [];
    vi.clearAllMocks();
    setWindowProperty('SpeechRecognition', MockSpeechRecognition);
    setWindowProperty('webkitSpeechRecognition', undefined);
    setWindowProperty('speechSynthesis', synthesis);
    setWindowProperty('SpeechSynthesisUtterance', MockSpeechSynthesisUtterance);
  });

  afterEach(() => {
    vi.useRealTimers();
    for (const [name, descriptor] of [
      ['SpeechRecognition', originalRecognition],
      ['webkitSpeechRecognition', originalWebkitRecognition],
      ['speechSynthesis', originalSynthesis],
      ['SpeechSynthesisUtterance', originalUtterance],
    ] as const) {
      if (descriptor) Object.defineProperty(window, name, descriptor);
      else Reflect.deleteProperty(window, name);
    }
  });

  it('configures and resolves one final recognition result exactly once', async () => {
    const recognitionPromise = listenOnce({ lang: 'en-US', timeoutMs: 500 });
    const recognition = MockSpeechRecognition.instances[0];

    expect(recognition).toMatchObject({
      continuous: false,
      interimResults: false,
      lang: 'en-US',
      maxAlternatives: 1,
    });
    expect(recognition.start).toHaveBeenCalledOnce();

    recognition.onresult?.(finalResult('  stop task two  '));

    await expect(recognitionPromise).resolves.toBe('stop task two');
    expect(recognition.stop).toHaveBeenCalledOnce();
    expect(recognition.abort).not.toHaveBeenCalled();
  });

  it('aborts the recognition implementation when the one-shot timeout expires', async () => {
    vi.useFakeTimers();
    const recognitionPromise = listenOnce({ timeoutMs: 25 });
    const rejection = expect(recognitionPromise).rejects.toMatchObject({ category: 'timeout' });

    await vi.advanceTimersByTimeAsync(25);

    await rejection;
    expect(MockSpeechRecognition.instances[0].abort).toHaveBeenCalledOnce();
  });

  it('forwards AbortSignal cancellation to the recognition implementation', async () => {
    const controller = new AbortController();
    const recognitionPromise = listenOnce({ signal: controller.signal });
    const recognition = MockSpeechRecognition.instances[0];

    controller.abort();

    await expect(recognitionPromise).rejects.toMatchObject({ category: 'cancelled' });
    expect(recognition.abort).toHaveBeenCalledOnce();
  });

  it('reports synthesis support without recognition and never constructs recognition', async () => {
    setWindowProperty('SpeechRecognition', undefined);
    setWindowProperty('webkitSpeechRecognition', undefined);

    expect(getBrowserSpeechCapabilities()).toEqual({
      speechSynthesis: true,
      speechRecognition: false,
    });
    await expect(listenOnce()).rejects.toEqual(expect.objectContaining({
      category: 'unsupported',
    }));
    expect(MockSpeechRecognition.instances).toHaveLength(0);
  });

  it('speaks one configured utterance and settles only when the browser ends it', async () => {
    const speech = speakOnce('Status ready', {
      lang: 'en-GB',
      rate: 1.2,
      pitch: 0.9,
      volume: 0.8,
    });
    const utterance = synthesis.speak.mock.calls[0][0];

    expect(utterance).toMatchObject({
      text: 'Status ready',
      lang: 'en-GB',
      rate: 1.2,
      pitch: 0.9,
      volume: 0.8,
    });
    utterance.onend?.();

    await expect(speech.promise).resolves.toBeUndefined();
    expect(synthesis.cancel).not.toHaveBeenCalled();
  });

  it('cancels synthesis through its narrow browser callback', async () => {
    const speech = speakOnce('Status ready');

    speech.cancel();

    await expect(speech.promise).rejects.toBeInstanceOf(BrowserSpeechError);
    await expect(speech.promise).rejects.toMatchObject({ category: 'cancelled' });
    expect(synthesis.cancel).toHaveBeenCalledOnce();
  });
});
