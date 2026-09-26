import { render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { RefinementChat } from './RefinementChat';

vi.mock('./setupWizardHooks', () => ({ useAgentsLoader: () => [] }));
vi.mock('../../hooks/useIsMobile', () => ({ useIsMobile: () => false }));

describe('RefinementChat focus requests', () => {
  test('focuses the refinement composer when requested by notification navigation', () => {
    render(
      <RefinementChat
        onSendMessage={vi.fn()}
        focusComposerRequest={1}
        disableAutoScroll
      />,
    );

    expect(screen.getByRole('textbox', { name: 'Refinement instructions' })).toHaveFocus();
  });
});
