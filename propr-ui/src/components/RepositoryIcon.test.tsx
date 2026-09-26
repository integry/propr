import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { RepositoryIcon } from './RepositoryIcon';
import { buildRepositoryIconUrl } from '../utils/repositoryIconUrl';

describe('RepositoryIcon', () => {
  it('validates identity and safely encodes revisions and every path segment', () => {
    expect(buildRepositoryIconUrl(
      'integry/propr.repo',
      'docs/static images/brand mark.svg',
      'feature/icon refresh',
    )).toBe(
      'https://raw.githubusercontent.com/integry/propr.repo/feature%2Ficon%20refresh/docs/static%20images/brand%20mark.svg',
    );
    expect(buildRepositoryIconUrl('integry/propr/extra', 'logo.svg')).toBeNull();
    expect(buildRepositoryIconUrl('integry/propr?raw=1', 'logo.svg')).toBeNull();
    expect(buildRepositoryIconUrl('integry/propr', '../logo.svg')).toBeNull();
    expect(buildRepositoryIconUrl('integry/propr', '/logo.svg')).toBeNull();
  });

  it('renders nothing instead of the GitHub mark when a dense surface opts out of the fallback', () => {
    const { rerender } = render(<RepositoryIcon repository="integry/propr" fallback="none" />);
    expect(screen.queryByTestId('repository-icon-fallback')).not.toBeInTheDocument();

    // A repository that does have an icon still renders it.
    rerender(<RepositoryIcon repository="integry/propr" iconPath="public/logo.svg" revision="main" fallback="none" />);
    expect(screen.getByTestId('repository-icon-image')).toBeInTheDocument();

    // A broken image collapses back to no mark at all rather than to the GitHub logo.
    fireEvent.error(screen.getByTestId('repository-icon-image'));
    expect(screen.queryByTestId('repository-icon-fallback')).not.toBeInTheDocument();
    expect(screen.queryByTestId('repository-icon-image')).not.toBeInTheDocument();
  });

  it('falls back after an image error and retries when the repository image changes', () => {
    const { rerender } = render(
      <RepositoryIcon repository="integry/one" iconPath="public/favicon.svg" revision="abc123" />,
    );
    fireEvent.error(screen.getByTestId('repository-icon-image'));
    expect(screen.getByTestId('repository-icon-fallback')).toBeInTheDocument();

    rerender(
      <RepositoryIcon repository="integry/two" iconPath="assets/logo.png" revision="def456" />,
    );
    expect(screen.getByTestId('repository-icon-image')).toHaveAttribute(
      'src',
      'https://raw.githubusercontent.com/integry/two/def456/assets/logo.png',
    );
  });
});
