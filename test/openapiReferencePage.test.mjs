import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const openapiDir = new URL('../docs/static/openapi/', import.meta.url);
const page = await readFile(new URL('index.html', openapiDir), 'utf8');
const scripts = [...page.matchAll(/<script\b([^>]*)>/g)].map(([, attributes]) => attributes);

test('the API reference page loads only the vendored renderer, with a matching SRI hash', async () => {
  const sources = scripts.map(attributes => attributes.match(/\bsrc="([^"]+)"/)?.[1]).filter(Boolean);
  assert.deepEqual(sources, ['/openapi/scalar/standalone.js'], 'no script may come from a CDN; the bundled docs work offline');
  const renderer = scripts.find(attributes => attributes.includes('/openapi/scalar/standalone.js'));
  const integrity = renderer.match(/\bintegrity="(sha384-[^"]+)"/)?.[1];
  assert.ok(integrity, 'the renderer keeps a pinned integrity hash');
  const vendored = await readFile(fileURLToPath(new URL('scalar/standalone.js', openapiDir)));
  assert.equal(integrity, `sha384-${createHash('sha384').update(vendored).digest('base64')}`,
    'update the integrity attribute in index.html after replacing scalar/standalone.js');
});

test('the vendored renderer notice names the version index.html refers to', async () => {
  const notice = await readFile(new URL('scalar/README.md', openapiDir), 'utf8');
  const version = page.match(/@scalar\/api-reference@(\d+\.\d+\.\d+)/)?.[1];
  assert.ok(version, 'index.html names the vendored Scalar version');
  assert.match(notice, new RegExp(`@scalar/api-reference@${version.replaceAll('.', '\\.')}`));
  const integrity = scripts.join(' ').match(/\bintegrity="(sha384-[^"]+)"/)[1];
  assert.ok(notice.includes(integrity), 'scalar/README.md records the current hash');
});

test('the spec the renderer loads is served next to it', () => {
  assert.match(page, /url: '\/openapi\/propr-api\.yaml'/);
  assert.match(page, /href="\/openapi\/propr-api\.yaml"/);
});
