import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ContextLevelSlider } from './ContextLevelSlider';

describe('ContextLevelSlider token estimate', () => {
  it('derives the estimate from the model context window, matching the preview budget', () => {
    const { rerender } = render(<ContextLevelSlider value={100} onChange={vi.fn()} modelMaxTokens={200_000} />);
    expect(screen.getByTestId('context-scope-estimate')).toHaveTextContent('≤196k tokens');

    rerender(<ContextLevelSlider value={100} onChange={vi.fn()} modelMaxTokens={1_360_000} />);
    expect(screen.getByTestId('context-scope-estimate')).toHaveTextContent('≤1.33M tokens');

    rerender(<ContextLevelSlider value={20} onChange={vi.fn()} modelMaxTokens={1_000_000} />);
    expect(screen.getByTestId('context-scope-estimate')).toHaveTextContent('≤196k tokens');
  });

  it('falls back to the default context window before a preview reports one', () => {
    render(<ContextLevelSlider value={50} onChange={vi.fn()} />);
    expect(screen.getByTestId('context-scope-estimate')).toHaveTextContent('≤98k tokens');
  });

  it('hides the token estimate with cost labels', () => {
    render(<ContextLevelSlider value={50} onChange={vi.fn()} modelMaxTokens={200_000} hideCostLabels />);
    expect(screen.getByTestId('context-scope-estimate')).not.toHaveTextContent('tokens');
  });
});
