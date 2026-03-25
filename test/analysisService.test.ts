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

// Define the ConversationLogEntry interface to match the one in analysisService.ts
interface ConversationLogEntry {
    type?: string;
    id?: string;
    name?: string;
    content?: string;
    tool_use_id?: string;
    is_error?: boolean;
    compacted?: boolean;
}

// Replicate the compactConversationLog function for testing
// This mirrors the implementation in packages/core/src/services/analysisService.ts:144-183
function compactConversationLog(conversationLog: ConversationLogEntry[]): ConversationLogEntry[] {
    if (!Array.isArray(conversationLog)) {
        return [];
    }

    const toolUseMap = new Map<string, string>();
    conversationLog.forEach(entry => {
        if (entry.type === 'tool_use' && entry.id && entry.name) {
            toolUseMap.set(entry.id, entry.name);
        }
    });

    return conversationLog.map(entry => {
        if (entry.type === 'text' || entry.type === 'tool_use') {
            return entry;
        }

        if (entry.type === 'tool_result') {
            if (entry.is_error) {
                return entry;
            }

            const toolName = entry.tool_use_id ? toolUseMap.get(entry.tool_use_id) : undefined;
            const content = entry.content || '';

            if (toolName === 'Read' || toolName === 'Grep' || toolName === 'Glob') {
                if (content.startsWith('No files found')) {
                    return entry;
                }
                const lines = content.split('\n');
                const summary = `[Content from ${toolName}: ${lines.length} lines. Content omitted for analysis.]`;
                return { ...entry, content: summary, compacted: true };
            }

            return entry;
        }

        return entry;
    });
}

