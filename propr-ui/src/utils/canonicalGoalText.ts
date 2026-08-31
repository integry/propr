export interface CanonicalGoalText {
  value: string;
  codePointLength: number;
}

export const GOAL_TEXT_MAX_CODE_POINTS = 4000;

export const canonicalGoalText = (rawValue: string): CanonicalGoalText => {
  const value = rawValue.trim();
  return { value, codePointLength: Array.from(value).length };
};
