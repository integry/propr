import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { redactDesktopValue } from './secret-redaction';

describe('desktop secret boundary redaction', () => {
  it('redacts credentials, key material and paths, authorization, and environment assignments recursively', () => {
    const value = redactDesktopValue({
      tokenLine: 'token=ghp_1234567890abcdef',
      authorizationLine: 'Authorization: Bearer relay-credential-value',
      environment: 'GH_WEBHOOK_SECRET=webhook-value HOST_GH_PRIVATE_KEY=/home/me/github-app.pem',
      docker: 'HostConfig.Binds=["/mnt/runtime/propr-data:/var/lib/propr"] SAFE_MODE=development',
      key: '-----BEGIN PRIVATE KEY-----\nprivate-key-content\n-----END PRIVATE KEY-----',
      nested: new Error('failed at /home/me/keys/github-app.pem'),
    });
    const serialized = JSON.stringify(value);
    for (const secret of ['ghp_1234567890abcdef', 'relay-credential-value', 'webhook-value', '/home/me/github-app.pem', '/mnt/runtime/propr-data', 'development', 'private-key-content']) {
      assert.doesNotMatch(serialized, new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }
    assert.match(serialized, /REDACTED/);
  });

  it('supports exact contextual redaction for unstructured webhook secrets and private-key paths', () => {
    const secret = 'totally-arbitrary-webhook-value';
    const path = '/secure/custom-name.bin';
    const serialized = JSON.stringify(redactDesktopValue(new Error(`${secret} ${path}`), 0, [secret, path]));
    assert.doesNotMatch(serialized, /totally-arbitrary|custom-name/);
  });
});