describe('compactConversationLog', () => {
    describe('omits Read/Grep/Glob tool output', () => {
        test('compacts Read tool output to summary', () => {
            const conversationLog: ConversationLogEntry[] = [
                { type: 'tool_use', id: 'tool-1', name: 'Read' },
                {
                    type: 'tool_result',
                    tool_use_id: 'tool-1',
                    content: 'line 1\nline 2\nline 3\nline 4\nline 5'
                }
            ];

            const result = compactConversationLog(conversationLog);

            assert.strictEqual(result[1].content, '[Content from Read: 5 lines. Content omitted for analysis.]');
            assert.strictEqual(result[1].compacted, true);
        });

        test('compacts Grep tool output to summary', () => {
            const conversationLog: ConversationLogEntry[] = [
                { type: 'tool_use', id: 'grep-1', name: 'Grep' },
                {
                    type: 'tool_result',
                    tool_use_id: 'grep-1',
                    content: 'match 1\nmatch 2\nmatch 3'
                }
            ];

            const result = compactConversationLog(conversationLog);

            assert.strictEqual(result[1].content, '[Content from Grep: 3 lines. Content omitted for analysis.]');
            assert.strictEqual(result[1].compacted, true);
        });

        test('compacts Glob tool output to summary', () => {
            const conversationLog: ConversationLogEntry[] = [
                { type: 'tool_use', id: 'glob-1', name: 'Glob' },
                {
                    type: 'tool_result',
                    tool_use_id: 'glob-1',
                    content: 'file1.ts\nfile2.ts\nfile3.ts\nfile4.ts\nfile5.ts\nfile6.ts\nfile7.ts'
                }
            ];

            const result = compactConversationLog(conversationLog);

            assert.strictEqual(result[1].content, '[Content from Glob: 7 lines. Content omitted for analysis.]');
            assert.strictEqual(result[1].compacted, true);
        });

        test('preserves "No files found" responses from Glob', () => {
            const conversationLog: ConversationLogEntry[] = [
                { type: 'tool_use', id: 'glob-2', name: 'Glob' },
                {
                    type: 'tool_result',
                    tool_use_id: 'glob-2',
                    content: 'No files found matching pattern'
                }
            ];

            const result = compactConversationLog(conversationLog);

            assert.strictEqual(result[1].content, 'No files found matching pattern');
            assert.strictEqual(result[1].compacted, undefined);
        });

        test('preserves "No files found" responses from Grep', () => {
            const conversationLog: ConversationLogEntry[] = [
                { type: 'tool_use', id: 'grep-2', name: 'Grep' },
                {
                    type: 'tool_result',
                    tool_use_id: 'grep-2',
                    content: 'No files found with matches'
                }
            ];

            const result = compactConversationLog(conversationLog);

            assert.strictEqual(result[1].content, 'No files found with matches');
            assert.strictEqual(result[1].compacted, undefined);
        });

        test('preserves error results from Read/Grep/Glob tools', () => {
            const conversationLog: ConversationLogEntry[] = [
                { type: 'tool_use', id: 'read-err', name: 'Read' },
                {
                    type: 'tool_result',
                    tool_use_id: 'read-err',
                    content: 'Error: File not found',
                    is_error: true
                }
            ];

            const result = compactConversationLog(conversationLog);

            assert.strictEqual(result[1].content, 'Error: File not found');
            assert.strictEqual(result[1].is_error, true);
            assert.strictEqual(result[1].compacted, undefined);
        });

        test('does not compact other tool results (Bash, Write, etc.)', () => {
            const conversationLog: ConversationLogEntry[] = [
                { type: 'tool_use', id: 'bash-1', name: 'Bash' },
                {
                    type: 'tool_result',
                    tool_use_id: 'bash-1',
                    content: 'Command output line 1\nCommand output line 2\nCommand output line 3'
                }
            ];

            const result = compactConversationLog(conversationLog);

            assert.strictEqual(result[1].content, 'Command output line 1\nCommand output line 2\nCommand output line 3');
            assert.strictEqual(result[1].compacted, undefined);
        });

        test('handles multiple tool results with mixed types', () => {
            const conversationLog: ConversationLogEntry[] = [
                { type: 'tool_use', id: 'read-1', name: 'Read' },
                { type: 'tool_result', tool_use_id: 'read-1', content: 'file content\nline 2' },
                { type: 'tool_use', id: 'bash-1', name: 'Bash' },
                { type: 'tool_result', tool_use_id: 'bash-1', content: 'bash output' },
                { type: 'tool_use', id: 'grep-1', name: 'Grep' },
                { type: 'tool_result', tool_use_id: 'grep-1', content: 'grep result\nline 2\nline 3' }
            ];

            const result = compactConversationLog(conversationLog);

            // Read should be compacted
            assert.strictEqual(result[1].content, '[Content from Read: 2 lines. Content omitted for analysis.]');
            assert.strictEqual(result[1].compacted, true);

            // Bash should not be compacted
            assert.strictEqual(result[3].content, 'bash output');
            assert.strictEqual(result[3].compacted, undefined);

            // Grep should be compacted
            assert.strictEqual(result[5].content, '[Content from Grep: 3 lines. Content omitted for analysis.]');
            assert.strictEqual(result[5].compacted, true);
        });
    });

    describe('preserves agent messages', () => {
        test('preserves text type entries unchanged', () => {
            const conversationLog: ConversationLogEntry[] = [
                { type: 'text', content: 'This is a text message from the assistant' }
            ];

            const result = compactConversationLog(conversationLog);

            assert.strictEqual(result[0].type, 'text');
            assert.strictEqual(result[0].content, 'This is a text message from the assistant');
        });

        test('preserves tool_use type entries unchanged', () => {
            const conversationLog: ConversationLogEntry[] = [
                { type: 'tool_use', id: 'tool-123', name: 'Read', content: '{"path": "/some/file.ts"}' }
            ];

            const result = compactConversationLog(conversationLog);

            assert.strictEqual(result[0].type, 'tool_use');
            assert.strictEqual(result[0].id, 'tool-123');
            assert.strictEqual(result[0].name, 'Read');
            assert.strictEqual(result[0].content, '{"path": "/some/file.ts"}');
        });

        test('preserves mixed conversation with agent messages intact', () => {
            const conversationLog: ConversationLogEntry[] = [
                { type: 'text', content: 'I will read the file for you.' },
                { type: 'tool_use', id: 'read-1', name: 'Read' },
                { type: 'tool_result', tool_use_id: 'read-1', content: 'file\ncontent\nhere' },
                { type: 'text', content: 'The file contains 3 lines.' }
            ];

            const result = compactConversationLog(conversationLog);

            // Text messages preserved
            assert.strictEqual(result[0].type, 'text');
            assert.strictEqual(result[0].content, 'I will read the file for you.');
            assert.strictEqual(result[3].type, 'text');
            assert.strictEqual(result[3].content, 'The file contains 3 lines.');

            // tool_use preserved
            assert.strictEqual(result[1].type, 'tool_use');
            assert.strictEqual(result[1].name, 'Read');

            // tool_result compacted
            assert.strictEqual(result[2].compacted, true);
        });

        test('returns same array length after compaction', () => {
            const conversationLog: ConversationLogEntry[] = [
                { type: 'text', content: 'message 1' },
                { type: 'tool_use', id: 'tool-1', name: 'Read' },
                { type: 'tool_result', tool_use_id: 'tool-1', content: 'content' },
                { type: 'text', content: 'message 2' }
            ];

            const result = compactConversationLog(conversationLog);

            assert.strictEqual(result.length, conversationLog.length);
        });
    });

    describe('handles non-array input', () => {
        test('returns empty array for null input', () => {
            const result = compactConversationLog(null as unknown as ConversationLogEntry[]);

            assert.deepStrictEqual(result, []);
        });

        test('returns empty array for undefined input', () => {
            const result = compactConversationLog(undefined as unknown as ConversationLogEntry[]);

            assert.deepStrictEqual(result, []);
        });

        test('returns empty array for string input', () => {
            const result = compactConversationLog('not an array' as unknown as ConversationLogEntry[]);

            assert.deepStrictEqual(result, []);
        });

        test('returns empty array for number input', () => {
            const result = compactConversationLog(42 as unknown as ConversationLogEntry[]);

            assert.deepStrictEqual(result, []);
        });

        test('returns empty array for object input', () => {
            const result = compactConversationLog({ type: 'text' } as unknown as ConversationLogEntry[]);

            assert.deepStrictEqual(result, []);
        });

        test('handles empty array input correctly', () => {
            const result = compactConversationLog([]);

            assert.deepStrictEqual(result, []);
            assert.strictEqual(result.length, 0);
        });
    });

    describe('reduces payload size', () => {
        test('significantly reduces content length for large Read output', () => {
            const largeContent = Array.from({ length: 500 }, (_, i) => `Line ${i + 1}: This is some content that represents a typical line in a source file.`).join('\n');
            const conversationLog: ConversationLogEntry[] = [
                { type: 'tool_use', id: 'read-large', name: 'Read' },
                { type: 'tool_result', tool_use_id: 'read-large', content: largeContent }
            ];

            const originalSize = JSON.stringify(conversationLog).length;
            const result = compactConversationLog(conversationLog);
            const compactedSize = JSON.stringify(result).length;

            // The compacted version should be significantly smaller
            assert.ok(compactedSize < originalSize, `Compacted size (${compactedSize}) should be less than original (${originalSize})`);
            // Should be at least 90% smaller for large payloads
            assert.ok(compactedSize < originalSize * 0.1, `Compacted size should be less than 10% of original`);
        });

        test('significantly reduces content length for large Grep output', () => {
            const largeContent = Array.from({ length: 200 }, (_, i) => `src/file${i}.ts:${i * 10}: const match = 'some pattern';`).join('\n');
            const conversationLog: ConversationLogEntry[] = [
                { type: 'tool_use', id: 'grep-large', name: 'Grep' },
                { type: 'tool_result', tool_use_id: 'grep-large', content: largeContent }
            ];

            const originalSize = JSON.stringify(conversationLog).length;
            const result = compactConversationLog(conversationLog);
            const compactedSize = JSON.stringify(result).length;

            assert.ok(compactedSize < originalSize, 'Compacted size should be less than original');
            assert.ok(compactedSize < originalSize * 0.1, 'Compacted size should be less than 10% of original');
        });

        test('significantly reduces content length for large Glob output', () => {
            const largeContent = Array.from({ length: 300 }, (_, i) => `src/components/feature${i}/Component${i}.tsx`).join('\n');
            const conversationLog: ConversationLogEntry[] = [
                { type: 'tool_use', id: 'glob-large', name: 'Glob' },
                { type: 'tool_result', tool_use_id: 'glob-large', content: largeContent }
            ];

            const originalSize = JSON.stringify(conversationLog).length;
            const result = compactConversationLog(conversationLog);
            const compactedSize = JSON.stringify(result).length;

            assert.ok(compactedSize < originalSize, 'Compacted size should be less than original');
            assert.ok(compactedSize < originalSize * 0.1, 'Compacted size should be less than 10% of original');
        });

        test('compacts multiple large tool results in a conversation', () => {
            // Use larger content (300 lines each) to demonstrate significant payload reduction
            const largeReadContent = Array.from({ length: 300 }, (_, i) => `Line ${i}: This is content from a source file that takes up significant space.`).join('\n');
            const largeGrepContent = Array.from({ length: 300 }, (_, i) => `src/file${i}.ts:${i * 10}: const match = 'pattern';`).join('\n');
            const conversationLog: ConversationLogEntry[] = [
                { type: 'text', content: 'Analyzing the codebase' },
                { type: 'tool_use', id: 'read-1', name: 'Read' },
                { type: 'tool_result', tool_use_id: 'read-1', content: largeReadContent },
                { type: 'tool_use', id: 'grep-1', name: 'Grep' },
                { type: 'tool_result', tool_use_id: 'grep-1', content: largeGrepContent },
                { type: 'text', content: 'Analysis complete' }
            ];

            const originalSize = JSON.stringify(conversationLog).length;
            const result = compactConversationLog(conversationLog);
            const compactedSize = JSON.stringify(result).length;

            // Should still preserve text entries but compact tool results
            // With large tool outputs, the payload should be significantly reduced
            assert.ok(compactedSize < originalSize * 0.05, 'Total payload should be reduced by at least 95%');
        });
    });

    describe('edge cases', () => {
        test('handles tool_result without matching tool_use', () => {
            const conversationLog: ConversationLogEntry[] = [
                {
                    type: 'tool_result',
                    tool_use_id: 'orphan-id',
                    content: 'some content'
                }
            ];

            const result = compactConversationLog(conversationLog);

            // Without a matching tool_use, toolName will be undefined, so content is preserved
            assert.strictEqual(result[0].content, 'some content');
            assert.strictEqual(result[0].compacted, undefined);
        });

        test('handles tool_result with empty content', () => {
            const conversationLog: ConversationLogEntry[] = [
                { type: 'tool_use', id: 'read-empty', name: 'Read' },
                { type: 'tool_result', tool_use_id: 'read-empty', content: '' }
            ];

            const result = compactConversationLog(conversationLog);

            // Empty content doesn't start with "No files found", so it gets compacted
            assert.strictEqual(result[1].content, '[Content from Read: 1 lines. Content omitted for analysis.]');
            assert.strictEqual(result[1].compacted, true);
        });

        test('handles tool_result with undefined content', () => {
            const conversationLog: ConversationLogEntry[] = [
                { type: 'tool_use', id: 'read-undef', name: 'Read' },
                { type: 'tool_result', tool_use_id: 'read-undef' }
            ];

            const result = compactConversationLog(conversationLog);

            // undefined content becomes empty string, which gets compacted
            assert.strictEqual(result[1].content, '[Content from Read: 1 lines. Content omitted for analysis.]');
            assert.strictEqual(result[1].compacted, true);
        });

        test('handles entries with unknown type', () => {
            const conversationLog: ConversationLogEntry[] = [
                { type: 'unknown_type', content: 'some content' }
            ];

            const result = compactConversationLog(conversationLog);

            // Unknown types are passed through unchanged
            assert.strictEqual(result[0].type, 'unknown_type');
            assert.strictEqual(result[0].content, 'some content');
        });

        test('handles entries without type property', () => {
            const conversationLog: ConversationLogEntry[] = [
                { content: 'no type specified' }
            ];

            const result = compactConversationLog(conversationLog);

            // Entries without type are passed through unchanged
            assert.strictEqual(result[0].content, 'no type specified');
            assert.strictEqual(result[0].type, undefined);
        });

        test('correctly counts single line content', () => {
            const conversationLog: ConversationLogEntry[] = [
                { type: 'tool_use', id: 'read-single', name: 'Read' },
                { type: 'tool_result', tool_use_id: 'read-single', content: 'single line without newline' }
            ];

            const result = compactConversationLog(conversationLog);

            assert.strictEqual(result[1].content, '[Content from Read: 1 lines. Content omitted for analysis.]');
        });

        test('preserves original entry properties in compacted result', () => {
            const conversationLog: ConversationLogEntry[] = [
                { type: 'tool_use', id: 'read-props', name: 'Read' },
                {
                    type: 'tool_result',
                    tool_use_id: 'read-props',
                    content: 'line 1\nline 2',
                    id: 'result-123'
                }
            ];

            const result = compactConversationLog(conversationLog);

            // Original properties should be preserved via spread
            assert.strictEqual(result[1].type, 'tool_result');
            assert.strictEqual(result[1].tool_use_id, 'read-props');
            assert.strictEqual(result[1].id, 'result-123');
            // Content should be replaced
            assert.strictEqual(result[1].content, '[Content from Read: 2 lines. Content omitted for analysis.]');
            assert.strictEqual(result[1].compacted, true);
        });
    });
});

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
