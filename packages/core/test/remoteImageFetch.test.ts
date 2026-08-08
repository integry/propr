import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { describe, test } from 'node:test';
import {
  collectBoundedBody,
  fetchRemoteImage,
  isGitHubAssetHost,
  isPublicRemoteAddress,
  redactRemoteUrl,
  type RemoteImageFetchDependencies,
} from '../src/services/remoteImageFetch.js';

const PUBLIC_ADDRESS = { address: '8.8.8.8', family: 4 as const };

function dependencies(
  request: RemoteImageFetchDependencies['request'],
  resolve: RemoteImageFetchDependencies['resolve'] = async () => [PUBLIC_ADDRESS],
): RemoteImageFetchDependencies {
  return { resolve, request };
}

describe('remote image fetching', () => {
  test('rejects private, local, metadata, mapped, and reserved destinations', () => {
    assert.equal(isPublicRemoteAddress('8.8.8.8'), true);
    assert.equal(isPublicRemoteAddress('2606:4700:4700::1111'), true);
    assert.equal(isPublicRemoteAddress('127.0.0.1'), false);
    assert.equal(isPublicRemoteAddress('10.1.2.3'), false);
    assert.equal(isPublicRemoteAddress('169.254.169.254'), false);
    assert.equal(isPublicRemoteAddress('192.0.2.1'), false);
    assert.equal(isPublicRemoteAddress('::1'), false);
    assert.equal(isPublicRemoteAddress('::2'), false);
    assert.equal(isPublicRemoteAddress('::ffff:7f00:1'), false);
    assert.equal(isPublicRemoteAddress('fc00::1'), false);
    assert.equal(isPublicRemoteAddress('3fff::1'), false);
    assert.equal(isPublicRemoteAddress('2001:5::1'), false);
    assert.equal(isPublicRemoteAddress('2001:3::1'), true);
    assert.equal(isPublicRemoteAddress('2001:20::1'), true);
  });

  test('rejects localhost and URL credentials before resolving or requesting', async () => {
    let touched = false;
    const deps = dependencies(async () => {
      touched = true;
      throw new Error('unexpected request');
    }, async () => {
      touched = true;
      return [PUBLIC_ADDRESS];
    });

    await assert.rejects(fetchRemoteImage('http://localhost/image.png', {}, deps), /local or invalid host/);
    await assert.rejects(fetchRemoteImage('http://metadata.internal/image.png', {}, deps), /local or invalid host/);
    await assert.rejects(fetchRemoteImage('https://user:pass@example.com/image.png', {}, deps), /must not include credentials/);
    assert.equal(touched, false);
  });

  test('rejects any DNS answer set containing a private destination', async () => {
    let requested = false;
    const deps = dependencies(async () => {
      requested = true;
      throw new Error('unexpected request');
    }, async () => [PUBLIC_ADDRESS, { address: '10.0.0.4', family: 4 }]);

    await assert.rejects(
      fetchRemoteImage('https://images.example/image.png', {}, deps),
      /private or reserved address/,
    );
    assert.equal(requested, false);
  });

  test('pins the request to a validated address and revalidates redirects', async () => {
    const requestedAddresses: string[] = [];
    const deps = dependencies(async (_url, address) => {
      requestedAddresses.push(address.address);
      return {
        statusCode: 302,
        headers: { location: 'http://169.254.169.254/latest/meta-data' },
        body: Buffer.alloc(0),
      };
    });

    await assert.rejects(
      fetchRemoteImage('https://images.example/image.png', {}, deps),
      /private or reserved address/,
    );
    assert.deepEqual(requestedAddresses, ['8.8.8.8']);
  });

  test('never forwards GitHub authorization to a non-GitHub redirect', async () => {
    const observedAuth: Array<string | undefined> = [];
    const deps = dependencies(async (url, _address, headers) => {
      observedAuth.push(headers.Authorization);
      if (url.hostname === 'private-user-images.githubusercontent.com') {
        return {
          statusCode: 302,
          headers: { location: 'https://cdn.example/image.png' },
          body: Buffer.alloc(0),
        };
      }
      return {
        statusCode: 200,
        headers: { 'content-type': 'image/png' },
        body: Buffer.from('image'),
      };
    });

    const result = await fetchRemoteImage(
      'https://private-user-images.githubusercontent.com/image.png',
      { authToken: 'secret' },
      deps,
    );
    assert.equal(result.toString(), 'image');
    assert.deepEqual(observedAuth, ['Bearer secret', undefined]);
  });

  test('never forwards GitHub authorization over HTTP after a redirect', async () => {
    const observedAuth: Array<string | undefined> = [];
    const deps = dependencies(async (url, _address, headers) => {
      observedAuth.push(headers.Authorization);
      if (url.hostname === 'images.example') {
        return {
          statusCode: 302,
          headers: { location: 'http://private-user-images.githubusercontent.com/image.png' },
          body: Buffer.alloc(0),
        };
      }
      return {
        statusCode: 200,
        headers: { 'content-type': 'image/png' },
        body: Buffer.from('image'),
      };
    });

    const result = await fetchRemoteImage(
      'https://images.example/image.png',
      { authToken: 'secret' },
      deps,
    );
    assert.equal(result.toString(), 'image');
    assert.deepEqual(observedAuth, [undefined, undefined]);
  });

  test('accepts only exact GitHub domains and strips signed query data from logs', () => {
    assert.equal(isGitHubAssetHost('github.com'), true);
    assert.equal(isGitHubAssetHost('private-user-images.githubusercontent.com'), true);
    assert.equal(isGitHubAssetHost('github.com.attacker.example'), false);
    assert.equal(isGitHubAssetHost('notgithubusercontent.com'), false);
    assert.equal(
      redactRemoteUrl(new URL('https://images.example/path.png?jwt=secret#fragment')),
      'https://images.example/path.png',
    );
  });

  test('rejects non-raster response types', async () => {
    const deps = dependencies(async () => ({
      statusCode: 200,
      headers: { 'content-type': 'image/svg+xml' },
      body: Buffer.from('<svg/>'),
    }));
    await assert.rejects(
      fetchRemoteImage('https://images.example/image.svg', {}, deps),
      /supported raster image/,
    );
  });

  test('bounds bodies using both declared and streamed byte counts', async () => {
    await assert.rejects(
      collectBoundedBody(Readable.from([Buffer.alloc(1)]), '101', 100),
      /100-byte limit/,
    );
    await assert.rejects(
      collectBoundedBody(Readable.from([Buffer.alloc(60), Buffer.alloc(41)]), undefined, 100),
      /100-byte limit/,
    );
    const body = await collectBoundedBody(Readable.from(['safe', Buffer.from('-image')]), '10', 10);
    assert.equal(body.toString(), 'safe-image');
  });

  test('stops after the configured redirect limit', async () => {
    let requestCount = 0;
    const deps = dependencies(async () => {
      requestCount += 1;
      return {
        statusCode: 302,
        headers: { location: `https://images.example/image-${requestCount}.png` },
        body: Buffer.alloc(0),
      };
    });
    await assert.rejects(
      fetchRemoteImage('https://images.example/image.png', { maxRedirects: 1 }, deps),
      /redirect limit/,
    );
    assert.equal(requestCount, 2);
  });

  test('can disable redirects entirely', async () => {
    const deps = dependencies(async () => ({
      statusCode: 302,
      headers: { location: 'https://images.example/next.png' },
      body: Buffer.alloc(0),
    }));
    await assert.rejects(
      fetchRemoteImage('https://images.example/image.png', { maxRedirects: 0 }, deps),
      /redirect limit/,
    );
  });

  test('applies one overall deadline to DNS and redirect work', async () => {
    const deps = dependencies(
      async () => { throw new Error('unexpected request'); },
      async () => await new Promise<never>(() => undefined),
    );
    await assert.rejects(
      fetchRemoteImage('https://images.example/image.png', { timeoutMs: 20 }, deps),
      /timed out/,
    );
  });
});
