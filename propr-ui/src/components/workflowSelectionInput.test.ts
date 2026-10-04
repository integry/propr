import { describe, expect, it } from 'vitest';
import { formatWorkflowInput, parseWorkflowInput, toggleWorkflowSelection, workflowMatchesEntry } from './workflowSelectionInput';

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

it('normalizes all workflow identities and removes every matching spelling on deselection', () => {
  const workflow = {
    id: 42, name: ' CI ', path: '.github/workflows/validation.yml ', file: 'validation.yml ',
    triggers: ['pull_request'], pullRequest: true,
  };
  const aliases = [' 42 ', ' .GITHUB/WORKFLOWS/VALIDATION.YML ', ' VALIDATION.YML ', ' cI '];
  for (const entry of aliases) expect(workflowMatchesEntry(workflow, entry)).toBe(true);
  expect(workflowMatchesEntry(workflow, 'validation')).toBe(false);
  expect(toggleWorkflowSelection([...aliases, 'other.yml'], workflow, false)).toEqual(['other.yml']);
});
