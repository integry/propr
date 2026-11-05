import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SetupWizardRightPane } from './SetupWizardRightPane';

const renderPane = (overrides: Partial<React.ComponentProps<typeof SetupWizardRightPane>> = {}) => render(
  <SetupWizardRightPane
    contextLevel={2}
    onContextLevelChange={vi.fn()}
    smartSelection={undefined}
    isPreviewLoading={false}
    contextRepositories={[]}
    availableRepos={[]}
    onAddContextRepo={vi.fn()}
    onRemoveContextRepo={vi.fn()}
    preview={{ isLoading: false, data: null, error: null, lastSynced: null }}
    isNewMode
    hideContextRepositories
    {...overrides}
  />
);

describe('SetupWizardRightPane', () => {
  it('collapses the file area to a status line while generation progress runs', () => {
    renderPane({
      isPreviewLoading: true,
      showPreviewProgress: true,
      preview: { isLoading: true, data: null, error: null, lastSynced: null },
    });

    expect(screen.getByTestId('context-discovery-status')).toHaveTextContent('Context discovery in progress...');
    expect(screen.queryByText('Files will be selected after context analysis')).not.toBeInTheDocument();
  });

  it('keeps the placeholder when no generation progress is shown', () => {
    renderPane();

    expect(screen.queryByTestId('context-discovery-status')).not.toBeInTheDocument();
    expect(screen.getByText('Files will be selected after context analysis')).toBeInTheDocument();
  });
});
