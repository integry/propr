import { test } from 'node:test';
import assert from 'node:assert';

interface ClaudeResult {
    success?: boolean;
    executionTime?: number;
    conversationId?: string;
    sessionId?: string;
    model?: string;
    conversationLog?: Array<{
        message?: {
            usage?: {
                input_tokens?: number;
                output_tokens?: number;
            };
        };
    }>;
    finalResult?: {
        cost_usd?: number;
    };
}

interface IssueRef {
    number: number;
    repoOwner: string;
    repoName: string;
}

interface UsageStats {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
}

function getUsageStats(claudeResult: ClaudeResult): UsageStats {
    let inputTokens = 0;
    let outputTokens = 0;

    if (claudeResult?.conversationLog) {
        claudeResult.conversationLog.forEach(msg => {
            if (msg.message?.usage) {
                inputTokens += (msg.message.usage.input_tokens || 0);
                outputTokens += (msg.message.usage.output_tokens || 0);
            }
        });
    }

    return {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens
    };
}

function generateMockCompletionComment(claudeResult: ClaudeResult, issueRef: IssueRef): string {
    const timestamp = new Date().toISOString();
    const isSuccess = claudeResult?.success || false;
    const executionTime = Math.round((claudeResult?.executionTime || 0) / 1000);
    const { inputTokens, outputTokens, totalTokens } = getUsageStats(claudeResult);
    const cost = claudeResult?.finalResult?.cost_usd || 0;
    
    function extractModelDisplayName(modelId: string | undefined): string {
        if (!modelId || typeof modelId !== 'string') {
            return 'Claude (Unknown Model)';
        }
        
        const modelMappings: Record<string, string> = {
            'claude-3-5-sonnet': 'Claude 3.5 Sonnet',
            'claude-3-opus': 'Claude 3 Opus',
            'claude-3-haiku': 'Claude 3 Haiku'
        };
        
        for (const [pattern, displayName] of Object.entries(modelMappings)) {
            if (modelId.toLowerCase().includes(pattern)) {
                return displayName;
            }
        }
        
        return 'Claude (Unknown Model)';
    }
    
    let comment = `🤖 **AI Processing ${isSuccess ? 'Completed' : 'Failed'}**\n\n`;
    comment += `**Execution Details:**\n`;
    comment += `- Issue: #${issueRef.number}\n`;
    comment += `- Repository: ${issueRef.repoOwner}/${issueRef.repoName}\n`;
    comment += `- Status: ${isSuccess ? '✅ Success' : '❌ Failed'}\n`;
    comment += `- Execution Time: ${executionTime}s\n`;
    comment += `- Tokens used: ${totalTokens.toLocaleString()} tokens [${inputTokens.toLocaleString()} input + ${outputTokens.toLocaleString()} output]\n`;
    comment += `- API cost: $${cost}\n`;
    comment += `- Timestamp: ${timestamp}\n`;
    
    if (claudeResult?.conversationId) {
        comment += `- Conversation ID: \`${claudeResult.conversationId}\`\n`;
    }
    
    if (claudeResult?.model) {
        const modelName = extractModelDisplayName(claudeResult.model);
        comment += `- LLM Model: ${modelName}\n`;
    }
    
    comment += `\n`;
    
    return comment;
}

