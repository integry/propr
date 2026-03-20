import { test, describe } from 'node:test';
import assert from 'node:assert';

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
