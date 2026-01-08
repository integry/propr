/**
 * Test helper module providing utilities for test setup and cleanup.
 *
 * This helper is designed to work with Node.js built-in test runner and
 * provides utilities for:
 * - Cleaning up connections (Redis, database)
 * - Setting up test environment
 * - Mocking external dependencies
 */

import { after } from 'node:test';

/**
 * Force close all connections - useful for test cleanup.
 * This function attempts to close database and Redis connections
 * that may have been created during module initialization.
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
        const { shutdownQueue } = await import('@gitfix/core');
        await shutdownQueue();
    } catch {
        // Ignore errors - queue may not exist
    }

    // Give time for connections to close
    await new Promise(resolve => setTimeout(resolve, 100));
}

/**
 * Setup cleanup to run after all tests.
 * Call this in test files that import from @gitfix/core
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
