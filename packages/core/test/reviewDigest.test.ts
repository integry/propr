import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildReviewDigest, createReviewRiskClassifier, REVIEW_DIGEST_MAX_RECORDED_FILES, type ReviewDigestChange } from '../src/workflow/reviewDigest.js';
import { renderReviewDigest, summarizeReviewDigest, REVIEW_DIGEST_MAX_LISTED_FILES } from '../src/workflow/reviewDigestMarkdown.js';
import { findAddedDependencies } from '../src/workflow/reviewDependencies.js';
import { collectReviewDigest } from '../src/workflow/reviewDigestCollect.js';
import type { RepositoryValidationResult } from '../src/workflow/repositoryValidationResult.js';

const change = (filePath: string, extra: Partial<ReviewDigestChange> = {}): ReviewDigestChange => ({ path: filePath, linesAdded: 1, linesRemoved: 0, ...extra });
const patch = (lines: string[]) => `diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,1 +1,1 @@\n${lines.join('\n')}`;

test('built-in tiers: structural files are high, docs and tests low, auth and payment paths high, the rest normal', () => {
    const { classify } = createReviewRiskClassifier();
    const expectations: Array<[string, string, string | undefined]> = [
        ['.github/workflows/ci.yml', 'high', 'ci_workflow'],
        ['.gitlab-ci.yml', 'high', 'ci_workflow'],
        ['ci/Jenkinsfile', 'high', 'ci_workflow'],
        ['.propr/workflow.yml', 'high', 'propr_configuration'],
        ['.propr', 'high', 'propr_configuration'],
        ['CLAUDE.md', 'high', 'agent_configuration'],
        ['packages/api/AGENTS.md', 'high', 'agent_configuration'],
        ['.claude/settings.json', 'high', 'agent_configuration'],
        ['.github/copilot-instructions.md', 'high', 'agent_configuration'],
        ['package-lock.json', 'high', 'lockfile'],
        ['go.sum', 'high', 'lockfile'],
        ['packages/web/package.json', 'high', 'dependency_manifest'],
        ['requirements-dev.txt', 'high', 'dependency_manifest'],
        ['Cargo.toml', 'high', 'dependency_manifest'],
        ['packages/core/src/db/migrations/0073_add.ts', 'high', 'database_migration'],
        ['db/migrate/20260101_create_users.rb', 'high', 'database_migration'],
        ['src/auth/session.ts', 'high', 'auth_path'],
        ['src/services/authService.ts', 'high', 'auth_path'],
        ['src/authorization.ts', 'high', 'auth_path'],
        ['src/billing/invoice.ts', 'high', 'payment_path'],
        ['src/stripeWebhook.ts', 'high', 'payment_path'],
        ['docs/guide.md', 'low', 'documentation'],
        ['README.md', 'low', 'documentation'],
        ['test/login.test.ts', 'low', 'test'],
        ['src/__tests__/auth.ts', 'low', 'test'],
        ['pkg/server_test.go', 'low', 'test'],
        ['src/index.ts', 'normal', undefined],
        ['src/authorName.ts', 'normal', undefined],
        ['src/tokenCalculation.ts', 'normal', undefined],
    ];
    for (const [filePath, tier, reason] of expectations) assert.deepEqual(classify(filePath), { tier, ...(reason && { reason }) }, filePath);
});

test('review.risk_paths marks more paths high and wins over the low tiers, using the protected_paths matcher', () => {
    const { classify } = createReviewRiskClassifier({ risk_paths: ['src/payments-core', 'docs/security/**', '**/*.sql'] });
    assert.deepEqual(classify('src/payments-core/ledger.ts'), { tier: 'high', reason: 'review_risk_paths' });
    // Directory patterns cover descendants and matching is case-insensitive, as for protected_paths.
    assert.deepEqual(classify('SRC/Payments-Core/x.ts'), { tier: 'high', reason: 'review_risk_paths' });
    assert.deepEqual(classify('docs/security/threat-model.md'), { tier: 'high', reason: 'review_risk_paths' });
    assert.deepEqual(classify('schema/seed.sql'), { tier: 'high', reason: 'review_risk_paths' });
    assert.deepEqual(classify('docs/other.md'), { tier: 'low', reason: 'documentation' });
});

