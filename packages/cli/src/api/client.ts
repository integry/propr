/**
 * CLI API Client
 *
 * A configured HTTP client for communicating with the ProPR backend REST API.
 * Automatically reads the base URL and authorization headers from ConfigManager
 * and provides standardized error handling.
 */

import { ConfigManager, createConfigManager } from "../config/index.js";
import {
  ApiClientOptions,
  ApiErrorResponse,
  ApiResponse,
  HttpMethod,
  RequestOptions,
} from "./types.js";
import {
  ApiError,
  createApiError,
  NetworkError,
  TimeoutError,
  UnauthorizedError,
} from "./errors.js";

/**
 * Default base URL for the ProPR backend API.
 */
const DEFAULT_BASE_URL = "http://localhost:4000";

/**
 * Default request timeout in milliseconds (30 seconds).
 */
const DEFAULT_TIMEOUT = 30000;

/**
 * API Client for making HTTP requests to the ProPR backend.
 *
 * Features:
 * - Automatic authorization header injection from ConfigManager
 * - Base URL configuration with default fallback
 * - Standardized error handling for common HTTP errors
 * - Request timeout support
 * - JSON request/response handling
 *
 * @example
 * ```typescript
 * const client = await createApiClient();
 *
 * // Make a GET request
 * const response = await client.get<{ repos: string[] }>('/api/repos');
 * console.log(response.data.repos);
 *
 * // Make a POST request
 * const result = await client.post<{ jobId: string }>('/api/jobs', {
 *   body: { repo: 'owner/repo' }
 * });
 * console.log(result.data.jobId);
 * ```
 */
export class ApiClient {
  private configManager: ConfigManager;
  private baseUrl: string;
  private token?: string;
  private defaultTimeout: number;

  /**
   * Creates a new ApiClient instance.
   *
   * @param configManager - The ConfigManager instance for reading configuration.
   * @param options - Optional configuration overrides.
   */
  constructor(configManager: ConfigManager, options: ApiClientOptions = {}) {
    this.configManager = configManager;
    this.baseUrl = options.baseUrl ?? this.configManager.getRemoteUrl() ?? DEFAULT_BASE_URL;
    this.token = options.token ?? this.configManager.getGithubToken();
    this.defaultTimeout = options.defaultTimeout ?? DEFAULT_TIMEOUT;
  }

  /**
   * Gets the current base URL.
   *
   * @returns The base URL being used for API requests.
   */
  getBaseUrl(): string {
    return this.baseUrl;
  }

  /**
   * Gets whether a token is configured.
   *
   * @returns True if a token is available for authentication.
   */
  hasToken(): boolean {
    return this.token !== undefined && this.token.length > 0;
  }

  /**
   * Makes an HTTP request to the API.
   *
   * @param endpoint - The API endpoint path (will be prepended with base URL).
   * @param options - Request options.
   * @returns A promise resolving to the API response.
   * @throws {UnauthorizedError} When the server returns 401.
   * @throws {ForbiddenError} When the server returns 403.
   * @throws {NotFoundError} When the server returns 404.
   * @throws {BadRequestError} When the server returns 400.
   * @throws {InternalServerError} When the server returns 500+.
   * @throws {NetworkError} When a network error occurs.
   * @throws {TimeoutError} When the request times out.
   */
  async request<T>(endpoint: string, options: RequestOptions = {}): Promise<ApiResponse<T>> {
    const {
      method = "GET",
      body,
      headers: customHeaders = {},
      params,
      timeout = this.defaultTimeout,
    } = options;

    // Build the full URL
    const url = this.buildUrl(endpoint, params);

    // Build headers
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Accept": "application/json",
      ...customHeaders,
    };

    // Add authorization header if token is available
    if (this.token) {
      headers["Authorization"] = `Bearer ${this.token}`;
    }

    // Build fetch options
    const fetchOptions: RequestInit = {
      method,
      headers,
    };

    // Add body for non-GET requests
    if (body !== undefined && method !== "GET") {
      fetchOptions.body = JSON.stringify(body);
    }

    // Create abort controller for timeout
    const controller = new AbortController();
    fetchOptions.signal = controller.signal;

    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(url, fetchOptions);
      clearTimeout(timeoutId);

      // Handle error responses
      if (!response.ok) {
        let errorResponse: ApiErrorResponse | undefined;
        try {
          errorResponse = await response.json() as ApiErrorResponse;
        } catch {
          // Response body is not JSON or empty
        }
        throw createApiError(response.status, errorResponse);
      }

      // Parse successful response
      let data: T;
      const contentType = response.headers.get("content-type");
      if (contentType?.includes("application/json")) {
        data = await response.json() as T;
      } else {
        // Handle non-JSON responses
        data = await response.text() as unknown as T;
      }

