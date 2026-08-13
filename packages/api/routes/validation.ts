/**
 * Shared input validation utilities for API routes.
 * Provides consistent validation patterns across all route handlers.
 */

/**
 * Validation result type for all validators.
 */
export interface ValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * Validated pagination parameters.
 */
export interface PaginationParams {
  page: number;
  limit: number;
  offset: number;
}

// Common regex patterns
export const TASK_ID_REGEX = /^[a-zA-Z0-9\-_.]+$/;
export const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const REPOSITORY_REGEX = /^[a-zA-Z0-9\-_]+\/[a-zA-Z0-9\-_.]+$/;
export const SESSION_ID_REGEX = /^[a-zA-Z0-9\-_]+$/;
export const SAFE_FILENAME_REGEX = /^[a-zA-Z0-9._\-\s]+$/;

// Allowed MIME types for file uploads
export const ALLOWED_MIME_TYPES = [
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/json',
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
] as const;

// Allowed file extensions for uploads
export const ALLOWED_EXTENSIONS = [
  '.txt', '.md', '.csv', '.json', '.pdf',
  '.png', '.jpg', '.jpeg', '.gif', '.webp',
] as const;

/**
 * Validates a task ID parameter.
 * Task IDs can be in various formats: UUIDs, issue-based IDs, or simple alphanumeric.
 */
export function validateTaskId(taskId: unknown): ValidationResult {
  if (!taskId || typeof taskId !== 'string') {
    return { valid: false, error: 'Task ID is required' };
  }

  const trimmed = taskId.trim();
  if (trimmed.length === 0) {
    return { valid: false, error: 'Task ID cannot be empty' };
  }

  if (trimmed.length > 256) {
    return { valid: false, error: 'Task ID is too long (max 256 characters)' };
  }

  if (!TASK_ID_REGEX.test(trimmed)) {
    return { valid: false, error: 'Task ID contains invalid characters' };
  }

  if (/^\.+$/.test(trimmed)) {
    return { valid: false, error: 'Task ID cannot be a dot path segment' };
  }

  return { valid: true };
}

/**
 * Validates a UUID parameter.
 */
export function validateUUID(uuid: unknown, fieldName = 'ID'): ValidationResult {
  if (!uuid || typeof uuid !== 'string') {
    return { valid: false, error: `${fieldName} is required` };
  }

  if (!UUID_REGEX.test(uuid)) {
    return { valid: false, error: `${fieldName} must be a valid UUID` };
  }

  return { valid: true };
}

/**
 * Validates a session ID parameter.
 */
export function validateSessionId(sessionId: unknown): ValidationResult {
  if (!sessionId || typeof sessionId !== 'string') {
    return { valid: false, error: 'Session ID is required' };
  }

  const trimmed = sessionId.trim();
  if (trimmed.length === 0) {
    return { valid: false, error: 'Session ID cannot be empty' };
  }

  if (trimmed.length > 256) {
    return { valid: false, error: 'Session ID is too long (max 256 characters)' };
  }

  if (!SESSION_ID_REGEX.test(trimmed)) {
    return { valid: false, error: 'Session ID contains invalid characters' };
  }

  return { valid: true };
}

/**
 * Validates the tail parameter for docker logs.
 * Must be a positive integer between 1 and 10000.
 */
export function validateTailParam(tail: unknown): ValidationResult & { value?: number } {
  if (tail === undefined || tail === null || tail === '') {
    // Default value will be used
    return { valid: true, value: 100 };
  }

  if (typeof tail !== 'string' && typeof tail !== 'number') {
    return { valid: false, error: 'Tail parameter must be a number' };
  }

  const parsed = typeof tail === 'number' ? tail : parseInt(tail as string, 10);

  if (isNaN(parsed)) {
    return { valid: false, error: 'Tail parameter must be a valid number' };
  }

  if (!Number.isInteger(parsed)) {
    return { valid: false, error: 'Tail parameter must be an integer' };
  }

  if (parsed < 1) {
    return { valid: false, error: 'Tail parameter must be at least 1' };
  }

  if (parsed > 10000) {
    return { valid: false, error: 'Tail parameter cannot exceed 10000' };
  }

  return { valid: true, value: parsed };
}

