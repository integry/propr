import type { RequestHandler } from 'express';

/**
 * Attach the API discovery cache prohibition at the first `/api` boundary so
 * limiters, route handlers, and error handlers all inherit the same headers.
 */
export const prohibitApiResponseCaching: RequestHandler = (_request, response, next) => {
  response.set('Cache-Control', 'no-store, max-age=0');
  response.set('Pragma', 'no-cache');
  next();
};
