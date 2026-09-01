export type GoalNativeSessionIdTiming = 'eager' | 'first_turn';
export type GoalSteeringBoundary = 'active_turn' | 'next_turn';
export type GoalPauseBoundary = 'active_turn' | 'after_turn';
export type GoalModelChangeBoundary = 'next_safe_boundary' | 'next_turn';

export type GoalProviderCapabilities = {
    nativeSessionId: 'eager';
    steering: GoalSteeringBoundary;
    pause: GoalPauseBoundary;
    modelChange: GoalModelChangeBoundary;
} | {
    nativeSessionId: 'first_turn';
    firstTurnIdCrashPolicy: 'retry_deterministically' | 'fail';
    steering: GoalSteeringBoundary;
    pause: GoalPauseBoundary;
    modelChange: GoalModelChangeBoundary;
};

/** Contract fixture for providers with a native active-turn control channel. */
export const EAGER_ACTIVE_TURN_PROVIDER_CAPABILITIES = {
    nativeSessionId: 'eager',
    steering: 'active_turn',
    pause: 'active_turn',
    modelChange: 'next_safe_boundary',
} as const satisfies GoalProviderCapabilities;

/** Contract fixture for discrete CLIs whose native identity arrives on turn one. */
export const FIRST_TURN_BOUNDARY_PROVIDER_CAPABILITIES = {
    nativeSessionId: 'first_turn',
    firstTurnIdCrashPolicy: 'fail',
    steering: 'next_turn',
    pause: 'after_turn',
    modelChange: 'next_turn',
} as const satisfies GoalProviderCapabilities;
