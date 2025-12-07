import { mock } from 'node:test';

interface LLMMetricsSummary {
    summary: {
        totalRequests: number;
        totalSuccessful: number;
        totalFailed: number;
        successRate: number;
        totalCostUsd: number;
        avgCostPerRequest: number;
        totalTurns: number;
        avgTurnsPerRequest: number;
        avgExecutionTimeSec: number;
    };
    modelBreakdown: Record<string, unknown>;
    dailyMetrics: unknown[];
    recentHighCostAlerts: unknown[];
    lastUpdated: string;
}

export const mockRecordLLMMetrics = mock.fn(async () => {
});

export const llmMetricsMock = {
    recordLLMMetrics: mockRecordLLMMetrics,
    getLLMMetricsSummary: mock.fn(async (): Promise<LLMMetricsSummary> => ({
        summary: {
            totalRequests: 0,
            totalSuccessful: 0,
            totalFailed: 0,
            successRate: 0,
            totalCostUsd: 0,
            avgCostPerRequest: 0,
            totalTurns: 0,
            avgTurnsPerRequest: 0,
            avgExecutionTimeSec: 0
        },
        modelBreakdown: {},
        dailyMetrics: [],
        recentHighCostAlerts: [],
        lastUpdated: new Date().toISOString()
    })),
    getLLMMetricsByCorrelationId: mock.fn(async () => null)
};
