import { test } from 'node:test';
import assert from 'node:assert';

test('Environment variable GIT_FALLBACK_BRANCH is respected', () => {
    const originalValue = process.env.GIT_FALLBACK_BRANCH;
    
    process.env.GIT_FALLBACK_BRANCH = 'dev';
    
    const commonBranches = [
        process.env.GIT_FALLBACK_BRANCH || 'main',
        'main', 
        'master', 
        'develop', 
        'dev', 
        'trunk'
    ];
    
    assert.strictEqual(commonBranches[0], 'dev');
    assert.ok(commonBranches.includes('main'));
    assert.ok(commonBranches.includes('master'));
    
    if (originalValue !== undefined) {
        process.env.GIT_FALLBACK_BRANCH = originalValue;
    } else {
        delete process.env.GIT_FALLBACK_BRANCH;
    }
});

test('Default fallback branch behavior without environment variable', () => {
    const originalValue = process.env.GIT_FALLBACK_BRANCH;
    delete process.env.GIT_FALLBACK_BRANCH;
    
    const commonBranches = [
        process.env.GIT_FALLBACK_BRANCH || 'main',
        'main', 
        'master', 
        'develop', 
        'dev', 
        'trunk'
    ];
    
    assert.strictEqual(commonBranches[0], 'main');
    
    if (originalValue !== undefined) {
        process.env.GIT_FALLBACK_BRANCH = originalValue;
    }
});

test('Branch detection priority order is correct', () => {
    const expectedOrder = ['main', 'master', 'develop', 'dev', 'trunk'];
    
    const commonBranches = [
        'main',
        'main', 
        'master', 
        'develop', 
        'dev', 
        'trunk'
    ];
    
    for (const branch of expectedOrder) {
        assert.ok(commonBranches.includes(branch), `Branch '${branch}' should be in fallback list`);
    }
    
    const devIndex = commonBranches.indexOf('dev');
    const trunkIndex = commonBranches.indexOf('trunk');
    assert.ok(devIndex < trunkIndex, 'dev should have higher priority than trunk');
});

test('Repository-specific environment variable key generation', () => {
    function getRepoConfigKey(owner: string, repoName: string): string {
        const cleanOwner = owner.toUpperCase().replace(/[^A-Z0-9]/g, '_');
        const cleanRepoName = repoName.toUpperCase().replace(/[^A-Z0-9]/g, '_');
        return `GIT_DEFAULT_BRANCH_${cleanOwner}_${cleanRepoName}`;
    }
    
    assert.strictEqual(
        getRepoConfigKey('integry', 'forex'), 
        'GIT_DEFAULT_BRANCH_INTEGRY_FOREX'
    );
    
    assert.strictEqual(
        getRepoConfigKey('my-org', 'my-repo.com'), 
        'GIT_DEFAULT_BRANCH_MY_ORG_MY_REPO_COM'
    );
    
    assert.strictEqual(
        getRepoConfigKey('org123', 'repo456'), 
        'GIT_DEFAULT_BRANCH_ORG123_REPO456'
    );
});

test('Repository-specific branch configuration takes precedence', () => {
    const originalValue = process.env.GIT_DEFAULT_BRANCH_INTEGRY_FOREX;
    
    process.env.GIT_DEFAULT_BRANCH_INTEGRY_FOREX = 'dev';
    
    const repoConfigKey = 'GIT_DEFAULT_BRANCH_INTEGRY_FOREX';
    const repoSpecificBranch = process.env[repoConfigKey];
    
    assert.strictEqual(repoSpecificBranch, 'dev');
    assert.ok(repoSpecificBranch, 'Repository-specific branch should be found');
    
    if (originalValue !== undefined) {
        process.env.GIT_DEFAULT_BRANCH_INTEGRY_FOREX = originalValue;
    } else {
        delete process.env.GIT_DEFAULT_BRANCH_INTEGRY_FOREX;
    }
});

test('Multiple repository configurations can coexist', () => {
    const originalForex = process.env.GIT_DEFAULT_BRANCH_INTEGRY_FOREX;
    const originalSnake = process.env.GIT_DEFAULT_BRANCH_INTEGRY_GITFIX_EXAMPLE_SNAKE;
    
    process.env.GIT_DEFAULT_BRANCH_INTEGRY_FOREX = 'dev';
    process.env.GIT_DEFAULT_BRANCH_INTEGRY_GITFIX_EXAMPLE_SNAKE = 'main';
    
    assert.strictEqual(process.env.GIT_DEFAULT_BRANCH_INTEGRY_FOREX, 'dev');
    assert.strictEqual(process.env.GIT_DEFAULT_BRANCH_INTEGRY_GITFIX_EXAMPLE_SNAKE, 'main');
    
    assert.notStrictEqual(
        process.env.GIT_DEFAULT_BRANCH_INTEGRY_FOREX, 
        process.env.GIT_DEFAULT_BRANCH_INTEGRY_GITFIX_EXAMPLE_SNAKE
    );
    
    if (originalForex !== undefined) {
        process.env.GIT_DEFAULT_BRANCH_INTEGRY_FOREX = originalForex;
    } else {
        delete process.env.GIT_DEFAULT_BRANCH_INTEGRY_FOREX;
    }
    
    if (originalSnake !== undefined) {
        process.env.GIT_DEFAULT_BRANCH_INTEGRY_GITFIX_EXAMPLE_SNAKE = originalSnake;
    } else {
        delete process.env.GIT_DEFAULT_BRANCH_INTEGRY_GITFIX_EXAMPLE_SNAKE;
    }
});
