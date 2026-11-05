import type { Locator } from '@playwright/test';

// Browsers land fractional layout positions on whole scroll offsets (WebKit rests at 24.5px), so allow at most 1 CSS px of rounding.
export const SCROLL_ROUNDING_TOLERANCE = 1;

// Unrounded gap between a step card and its scroll container's padding edge (below any top border), beside the card's own CSS scroll margin.
export const scrollGap = (card: Locator) => card.evaluate(element => {
  const pane = element.closest('[data-task-list]')!;
  const gap = element.getBoundingClientRect().top - pane.getBoundingClientRect().top - pane.clientTop;
  return { gap, margin: parseFloat(getComputedStyle(element).scrollMarginTop) };
});

export const scrollMarginMiss = async (card: Locator) => {
  const { gap, margin } = await scrollGap(card);
  return Math.abs(gap - margin);
};
