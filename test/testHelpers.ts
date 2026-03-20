import { mock } from 'node:test';

// ========== Mock Octokit Factory ==========

/**
 * Type definition for mock Octokit instance.
 * Matches the Octokit type used throughout the codebase.
 */
export interface MockOctokit {
    request: ReturnType<typeof mock.fn<(endpoint: string, options?: Record<string, unknown>) => Promise<{ data: Record<string, unknown> }>>>;
}

/**
 * Extended mock Octokit with paginate support for listing operations.
 */
export interface MockOctokitWithPaginate extends MockOctokit {
    paginate: ReturnType<typeof mock.fn<(endpoint: string, options?: Record<string, unknown>) => Promise<unknown[]>>>;
}

/**
 * Configuration options for creating mock Octokit instances.
 */
export interface CreateMockOctokitOptions {
    /**
     * Custom implementation for the request method.
     * If not provided, returns `{ data: {} }` by default.
     */
    requestImpl?: (endpoint: string, options?: Record<string, unknown>) => Promise<{ data: Record<string, unknown> }>;
    /**
     * Whether to include the paginate method for listing operations.
     * Defaults to false.
     */
    withPaginate?: boolean;
    /**
     * Custom implementation for the paginate method (only used if withPaginate is true).
     * If not provided, returns an empty array by default.
     */
    paginateImpl?: (endpoint: string, options?: Record<string, unknown>) => Promise<unknown[]>;
}

/**
 * Creates a typed mock Octokit instance for testing GitHub API interactions.
 *
 * @param options - Configuration options for the mock
 * @returns A typed mock Octokit instance
 *
 * @example
 * // Basic usage - returns { data: {} } for all requests
 * const mockOctokit = createMockOctokit();
 *
 * @example
 * // With custom request implementation
 * const mockOctokit = createMockOctokit({
 *     requestImpl: async (endpoint, options) => {
 *         if (endpoint.includes('issues')) {
 *             return { data: { number: 123 } };
 *         }
 *         return { data: {} };
 *     }
 * });
 *
 * @example
 * // With paginate support for listing operations
 * const mockOctokit = createMockOctokit({
 *     withPaginate: true,
 *     paginateImpl: async () => [{ id: 1 }, { id: 2 }]
 * });
 *
 * @example
 * // Verifying calls made to the mock
 * const mockOctokit = createMockOctokit();
 * await mockOctokit.request('POST /repos/{owner}/{repo}/issues', { owner: 'test', repo: 'repo' });
 * assert.strictEqual(mockOctokit.request.mock.calls.length, 1);
 */
export function createMockOctokit(options?: CreateMockOctokitOptions & { withPaginate: true }): MockOctokitWithPaginate;
export function createMockOctokit(options?: CreateMockOctokitOptions & { withPaginate?: false }): MockOctokit;
export function createMockOctokit(options?: CreateMockOctokitOptions): MockOctokit | MockOctokitWithPaginate {
    const defaultRequestImpl = async (): Promise<{ data: Record<string, unknown> }> => ({ data: {} });
    const defaultPaginateImpl = async (): Promise<unknown[]> => [];

    const requestImpl = options?.requestImpl ?? defaultRequestImpl;
    const mockRequest = mock.fn(requestImpl);

    if (options?.withPaginate) {
        const paginateImpl = options.paginateImpl ?? defaultPaginateImpl;
        const mockPaginate = mock.fn(paginateImpl);
        return {
            request: mockRequest,
            paginate: mockPaginate
        } as MockOctokitWithPaginate;
    }

    return {
        request: mockRequest
    } as MockOctokit;
}

/**
 * Resets all mock calls on a mock Octokit instance.
 * Useful in beforeEach hooks to clear call history between tests.
 *
 * @param mockOctokit - The mock Octokit instance to reset
 *
 * @example
 * beforeEach(() => {
 *     resetMockOctokit(mockOctokit);
 * });
 */
export function resetMockOctokit(mockOctokit: MockOctokit | MockOctokitWithPaginate): void {
    mockOctokit.request.mock.resetCalls();
    if ('paginate' in mockOctokit) {
        mockOctokit.paginate.mock.resetCalls();
    }
}

// ========== LLM Metrics Mock ==========

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
