export const SPARKLINE_WIDTH = 120;
export const SPARKLINE_HEIGHT = 28;

/** Scores on a fixed 1–10 axis, so one PR's trend reads the same as another's. */
export const sparklinePoints = (scores: number[]): string =>
  scores.map((score, index) => {
    const x = scores.length === 1 ? SPARKLINE_WIDTH / 2 : (index / (scores.length - 1)) * SPARKLINE_WIDTH;
    const y = SPARKLINE_HEIGHT - ((score - 1) / 9) * SPARKLINE_HEIGHT;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
