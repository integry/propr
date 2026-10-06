import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    decideAutoMerge, describeAutoMergeDecision, findProtectedPaths, validateAutoMergeConfig,
    type AutoMergePolicyInput, type AutoMergeReason,
} from '../src/workflow/autoMergePolicy.js';
import { parseRepositoryWorkflow, RepositoryWorkflowPolicyError } from '../src/workflow/repositoryWorkflow.js';

const context = { opportunity: 'initial_pr' as const };
const valid = (config?: Record<string, unknown>): AutoMergePolicyInput => ({ status: 'valid', config });
const protectedConfig = { protected_paths: ['.github/workflows/**', 'packages/core/src/db/migrations/**', 'package.json'] };

const cases: Array<{ name: string; policy: AutoMergePolicyInput; files: string[] | null; reason: AutoMergeReason; matched?: string[] }> = [
    { name: 'no policy file arms', policy: valid(), files: ['src/a.ts'], reason: 'armed' },
    { name: 'enabled policy without matches arms', policy: valid({ enabled: true, ...protectedConfig }), files: ['src/a.ts', 'docs/x.md'], reason: 'armed' },
    { name: 'disabled policy never arms', policy: valid({ enabled: false }), files: ['src/a.ts'], reason: 'skipped_disabled' },
    { name: 'invalid policy never arms', policy: { status: 'invalid', error: 'bad yaml' }, files: ['src/a.ts'], reason: 'skipped_policy_invalid' },
    { name: 'unknown method is an invalid policy', policy: valid({ method: 'fast-forward' }), files: ['src/a.ts'], reason: 'skipped_policy_invalid' },
    { name: 'unknown field is an invalid policy', policy: valid({ protect: ['x'] }), files: ['src/a.ts'], reason: 'skipped_policy_invalid' },
    { name: 'non-string glob is an invalid policy', policy: valid({ protected_paths: [42] }), files: ['src/a.ts'], reason: 'skipped_policy_invalid' },
    { name: 'unavailable diff never arms', policy: valid(), files: null, reason: 'skipped_diff_unavailable' },
    { name: 'empty diff never arms', policy: valid(), files: [], reason: 'skipped_empty_diff' },
    { name: 'blank paths count as an empty diff', policy: valid(), files: ['', '  '], reason: 'skipped_empty_diff' },
    { name: 'workflow file is protected', policy: valid(protectedConfig), files: ['src/a.ts', '.github/workflows/ci.yml'], reason: 'skipped_protected_path', matched: ['.github/workflows/ci.yml'] },
    { name: 'nested migration is protected', policy: valid(protectedConfig), files: ['packages/core/src/db/migrations/2026/01_add.ts'], reason: 'skipped_protected_path', matched: ['packages/core/src/db/migrations/2026/01_add.ts'] },
    { name: 'root package.json is protected', policy: valid(protectedConfig), files: ['package.json'], reason: 'skipped_protected_path', matched: ['package.json'] },
    { name: 'nested package.json is not matched by a root pattern', policy: valid(protectedConfig), files: ['packages/core/package.json'], reason: 'armed' },
    { name: '**/ pattern matches at any depth', policy: valid({ protected_paths: ['**/package.json'] }), files: ['packages/core/package.json'], reason: 'skipped_protected_path', matched: ['packages/core/package.json'] },
    { name: 'matching is case-insensitive', policy: valid(protectedConfig), files: ['.GitHub/Workflows/CI.yml', 'Package.JSON'], reason: 'skipped_protected_path', matched: ['.GitHub/Workflows/CI.yml', 'Package.JSON'] },
    { name: '* matches dotfiles', policy: valid({ protected_paths: ['config/*'] }), files: ['config/.env'], reason: 'skipped_protected_path', matched: ['config/.env'] },
    { name: '* stays within a segment', policy: valid({ protected_paths: ['config/*.yml'] }), files: ['config/nested/a.yml'], reason: 'armed' },
    { name: 'directory pattern protects descendants', policy: valid({ protected_paths: ['infra/'] }), files: ['infra/terraform/main.tf'], reason: 'skipped_protected_path', matched: ['infra/terraform/main.tf'] },
    { name: 'repeated trailing slashes act as a directory pattern', policy: valid({ protected_paths: ['infra' + '/'.repeat(50_000)] }), files: ['infra/main.tf'], reason: 'skipped_protected_path', matched: ['infra/main.tf'] },
    { name: 'leading ./ in a pattern is ignored', policy: valid({ protected_paths: ['./secrets/**'] }), files: ['secrets/key.pem'], reason: 'skipped_protected_path', matched: ['secrets/key.pem'] },
    { name: 'prefix of a file name is not a directory match', policy: valid({ protected_paths: ['infra'] }), files: ['infrastructure.md'], reason: 'armed' },
    { name: 'character classes and ? match', policy: valid({ protected_paths: ['scripts/deploy-?.[sb]h'] }), files: ['scripts/deploy-1.sh'], reason: 'skipped_protected_path', matched: ['scripts/deploy-1.sh'] },
    { name: '.propr/** is always protected', policy: valid(), files: ['.propr/workflow.yml'], reason: 'skipped_protected_path', matched: ['.propr/workflow.yml'] },
    { name: '.propr/** is protected even with an explicit empty list', policy: valid({ protected_paths: [] }), files: ['src/a.ts', '.propr/nested/setup.sh'], reason: 'skipped_protected_path', matched: ['.propr/nested/setup.sh'] },
    { name: '.propr/** is protected regardless of case', policy: valid(), files: ['.PROPR/Workflow.yml'], reason: 'skipped_protected_path', matched: ['.PROPR/Workflow.yml'] },
    { name: 'a .propr-like sibling is not protected', policy: valid(), files: ['.proprc'], reason: 'armed' },
    { name: 'disabled wins over a missing diff', policy: valid({ enabled: false }), files: null, reason: 'skipped_disabled' },
];

