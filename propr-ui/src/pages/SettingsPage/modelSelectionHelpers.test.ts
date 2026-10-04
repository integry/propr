import { describe, expect, it } from 'vitest';
import { buildAllModelOptions, buildSelectableModels, buildPlanGenerationOptions, buildPrReviewOptions } from './modelSelectionHelpers';

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
