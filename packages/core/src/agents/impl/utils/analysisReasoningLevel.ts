import type { ReasoningLevel } from '@propr/shared';

/**
 * The `reasoningLevel` field of an analysis result: the effective level the
 * runtime was given, or nothing when none was configured.
 */
export function analysisReasoningLevelField(level: ReasoningLevel | '' | undefined): { reasoningLevel?: ReasoningLevel } {
    return level ? { reasoningLevel: level } : {};
}
