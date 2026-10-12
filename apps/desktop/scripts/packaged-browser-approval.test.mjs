import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createBrowserApproval } from './packaged-browser-approval.mjs';

const origin = 'http://127.0.0.2:41731';
const fixture = () => {
  const approval = createBrowserApproval(origin, '/api/desktop/pairings/fixture/browser');
  approval.reset();
  const request = (method, { url = approval.url(), headers = {}, body = '' } = {}) => {
    const result = {};
    const response = { writeHead: (status, headers) => Object.assign(result, { status, headers }), end: html => { result.html = html; } };
    result.handled = approval.handle({ method, url, headers }, response, body);
    return result;
  };
  const open = () => {
    const response = request('GET');
    assert.equal(response.status, 200);
    return response.headers['Set-Cookie'].split(';')[0];
  };
  return { approval, request, open };
};

test('browser GET remains pending; explicit same-origin form approval unlocks activation', () => {
  const f = fixture();
  assert.equal(f.approval.approved(), false);
  const cookie = f.open();
  assert.equal(f.approval.status(), 'pending');
  assert.equal(f.approval.approved(), false);
  assert.equal(f.request('POST', { headers: { origin, cookie }, body: 'decision=approve' }).status, 200);
  assert.equal(f.approval.approved(), true);
  assert.equal(f.approval.wrongAccount(), false);
  assert.equal(f.request('POST', { headers: { origin, cookie }, body: 'decision=approve' }).status, 409);
});

test('unopened, wrong-origin, missing-cookie, invalid and replayed approvals cannot unlock polling', () => {
  const f = fixture();
  assert.equal(f.request('POST', { headers: { origin, cookie: 'propr_fixture_approval=1' }, body: 'decision=approve' }).status, 403);
  const cookie = f.open();
  for (const headers of [{ origin }, { cookie }, { cookie, origin: 'https://github.com' }, { origin, cookie: 'wrong' }]) {
    assert.equal(f.request('POST', { headers, body: 'decision=approve' }).status, 403);
    assert.equal(f.approval.approved(), false);
  }
  for (const body of ['decision=bogus', 'decision=approve&decision=reject', 'decision=approve&token=unsafe']) {
    assert.equal(f.request('POST', { headers: { origin, cookie }, body }).status, 400);
    assert.equal(f.approval.approved(), false);
  }
  const staleUrl = f.approval.url();
  f.approval.reset();
  assert.equal(f.request('GET', { url: staleUrl }).status, 409);
  assert.equal(f.request('POST', { headers: { origin, cookie }, body: 'decision=approve' }).status, 403);
  assert.equal(f.approval.approved(), false);
});

for (const [decision, status] of [['reject', 'rejected'], ['expire', 'expired'], ['wrong-account', 'approved']]) {
  test(`explicit browser ${decision} preserves the terminal decision`, () => {
    const f = fixture();
    const cookie = f.open();
    assert.equal(f.request('POST', { headers: { origin, cookie }, body: `decision=${decision}` }).status, 200);
    assert.equal(f.approval.status(), status);
    assert.equal(f.approval.approved(), decision === 'wrong-account');
    assert.equal(f.approval.wrongAccount(), decision === 'wrong-account');
    f.approval.cancel();
    assert.equal(f.approval.approved(), false);
  });
}