test('buildReviewDigest returns null without a diff, so the section is omitted', () => {
    assert.equal(buildReviewDigest([], undefined), null);
    assert.equal(buildReviewDigest(null, undefined), null);
    assert.equal(renderReviewDigest(null), '');
    assert.equal(renderReviewDigest(buildReviewDigest([], { commands: [{ index: 0, command: 'npm test', status: 'passed', verified: true }], overall: 'passed' })), '');
});

test('the digest renders risk tiers, then validation evidence, then diff size, with no diff content', () => {
    const validation: RepositoryValidationResult = {
        overall: 'failed',
        commands: [
            { index: 0, command: 'npm test', status: 'passed', verified: true },
            { index: 1, command: 'npm run lint', status: 'failed', exitCode: 2, verified: true },
        ],
    };
    const digest = buildReviewDigest([
        change('src/index.ts', { linesAdded: 10, linesRemoved: 2, diff: patch(['+const SECRET_DIFF_LINE = 1;']) }),
        change('docs/guide.md', { linesAdded: 4, status: 'added' }),
        change('.github/workflows/ci.yml', { linesAdded: 3, linesRemoved: 1 }),
        change('package.json', { linesAdded: 2, linesRemoved: 1, diff: patch([' "dependencies": {', '+  "zod": "^3.23.0",', '-  "react": "^18.2.0",', '+  "react": "^18.3.0",', ' }']) }),
    ], validation)!;
    assert.deepEqual(digest.size, { files: 4, linesAdded: 19, linesRemoved: 4 });
    assert.deepEqual(digest.newDependencies, { count: 1, entries: [{ name: 'zod', manifest: 'package.json' }] });
    assert.equal(digest.validation, validation);
    assert.deepEqual(digest.tiers.high.files.map(file => [file.path, file.reason]), [['.github/workflows/ci.yml', 'ci_workflow'], ['package.json', 'dependency_manifest']]);

    const markdown = renderReviewDigest(digest);
    assert.equal(markdown, [
        '### Review digest',
        '',
        '**Risk-tiered paths**',
        '',
        '- **High risk** (2 files)',
        '  - `.github/workflows/ci.yml` (+3/−1): CI or workflow file',
        '  - `package.json` (+2/−1): dependency manifest',
        '- **Normal risk** (1 file)',
        '  - `src/index.ts` (+10/−2)',
        '- **Low risk** (1 file)',
        '  - `docs/guide.md` (added, +4/−0)',
        '',
        '**New dependencies** (1): `zod` in `package.json`',
        '',
        '**Validation evidence** (failed)',
        '',
        '- [1] `npm test`: Passed',
        '- [2] `npm run lint`: Failed (exit 2)',
        '',
        '**Diff size:** 4 files changed, +19/−4 lines',
    ].join('\n') + '\n\n');
    assert.ok(!markdown.includes('SECRET_DIFF_LINE'));
    assert.ok(!JSON.stringify(digest).includes('SECRET_DIFF_LINE'), 'the structured digest keeps no diff content either');
    assert.equal(summarizeReviewDigest(digest), 'Review digest: 4 files (+19/−4): 2 high, 1 normal, 1 low risk; 1 new dependency; validation failed');
});

test('without validation commands the evidence says so; empty tiers read none', () => {
    const markdown = renderReviewDigest(buildReviewDigest([change('src/a.ts')], undefined));
    assert.match(markdown, /- \*\*High risk\*\*: none\n- \*\*Normal risk\*\* \(1 file\)\n {2}- `src\/a\.ts` \(\+1\/−0\)\n- \*\*Low risk\*\*: none/);
    assert.match(markdown, /\*\*Validation evidence\*\*\n\n- No repository validation commands ran\./);
});

