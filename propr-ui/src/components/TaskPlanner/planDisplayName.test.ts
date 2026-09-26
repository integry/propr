import { describe, expect, it } from 'vitest';
import { getDraftDisplayName, isStalePromptDerivedName } from './planDisplayName';

describe('isStalePromptDerivedName', () => {
  it('detects a name derived from an earlier, shorter version of the prompt', () => {
    expect(isStalePromptDerivedName('Add', 'Add dark mode toggle to settings.')).toBe(true);
  });

  it('ignores a trailing ellipsis when comparing the name against the prompt', () => {
    const prompt = `Add dark mode ${'toggle '.repeat(20)}to settings`;
    expect(isStalePromptDerivedName('Add dark...', prompt)).toBe(true);
  });

  it('does not flag a name that is not a prefix of the prompt', () => {
    expect(isStalePromptDerivedName('Dark Mode Settings Toggle', 'Add dark mode toggle to settings.')).toBe(false);
  });

  it('does not flag a name that already matches the prompt derived title', () => {
    expect(isStalePromptDerivedName('Add dark mode toggle to settings.', 'Add dark mode toggle to settings.')).toBe(false);
  });

  it('returns false when the name or prompt is missing', () => {
    expect(isStalePromptDerivedName('', 'Add dark mode toggle to settings.')).toBe(false);
    expect(isStalePromptDerivedName('Add', '')).toBe(false);
    expect(isStalePromptDerivedName(null, undefined)).toBe(false);
  });
});

describe('getDraftDisplayName', () => {
  it('refreshes a one-word name captured mid-typing from the current prompt', () => {
    expect(getDraftDisplayName({ name: 'Add', initial_prompt: 'Add dark mode toggle to settings.' }))
      .toBe('Add dark mode toggle to settings.');
  });

  it('keeps an LLM-generated name that is not derived from the prompt', () => {
    expect(getDraftDisplayName({ name: 'Dark Mode Settings Toggle', initial_prompt: 'Add dark mode toggle to settings.' }))
      .toBe('Dark Mode Settings Toggle');
  });

  it('keeps a user-provided rename even when the prompt is longer', () => {
    expect(getDraftDisplayName({ name: 'Settings polish', initial_prompt: 'Add dark mode toggle to settings. Also tidy the layout.' }))
      .toBe('Settings polish');
  });

  it('only shows the first two sentences of the prompt, matching what the server stores', () => {
    expect(getDraftDisplayName({ name: 'Add', initial_prompt: 'Add dark mode. Ship it. Then celebrate.' }))
      .toBe('Add dark mode. Ship it.');
  });

  it('falls back to the prompt derived title when there is no name', () => {
    expect(getDraftDisplayName({ initial_prompt: 'Add dark mode toggle to settings.' }))
      .toBe('Add dark mode toggle to settings.');
  });

  it('falls back to the provided fallback when there is no name and no prompt', () => {
    expect(getDraftDisplayName({}, 'Untitled Plan')).toBe('Untitled Plan');
    expect(getDraftDisplayName(null, 'Planner Studio')).toBe('Planner Studio');
  });

  it('defaults to Untitled Plan when no fallback is given', () => {
    expect(getDraftDisplayName({ name: '   ', initial_prompt: '  ' })).toBe('Untitled Plan');
  });
});
