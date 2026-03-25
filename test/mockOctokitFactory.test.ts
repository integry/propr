import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createMockOctokit, resetMockOctokit, MockOctokit, MockOctokitWithPaginate } from './testHelpers.ts';

describe('createMockOctokit', () => {
    describe('basic usage', () => {
        test('should create a mock Octokit with request method', () => {
            const mockOctokit = createMockOctokit();

            assert.ok(mockOctokit.request, 'request method should exist');
            assert.ok(typeof mockOctokit.request === 'function', 'request should be a function');
        });

        test('should return { data: {} } by default', async () => {
            const mockOctokit = createMockOctokit();

            const result = await mockOctokit.request('GET /repos/{owner}/{repo}', { owner: 'test', repo: 'test' });

            assert.deepStrictEqual(result, { data: {} });
        });

        test('should track mock calls', async () => {
            const mockOctokit = createMockOctokit();

            await mockOctokit.request('POST /repos/{owner}/{repo}/issues', { owner: 'test', repo: 'test' });
            await mockOctokit.request('GET /repos/{owner}/{repo}/issues/1', { owner: 'test', repo: 'test' });

            assert.strictEqual(mockOctokit.request.mock.calls.length, 2);
            assert.strictEqual(mockOctokit.request.mock.calls[0].arguments[0], 'POST /repos/{owner}/{repo}/issues');
            assert.strictEqual(mockOctokit.request.mock.calls[1].arguments[0], 'GET /repos/{owner}/{repo}/issues/1');
        });
    });

    describe('custom request implementation', () => {
        test('should use custom requestImpl when provided', async () => {
            const mockOctokit = createMockOctokit({
                requestImpl: async (endpoint) => {
                    if (endpoint.includes('issues')) {
                        return { data: { number: 123, title: 'Test Issue' } };
                    }
                    return { data: { default: true } };
                }
            });

            const issueResult = await mockOctokit.request('GET /repos/{owner}/{repo}/issues/123', {});
            const otherResult = await mockOctokit.request('GET /repos/{owner}/{repo}', {});

            assert.deepStrictEqual(issueResult, { data: { number: 123, title: 'Test Issue' } });
            assert.deepStrictEqual(otherResult, { data: { default: true } });
        });

        test('should pass options to custom requestImpl', async () => {
            let capturedOptions: Record<string, unknown> | undefined;

            const mockOctokit = createMockOctokit({
                requestImpl: async (_endpoint, options) => {
                    capturedOptions = options;
                    return { data: {} };
                }
            });

            await mockOctokit.request('POST /repos/{owner}/{repo}/issues', {
                owner: 'testowner',
                repo: 'testrepo',
                title: 'Test Issue'
            });

            assert.deepStrictEqual(capturedOptions, {
                owner: 'testowner',
                repo: 'testrepo',
                title: 'Test Issue'
            });
        });
    });

    describe('with paginate support', () => {
        test('should include paginate method when withPaginate is true', () => {
            const mockOctokit = createMockOctokit({ withPaginate: true });

            assert.ok(mockOctokit.request, 'request method should exist');
            assert.ok(mockOctokit.paginate, 'paginate method should exist');
            assert.ok(typeof mockOctokit.paginate === 'function', 'paginate should be a function');
        });

        test('should return empty array by default for paginate', async () => {
            const mockOctokit = createMockOctokit({ withPaginate: true });

            const result = await mockOctokit.paginate('GET /repos/{owner}/{repo}/issues', {});

            assert.deepStrictEqual(result, []);
        });

        test('should use custom paginateImpl when provided', async () => {
            const mockOctokit = createMockOctokit({
                withPaginate: true,
                paginateImpl: async () => [
                    { id: 1, title: 'Issue 1' },
                    { id: 2, title: 'Issue 2' }
                ]
            });

            const result = await mockOctokit.paginate('GET /repos/{owner}/{repo}/issues', {});

            assert.deepStrictEqual(result, [
                { id: 1, title: 'Issue 1' },
                { id: 2, title: 'Issue 2' }
            ]);
        });

        test('should track paginate calls', async () => {
            const mockOctokit = createMockOctokit({ withPaginate: true });

            await mockOctokit.paginate('GET /repos/{owner}/{repo}/issues', { state: 'open' });

            assert.strictEqual(mockOctokit.paginate.mock.calls.length, 1);
            assert.strictEqual(mockOctokit.paginate.mock.calls[0].arguments[0], 'GET /repos/{owner}/{repo}/issues');
        });
    });

    describe('TypeScript type inference', () => {
        test('should return MockOctokit when withPaginate is false or undefined', () => {
            const mockOctokit1: MockOctokit = createMockOctokit();
            const mockOctokit2: MockOctokit = createMockOctokit({ withPaginate: false });

            assert.ok(mockOctokit1.request);
            assert.ok(mockOctokit2.request);
            // @ts-expect-error - paginate should not exist on MockOctokit
            assert.ok(!mockOctokit1.paginate);
        });

        test('should return MockOctokitWithPaginate when withPaginate is true', () => {
            const mockOctokit: MockOctokitWithPaginate = createMockOctokit({ withPaginate: true });

            assert.ok(mockOctokit.request);
            assert.ok(mockOctokit.paginate);
        });
    });
});

