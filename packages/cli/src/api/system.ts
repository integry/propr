/**
 * System Status API
 *
 * Functions for interacting with the ProPR backend system status and queue endpoints.
 * These functions provide a typed interface to check system health and queue statistics.
 */

import { ApiClient, createApiClient } from "./index.js";

/**
 * System status response from the backend.
 */
export interface SystemStatus {
  /**
   * API health status.
   */
  api: string;

  /**
   * Redis connection status ('connected' | 'disconnected').
   */
  redis: string;

  /**
   * Daemon status ('running' | 'stopped').
   */
  daemon: string;

  /**
   * Worker status ('running' | 'stopped').
   */
  worker: string;

  /**
   * Number of active workers.
   */
  workerCount?: number;

  /**
   * GitHub authentication status ('connected' | 'disconnected').
   */
  githubAuth: string;

  /**
   * Claude authentication status ('connected' | 'disconnected').
   */
  claudeAuth: string;

  /**
   * Timestamp of the status check.
   */
  timestamp: string;
}

/**
 * Queue statistics response from the backend.
 */
export interface QueueStats {
  /**
   * Number of jobs waiting in the queue.
   */
  waiting: number;

  /**
   * Number of jobs currently being processed.
   */
  active: number;

  /**
   * Number of successfully completed jobs.
   */
  completed: number;

  /**
   * Number of failed jobs.
   */
  failed: number;

  /**
   * Number of delayed jobs.
   */
  delayed: number;

  /**
   * Total number of jobs (sum of all states).
   */
  total: number;
}

/**
 * Fetches the current system status from the backend.
 *
 * This function retrieves health information about various backend components
 * including the API, Redis, daemon, workers, and authentication status.
 *
 * @param client - Optional ApiClient instance. If not provided, one will be created.
 * @returns A promise resolving to the system status.
 *
 * @example
 * ```typescript
 * // Get system status
 * const status = await getSystemStatus();
 * console.log(`API: ${status.api}`);
 * console.log(`Redis: ${status.redis}`);
 * console.log(`Workers: ${status.workerCount}`);
 * ```
 */
export async function getSystemStatus(
  client?: ApiClient
): Promise<SystemStatus> {
  const apiClient = client ?? (await createApiClient());
  const response = await apiClient.get<SystemStatus>("/api/status");
  return response.data;
}

/**
 * Fetches queue statistics from the backend.
 *
 * This function retrieves information about the current state of the task queue
 * including counts of waiting, active, completed, failed, and delayed jobs.
 *
 * @param client - Optional ApiClient instance. If not provided, one will be created.
 * @returns A promise resolving to the queue statistics.
 *
 * @example
 * ```typescript
 * // Get queue stats
 * const stats = await getQueueStats();
 * console.log(`Active: ${stats.active}`);
 * console.log(`Completed: ${stats.completed}`);
 * console.log(`Failed: ${stats.failed}`);
 * ```
 */
export async function getQueueStats(client?: ApiClient): Promise<QueueStats> {
  const apiClient = client ?? (await createApiClient());
  const response = await apiClient.get<QueueStats>("/api/queue/stats");
  return response.data;
}