      return {
        data,
        status: response.status,
        headers: response.headers,
      };
    } catch (error) {
      clearTimeout(timeoutId);

      // Re-throw API errors as-is
      if (error instanceof ApiError) {
        throw error;
      }

      // Handle abort errors (timeout)
      if (error instanceof Error && error.name === "AbortError") {
        throw new TimeoutError("Request timed out.", timeout);
      }

      // Handle network errors
      if (error instanceof TypeError) {
        throw new NetworkError(
          `Network error: ${error.message}`,
          error
        );
      }

      // Handle other errors
      throw new NetworkError(
        `Unexpected error: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Makes a GET request.
   *
   * @param endpoint - The API endpoint path.
   * @param options - Request options (method will be ignored).
   * @returns A promise resolving to the API response.
   */
  async get<T>(endpoint: string, options: Omit<RequestOptions, "method" | "body"> = {}): Promise<ApiResponse<T>> {
    return this.request<T>(endpoint, { ...options, method: "GET" });
  }

  /**
   * Makes a POST request.
   *
   * @param endpoint - The API endpoint path.
   * @param options - Request options (method will be ignored).
   * @returns A promise resolving to the API response.
   */
  async post<T>(endpoint: string, options: Omit<RequestOptions, "method"> = {}): Promise<ApiResponse<T>> {
    return this.request<T>(endpoint, { ...options, method: "POST" });
  }

  /**
   * Makes a PUT request.
   *
   * @param endpoint - The API endpoint path.
   * @param options - Request options (method will be ignored).
   * @returns A promise resolving to the API response.
   */
  async put<T>(endpoint: string, options: Omit<RequestOptions, "method"> = {}): Promise<ApiResponse<T>> {
    return this.request<T>(endpoint, { ...options, method: "PUT" });
  }

  /**
   * Makes a PATCH request.
   *
   * @param endpoint - The API endpoint path.
   * @param options - Request options (method will be ignored).
   * @returns A promise resolving to the API response.
   */
  async patch<T>(endpoint: string, options: Omit<RequestOptions, "method"> = {}): Promise<ApiResponse<T>> {
    return this.request<T>(endpoint, { ...options, method: "PATCH" });
  }

  /**
   * Makes a DELETE request.
   *
   * @param endpoint - The API endpoint path.
   * @param options - Request options (method will be ignored).
   * @returns A promise resolving to the API response.
   */
  async delete<T>(endpoint: string, options: Omit<RequestOptions, "method"> = {}): Promise<ApiResponse<T>> {
    return this.request<T>(endpoint, { ...options, method: "DELETE" });
  }

  /**
   * Builds the full URL for a request.
   *
   * @param endpoint - The API endpoint path.
   * @param params - Optional query parameters.
   * @returns The full URL string.
   */
  private buildUrl(endpoint: string, params?: Record<string, string | number | boolean | undefined>): string {
    // Ensure endpoint starts with /
    const normalizedEndpoint = endpoint.startsWith("/") ? endpoint : `/${endpoint}`;

    // Build URL
    const url = new URL(normalizedEndpoint, this.baseUrl);

    // Add query parameters
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined) {
          url.searchParams.set(key, String(value));
        }
      }
    }

    return url.toString();
  }

  /**
   * Refreshes the client configuration from ConfigManager.
   * Useful when the configuration may have changed after initialization.
   */
  refreshConfig(): void {
    const newBaseUrl = this.configManager.getRemoteUrl();
    const newToken = this.configManager.getGithubToken();

    if (newBaseUrl !== undefined) {
      this.baseUrl = newBaseUrl;
    }
    // Assign unconditionally: after `propr logout` the config value becomes
    // undefined, and a long-lived client must stop sending the stale token.
    this.token = newToken;
  }
}

/**
 * Creates and initializes an ApiClient instance.
 *
 * This convenience function creates a ConfigManager, initializes it,
 * and returns a configured ApiClient.
 *
 * @param options - Optional configuration overrides.
 * @returns A promise resolving to an initialized ApiClient.
 *
 * @example
 * ```typescript
 * const client = await createApiClient();
 * const response = await client.get<{ status: string }>('/api/status');
 * console.log(response.data.status);
 * ```
 */
export async function createApiClient(options: ApiClientOptions = {}): Promise<ApiClient> {
  const configManager = await createConfigManager();
  return new ApiClient(configManager, options);
}

/**
 * Creates an ApiClient using an existing ConfigManager instance.
 *
 * Use this when you already have a ConfigManager initialized and want
 * to avoid creating a duplicate instance.
 *
 * @param configManager - An existing ConfigManager instance.
 * @param options - Optional configuration overrides.
 * @returns An ApiClient instance.
 */
export function createApiClientWithConfig(
  configManager: ConfigManager,
  options: ApiClientOptions = {}
): ApiClient {
  return new ApiClient(configManager, options);
}
