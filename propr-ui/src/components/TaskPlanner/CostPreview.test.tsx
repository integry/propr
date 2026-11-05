import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CostPreview } from './CostPreview';

describe('CostPreview token usage', () => {
  it('shows current and maximum tokens in the same compact unit', () => {
    render(
      <CostPreview
        preview={{
          isLoading: false,
          error: null,
          lastSynced: new Date(),
          data: {
            success: true,
            stats: { totalTokens: 942_496, costEstimate: 0.034, contextLength: 3_000_000, fileCount: 989, maxTokens: 1_333_000 },
            smartSelection: [],
            warnings: [],
          },
        }}
      />
    );

    expect(screen.getByText('942k').parentElement).toHaveTextContent('942k / 1.33M tokens (70.7%)');
    expect(screen.queryByText(/1333k max/)).not.toBeInTheDocument();
  });
});
