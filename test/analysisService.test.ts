import { test, describe, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';

// Define the Task interface to match the one in analysisService.ts
interface Task {
    task_id: string;
    repository: string;
    issue_number: number;
    commit_hash?: string;
}

// Define the TaskHistoryMetadata interface to match the one in analysisService.ts
interface TaskHistoryMetadata {
    historyMetadata?: {
        commitResult?: {
            commitHash?: string;
        };
    };
    commitResult?: {
        commitHash?: string;
    };
    commitHash?: string;
    prResult?: {
        commitHash?: string;
        commitResult?: {
            commitHash?: string;
        };
    };
    githubComment?: {
        body?: string;
    };
}

// Replicate the extractCommitHashFromMetadata function for testing
// This mirrors the implementation in packages/core/src/services/analysisService.ts:113-124
function extractCommitHashFromMetadata(metadata: TaskHistoryMetadata): string | null {
    if (metadata.historyMetadata?.commitResult?.commitHash) return metadata.historyMetadata.commitResult.commitHash;
    if (metadata.commitResult?.commitHash) return metadata.commitResult.commitHash;
    if (metadata.commitHash) return metadata.commitHash;
    if (metadata.prResult?.commitResult?.commitHash) return metadata.prResult.commitResult.commitHash;
    if (metadata.prResult?.commitHash) return metadata.prResult.commitHash;
    if (metadata.githubComment?.body) {
        const match = metadata.githubComment.body.match(/\bcommit ([a-f0-9]{7,40})\b/i);
        if (match) return match[1];
    }
    return null;
}

describe('extractCommitHashFromMetadata', () => {
    describe('extracts hash from nested metadata paths', () => {
        test('extracts from metadata.historyMetadata.commitResult.commitHash (path 1)', () => {
            const metadata: TaskHistoryMetadata = {
                historyMetadata: {
                    commitResult: {
                        commitHash: 'abc1234567890def'
                    }
                }
            };

            const result = extractCommitHashFromMetadata(metadata);

            assert.strictEqual(result, 'abc1234567890def');
        });

        test('extracts from metadata.commitResult.commitHash (path 2)', () => {
            const metadata: TaskHistoryMetadata = {
                commitResult: {
                    commitHash: 'def4567890123abc'
                }
            };

            const result = extractCommitHashFromMetadata(metadata);

            assert.strictEqual(result, 'def4567890123abc');
        });

        test('extracts from metadata.commitHash (path 3)', () => {
            const metadata: TaskHistoryMetadata = {
                commitHash: '1234567890abcdef'
            };

            const result = extractCommitHashFromMetadata(metadata);

            assert.strictEqual(result, '1234567890abcdef');
        });

        test('extracts from metadata.prResult.commitResult.commitHash (path 4)', () => {
            const metadata: TaskHistoryMetadata = {
                prResult: {
                    commitResult: {
                        commitHash: 'fedcba0987654321'
                    }
                }
            };

            const result = extractCommitHashFromMetadata(metadata);

            assert.strictEqual(result, 'fedcba0987654321');
        });

        test('extracts from metadata.prResult.commitHash (path 5)', () => {
            const metadata: TaskHistoryMetadata = {
                prResult: {
                    commitHash: 'abcdef1234567890'
                }
            };

            const result = extractCommitHashFromMetadata(metadata);

            assert.strictEqual(result, 'abcdef1234567890');
        });

        test('extracts from metadata.githubComment.body via regex (path 6)', () => {
            const metadata: TaskHistoryMetadata = {
                githubComment: {
                    body: 'Fixed the issue in commit abc123def'
                }
            };

            const result = extractCommitHashFromMetadata(metadata);

            assert.strictEqual(result, 'abc123def');
        });
    });

    describe('priority order of extraction paths', () => {
        test('historyMetadata.commitResult.commitHash takes priority over all others', () => {
            const metadata: TaskHistoryMetadata = {
                historyMetadata: {
                    commitResult: {
                        commitHash: 'priority1'
                    }
                },
                commitResult: {
                    commitHash: 'priority2'
                },
                commitHash: 'priority3',
                prResult: {
                    commitHash: 'priority4',
                    commitResult: {
                        commitHash: 'priority5'
                    }
                },
                githubComment: {
                    body: 'commit priority6'
                }
            };

            const result = extractCommitHashFromMetadata(metadata);

            assert.strictEqual(result, 'priority1');
        });

        test('commitResult.commitHash takes priority when historyMetadata is absent', () => {
            const metadata: TaskHistoryMetadata = {
                commitResult: {
                    commitHash: 'priority2'
                },
                commitHash: 'priority3',
                prResult: {
                    commitHash: 'priority4'
                }
            };

            const result = extractCommitHashFromMetadata(metadata);

            assert.strictEqual(result, 'priority2');
        });

        test('commitHash takes priority when higher paths are absent', () => {
            const metadata: TaskHistoryMetadata = {
                commitHash: 'priority3',
                prResult: {
                    commitHash: 'priority4'
                }
            };

            const result = extractCommitHashFromMetadata(metadata);

            assert.strictEqual(result, 'priority3');
        });

        test('prResult.commitResult.commitHash takes priority over prResult.commitHash', () => {
            const metadata: TaskHistoryMetadata = {
                prResult: {
                    commitHash: 'priority5',
                    commitResult: {
                        commitHash: 'priority4'
                    }
                }
            };

            const result = extractCommitHashFromMetadata(metadata);

            assert.strictEqual(result, 'priority4');
        });
    });

    describe('returns null when no hash found', () => {
        test('returns null for empty metadata object', () => {
            const metadata: TaskHistoryMetadata = {};

            const result = extractCommitHashFromMetadata(metadata);

            assert.strictEqual(result, null);
        });

        test('returns null when all paths are undefined', () => {
            const metadata: TaskHistoryMetadata = {
                historyMetadata: undefined,
                commitResult: undefined,
                commitHash: undefined,
                prResult: undefined,
                githubComment: undefined
            };

            const result = extractCommitHashFromMetadata(metadata);

            assert.strictEqual(result, null);
        });

        test('returns null when nested objects exist but commitHash is missing', () => {
            const metadata: TaskHistoryMetadata = {
                historyMetadata: {
                    commitResult: {}
                },
                commitResult: {},
                prResult: {
                    commitResult: {}
                }
            };

            const result = extractCommitHashFromMetadata(metadata);

            assert.strictEqual(result, null);
        });

        test('returns null when githubComment body does not contain commit hash pattern', () => {
            const metadata: TaskHistoryMetadata = {
                githubComment: {
                    body: 'This is a comment without any commit reference'
                }
            };

            const result = extractCommitHashFromMetadata(metadata);

            assert.strictEqual(result, null);
        });

        test('returns null when githubComment body is empty', () => {
            const metadata: TaskHistoryMetadata = {
                githubComment: {
                    body: ''
                }
            };

            const result = extractCommitHashFromMetadata(metadata);

            assert.strictEqual(result, null);
        });

        test('returns null when githubComment exists but body is undefined', () => {
            const metadata: TaskHistoryMetadata = {
                githubComment: {}
            };

            const result = extractCommitHashFromMetadata(metadata);

            assert.strictEqual(result, null);
        });
    });

    describe('GitHub comment body regex extraction', () => {
        test('extracts 7-character commit hash from comment body', () => {
            const metadata: TaskHistoryMetadata = {
                githubComment: {
                    body: 'See commit abc1234 for details'
                }
            };

            const result = extractCommitHashFromMetadata(metadata);

            assert.strictEqual(result, 'abc1234');
        });

        test('extracts 40-character full commit hash from comment body', () => {
            const metadata: TaskHistoryMetadata = {
                githubComment: {
                    body: 'Fixed in commit abcdef1234567890abcdef1234567890abcdef12'
                }
            };

            const result = extractCommitHashFromMetadata(metadata);

            assert.strictEqual(result, 'abcdef1234567890abcdef1234567890abcdef12');
        });

        test('handles case-insensitive "commit" keyword', () => {
            const metadata: TaskHistoryMetadata = {
                githubComment: {
                    body: 'Applied in COMMIT abc1234def'
                }
            };

            const result = extractCommitHashFromMetadata(metadata);

            assert.strictEqual(result, 'abc1234def');
        });

        test('handles "Commit" with mixed case', () => {
            const metadata: TaskHistoryMetadata = {
                githubComment: {
                    body: 'Changes in Commit def5678abc'
                }
            };

            const result = extractCommitHashFromMetadata(metadata);

            assert.strictEqual(result, 'def5678abc');
        });

        test('extracts first matching commit hash when multiple exist', () => {
            const metadata: TaskHistoryMetadata = {
                githubComment: {
                    body: 'commit abc1234 reverts commit def5678'
                }
            };

            const result = extractCommitHashFromMetadata(metadata);

            assert.strictEqual(result, 'abc1234');
        });

        test('requires word boundary before "commit" keyword', () => {
            const metadata: TaskHistoryMetadata = {
                githubComment: {
                    body: 'recommit abc1234 should not match'
                }
            };

            const result = extractCommitHashFromMetadata(metadata);

            assert.strictEqual(result, null);
        });

        test('requires word boundary after commit hash', () => {
            const metadata: TaskHistoryMetadata = {
                githubComment: {
                    body: 'commit abc1234xyz is an invalid reference'
                }
            };

            // The regex /\bcommit ([a-f0-9]{7,40})\b/i requires word boundary after hex chars
            // 'abc1234xyz' - after hex chars 'abc1234', there's 'x' which is also hex,
            // but then 'y' follows which is not hex. However, 'abc1234x' (8 chars) has no
            // word boundary after it since 'y' is alphanumeric. So no match is found.
            const result = extractCommitHashFromMetadata(metadata);

            assert.strictEqual(result, null);
        });

        test('does not match hashes shorter than 7 characters', () => {
            const metadata: TaskHistoryMetadata = {
                githubComment: {
                    body: 'commit abc123 is too short'
                }
            };

            const result = extractCommitHashFromMetadata(metadata);

            assert.strictEqual(result, null);
        });

        test('handles commit hash at start of comment body', () => {
            const metadata: TaskHistoryMetadata = {
                githubComment: {
                    body: 'commit abc1234def applied successfully'
                }
            };

            const result = extractCommitHashFromMetadata(metadata);

            assert.strictEqual(result, 'abc1234def');
        });

        test('handles commit hash at end of comment body', () => {
            const metadata: TaskHistoryMetadata = {
                githubComment: {
                    body: 'See changes in commit abc1234def'
                }
            };

            const result = extractCommitHashFromMetadata(metadata);

            assert.strictEqual(result, 'abc1234def');
        });

        test('handles multiline comment body', () => {
            const metadata: TaskHistoryMetadata = {
                githubComment: {
                    body: 'This is a multiline comment.\nThe fix was applied in commit abc1234def.\nPlease review.'
                }
            };

            const result = extractCommitHashFromMetadata(metadata);

            assert.strictEqual(result, 'abc1234def');
        });
    });

    describe('handles JSON string parsing scenario', () => {
        // This tests the scenario where metadata comes as a JSON string
        // as used by extractCommitHash in analysisService.ts:129
        test('handles metadata that would come as parsed JSON string', () => {
            const metadataString = JSON.stringify({
                commitHash: 'abc1234567890def'
            });

            // Parse the JSON string like extractCommitHash does
            const metadata: TaskHistoryMetadata = JSON.parse(metadataString);

            const result = extractCommitHashFromMetadata(metadata);

            assert.strictEqual(result, 'abc1234567890def');
        });

        test('handles nested metadata from parsed JSON string', () => {
            const metadataString = JSON.stringify({
                historyMetadata: {
                    commitResult: {
                        commitHash: 'fedcba9876543210'
                    }
                }
            });

            const metadata: TaskHistoryMetadata = JSON.parse(metadataString);

            const result = extractCommitHashFromMetadata(metadata);

            assert.strictEqual(result, 'fedcba9876543210');
        });

        test('handles prResult from parsed JSON string', () => {
            const metadataString = JSON.stringify({
                prResult: {
                    commitResult: {
                        commitHash: '0123456789abcdef'
                    }
                }
            });

            const metadata: TaskHistoryMetadata = JSON.parse(metadataString);

            const result = extractCommitHashFromMetadata(metadata);

            assert.strictEqual(result, '0123456789abcdef');
        });

        test('handles githubComment from parsed JSON string', () => {
            const metadataString = JSON.stringify({
                githubComment: {
                    body: 'Merged via commit 1234567890abcdef'
                }
            });

            const metadata: TaskHistoryMetadata = JSON.parse(metadataString);

            const result = extractCommitHashFromMetadata(metadata);

            assert.strictEqual(result, '1234567890abcdef');
        });

        test('handles empty parsed JSON object', () => {
            const metadataString = JSON.stringify({});

            const metadata: TaskHistoryMetadata = JSON.parse(metadataString);

            const result = extractCommitHashFromMetadata(metadata);

            assert.strictEqual(result, null);
        });
    });

    describe('edge cases', () => {
        test('handles metadata with empty string commitHash', () => {
            const metadata: TaskHistoryMetadata = {
                commitHash: ''
            };

            const result = extractCommitHashFromMetadata(metadata);

            // Empty string is falsy, so it should fall through to return null
            assert.strictEqual(result, null);
        });

        test('handles metadata with whitespace-only commitHash', () => {
            const metadata: TaskHistoryMetadata = {
                commitHash: '   '
            };

            const result = extractCommitHashFromMetadata(metadata);

            // Whitespace is truthy, so it would be returned (though invalid hash)
            assert.strictEqual(result, '   ');
        });

        test('handles very long commit hash in comment body (40+ chars)', () => {
            // The regex /\bcommit ([a-f0-9]{7,40})\b/i requires a word boundary after the match
            // When we have 45 consecutive 'a' chars, the regex tries to match 7-40 of them,
            // but there's no word boundary after 40 chars (more 'a' chars follow).
            // Therefore, no match is found and null is returned.
            const longHash = 'a'.repeat(45);
            const metadata: TaskHistoryMetadata = {
                githubComment: {
                    body: `commit ${longHash} is too long`
                }
            };

            const result = extractCommitHashFromMetadata(metadata);

            // No match because word boundary required after hex chars
            assert.strictEqual(result, null);
        });

        test('handles commit hash with uppercase letters in comment body', () => {
            const metadata: TaskHistoryMetadata = {
                githubComment: {
                    body: 'commit ABCDEF1234567'
                }
            };

            const result = extractCommitHashFromMetadata(metadata);

            // The /i flag makes the entire regex case-insensitive,
            // including the character class [a-f0-9], so uppercase letters match
            assert.strictEqual(result, 'ABCDEF1234567');
        });

        test('directly provided commitHash can contain uppercase', () => {
            const metadata: TaskHistoryMetadata = {
                commitHash: 'ABCDEF1234567890'
            };

            const result = extractCommitHashFromMetadata(metadata);

            // Direct commitHash values are returned as-is
            assert.strictEqual(result, 'ABCDEF1234567890');
        });

        test('handles special characters around commit keyword', () => {
            const metadata: TaskHistoryMetadata = {
                githubComment: {
                    body: '(commit abc1234def) was merged'
                }
            };

            const result = extractCommitHashFromMetadata(metadata);

            assert.strictEqual(result, 'abc1234def');
        });

        test('handles commit with colon separator', () => {
            const metadata: TaskHistoryMetadata = {
                githubComment: {
                    body: 'commit: abc1234def'
                }
            };

            const result = extractCommitHashFromMetadata(metadata);

            // The regex expects "commit " (commit followed by space) then the hash
            // "commit:" does not match because the colon is between "commit" and the hash
            // The regex pattern is /\bcommit ([a-f0-9]{7,40})\b/i which requires a space
            // after "commit" (the space is literal in the pattern between "commit" and the capture group)
            assert.strictEqual(result, null);
        });
    });
});

// Mock logger for waitForCommitHash tests
function createMockLogger() {
    return {
        debug: mock.fn(),
        info: mock.fn(),
        warn: mock.fn(),
        error: mock.fn()
    };
}

// Type for the mock database query function
type MockDbQueryFn = (taskId: string) => Promise<Task | undefined>;

// Replicate the waitForCommitHash function for testing
// This mirrors the implementation in packages/core/src/services/analysisService.ts:185-205
async function waitForCommitHash(
    taskId: string,
    initialTask: Task,
    correlatedLogger: ReturnType<typeof createMockLogger>,
    dbQuery: MockDbQueryFn,
    delayMs: number = 10000
): Promise<Task> {
    let task = initialTask;
    const maxRetries = 6;

    for (let attempt = 0; attempt < maxRetries && !task.commit_hash; attempt++) {
        correlatedLogger.debug({ taskId, attempt: attempt + 1, maxRetries }, 'Waiting for commit_hash to be populated...');
        await new Promise(resolve => setTimeout(resolve, delayMs));
        const refreshedTask = await dbQuery(taskId);
        if (!refreshedTask) break;
        task = refreshedTask;
    }

    return task;
}

describe('waitForCommitHash', () => {
    describe('returns immediately when hash already present', () => {
        test('returns task unchanged when commit_hash is already present', async () => {
            const mockLogger = createMockLogger();
            const taskWithHash: Task = {
                task_id: 'task-123',
                repository: 'owner/repo',
                issue_number: 42,
                commit_hash: 'abc1234567890def'
            };

            // Mock DB should never be called when hash is already present
            const mockDbQuery = mock.fn(async (_taskId: string): Promise<Task | undefined> => {
                throw new Error('DB should not be called when hash is present');
            });

            const result = await waitForCommitHash(
                'task-123',
                taskWithHash,
                mockLogger,
                mockDbQuery,
                1 // Use 1ms delay for fast tests
            );

            assert.strictEqual(result.task_id, 'task-123');
            assert.strictEqual(result.commit_hash, 'abc1234567890def');
            assert.strictEqual(mockDbQuery.mock.callCount(), 0, 'DB should not be queried when hash is present');
            assert.strictEqual(mockLogger.debug.mock.callCount(), 0, 'No polling logs when hash is present');
        });

        test('returns task with existing hash without modifications', async () => {
            const mockLogger = createMockLogger();
            const originalTask: Task = {
                task_id: 'task-456',
                repository: 'org/project',
                issue_number: 99,
                commit_hash: 'fedcba9876543210'
            };

            const mockDbQuery = mock.fn(async (_taskId: string): Promise<Task | undefined> => undefined);

            const result = await waitForCommitHash(
                'task-456',
                originalTask,
                mockLogger,
                mockDbQuery,
                1
            );

            // Verify it's the same object reference
            assert.strictEqual(result, originalTask);
        });
    });

    describe('polls and returns when hash appears', () => {
        test('returns task after hash appears on first poll', async () => {
            const mockLogger = createMockLogger();
            const initialTask: Task = {
                task_id: 'task-789',
                repository: 'owner/repo',
                issue_number: 10,
                commit_hash: undefined
            };

            const updatedTask: Task = {
                task_id: 'task-789',
                repository: 'owner/repo',
                issue_number: 10,
                commit_hash: '1234567890abcdef'
            };

            const mockDbQuery = mock.fn(async (_taskId: string): Promise<Task | undefined> => updatedTask);

            const result = await waitForCommitHash(
                'task-789',
                initialTask,
                mockLogger,
                mockDbQuery,
                1
            );

            assert.strictEqual(result.commit_hash, '1234567890abcdef');
            assert.strictEqual(mockDbQuery.mock.callCount(), 1, 'Should poll once before finding hash');
            assert.strictEqual(mockLogger.debug.mock.callCount(), 1, 'Should log one polling attempt');
        });

        test('returns task after hash appears on third poll', async () => {
            const mockLogger = createMockLogger();
            const initialTask: Task = {
                task_id: 'task-poll-3',
                repository: 'owner/repo',
                issue_number: 20,
                commit_hash: undefined
            };

            let pollCount = 0;
            const mockDbQuery = mock.fn(async (_taskId: string): Promise<Task | undefined> => {
                pollCount++;
                if (pollCount < 3) {
                    return {
                        task_id: 'task-poll-3',
                        repository: 'owner/repo',
                        issue_number: 20,
                        commit_hash: undefined
                    };
                }
                return {
                    task_id: 'task-poll-3',
                    repository: 'owner/repo',
                    issue_number: 20,
                    commit_hash: 'hash_on_poll_3'
                };
            });

            const result = await waitForCommitHash(
                'task-poll-3',
                initialTask,
                mockLogger,
                mockDbQuery,
                1
            );

            assert.strictEqual(result.commit_hash, 'hash_on_poll_3');
            assert.strictEqual(mockDbQuery.mock.callCount(), 3, 'Should poll 3 times before finding hash');
            assert.strictEqual(mockLogger.debug.mock.callCount(), 3, 'Should log 3 polling attempts');
        });

        test('returns task after hash appears on fifth poll', async () => {
            const mockLogger = createMockLogger();
            const initialTask: Task = {
                task_id: 'task-poll-5',
                repository: 'owner/repo',
                issue_number: 30,
                commit_hash: undefined
            };

            let pollCount = 0;
            const mockDbQuery = mock.fn(async (_taskId: string): Promise<Task | undefined> => {
                pollCount++;
                if (pollCount < 5) {
                    return {
                        task_id: 'task-poll-5',
                        repository: 'owner/repo',
                        issue_number: 30,
                        commit_hash: undefined
                    };
                }
                return {
                    task_id: 'task-poll-5',
                    repository: 'owner/repo',
                    issue_number: 30,
                    commit_hash: 'hash_on_poll_5'
                };
            });

            const result = await waitForCommitHash(
                'task-poll-5',
                initialTask,
                mockLogger,
                mockDbQuery,
                1
            );

            assert.strictEqual(result.commit_hash, 'hash_on_poll_5');
            assert.strictEqual(mockDbQuery.mock.callCount(), 5, 'Should poll 5 times before finding hash');
        });

        test('stops polling once hash is found', async () => {
            const mockLogger = createMockLogger();
            const initialTask: Task = {
                task_id: 'task-stop',
                repository: 'owner/repo',
                issue_number: 40,
                commit_hash: undefined
            };

            let pollCount = 0;
            const mockDbQuery = mock.fn(async (_taskId: string): Promise<Task | undefined> => {
                pollCount++;
                // Return hash on second poll
                if (pollCount >= 2) {
                    return {
                        task_id: 'task-stop',
                        repository: 'owner/repo',
                        issue_number: 40,
                        commit_hash: 'stop_hash'
                    };
                }
                return {
                    task_id: 'task-stop',
                    repository: 'owner/repo',
                    issue_number: 40,
                    commit_hash: undefined
                };
            });

            const result = await waitForCommitHash(
                'task-stop',
                initialTask,
                mockLogger,
                mockDbQuery,
                1
            );

            assert.strictEqual(result.commit_hash, 'stop_hash');
            // Should stop after finding hash, not continue to 6 retries
            assert.strictEqual(mockDbQuery.mock.callCount(), 2, 'Should stop polling after hash is found');
        });
    });

    describe('times out after 6 retries (60s)', () => {
        test('returns task without hash after 6 polling attempts', async () => {
            const mockLogger = createMockLogger();
            const initialTask: Task = {
                task_id: 'task-timeout',
                repository: 'owner/repo',
                issue_number: 50,
                commit_hash: undefined
            };

            // Always return task without hash
            const mockDbQuery = mock.fn(async (_taskId: string): Promise<Task | undefined> => ({
                task_id: 'task-timeout',
                repository: 'owner/repo',
                issue_number: 50,
                commit_hash: undefined
            }));

            const result = await waitForCommitHash(
                'task-timeout',
                initialTask,
                mockLogger,
                mockDbQuery,
                1
            );

            assert.strictEqual(result.commit_hash, undefined);
            assert.strictEqual(mockDbQuery.mock.callCount(), 6, 'Should poll exactly 6 times (max retries)');
            assert.strictEqual(mockLogger.debug.mock.callCount(), 6, 'Should log 6 polling attempts');
        });

        test('logs attempt count and max retries on each poll', async () => {
            const mockLogger = createMockLogger();
            const initialTask: Task = {
                task_id: 'task-log-check',
                repository: 'owner/repo',
                issue_number: 60,
                commit_hash: undefined
            };

            const mockDbQuery = mock.fn(async (_taskId: string): Promise<Task | undefined> => ({
                task_id: 'task-log-check',
                repository: 'owner/repo',
                issue_number: 60,
                commit_hash: undefined
            }));

            await waitForCommitHash(
                'task-log-check',
                initialTask,
                mockLogger,
                mockDbQuery,
                1
            );

            // Verify each debug call has the correct attempt number
            const debugCalls = mockLogger.debug.mock.calls;
            assert.strictEqual(debugCalls.length, 6);

            for (let i = 0; i < 6; i++) {
                const callArgs = debugCalls[i].arguments;
                assert.strictEqual(callArgs[0].taskId, 'task-log-check');
                assert.strictEqual(callArgs[0].attempt, i + 1);
                assert.strictEqual(callArgs[0].maxRetries, 6);
                assert.strictEqual(callArgs[1], 'Waiting for commit_hash to be populated...');
            }
        });

        test('does not poll more than 6 times even with no hash', async () => {
            const mockLogger = createMockLogger();
            const initialTask: Task = {
                task_id: 'task-max-6',
                repository: 'owner/repo',
                issue_number: 70,
                commit_hash: undefined
            };

            const mockDbQuery = mock.fn(async (_taskId: string): Promise<Task | undefined> => ({
                task_id: 'task-max-6',
                repository: 'owner/repo',
                issue_number: 70,
                commit_hash: undefined
            }));

            await waitForCommitHash(
                'task-max-6',
                initialTask,
                mockLogger,
                mockDbQuery,
                1
            );

            // Verify we never exceed 6 polls
            assert.ok(mockDbQuery.mock.callCount() <= 6, 'Should never poll more than 6 times');
        });
    });

    describe('handles task disappearing during polling', () => {
        test('returns last known task when task disappears on first poll', async () => {
            const mockLogger = createMockLogger();
            const initialTask: Task = {
                task_id: 'task-disappear-1',
                repository: 'owner/repo',
                issue_number: 80,
                commit_hash: undefined
            };

            // Task disappears immediately
            const mockDbQuery = mock.fn(async (_taskId: string): Promise<Task | undefined> => undefined);

            const result = await waitForCommitHash(
                'task-disappear-1',
                initialTask,
                mockLogger,
                mockDbQuery,
                1
            );

            assert.strictEqual(result.task_id, 'task-disappear-1');
            assert.strictEqual(result.commit_hash, undefined);
            assert.strictEqual(mockDbQuery.mock.callCount(), 1, 'Should stop after task disappears');
        });

        test('returns last known task when task disappears on third poll', async () => {
            const mockLogger = createMockLogger();
            const initialTask: Task = {
                task_id: 'task-disappear-3',
                repository: 'owner/repo',
                issue_number: 90,
                commit_hash: undefined
            };

            let pollCount = 0;
            const mockDbQuery = mock.fn(async (_taskId: string): Promise<Task | undefined> => {
                pollCount++;
                if (pollCount < 3) {
                    return {
                        task_id: 'task-disappear-3',
                        repository: 'owner/repo',
                        issue_number: 90,
                        commit_hash: undefined
                    };
                }
                // Task disappears on third poll
                return undefined;
            });

            const result = await waitForCommitHash(
                'task-disappear-3',
                initialTask,
                mockLogger,
                mockDbQuery,
                1
            );

            // Should return the last known task (from poll 2)
            assert.strictEqual(result.task_id, 'task-disappear-3');
            assert.strictEqual(result.commit_hash, undefined);
            assert.strictEqual(mockDbQuery.mock.callCount(), 3, 'Should stop polling after task disappears');
        });

        test('breaks early and does not continue polling after task disappears', async () => {
            const mockLogger = createMockLogger();
            const initialTask: Task = {
                task_id: 'task-early-break',
                repository: 'owner/repo',
                issue_number: 100,
                commit_hash: undefined
            };

            let pollCount = 0;
            const mockDbQuery = mock.fn(async (_taskId: string): Promise<Task | undefined> => {
                pollCount++;
                if (pollCount === 2) {
                    return undefined; // Task disappears on second poll
                }
                return {
                    task_id: 'task-early-break',
                    repository: 'owner/repo',
                    issue_number: 100,
                    commit_hash: undefined
                };
            });

            await waitForCommitHash(
                'task-early-break',
                initialTask,
                mockLogger,
                mockDbQuery,
                1
            );

            // Should stop at poll 2, not continue to 6
            assert.strictEqual(mockDbQuery.mock.callCount(), 2, 'Should break early when task disappears');
            assert.ok(mockDbQuery.mock.callCount() < 6, 'Should not reach max retries');
        });

        test('returns initialTask if task disappears on first poll', async () => {
            const mockLogger = createMockLogger();
            const initialTask: Task = {
                task_id: 'task-return-initial',
                repository: 'owner/repo',
                issue_number: 110,
                commit_hash: undefined
            };

            const mockDbQuery = mock.fn(async (_taskId: string): Promise<Task | undefined> => undefined);

            const result = await waitForCommitHash(
                'task-return-initial',
                initialTask,
                mockLogger,
                mockDbQuery,
                1
            );

            // When task disappears on first poll, we should still have the initial task
            assert.strictEqual(result, initialTask);
        });
    });

    describe('edge cases', () => {
        test('handles empty string commit_hash as falsy (continues polling)', async () => {
            const mockLogger = createMockLogger();
            const initialTask: Task = {
                task_id: 'task-empty-hash',
                repository: 'owner/repo',
                issue_number: 120,
                commit_hash: ''
            };

            let pollCount = 0;
            const mockDbQuery = mock.fn(async (_taskId: string): Promise<Task | undefined> => {
                pollCount++;
                if (pollCount >= 2) {
                    return {
                        task_id: 'task-empty-hash',
                        repository: 'owner/repo',
                        issue_number: 120,
                        commit_hash: 'valid_hash'
                    };
                }
                return {
                    task_id: 'task-empty-hash',
                    repository: 'owner/repo',
                    issue_number: 120,
                    commit_hash: ''
                };
            });

            const result = await waitForCommitHash(
                'task-empty-hash',
                initialTask,
                mockLogger,
                mockDbQuery,
                1
            );

            // Empty string is falsy, so polling should continue until valid hash found
            assert.strictEqual(result.commit_hash, 'valid_hash');
        });

        test('uses correct taskId for database query', async () => {
            const mockLogger = createMockLogger();
            const initialTask: Task = {
                task_id: 'task-id-check',
                repository: 'owner/repo',
                issue_number: 130,
                commit_hash: undefined
            };

            const queriedTaskIds: string[] = [];
            const mockDbQuery = mock.fn(async (taskId: string): Promise<Task | undefined> => {
                queriedTaskIds.push(taskId);
                return {
                    task_id: taskId,
                    repository: 'owner/repo',
                    issue_number: 130,
                    commit_hash: 'found_hash'
                };
            });

            await waitForCommitHash(
                'task-id-check',
                initialTask,
                mockLogger,
                mockDbQuery,
                1
            );

            assert.strictEqual(queriedTaskIds.length, 1);
            assert.strictEqual(queriedTaskIds[0], 'task-id-check');
        });

        test('preserves all task properties when returning updated task', async () => {
            const mockLogger = createMockLogger();
            const initialTask: Task = {
                task_id: 'task-preserve',
                repository: 'owner/special-repo',
                issue_number: 999,
                commit_hash: undefined
            };

            const mockDbQuery = mock.fn(async (_taskId: string): Promise<Task | undefined> => ({
                task_id: 'task-preserve',
                repository: 'owner/special-repo',
                issue_number: 999,
                commit_hash: 'new_hash_value'
            }));

            const result = await waitForCommitHash(
                'task-preserve',
                initialTask,
                mockLogger,
                mockDbQuery,
                1
            );

            assert.strictEqual(result.task_id, 'task-preserve');
            assert.strictEqual(result.repository, 'owner/special-repo');
            assert.strictEqual(result.issue_number, 999);
            assert.strictEqual(result.commit_hash, 'new_hash_value');
        });
    });
});