for (const testCase of cases) {
    test(`decideAutoMerge: ${testCase.name}`, () => {
        const decision = decideAutoMerge(testCase.policy, testCase.files, context);
        assert.equal(decision.reason, testCase.reason);
        assert.equal(decision.arm, testCase.reason === 'armed');
        if (testCase.matched) assert.deepEqual(decision.matchedPaths, [...testCase.matched].sort());
        else assert.equal(decision.matchedPaths, undefined);
    });
}

test('decideAutoMerge returns the configured method only when armed', () => {
    assert.equal(decideAutoMerge(valid({ method: 'rebase' }), ['a.ts'], context).method, 'rebase');
    assert.equal(decideAutoMerge(valid(), ['a.ts'], context).method, undefined);
    assert.equal(decideAutoMerge(valid({ method: 'rebase' }), [], context).method, undefined);
});

test('findProtectedPaths deduplicates and sorts matches', () => {
    assert.deepEqual(findProtectedPaths(['b/.propr/x', '.propr/b', '.propr/a', '.propr/a'], ['b/**']), ['.propr/a', '.propr/b', 'b/.propr/x']);
});

test('workflow parser accepts the auto_merge block and rejects invalid values', () => {
    const config = parseRepositoryWorkflow('auto_merge:\n  enabled: true\n  method: squash\n  protected_paths:\n    - ".github/workflows/**"\n');
    assert.deepEqual(config.auto_merge, { enabled: true, method: 'squash', protected_paths: ['.github/workflows/**'] });
    for (const source of [
        'auto_merge: true', 'auto_merge:\n  enabled: "yes"', 'auto_merge:\n  method: fast', 'auto_merge:\n  protected_paths: "*.ts"',
        'auto_merge:\n  protected_paths: ["../x"]', 'auto_merge:\n  protected_paths: [""]', 'auto_merge:\n  extra: 1',
    ]) {
        assert.throws(() => parseRepositoryWorkflow(source), RepositoryWorkflowPolicyError, source);
    }
    assert.equal(validateAutoMergeConfig({ protected_paths: Array.from({ length: 201 }, (_, i) => `p${i}`) })?.includes('at most 200'), true);
});

test('skip explanations are one line and name the reason code and paths', () => {
    const message = describeAutoMergeDecision(decideAutoMerge(valid(), ['.propr/workflow.yml'], context));
    assert.equal(message.includes('\n'), false);
    assert.match(message, /skipped_protected_path/);
    assert.match(message, /`\.propr\/workflow\.yml`/);
    assert.match(message, /label stays in place/);
    const many = describeAutoMergeDecision(decideAutoMerge(valid(), Array.from({ length: 8 }, (_, i) => `.propr/${i}`), context));
    assert.match(many, /and 3 more/);
});