describe('resetMockOctokit', () => {
    test('should reset request mock calls', async () => {
        const mockOctokit = createMockOctokit();

        await mockOctokit.request('GET /test', {});
        await mockOctokit.request('POST /test', {});
        assert.strictEqual(mockOctokit.request.mock.calls.length, 2);

        resetMockOctokit(mockOctokit);

        assert.strictEqual(mockOctokit.request.mock.calls.length, 0);
    });

    test('should reset paginate mock calls when present', async () => {
        const mockOctokit = createMockOctokit({ withPaginate: true });

        await mockOctokit.request('GET /test', {});
        await mockOctokit.paginate('GET /test/list', {});
        assert.strictEqual(mockOctokit.request.mock.calls.length, 1);
        assert.strictEqual(mockOctokit.paginate.mock.calls.length, 1);

        resetMockOctokit(mockOctokit);

        assert.strictEqual(mockOctokit.request.mock.calls.length, 0);
        assert.strictEqual(mockOctokit.paginate.mock.calls.length, 0);
    });

    test('should work correctly in beforeEach pattern', async () => {
        const mockOctokit = createMockOctokit();

        // Simulate test 1
        await mockOctokit.request('GET /test1', {});
        assert.strictEqual(mockOctokit.request.mock.calls.length, 1);

        // Simulate beforeEach cleanup
        resetMockOctokit(mockOctokit);

        // Simulate test 2
        await mockOctokit.request('GET /test2', {});
        assert.strictEqual(mockOctokit.request.mock.calls.length, 1);
        assert.strictEqual(mockOctokit.request.mock.calls[0].arguments[0], 'GET /test2');
    });
});

describe('mockImplementation override', () => {
    test('should allow overriding mock implementation after creation', async () => {
        const mockOctokit = createMockOctokit();

        // Use default implementation
        let result = await mockOctokit.request('GET /test', {});
        assert.deepStrictEqual(result, { data: {} });

        // Override implementation
        mockOctokit.request.mock.mockImplementation(async () => ({
            data: { overridden: true }
        }));

        result = await mockOctokit.request('GET /test', {});
        assert.deepStrictEqual(result, { data: { overridden: true } });
    });

    test('should support conditional responses based on endpoint', async () => {
        const mockOctokit = createMockOctokit();

        mockOctokit.request.mock.mockImplementation(async (endpoint: string) => {
            if (endpoint.includes('git/ref')) {
                return { data: { object: { sha: 'sha123' } } };
            }
            if (endpoint.includes('pulls')) {
                return { data: { number: 42, url: 'https://github.com/owner/repo/pull/42' } };
            }
            return { data: {} };
        });

        const refResult = await mockOctokit.request('GET /repos/{owner}/{repo}/git/ref/heads/main', {});
        const prResult = await mockOctokit.request('POST /repos/{owner}/{repo}/pulls', {});

        assert.deepStrictEqual(refResult, { data: { object: { sha: 'sha123' } } });
        assert.deepStrictEqual(prResult, { data: { number: 42, url: 'https://github.com/owner/repo/pull/42' } });
    });
});
