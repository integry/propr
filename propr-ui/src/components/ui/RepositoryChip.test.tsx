import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RepositoryChip } from './RepositoryChip';

describe('RepositoryChip', () => {
  it('renders a monospace chip that hugs the repository name without a repeated GitHub mark', () => {
    render(<RepositoryChip repository="integry/propr" />);

    const chip = screen.getByTestId('repository-chip');
    expect(chip).toHaveClass('inline-flex', 'font-mono', 'text-[12px]', 'bg-slate-100', 'border', 'border-slate-200', 'text-slate-800', 'rounded-sm', 'px-1.5', 'py-0.5');
    // A fixed or full width would stretch the background past the text.
    expect(chip).not.toHaveClass('block', 'w-full');
    expect(chip).toHaveAttribute('title', 'integry/propr');
    expect(chip).toHaveTextContent('integry/propr');
    // A wall of identical GitHub logos is noise in a dense list: the slug stands alone.
    expect(screen.queryByTestId('repository-icon-fallback')).not.toBeInTheDocument();
  });

  it('shows the repository-provided icon when one is configured', () => {
    render(<RepositoryChip repository="integry/propr" iconPath="public/logo.svg" revision="main" />);

    expect(screen.getByTestId('repository-icon-image')).toHaveAttribute(
      'src',
      'https://raw.githubusercontent.com/integry/propr/main/public/logo.svg',
    );
  });

  it('reports the baseline of its slug, not its border box, so a mixed text row stays on one line', () => {
    render(<RepositoryChip repository="integry/propr" iconPath="public/logo.svg" revision="main" />);

    // Only the slug takes part in baseline alignment; the mark centres itself and stays out of it.
    expect(screen.getByTestId('repository-chip')).toHaveClass('items-baseline');
    expect(screen.getByTestId('repository-icon-image')).toHaveClass('self-center');
  });
});
