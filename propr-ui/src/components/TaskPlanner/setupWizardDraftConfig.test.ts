import { describe, expect, it } from 'vitest';
import { getDraftContextConfig, parseDraftContextConfig } from './setupWizardDraftConfig';
import { makeDraft } from './setupWizardHooks.testUtils';

describe('draft context config parsing', () => {
  it('hydrates legacy JSON-backed draft settings', () => {
    const draft = makeDraft({
      context_config: JSON.stringify({ baseBranch: 'release', contextLevel: 75 }),
    });

    expect(getDraftContextConfig(draft)).toEqual({ baseBranch: 'release', contextLevel: 75 });
  });

  it('rejects arrays and malformed legacy JSON', () => {
    expect(parseDraftContextConfig([])).toBeUndefined();
    expect(parseDraftContextConfig('[{"baseBranch":"release"}]')).toBeUndefined();
    expect(parseDraftContextConfig('{broken')).toBeUndefined();
  });

  it.each([
    [{ baseBranch: 42 }],
    [{ granularity: 'large' }],
    [{ manualFiles: 'src/index.ts' }],
    [{ excludedFiles: [42] }],
    [{ contextRepositories: [{ repository: 42, branch: 'main' }] }],
    [{ contextRepositories: [{ repository: 'integry/shared', branch: 42 }] }],
  ])('rejects malformed typed draft branches %#', (value) => {
    expect(parseDraftContextConfig(value)).toBeUndefined();
    expect(parseDraftContextConfig(JSON.stringify(value))).toBeUndefined();
  });

  it('keeps validated legacy fields and discards unrelated properties', () => {
    expect(parseDraftContextConfig(JSON.stringify({
      baseBranch: 'release',
      manualFiles: ['src/index.ts'],
      contextRepositories: [{ repository: 'integry/shared', branch: 'main' }],
      unrelated: { trusted: false },
    }))).toEqual({
      baseBranch: 'release',
      manualFiles: ['src/index.ts'],
      contextRepositories: [{ repository: 'integry/shared', branch: 'main' }],
    });
  });
});
