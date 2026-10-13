// Fixture only: never imported by the production authentication path.
// Exercise keyboard modality and the real tab order before checking :focus-visible.
export const focusPairingControlWithKeyboard = async control => {
  await control.waitFor({ state: 'visible' });
  // At 200% zoom the installed sign-in control can start below the viewport.
  // Bring it into view before exercising keyboard modality and tab order.
  await control.scrollIntoViewIfNeeded();
  for (let tabs = 0; tabs < 40; tabs += 1) {
    await control.page().keyboard.press('Tab');
    if (await control.evaluate(element => element === document.activeElement)) return;
  }
  throw new Error('Pairing control is not keyboard reachable');
};

export const createBrowserApproval = (origin, path) => {
  let generation = 0;
  let nextLifetime = 60_000;
  let lifetime = 60_000;
  let state = 'absent';
  let opened = false;
  let wrongAccount = false;
  const reset = () => { lifetime = nextLifetime; nextLifetime = 60_000; generation++; state = 'pending'; opened = false; wrongAccount = false; };
  const url = () => `${origin}${path}?attempt=${generation}`;
  const handle = (request, response, bodyText) => {
    const target = new URL(request.url, origin);
    if (target.pathname !== path) return false;
    const finish = (status, text, headers = {}) => {
      response.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'", ...headers });
      response.end(text);
      return true;
    };
    if (state !== 'pending' || target.search !== `?attempt=${generation}`) return finish(409, 'Approval unavailable');
    if (request.method === 'GET') {
      opened = true;
      return finish(200, `<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Approve desktop pairing</title>
<style>body{font:18px sans-serif;max-width:32rem;margin:2rem;padding:1rem}button{font:inherit;padding:1rem;margin:.5rem}button:focus-visible{outline:4px solid #163db3}p{overflow-wrap:anywhere}</style>
<h1>Approve desktop pairing</h1><p>Local acceptance instance</p><p>Account: @acceptance-admin</p>
<form method="post"><button name="decision" value="approve">Approve @acceptance-admin</button><button name="decision" value="reject">Reject</button><button name="decision" value="expire">Expire request</button><button name="decision" value="wrong-account">Approve @other-admin</button></form></html>`,
        { 'Set-Cookie': `propr_fixture_approval=${generation}; HttpOnly; SameSite=Strict; Path=${path}` });
    }
    if (request.method !== 'POST' || !opened || request.headers.origin !== origin
      || request.headers.cookie !== `propr_fixture_approval=${generation}`) return finish(403, 'Approval denied');
    const values = new URLSearchParams(bodyText);
    const decision = values.get('decision');
    if ([...values.keys()].join(',') !== 'decision' || !['approve', 'reject', 'expire', 'wrong-account'].includes(decision)) return finish(400, 'Invalid decision');
    wrongAccount = decision === 'wrong-account';
    state = decision === 'reject' ? 'rejected' : decision === 'expire' ? 'expired' : 'approved';
    return finish(200, '<!doctype html><html lang="en"><title>Approval complete</title><h1>Approval complete</h1></html>');
  };
  return { reset, url, handle, lifetime: () => lifetime,
    setNextLifetime: milliseconds => {
      if (!Number.isInteger(milliseconds) || milliseconds < 100 || milliseconds > 60_000) throw new Error('Invalid fixture pairing lifetime');
      nextLifetime = milliseconds;
    }, status: () => state, wrongAccount: () => wrongAccount,
    cancel: () => { state = 'cancelled'; }, approved: () => opened && state === 'approved' };
};
