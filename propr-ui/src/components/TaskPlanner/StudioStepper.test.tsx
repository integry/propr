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
});
