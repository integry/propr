import { Redis } from 'ioredis';
import type { PaginatedOctokitInstance } from '@gitfix/core';
export interface DetectedIssue {
    id: number;
    number: number;
    title: string;
    url: string;
    repoOwner: string;
    repoName: string;
    labels: string[];
    createdAt: string;
    updatedAt: string;
}
export declare function processDetectedIssue(issue: DetectedIssue, correlationId: string, redisClient: Redis): Promise<void>;
export declare function fetchIssuesForRepo(octokit: PaginatedOctokitInstance, repoFullName: string, correlationId: string): Promise<DetectedIssue[]>;
