/**
 * Test helper module providing utilities for test setup and cleanup.
 *
 * This helper is designed to work with Node.js built-in test runner and
 * provides utilities for:
 * - Cleaning up connections (Redis, database)
 * - Setting up test environment
 * - Mocking external dependencies
 *
 * IMPORTANT: The queue module now uses lazy initialization, so importing
 * @gitfix/core will NOT automatically create Redis connections. Connections
 * are only created when actually used (e.g., when adding jobs or creating workers).
 * This eliminates the need for forced process.exit() in most tests.
 */

import { after } from 'node:test';

/**
 * Force close all connections - useful for test cleanup.
 * This function attempts to close database and Redis connections
 * that may have been created during module initialization.
 *
 * NOTE: With lazy initialization, this is only needed if your test
 * actually used queue functionality or database connections.
 */
export async function cleanupConnections(): Promise<void> {
    try {
        // Dynamic import to avoid module initialization side effects
        // when this helper is imported
        const { closeConnection } = await import('@gitfix/core');
        await closeConnection();
    } catch {
        // Ignore errors - connection may not exist
    }

    try {
        const { shutdownQueue, hasQueueResources } = await import('@gitfix/core');
        // Only shutdown if resources were actually created
        if (hasQueueResources()) {
            await shutdownQueue();
        }
    } catch {
        // Ignore errors - queue may not exist
    }

    try {
        const { closeAnalysisRedis, hasAnalysisRedisResources } = await import('@gitfix/core');
        // Only close if resources were actually created
        if (hasAnalysisRedisResources()) {
            await closeAnalysisRedis();
        }
    } catch {
        // Ignore errors - redis may not exist
    }

    try {
        const { closeStateManager } = await import('@gitfix/core');
        await closeStateManager();
    } catch {
        // Ignore errors - state manager may not exist
    }

    // Brief delay to allow async cleanup to complete
    await new Promise(resolve => setTimeout(resolve, 50));
}

/**
 * Setup cleanup to run after all tests.
 * Call this in test files that import from @gitfix/core
 *
 * NOTE: With lazy initialization, tests that don't use queue/database
 * will exit cleanly without needing explicit cleanup.
 */
export function setupTestCleanup(): void {
    after(async () => {
        await cleanupConnections();
    });
}

/**
 * Set default test environment variables
 */
export function setupTestEnv(): void {
    process.env.NODE_ENV = 'test';
    process.env.REDIS_HOST = process.env.REDIS_HOST || '127.0.0.1';
    process.env.REDIS_PORT = process.env.REDIS_PORT || '6379';
}

/**
 * Register a cleanup handler that runs after all tests.
 * This is an alternative to setupTestCleanup() for tests that need
 * custom cleanup logic in addition to connection cleanup.
 */
export function registerCleanup(cleanupFn: () => Promise<void>): void {
    after(async () => {
        try {
            await cleanupFn();
        } catch {
            // Ignore cleanup errors
        }
        await cleanupConnections();
    });
}
