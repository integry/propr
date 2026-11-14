import { describe, expect, it } from 'vitest';
import { getCleanDocumentTitle } from './utils.tsx';
import { cleanHeaderTaskTitle } from '../headerUtils';

describe('title parsers and the PR status slot', () => {
  for (const slot of ['', '🔨 ', '⚠️⑥ ', '⚠ ', '✅⑧ ']) {
    it(`getCleanDocumentTitle reads the [N by Model] prefix with slot "${slot}"`, () => {
      expect(getCleanDocumentTitle(`${slot}[3475 by Claude Opus 5.5] Let an automation run`)).toBe('3475: Let an automation run');
      expect(getCleanDocumentTitle(`Followup: ${slot}[870 by Claude Opus] Update checkout`)).toBe('870: Update checkout');
      expect(getCleanDocumentTitle(`Followup: ${slot}Update checkout`, 12)).toBe('12: Update checkout');
    });

    it(`cleanHeaderTaskTitle drops the prefix, slot and model tag with slot "${slot}"`, () => {
      expect(cleanHeaderTaskTitle(`${slot}[3510 by Claude Opus 5.5] Apply library extensions`)).toBe('Apply library extensions');
      expect(cleanHeaderTaskTitle(`Followup: ${slot}[3510 by Claude Opus 5.5] Apply library extensions`)).toBe('Apply library extensions');
    });
  }

  for (const slot of ['○ 0/21 ', '◔ 3/21 ', '◑ 11/21 ', '◕ 17/21 ', '🔨 3/21 ', '✅ 21/21 ']) {
    it(`strips the epic slot "${slot}"`, () => {
      expect(getCleanDocumentTitle(`${slot}[Epic] Plugin system`)).toBe('[Epic] Plugin system');
      expect(cleanHeaderTaskTitle(`Followup: ${slot}[3510 by Claude Opus 5.5] Apply library extensions`)).toBe('Apply library extensions');
    });
  }

  it('strips only a strict leading slot', () => {
    expect(getCleanDocumentTitle('✅ done is not a model tag')).toBe('done is not a model tag');
    expect(getCleanDocumentTitle('🔨Hammer time')).toBe('🔨Hammer time');
    expect(getCleanDocumentTitle('◔ Not a count')).toBe('◔ Not a count');
    expect(cleanHeaderTaskTitle(undefined)).toBe('');
  });
});