test('Enhanced GitHub comment includes conversation ID and model', () => {
    const mockClaudeResult: ClaudeResult = {
        success: true,
        executionTime: 127000,
        conversationId: 'conv_abc123xyz789',
        sessionId: 'session_def456',
        model: 'claude-3-5-sonnet-20241022',
        conversationLog: [
            { message: { usage: { input_tokens: 5000, output_tokens: 2000 } } },
            { message: { usage: { input_tokens: 2000, output_tokens: 1123 } } }
        ],
        finalResult: {
            cost_usd: 0.42
        }
    };
    
    const mockIssueRef: IssueRef = {
        number: 344,
        repoOwner: 'integry',
        repoName: 'forex'
    };
    
    const comment = generateMockCompletionComment(mockClaudeResult, mockIssueRef);
    
    assert.ok(comment.includes('🤖 **AI Processing Completed**'));
    assert.ok(comment.includes('- Issue: #344'));
    assert.ok(comment.includes('- Repository: integry/forex'));
    assert.ok(comment.includes('- Status: ✅ Success'));
    assert.ok(comment.includes('- Execution Time: 127s'));
    assert.ok(comment.includes('- Conversation ID: `conv_abc123xyz789`'));
    assert.ok(comment.includes('- LLM Model: Claude 3.5 Sonnet'));
    assert.ok(comment.includes('- Tokens used: 10,123 tokens [7,000 input + 3,123 output]'));
    assert.ok(comment.includes('- API cost: $0.42'));
});

test('GitHub comment gracefully handles missing optional fields', () => {
    const mockClaudeResult: ClaudeResult = {
        success: false,
        executionTime: 5000,
    };
    
    const mockIssueRef: IssueRef = {
        number: 123,
        repoOwner: 'testorg',
        repoName: 'testrepo'
    };
    
    const comment = generateMockCompletionComment(mockClaudeResult, mockIssueRef);
    
    assert.ok(comment.includes('🤖 **AI Processing Failed**'));
    assert.ok(comment.includes('- Status: ❌ Failed'));
    assert.ok(comment.includes('- Execution Time: 5s'));
    assert.ok(comment.includes('- Tokens used: 0 tokens [0 input + 0 output]'));
    assert.ok(comment.includes('- API cost: $0'));
    
    assert.ok(!comment.includes('Conversation ID:'));
    assert.ok(!comment.includes('LLM Model:'));
});

test('GitHub comment handles different model types correctly', () => {
    const testCases = [
        {
            model: 'claude-3-opus-20240229',
            expected: 'Claude 3 Opus'
        },
        {
            model: 'claude-3-haiku-20240307',
            expected: 'Claude 3 Haiku'
        },
        {
            model: 'claude-3-5-sonnet',
            expected: 'Claude 3.5 Sonnet'
        },
        {
            model: 'unknown-model',
            expected: 'Claude (Unknown Model)'
        }
    ];
    
    testCases.forEach(({ model, expected }) => {
        const mockClaudeResult: ClaudeResult = {
            success: true,
            executionTime: 1000,
            model
        };
        
        const mockIssueRef: IssueRef = {
            number: 1,
            repoOwner: 'test',
            repoName: 'test'
        };
        
        const comment = generateMockCompletionComment(mockClaudeResult, mockIssueRef);
        assert.ok(comment.includes(`- LLM Model: ${expected}`), 
                   `Expected to find "${expected}" for model "${model}"`);
    });
});

test('GitHub comment correctly displays token usage with conversationLog', () => {
    const mockClaudeResult: ClaudeResult = {
        success: true,
        executionTime: 95000,
        conversationId: 'conv_test123',
        sessionId: 'session_test456',
        model: 'claude-3-5-sonnet-20241022',
        conversationLog: [
            { message: { usage: { input_tokens: 3000, output_tokens: 1500 } } },
            { message: { usage: { input_tokens: 2000, output_tokens: 1000 } } }
        ],
        finalResult: {
            cost_usd: 0.35
        }
    };
    
    const mockIssueRef: IssueRef = {
        number: 456,
        repoOwner: 'testorg',
        repoName: 'testrepo'
    };
    
    const comment = generateMockCompletionComment(mockClaudeResult, mockIssueRef);
    
    assert.ok(comment.includes('🤖 **AI Processing Completed**'));
    assert.ok(comment.includes('- Issue: #456'));
    assert.ok(comment.includes('- Tokens used: 7,500 tokens [5,000 input + 2,500 output]'));
    assert.ok(comment.includes('- API cost: $0.35'));
});