/**
 * Validates pagination parameters (page, limit, offset).
 */
export function validatePagination(
  page: unknown,
  limit: unknown,
  options: { maxLimit?: number; defaultLimit?: number } = {}
): ValidationResult & { params?: PaginationParams } {
  const { maxLimit = 100, defaultLimit = 50 } = options;

  // Parse page
  let parsedPage = 1;
  if (page !== undefined && page !== null && page !== '') {
    const pageNum = typeof page === 'number' ? page : parseInt(page as string, 10);
    if (isNaN(pageNum) || !Number.isInteger(pageNum)) {
      return { valid: false, error: 'Page must be a valid integer' };
    }
    if (pageNum < 1) {
      return { valid: false, error: 'Page must be at least 1' };
    }
    if (pageNum > 1000000) {
      return { valid: false, error: 'Page number is too large' };
    }
    parsedPage = pageNum;
  }

  // Parse limit
  let parsedLimit = defaultLimit;
  if (limit !== undefined && limit !== null && limit !== '') {
    const limitNum = typeof limit === 'number' ? limit : parseInt(limit as string, 10);
    if (isNaN(limitNum) || !Number.isInteger(limitNum)) {
      return { valid: false, error: 'Limit must be a valid integer' };
    }
    if (limitNum < 1) {
      return { valid: false, error: 'Limit must be at least 1' };
    }
    if (limitNum > maxLimit) {
      return { valid: false, error: `Limit cannot exceed ${maxLimit}` };
    }
    parsedLimit = limitNum;
  }

  return {
    valid: true,
    params: {
      page: parsedPage,
      limit: parsedLimit,
      offset: (parsedPage - 1) * parsedLimit,
    },
  };
}

/**
 * Validates a repository name format (owner/repo).
 */
export function validateRepository(repository: unknown): ValidationResult {
  if (!repository || typeof repository !== 'string') {
    return { valid: false, error: 'Repository is required' };
  }

  const trimmed = repository.trim();
  if (trimmed.length === 0) {
    return { valid: false, error: 'Repository cannot be empty' };
  }

  if (!REPOSITORY_REGEX.test(trimmed)) {
    return { valid: false, error: 'Repository must be in format owner/repo' };
  }

  return { valid: true };
}

/**
 * Validates an optional repository filter (can be 'all' or a valid repo name).
 */
export function validateRepositoryFilter(repository: unknown): ValidationResult {
  if (!repository || repository === 'all') {
    return { valid: true };
  }

  if (typeof repository !== 'string') {
    return { valid: false, error: 'Repository must be a string' };
  }

  return validateRepository(repository);
}

/**
 * Validates a log type parameter for execution routes.
 */
export function validateLogType(type: unknown): ValidationResult {
  const validTypes = ['stdout', 'stderr', 'conversation', 'full'];

  if (!type || typeof type !== 'string') {
    return { valid: false, error: 'Log type is required' };
  }

  if (!validTypes.includes(type)) {
    return { valid: false, error: `Log type must be one of: ${validTypes.join(', ')}` };
  }

  return { valid: true };
}

/**
 * Validates file upload metadata.
 */
