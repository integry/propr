import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateSessionSecret } from '../packages/shared/src/sessionSecret.js';
import { materializeSessionSecret } from '../packages/cli/src/commands/initStack.js';

test('session secret validation rejects missing, placeholder, and short values', () => {
  assert.match(validateSessionSecret(undefined) ?? '', /required/);
  assert.match(validateSessionSecret('your-session-secret-here') ?? '', /placeholder/);
  assert.match(validateSessionSecret('too-short') ?? '', /at least 32/);
});

test('session secret validation accepts generated-length values', () => {
  assert.equal(validateSessionSecret('a'.repeat(32)), undefined);
});

test('stack scaffolding replaces the example secret without changing other values', () => {
  const template = 'FRONTEND_URL=http://localhost:5173\nSESSION_SECRET=your-session-secret-here\n';
  const secret = '0123456789abcdef'.repeat(4);

  assert.equal(
    materializeSessionSecret(template, secret),
    `FRONTEND_URL=http://localhost:5173\nSESSION_SECRET=${secret}\n`,
  );
});

test('stack scaffolding fails if the template loses its session-secret entry', () => {
  assert.throws(
    () => materializeSessionSecret('FRONTEND_URL=http://localhost:5173\n', 'a'.repeat(32)),
    /does not define SESSION_SECRET/,
  );
});
