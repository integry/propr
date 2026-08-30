import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import ModelContextSelector from './ModelContextSelector';

describe('ModelContextSelector', () => {
  it('uses the instance catalog and includes synthetic virtual models', () => {
    render(
      <ModelContextSelector
        selectedModel=""
        onModelChange={vi.fn()}
        contextLevel={50}
        onContextLevelChange={vi.fn()}
        agents={[
          {
            id: 'direct-1',
            kind: 'direct',
            alias: 'codex-work',
            enabled: true,
            supportedModels: ['gpt-5.2']
          },
          {
            id: 'pool-1',
            kind: 'synthetic',
            alias: 'balanced',
            enabled: true,
            supportedModels: ['virtual-code']
          }
        ]}
      />
    );

    const modelSelect = screen.getByRole('combobox');
    expect(within(modelSelect).getByRole('group', { name: 'balanced (Synthetic pool)' })).toBeInTheDocument();
    expect(within(modelSelect).getByRole('option', { name: 'virtual-code' })).toHaveValue('balanced:virtual-code');
  });
});
