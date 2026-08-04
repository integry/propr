import type { Request } from 'express';

/** Express request for routes whose named parameters each match one path segment. */
export type FlatRequest = Request<Record<string, string>>;
