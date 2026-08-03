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
});
