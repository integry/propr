import { describe, expect, it } from 'vitest';
import { formatModelName, humanizeModelId } from './modelDisplay';

describe('formatModelName', () => {
  it('uses the catalogue name for a known model, with or without a provider prefix', () => {
    expect(formatModelName('claude-opus-5-5')).toBe('Claude Opus 5.5');
    expect(formatModelName('openai/gpt-5.5')).toBe('GPT-5.5');
  });

  it('formats an id the catalogue does not know the same way', () => {
    expect(formatModelName('gpt-5.6')).toBe('GPT-5.6');
    expect(humanizeModelId('gpt-5.6-mini')).toBe('GPT-5.6 Mini');
    expect(humanizeModelId('claude-sonnet-9-1-20990101')).toBe('Claude Sonnet 9.1');
    expect(humanizeModelId('kimi-k3')).toBe('Kimi K3');
  });
});