export function validateFileUpload(file: {
  originalname?: string;
  mimetype?: string;
  size?: number;
} | undefined): ValidationResult {
  if (!file) {
    return { valid: false, error: 'No file uploaded' };
  }

  // Validate filename
  if (file.originalname) {
    // Check for path traversal attempts
    if (file.originalname.includes('..') || file.originalname.includes('/') || file.originalname.includes('\\')) {
      return { valid: false, error: 'Invalid filename' };
    }

    // Check filename length
    if (file.originalname.length > 255) {
      return { valid: false, error: 'Filename is too long (max 255 characters)' };
    }

    // Get file extension
    const ext = getFileExtension(file.originalname);
    if (ext && !ALLOWED_EXTENSIONS.includes(ext as typeof ALLOWED_EXTENSIONS[number])) {
      return { valid: false, error: `File type not allowed. Allowed types: ${ALLOWED_EXTENSIONS.join(', ')}` };
    }
  }

  // Validate MIME type
  if (file.mimetype && !ALLOWED_MIME_TYPES.includes(file.mimetype as typeof ALLOWED_MIME_TYPES[number])) {
    return { valid: false, error: `File type not allowed. Allowed types: ${ALLOWED_MIME_TYPES.join(', ')}` };
  }

  return { valid: true };
}

/**
 * Gets the file extension from a filename (lowercase, with dot).
 */
function getFileExtension(filename: string): string | null {
  const lastDot = filename.lastIndexOf('.');
  if (lastDot === -1 || lastDot === filename.length - 1) {
    return null;
  }
  return filename.slice(lastDot).toLowerCase();
}

/**
 * Validates a string enum value.
 */
export function validateEnum<T extends string>(
  value: unknown,
  allowedValues: readonly T[],
  fieldName = 'Value'
): ValidationResult & { value?: T } {
  if (value === undefined || value === null || value === '') {
    return { valid: true }; // Optional field
  }

  if (typeof value !== 'string') {
    return { valid: false, error: `${fieldName} must be a string` };
  }

  if (!allowedValues.includes(value as T)) {
    return { valid: false, error: `${fieldName} must be one of: ${allowedValues.join(', ')}` };
  }

  return { valid: true, value: value as T };
}

/**
 * Validates a string has a minimum and maximum length.
 */
export function validateStringLength(
  value: unknown,
  fieldName: string,
  options: { minLength?: number; maxLength?: number; required?: boolean } = {}
): ValidationResult {
  const { minLength = 0, maxLength = 10000, required = false } = options;

  if (value === undefined || value === null || value === '') {
    if (required) {
      return { valid: false, error: `${fieldName} is required` };
    }
    return { valid: true };
  }

  if (typeof value !== 'string') {
    return { valid: false, error: `${fieldName} must be a string` };
  }

  if (value.length < minLength) {
    return { valid: false, error: `${fieldName} must be at least ${minLength} characters` };
  }

  if (value.length > maxLength) {
    return { valid: false, error: `${fieldName} cannot exceed ${maxLength} characters` };
  }

  return { valid: true };
}

/**
 * Validates a positive integer.
 */
export function validatePositiveInteger(
  value: unknown,
  fieldName: string,
  options: { required?: boolean; max?: number } = {}
): ValidationResult & { value?: number } {
  const { required = false, max } = options;

  if (value === undefined || value === null || value === '') {
    if (required) {
      return { valid: false, error: `${fieldName} is required` };
    }
    return { valid: true };
  }

  const parsed = typeof value === 'number' ? value : parseInt(value as string, 10);

  if (isNaN(parsed) || !Number.isInteger(parsed)) {
    return { valid: false, error: `${fieldName} must be a valid integer` };
  }

  if (parsed < 0) {
    return { valid: false, error: `${fieldName} must be a positive integer` };
  }

  if (max !== undefined && parsed > max) {
    return { valid: false, error: `${fieldName} cannot exceed ${max}` };
  }

  return { valid: true, value: parsed };
}

/**
 * Validates a boolean parameter (string 'true'/'false' or actual boolean).
 */
export function validateBoolean(value: unknown): ValidationResult & { value?: boolean } {
  if (value === undefined || value === null || value === '') {
    return { valid: true, value: false };
  }

  if (typeof value === 'boolean') {
    return { valid: true, value };
  }

  if (typeof value === 'string') {
    if (value === 'true' || value === '1') {
      return { valid: true, value: true };
    }
    if (value === 'false' || value === '0') {
      return { valid: true, value: false };
    }
  }

  return { valid: false, error: 'Value must be a boolean (true/false)' };
}
