import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';

import { closeConnection } from '../packages/core/src/db/connection.js';
import { parseBatchResponse } from '../packages/core/src/services/relevance/summaryMinerBatch.js';
import {
  normalizeSummaryPath,
  parseBatchDirectoryResponse,
  resolveExpectedSummaryPath
} from '../packages/core/src/services/relevance/summaryMinerDirectoryHelpers.js';

describe('summary miner path parsing', () => {
  after(async () => {
    await closeConnection();
  });

  test('normalizes Antigravity absolute workspace paths', () => {
    assert.equal(
      normalizeSummaryPath('/home/node/workspace/integry/agent-tank-website/packages/website'),
      'integry/agent-tank-website/packages/website'
    );
  });

  test('resolves absolute directory paths to expected canonical paths', () => {
    const parsed = parseBatchDirectoryResponse(
      JSON.stringify({
        summaries: [{
          path: '/home/node/workspace/integry/agent-tank-website/packages/website',
          summary: 'Contains the Agent Tank website package.'
        }]
      }),
      ['integry/agent-tank-website/packages/website']
    );

    assert.deepEqual(parsed, [{
      dirPath: 'integry/agent-tank-website/packages/website',
      summary: 'Contains the Agent Tank website package.'
    }]);
  });

  test('resolves file paths with repository prefixes back to batch-relative paths', () => {
    const parsed = parseBatchResponse(
      JSON.stringify({
        summaries: [{
          path: '/home/node/workspace/integry/agent-tank-website/packages/website/index.html',
          summary: 'Defines the website HTML shell.'
        }]
      }),
      ['packages/website/index.html']
    );

    assert.deepEqual(parsed, [{
      path: 'packages/website/index.html',
      summary: 'Defines the website HTML shell.'
    }]);
  });

  test('does not resolve ambiguous suffix-only paths', () => {
    assert.equal(
      resolveExpectedSummaryPath('/home/node/workspace/packages/website/index.html', [
        'apps/admin/packages/website/index.html',
        'apps/public/packages/website/index.html'
      ]),
      null
    );
  });
});