test('file lists are capped like files_changed; the structured value keeps counts and a bounded list', () => {
    const changes = [
        ...Array.from({ length: 30 }, (_, index) => change(`migrations/${String(index).padStart(3, '0')}.sql`)),
        ...Array.from({ length: 250 }, (_, index) => change(`src/file${String(index).padStart(3, '0')}.ts`)),
        ...Array.from({ length: 5 }, (_, index) => change(`docs/${index}.md`)),
    ];
    const digest = buildReviewDigest(changes, undefined)!;
    assert.equal(digest.tiers.normal.count, 250);
    assert.equal(digest.tiers.normal.files.length, REVIEW_DIGEST_MAX_RECORDED_FILES);
    const markdown = renderReviewDigest(digest);
    const listed = markdown.split('\n').filter(line => /^ {2}- `/.test(line));
    assert.equal(listed.length, REVIEW_DIGEST_MAX_LISTED_FILES);
    assert.match(markdown, /- \*\*High risk\*\* \(30 files\)/);
    assert.match(markdown, /- \*\*Normal risk\*\* \(250 files\)\n(?: {2}- `src\/file\d+\.ts` \(\+1\/−0\)\n){20} {2}- …and 230 more\n/);
    assert.match(markdown, /- \*\*Low risk\*\* \(5 files\)\n {2}- …and 5 more\n/);
    assert.match(markdown, /\*\*Diff size:\*\* 285 files changed/);
});

test('paths and names cannot break out of their code spans or inject HTML', () => {
    const markdown = renderReviewDigest(buildReviewDigest([
        change('src/a`b``c.ts'), change('src/<img src=x onerror=alert(1)>.ts'), change('docs/line\nbreak.md'),
        change('package.json', { diff: patch([' "devDependencies": {', '+  "<script>": "1.0.0",', ' }']) }),
    ], undefined));
    assert.ok(markdown.includes('```src/a`b``c.ts```'), markdown);
    assert.ok(markdown.includes('`src/<img src=x onerror=alert(1)>.ts`'));
    assert.ok(markdown.includes('`docs/line break.md`'));
    assert.ok(markdown.includes('`<script>` in `package.json`'));
    for (const line of markdown.split('\n')) {
        // Every `<` is inside a code span: strip spans and nothing tag-like is left.
        assert.ok(!/<[A-Za-z]/.test(line.replace(/(`+)[\s\S]*?\1/g, '')), line);
    }
});

test('secrets in paths are redacted', () => {
    const token = `ghp_${'a'.repeat(36)}`;
    const digest = buildReviewDigest([change(`src/${token}.ts`)], undefined)!;
    assert.ok(!JSON.stringify(digest).includes(token));
    assert.ok(!renderReviewDigest(digest).includes(token));
});

test('findAddedDependencies reads package.json blocks and ignores bumps, scripts and top-level fields', () => {
    assert.deepEqual(findAddedDependencies({ path: 'package.json', diff: patch([
        ' {', '   "name": "app",', '-  "version": "1.0.0",', '+  "version": "1.1.0",', '   "scripts": {', '+    "lint": "eslint .",', '   },',
        '   "dependencies": {', '+    "zod": "^3.23.0",', '-    "express": "^4.18.0",', '+    "express": "^4.19.0",', '   },',
        '   "devDependencies": {', '+    "@types/node": "^22.0.0",', '+    "vitest": "workspace:*"', '   }', ' }',
    ]) }), ['zod', '@types/node', 'vitest']);
    // A hunk that starts inside an unknown block accepts only version-like values.
    assert.deepEqual(findAddedDependencies({ path: 'web/package.json', diff: patch(['     "left-pad": "1.3.0",', '+    "lodash": "^4.17.21",', '+    "build": "vite build",', '     "zod": "3.0.0"']) }), ['lodash']);
    // A moved entry is not new.
    assert.deepEqual(findAddedDependencies({ path: 'package.json', diff: `${patch([' "dependencies": {', '-  "a": "1.0.0",', ' }'])}\n@@ -9,1 +9,1 @@\n "devDependencies": {\n+  "a": "1.0.0",\n }` }), []);
    assert.deepEqual(findAddedDependencies({ path: 'src/index.ts', diff: patch(['+  "zod": "^3.0.0",']) }), []);
    assert.deepEqual(findAddedDependencies({ path: 'package.json', status: 'deleted', diff: patch([' "dependencies": {', '-  "zod": "1"', ' }']) }), []);
});

test('findAddedDependencies reads the other common manifest formats', () => {
    const cases: Array<[string, string[], string[]]> = [
        ['requirements.txt', ['+requests>=2.31', '+# comment', '+-r base.txt', '+uvicorn[standard]==0.30', '-flask==2.0', '+flask==3.0', '+numpy'], ['requests', 'uvicorn', 'numpy']],
        ['pyproject.toml', ['[project]', 'name = "app"', '+version = "2.0"', 'dependencies = [', '+  "httpx>=0.27",', '   "pydantic",', ']', '[project.optional-dependencies]', '+dev = ["pytest>=8", "ruff"]', '[tool.poetry.dependencies]', '+python = "^3.12"', '+rich = "^13"'], ['httpx', 'pytest', 'ruff', 'rich']],
        ['Cargo.toml', ['[package]', '+version = "0.2.0"', '[dependencies]', '+serde = { version = "1", features = ["derive"] }', '+[dependencies.tokio]', '+version = "1"', '[dev-dependencies]', '+insta = "1"'], ['serde', 'tokio', 'insta']],
        ['go.mod', ['require (', '+\tgithub.com/spf13/cobra v1.8.0', '\tgolang.org/x/mod v0.17.0', ')', 'replace (', '+\tgithub.com/a/b v1.0.0 => ../b', ')', '+require github.com/stretchr/testify v1.9.0'], ['github.com/spf13/cobra', 'github.com/stretchr/testify']],
        ['Gemfile', ['+gem "rails", "~> 7.1"', "+  gem 'pry'", '+# gem "commented"'], ['rails', 'pry']],
        ['app/build.gradle.kts', ['+    implementation("com.squareup.okhttp3:okhttp:4.12.0")', '+    testImplementation \'junit:junit:4.13\''], ['com.squareup.okhttp3:okhttp', 'junit:junit']],
        ['pom.xml', ['+    <dependency>', '+      <groupId>org.slf4j</groupId>', '+      <artifactId>slf4j-api</artifactId>', '+    </dependency>', '   <artifactId>my-app</artifactId>'], ['org.slf4j:slf4j-api']],
        ['src/App.csproj', ['+    <PackageReference Include="Newtonsoft.Json" Version="13.0.3" />'], ['Newtonsoft.Json']],
        ['pubspec.yaml', ['dependencies:', '+  http: ^1.2.0', '   flutter:', '+    sdk: flutter', 'flutter:', '+  uses-material-design: true'], ['http']],
    ];
    for (const [file, lines, expected] of cases) assert.deepEqual(findAddedDependencies({ path: file, diff: patch(lines.map(line => /^[+-]/.test(line) ? line : ` ${line}`)) }), expected, file);
});

test('collectReviewDigest reads the run diff from a real worktree', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'review-digest-'));
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: directory, encoding: 'utf8' }).trim();
    try {
        git('init', '-q');
        await writeFile(path.join(directory, 'package.json'), '{\n  "name": "app",\n  "dependencies": {\n    "react": "^18.2.0"\n  }\n}\n');
        await writeFile(path.join(directory, 'index.js'), 'console.log(1);\n');
        git('add', '.');
        git('commit', '-qm', 'base');
        const base = git('rev-parse', 'HEAD');
        await writeFile(path.join(directory, 'package.json'), '{\n  "name": "app",\n  "dependencies": {\n    "react": "^18.3.0",\n    "zod": "^3.23.0"\n  }\n}\n');
        await writeFile(path.join(directory, 'index.js'), 'console.log(2);\nconsole.log(3);\n');
        await mkdir(path.join(directory, '.github/workflows'), { recursive: true });
        await writeFile(path.join(directory, '.github/workflows/ci.yml'), 'on: push\n');
        git('add', '.');
        git('commit', '-qm', 'change');
        const commit = git('rev-parse', 'HEAD');
        const fromBase = await collectReviewDigest({ worktreePath: directory, comparisonRef: base, review: { risk_paths: ['index.js'] } });
        const fromCommit = await collectReviewDigest({ worktreePath: directory, commitHash: commit });
        for (const digest of [fromBase, fromCommit]) {
            assert.ok(digest);
            assert.deepEqual(digest.size, { files: 3, linesAdded: 5, linesRemoved: 2 });
            assert.deepEqual(digest.newDependencies.entries, [{ name: 'zod', manifest: 'package.json' }]);
        }
        assert.deepEqual(fromBase!.tiers.high.files.map(file => file.reason), ['ci_workflow', 'review_risk_paths', 'dependency_manifest']);
        assert.equal(await collectReviewDigest({ worktreePath: directory, comparisonRef: commit }), null, 'no diff, no digest');
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});
