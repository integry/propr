import { describe, expect, it } from 'vitest';
import { formatWorkflowInput, parseWorkflowInput } from './workflowSelectionInput';

describe('workflow selection serialization', () => {
  it('round-trips commas, quotes, and embedded newlines without splitting identities', () => {
    const selection = ['Build, Test', 'Lint "strict"', 'Build\nLinux', 'ci.yml'];
    expect(parseWorkflowInput(formatWorkflowInput(selection))).toEqual(selection);
  });

  it('normalizes ordinary input and rejects malformed quoted values', () => {
    expect(parseWorkflowInput(' ci.yml, CI.YML\n lint.yml ')).toEqual(['ci.yml', 'lint.yml']);
    expect(parseWorkflowInput('"Build, Test')).toBeNull();
    expect(parseWorkflowInput('"Build, Test"suffix')).toBeNull();
  });
});
