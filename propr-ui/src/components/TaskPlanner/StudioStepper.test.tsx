import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { StudioPhaseSwitcher } from './StudioStepper';
import { StudioStageContext } from './studioStageContext';

describe('StudioPhaseSwitcher', () => {
  it('renders nothing outside a studio page', () => {
    const { container } = render(<StudioPhaseSwitcher />);
    expect(container).toBeEmptyDOMElement();
  });

  it('marks the current phase and shows its count', () => {
    render(
      <StudioStageContext.Provider value="review">
        <StudioPhaseSwitcher counts={{ review: 17 }} />
      </StudioStageContext.Provider>
    );

    const phases = screen.getByRole('navigation', { name: 'Plan phase' });
    expect(phases).toHaveTextContent('Define');
    expect(screen.getByLabelText('Done')).toBeInTheDocument();
    const current = phases.querySelector('[aria-current="step"]');
    expect(current).toHaveTextContent('2Review(17)');
    expect(phases).toHaveTextContent('3Execute');
  });

  it('collapses to a step badge below md so it fits beside the scope pill on a phone', () => {
    render(
      <StudioStageContext.Provider value="execute">
        <StudioPhaseSwitcher />
      </StudioStageContext.Provider>
    );

    const badge = screen.getByTestId('phase-step-badge');
    expect(badge).toHaveTextContent('Step 3/3');
    expect(badge).toHaveAttribute('aria-label', 'Step 3 of 3: Execute');
    expect(badge).toHaveClass('md:hidden');
    expect(screen.getByRole('list')).toHaveClass('hidden', 'md:flex');
  });
});
