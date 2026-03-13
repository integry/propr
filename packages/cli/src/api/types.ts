/**
 * API Client Types
 *
 * Type definitions for the CLI API client.
 */

/**
 * HTTP methods supported by the API client.
 */
export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/**
 * Options for making API requests.
 */
export interface RequestOptions {
  /**
   * HTTP method to use. Defaults to GET.
   */
  method?: HttpMethod;

  /**
   * Request body. Will be JSON stringified.
   */
  body?: unknown;

  /**
   * Additional headers to include in the request.
   */
  headers?: Record<string, string>;

  /**
   * Query parameters to append to the URL.
   */
  params?: Record<string, string | number | boolean | undefined>;

  /**
   * Request timeout in milliseconds. Defaults to 30000 (30 seconds).
   */
  timeout?: number;
}

/**
 * API client configuration options.
 */
export interface ApiClientOptions {
  /**
   * Base URL for the API. If not provided, reads from ConfigManager.
   */
  baseUrl?: string;

  /**
   * GitHub token for authentication. If not provided, reads from ConfigManager.
   */
  token?: string;

  /**
   * Default timeout for requests in milliseconds.
   */
  defaultTimeout?: number;
}

/**
 * Error codes returned by the API client.
 */
export type ApiErrorCode =
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "BAD_REQUEST"
  | "INTERNAL_ERROR"
  | "NETWORK_ERROR"
  | "TIMEOUT"
  | "UNKNOWN";

/**
 * Structured error response from the API.
 */
export interface ApiErrorResponse {
  error: string;
  code?: string;
  details?: unknown;
}

/**
 * API response wrapper.
 */
export interface ApiResponse<T> {
  data: T;
  status: number;
  headers: Headers;
}
