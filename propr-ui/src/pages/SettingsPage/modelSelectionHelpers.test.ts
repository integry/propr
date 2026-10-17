import { describe, expect, it } from 'vitest';
import { buildAllModelOptions, buildContextAnalysisOptions, buildSelectableModels, buildPlanGenerationOptions, buildPrReviewOptions, buildSummarizationOptions } from './modelSelectionHelpers';

describe('Claude model recommendations', () => {
  it('recommends Sonnet 5.5 instead of legacy Sonnet releases', () => {
    const agents = [{
      alias: 'claude',
      enabled: true,
      supportedModels: ['claude-sonnet-5', 'claude-sonnet-5-5', 'claude-sonnet-4-6'],
    }];

    for (const options of [buildPlanGenerationOptions(agents), buildPrReviewOptions(agents)]) {
      expect(options.find(option => option.value === 'claude:claude-sonnet-5-5')?.isRecommended).toBe(true);
      expect(options.find(option => option.value === 'claude:claude-sonnet-5')?.isRecommended).toBe(false);
      expect(options.find(option => option.value === 'claude:claude-sonnet-4-6')?.isRecommended).toBe(false);
      expect(options[0]?.value).toBe('claude:claude-sonnet-5-5');
    }
  });

  it('recommends Haiku 5.5 instead of Haiku 4.5 for lightweight work', () => {
    const agents = [{
      alias: 'claude',
      enabled: true,
      supportedModels: ['claude-haiku-4-5-20251001', 'claude-haiku-5-5'],
    }];

    for (const options of [buildSummarizationOptions(agents), buildContextAnalysisOptions(agents)]) {
      expect(options.find(option => option.value === 'claude:claude-haiku-5-5')?.isRecommended).toBe(true);
      expect(options.find(option => option.value === 'claude:claude-haiku-4-5-20251001')?.isRecommended).toBe(false);
      expect(options[0]?.value).toBe('claude:claude-haiku-5-5');
    }
  });
});

describe('Antigravity model recommendations', () => {
  it('recommends Gemini 4 Argon for planning and review, and Flash for lightweight work', () => {
    const agents = [{
      alias: 'antigravity',
      enabled: true,
      supportedModels: ['antigravity-gemini-3.8-flash', 'antigravity-gemini-4-argon', 'antigravity-gpt-oss-120b'],
    }];

    for (const options of [buildPlanGenerationOptions(agents), buildPrReviewOptions(agents)]) {
      expect(options[0]).toMatchObject({ value: 'antigravity:antigravity-gemini-4-argon', label: 'antigravity - Antigravity Gemini 4 Argon', isRecommended: true });
      expect(options.find(option => option.value === 'antigravity:antigravity-gemini-3.8-flash')?.isRecommended).toBe(false);
    }
    expect(buildSummarizationOptions(agents)[0]?.value).toBe('antigravity:antigravity-gemini-3.8-flash');
  });
});


describe('Vibe GLM selection', () => {
  it('offers GLM in agent configuration, task, planning and review options', () => {
    const models = buildSelectableModels('vibe', []);
    const agents = [{ alias: 'mistral-work', enabled: true, supportedModels: models.map(model => model.id) }];
    for (const build of [buildAllModelOptions, buildPlanGenerationOptions, buildPrReviewOptions]) {
      const options = build(agents);
      for (const minor of ['3', '2']) {
        expect(options.find(option => option.value === `mistral-work:zai-glm-5-${minor}`)).toMatchObject({
          label: `mistral-work - GLM 5.${minor}`, enabled: true,
        });
      }
    }
    expect(models.some(model => model.id.startsWith('devstral'))).toBe(false);
  });
});
