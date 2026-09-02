export const parseEventRecord: (smokeOutput: string, expectedEvent: string) => Record<string, unknown> | undefined;
export const parseEventLayout: (smokeOutput: string, expectedEvent: string) => unknown;
export const assertPackagedLayout: (layout: unknown, platform?: NodeJS.Platform) => void;
