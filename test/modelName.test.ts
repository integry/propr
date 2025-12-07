import { test } from 'node:test';
import assert from 'node:assert';

function extractModelDisplayName(modelId: string | null | undefined): string {
    if (!modelId || typeof modelId !== 'string') {
        return 'Claude (Unknown Model)';
    }
    
    const modelMappings: Record<string, string> = {
        'claude-3-5-sonnet': 'Claude 3.5 Sonnet',
        'claude-3-sonnet': 'Claude 3 Sonnet',
        'claude-3-opus': 'Claude 3 Opus',
        'claude-3-haiku': 'Claude 3 Haiku',
        'claude-2.1': 'Claude 2.1',
        'claude-2.0': 'Claude 2.0',
        'claude-instant': 'Claude Instant'
    };
    
    for (const [pattern, displayName] of Object.entries(modelMappings)) {
        if (modelId.toLowerCase().includes(pattern)) {
            return displayName;
        }
    }
    
    const claudeMatch = modelId.match(/claude-(\d+(?:\.\d+)?)-(\w+)/i);
    if (claudeMatch) {
        const version = claudeMatch[1];
        const type = claudeMatch[2].charAt(0).toUpperCase() + claudeMatch[2].slice(1);
        return `Claude ${version} ${type}`;
    }
    
    const cleanedId = modelId
        .replace(/^claude-?/i, 'Claude ')
        .replace(/-(\d{8}|\d{4}-\d{2}-\d{2}).*$/, '')
        .replace(/-/g, ' ')
        .replace(/\b\w/g, l => l.toUpperCase())
        .trim();
    
    return cleanedId || 'Claude (Unknown Model)';
}

test('Model name extraction for Claude 3.5 Sonnet variants', () => {
    assert.strictEqual(
        extractModelDisplayName('claude-3-5-sonnet-20241022'), 
        'Claude 3.5 Sonnet'
    );
    
    assert.strictEqual(
        extractModelDisplayName('claude-3-5-sonnet'), 
        'Claude 3.5 Sonnet'
    );
    
    assert.strictEqual(
        extractModelDisplayName('CLAUDE-3-5-SONNET-LATEST'), 
        'Claude 3.5 Sonnet'
    );
});

test('Model name extraction for other Claude models', () => {
    assert.strictEqual(
        extractModelDisplayName('claude-3-opus-20240229'), 
        'Claude 3 Opus'
    );
    
    assert.strictEqual(
        extractModelDisplayName('claude-3-haiku-20240307'), 
        'Claude 3 Haiku'
    );
    
    assert.strictEqual(
        extractModelDisplayName('claude-3-sonnet'), 
        'Claude 3 Sonnet'
    );
    
    assert.strictEqual(
        extractModelDisplayName('claude-2.1'), 
        'Claude 2.1'
    );
    
    assert.strictEqual(
        extractModelDisplayName('claude-instant'), 
        'Claude Instant'
    );
});

test('Model name extraction with pattern matching fallback', () => {
    assert.strictEqual(
        extractModelDisplayName('claude-4-turbo'), 
        'Claude 4 Turbo'
    );
    
    assert.strictEqual(
        extractModelDisplayName('claude-3.5-nova'), 
        'Claude 3.5 Nova'
    );
});

test('Model name extraction for unknown or malformed inputs', () => {
    assert.strictEqual(
        extractModelDisplayName(''), 
        'Claude (Unknown Model)'
    );
    
    assert.strictEqual(
        extractModelDisplayName(null), 
        'Claude (Unknown Model)'
    );
    
    assert.strictEqual(
        extractModelDisplayName(undefined), 
        'Claude (Unknown Model)'
    );
    
    assert.strictEqual(
        extractModelDisplayName('some-other-model'), 
        'Some Other Model'
    );
});

test('Model name extraction removes timestamps', () => {
    assert.strictEqual(
        extractModelDisplayName('claude-3-5-sonnet-20241022-v2'), 
        'Claude 3.5 Sonnet'
    );
    
    assert.strictEqual(
        extractModelDisplayName('claude-4-nova-2024-12-01'), 
        'Claude 4 Nova'
    );
});

test('Model name extraction handles edge cases', () => {
    assert.strictEqual(
        extractModelDisplayName('Claude-3-5-Sonnet'), 
        'Claude 3.5 Sonnet'
    );
    
    assert.strictEqual(
        extractModelDisplayName('claude'), 
        'Claude'
    );
});
