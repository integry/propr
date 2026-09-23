import express, { type Express, type Request, type Response } from 'express';
import { Octokit } from '@octokit/core';
import { loadMonitoredReposRaw } from '@propr/core';
import { isUserWhitelisted } from '../userWhitelist.js';
import { resolveInstanceAuthorization } from '../authorization.js';
import { createAuthRequestRateLimiter } from '../requestRateLimits.js';
import { isDemoMode } from '../demoMode.js';
import type { GitHubUser } from '../authTypes.js';
import { McpOAuthProvider, type McpGrant, type PendingAuthorization } from './oauth.js';
import { loadMcpGrantActivity, MCP_ACCESS_LOG_RECENT_MS, type McpGrantActivity } from './accessLog.js';
import { MCP_SCOPES } from './config.js';
import { digest, secret } from './store.js';
import type { Artifact } from './toolsArtifacts.js';

const escape = (text: unknown): string => String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
type ConsentSession = Request['session'] & { mcpCsrf?: string };

// Static script: client names, scopes and repository names are only rendered as escaped HTML.
const consentScript = `
document.querySelectorAll('[data-selection-group]').forEach(group => {
  const checkboxes = Array.from(group.querySelectorAll('input[type="checkbox"]'));
  const editable = checkboxes.filter(checkbox => !checkbox.disabled);
  const controls = group.querySelector('.selection-tools');
  const count = group.querySelector('[role="status"]');
  const update = () => {
    count.textContent = checkboxes.filter(checkbox => checkbox.checked).length + ' of ' +
      checkboxes.length + ' ' + group.dataset.selectionGroup + ' selected';
  };
  controls.querySelectorAll('button').forEach(button => {
    button.disabled = editable.length === 0;
    button.addEventListener('click', () => {
      editable.forEach(checkbox => { checkbox.checked = button.dataset.selection === 'all'; });
      update();
    });
  });
  group.addEventListener('change', update);
  window.addEventListener('pageshow', update);
  update();
  controls.hidden = false;
});`;

function selectionControls(group: string): string {
  return `<div class="selection-tools" hidden><div><button type="button" class="secondary" data-selection="all" aria-label="Select all ${group}">Select all</button><button type="button" class="secondary" data-selection="clear" aria-label="Clear ${group}">Clear</button></div><small role="status" aria-live="polite" aria-atomic="true"></small></div>`;
}

// The ProPR wordmark and arrow are inlined as markup because the strict CSP on
// these pages (default-src 'none', no img-src) forbids fetching image assets.
const brandHeader = `<header class="brand"><svg width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden="true"><defs><linearGradient id="propr-arrow" x1="4" y1="20" x2="16" y2="4" gradientUnits="userSpaceOnUse"><stop stop-color="#24A3A3"/><stop offset="1" stop-color="#43D9A3"/></linearGradient></defs><circle cx="4" cy="20" r="1.7" fill="url(#propr-arrow)"/><path d="M4 20c7-1 9-7 10-14" stroke="url(#propr-arrow)" stroke-width="2.6" stroke-linecap="round"/><path d="M10 9.5 14 4.5l4 5" stroke="url(#propr-arrow)" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg><span class="brand-name">Pro<b>PR</b></span><small>Connected apps</small></header>`;

// Connected-apps rows follow the Studio list spec: full-bleed rows on a flat white
// surface, uppercase scope badges and monospace repository chips. There is no
// script on that page, so repository overflow uses a native <details> toggle.
const appsStyle = `body.flat{background:#fff}body.flat main{max-width:760px;margin:0 auto;padding:8px 0;border:0;border-radius:0;box-shadow:none}.apps{list-style:none;margin:24px 0 0;padding:0;border-top:1px solid #F1F5F9}.app{border-bottom:1px solid #F1F5F9;padding:16px 0;min-width:0}.app-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}.app-title{display:flex;align-items:center;gap:10px;min-width:0}.app-icon{display:flex;flex:none;align-items:center;justify-content:center;width:28px;height:28px;border-radius:4px;background:#F1F5F9;color:#475569}.app h2{margin:0;font-size:14px;line-height:28px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.app-body{padding-left:38px;min-width:0}.meta{display:flex;flex-wrap:wrap;gap:2px 6px;margin:2px 0 0;font-size:12px;color:#64748B}.meta-id{display:inline-flex;align-items:center;gap:4px;min-width:0;max-width:100%}.label{margin:12px 0 6px;font-size:10px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:#64748B}.chips{display:flex;flex-wrap:wrap;gap:6px;margin:0;padding:0;list-style:none;min-width:0}.chips li{min-width:0;max-width:100%}.scope{display:inline-block;text-transform:uppercase;font-size:10px;font-weight:700;line-height:16px;letter-spacing:.025em;color:#64748B;background:#F8FAFC;padding:2px 6px;border-radius:4px}.chip{display:inline-block;max-width:100%;box-sizing:border-box;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;vertical-align:middle;font:12px/16px ui-monospace,SFMono-Regular,Menlo,monospace;color:#1E293B;background:#F1F5F9;border:1px solid #E2E8F0;border-radius:2px;padding:2px 6px}.more{margin-top:6px}.more summary{display:inline-block;cursor:pointer;list-style:none;font-size:12px;font-weight:500;color:#64748B;padding:2px 6px;border-radius:4px}.more summary::-webkit-details-marker{display:none}.more summary:hover{background:#F8FAFC;color:#0F172A}.more summary:focus-visible{outline:3px solid #24A3A3;outline-offset:2px}.more .chips{margin-top:6px}.more[open] .collapsed,.more:not([open]) .expanded{display:none}.app-head form{flex:none;margin:0}.app-head .revoke{width:auto;margin:0;padding:4px 10px;font-size:12px;font-weight:500;background:#fff;color:#334155;border:1px solid #E2E8F0;border-radius:4px;transition:background-color .15s,border-color .15s,color .15s}.app-head .revoke:hover:not(:disabled){background:#FEF2F2;border-color:#FECACA;color:#DC2626}.app-head .revoke:focus-visible{outline:3px solid #EF4444;outline-offset:2px}.empty{padding:48px 0;text-align:center;color:#94A3B8;font-size:14px}@media(max-width:480px){body.flat{padding:12px 16px}.app-body{padding-left:0}}`;

export function renderMcpPage(title: string, body: string, nonce?: string, options: { flat?: boolean } = {}): string {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)} · ProPR</title><style${nonce ? ` nonce="${escape(nonce)}"` : ''}>body{font:16px/1.5 Inter,system-ui,-apple-system,"Segoe UI",sans-serif;background:#F8F9FA;color:#1F2937;margin:0;padding:24px}main{max-width:640px;margin:5vh auto;padding:32px;border:1px solid #E2E8F0;border-radius:8px;background:#fff;box-shadow:0 4px 6px -1px rgba(0,0,0,.1),0 2px 4px -2px rgba(0,0,0,.1)}.brand{display:flex;align-items:center;gap:10px;padding-bottom:16px;border-bottom:1px solid #E2E8F0}.brand-name{font-size:22px;font-weight:700;color:#1F2937;letter-spacing:-.02em}.brand-name b{color:#24A3A3;font-weight:700}.brand small{margin-left:auto}h1{font-size:24px;font-weight:600;color:#111827}h2{font-size:16px;font-weight:600;color:#111827}p,li{line-height:1.6;overflow-wrap:anywhere}p{color:#4B5563}label{display:block;padding:12px;border:1px solid #E2E8F0;border-radius:6px;margin:8px 0;color:#1F2937;overflow-wrap:anywhere}label:hover{background:#F8F9FA}input{margin-right:10px;accent-color:#1D8A8A}button,a{font:inherit}button{background:#1D8A8A;color:#fff;border:1px solid transparent;border-radius:6px;padding:12px 18px;margin:12px 12px 0 0;font-weight:500;cursor:pointer}button:hover:not(:disabled){background:#167575}a{color:#1D8A8A}.secondary{background:#fff;color:#374151;border-color:#D1D5DB}.secondary:hover:not(:disabled){background:#F8F9FA}small{color:#64748B}.selection-tools:not([hidden]){display:flex;flex-wrap:wrap;align-items:center;gap:8px 16px;margin-bottom:12px}.selection-tools button{width:auto;margin:0 8px 0 0;min-height:44px}.selection-tools small{display:block}button:disabled{opacity:.55;cursor:default}button:focus-visible,input:focus-visible{outline:3px solid #24A3A3;outline-offset:3px}article{border-top:1px solid #E2E8F0;margin-top:24px;padding-top:8px}@media(max-width:480px){body{padding:12px}main{margin:12px auto;padding:20px}button{width:100%}}${options.flat ? appsStyle : ''}</style>${options.flat ? '<body class="flat">' : ''}<main>${brandHeader}<h1>${escape(title)}</h1>${body}</main></html>`;
}

/** Repository chips shown before the rest collapse behind a "+ N more" toggle. */
export const REPOSITORY_PREVIEW_LIMIT = 10;
const scopeRank = new Map<string, number>(MCP_SCOPES.map((scope, index) => [scope, index]));

/** Canonical scope family order (docs/mcp.md); unknown scopes last, alphabetically. */
export function orderScopes(scopes: readonly string[]): string[] {
  return [...new Set(scopes)].sort((a, b) =>
    (scopeRank.get(a) ?? MCP_SCOPES.length) - (scopeRank.get(b) ?? MCP_SCOPES.length) || a.localeCompare(b));
}

export function relativeTime(timestamp: number, now = Date.now()): string {
  const minutes = Math.floor((now - timestamp) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(timestamp).toISOString().slice(0, 10);
}

// Generic app glyph (Lucide "bot"); inlined because the page CSP forbids images.
const appIcon = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/></svg>';
const chipList = (repositories: readonly string[]): string =>
  `<ul class="chips">${repositories.map(repo => `<li><span class="chip" title="${escape(repo)}">${escape(repo)}</span></li>`).join('')}</ul>`;

/** Hours behind the per-app request count, matching the access log's recent window. */
const RECENT_HOURS = Math.round(MCP_ACCESS_LOG_RECENT_MS / 3_600_000);

/** Activity is derived from the MCP access log; a grant with no rows has never been used. */
function activityMeta(activity?: McpGrantActivity): string {
  if (!activity?.lastSeenAt) return '<span aria-hidden="true">•</span><span>Never used</span>';
  const requests = activity.recentRequests;
  return `<span aria-hidden="true">•</span><span title="${new Date(activity.lastSeenAt).toISOString()}">Last used ${relativeTime(activity.lastSeenAt)}</span>`
    + `<span aria-hidden="true">•</span><span>${requests} ${requests === 1 ? 'request' : 'requests'} in the last ${RECENT_HOURS}h</span>`;
}

export function renderConnectedApp(grant: McpGrant, csrfField: string, activity?: McpGrantActivity): string {
  const seen = new Set<string>();
  const repositories = grant.repositories.filter(repo => !seen.has(repo.toLowerCase()) && !!seen.add(repo.toLowerCase()));
  const hidden = repositories.slice(REPOSITORY_PREVIEW_LIMIT);
  const connected = new Date(grant.createdAt).toISOString();
  return `<li class="app"><div class="app-head"><div class="app-title"><span class="app-icon">${appIcon}</span><h2 title="${escape(grant.clientName)}">${escape(grant.clientName)}</h2></div>`
    + `<form method="post" action="/mcp/apps/revoke">${csrfField}<input type="hidden" name="grant" value="${escape(grant.id)}"><button class="revoke" aria-label="Revoke access for ${escape(grant.clientName)} (ID: ${escape(grant.id)})">Revoke access</button></form></div>`
    + `<div class="app-body"><p class="meta"><span title="${connected}">Connected ${relativeTime(grant.createdAt)}</span>${activityMeta(activity)}<span aria-hidden="true">•</span><span class="meta-id">ID: <span class="chip" title="${escape(grant.id)}">${escape(grant.id)}</span></span></p>`
    + `<div role="group" aria-labelledby="scopes-${escape(grant.id)}"><p class="label" id="scopes-${escape(grant.id)}">Permissions</p><ul class="chips">${orderScopes(grant.scopes).map(scope => `<li><span class="scope">${escape(scope)}</span></li>`).join('')}</ul></div>`
    + `<div role="group" aria-labelledby="repos-${escape(grant.id)}"><p class="label" id="repos-${escape(grant.id)}">Repositories</p>${chipList(repositories.slice(0, REPOSITORY_PREVIEW_LIMIT))}`
    + (hidden.length ? `<details class="more"><summary><span class="collapsed">+ ${hidden.length} more ${hidden.length === 1 ? 'repository' : 'repositories'}</span><span class="expanded">Show fewer</span></summary>${chipList(hidden)}</details>` : '')
    + '</div></div></li>';
}

export function mountMcpBrowser(app: Express, oauth: McpOAuthProvider, overrides: { accessibleRepositories?: (user: GitHubUser) => Promise<string[]> } = {}): void {
  app.use('/mcp', createAuthRequestRateLimiter(), express.urlencoded({ extended: false, limit: '16kb' }), (req, res, next) => {
    res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'" });
    if (isDemoMode()) { res.status(403).send('MCP grants are disabled in demo mode.'); return; }
    if (!req.isAuthenticated() || !req.user?.accessToken) {
      res.redirect(`/api/auth/github?redirectTo=${encodeURIComponent(oauth.config.origin + req.originalUrl)}`); return;
    }
    if (!isUserWhitelisted(req.user.username)) { res.status(403).send('Instance access denied.'); return; }
    const session = req.session as ConsentSession;
    session.mcpCsrf ||= secret();
    if (req.method === 'POST' && (req.body.csrf !== session.mcpCsrf || req.get('origin') !== oauth.config.origin)) {
      res.status(403).send('Invalid consent request. Reload this page and try again.'); return;
    }
    next();
  });
  const csrf = (req: Request): string => `<input type="hidden" name="csrf" value="${escape((req.session as ConsentSession).mcpCsrf)}">`;

  async function repositories(req: Request): Promise<string[]> {
    if (overrides.accessibleRepositories) return overrides.accessibleRepositories(req.user!);
    const github = new Octokit({ auth: req.user!.accessToken, request: { timeout: 10000 } });
    const { data } = await github.request('GET /user');
    if (String(data.id) !== req.user!.id) throw new Error('GitHub identity mismatch');
    const configured = (await loadMonitoredReposRaw()).filter(repo => repo.enabled);
    const allowed: string[] = [];
    for (const repo of configured.slice(0, 100)) {
      const [owner, name] = repo.name.split('/');
      try { await github.request('GET /repos/{owner}/{repo}', { owner, repo: name }); allowed.push(repo.name); } catch { /* inaccessible repositories are not offered */ }
    }
    return allowed;
  }

  app.get('/mcp/consent', async (req, res) => {
    const id = typeof req.query.request === 'string' ? req.query.request : '';
    const pending = await oauth.store.get<PendingAuthorization>('pending', digest(id));
    if (!pending) { res.status(400).send(renderMcpPage('Request expired', '<p>Return to your chat client and connect again.</p>')); return; }
    const repos = await repositories(req);
    const nonce = secret();
    res.set('Content-Security-Policy', `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; form-action 'self' ${new URL(pending.params.redirectUri).origin}; frame-ancestors 'none'; base-uri 'none'`);
    res.type('html').send(renderMcpPage('Connect an app', `
      <p><strong>${escape(pending.client.client_name || pending.client.client_id)}</strong> wants access to this ProPR instance as <strong>${escape(req.user!.username)}</strong>.</p>
      <p>Instance: ${escape(oauth.config.instanceId)}</p>
      <p>Choose permissions below. Read is required; leave optional permissions unchecked for read-only access. Execute can start work; publish creates GitHub issues; merge can merge reviewed changes; manage changes instance configuration.</p>
      <p>Choose repositories. Access always remains limited by your current permissions. You can revoke this connection at any time.</p>
      <form method="post">${csrf(req)}<input type="hidden" name="request" value="${escape(id)}">
        <section role="group" aria-labelledby="permissions-heading" data-selection-group="permissions">
          <h2 id="permissions-heading">Permissions</h2>${selectionControls('permissions')}
          ${pending.params.scopes?.map(scope => `<label><input type="checkbox" name="scopes" value="${escape(scope)}"${scope === 'read' ? ' checked disabled' : ''}>${escape(scope)}${scope === 'read' ? ' (required)' : ''}</label>`).join('')}
          <input type="hidden" name="scopes" value="read">
          ${pending.params.scopes?.some(scope => scope !== 'read') ? '' : '<p><small>This app only requests required read access.</small></p>'}
        </section>
        <section role="group" aria-labelledby="repositories-heading" data-selection-group="repositories">
          <h2 id="repositories-heading">Repositories</h2>${selectionControls('repositories')}
          ${repos.map(repo => `<label><input type="checkbox" name="repositories" value="${escape(repo)}">${escape(repo)}</label>`).join('')}
          ${repos.length ? '' : '<p>No accessible repositories are available. At least one is required to allow access.</p>'}
        </section>
        <p><small>Return address: ${escape(pending.params.redirectUri)}</small></p>
        <button name="decision" value="approve"${repos.length ? '' : ' disabled'}>Allow selected access</button><button class="secondary" name="decision" value="deny">Deny</button>
      </form><script nonce="${nonce}">${consentScript}</script>`, nonce));
  });

  app.post('/mcp/consent', async (req, res) => {
    if (typeof req.body.request !== 'string') { res.status(400).send('Invalid request'); return; }
    if (!['approve', 'deny'].includes(req.body.decision)) { res.status(400).send('Choose allow or deny.'); return; }
    if (req.body.decision === 'deny') {
      const pending = await oauth.store.db.transaction(tx => oauth.store.take<PendingAuthorization>('pending', digest(req.body.request), tx));
      if (!pending) { res.status(400).send('Request expired'); return; }
      const url = new URL(pending.params.redirectUri); url.searchParams.set('error', 'access_denied');
      url.searchParams.set('iss', `${oauth.config.origin}/`);
      if (pending.params.state) url.searchParams.set('state', pending.params.state);
      res.set('Content-Security-Policy', `default-src 'none'; form-action 'self' ${url.origin}; frame-ancestors 'none'; base-uri 'none'`);
      res.redirect(url.href); return;
    }
    const selected = Array.isArray(req.body.repositories) ? req.body.repositories : [req.body.repositories].filter(Boolean);
    const allowed = await repositories(req);
    if (!selected.length || selected.some((repo: unknown) => typeof repo !== 'string' || !allowed.includes(repo))) { res.status(400).send('Select at least one accessible repository.'); return; }
    const authorization = await resolveInstanceAuthorization(req.user!, oauth.store.db);
    const selectedScopes = typeof req.body.scopes === 'string' ? [req.body.scopes] : req.body.scopes ?? [];
    let redirect: string;
    try { redirect = await oauth.approve(req.body.request, req.user!, [...new Set(selected)] as string[], { membershipSource: authorization.source, selectedScopes }); }
    catch { res.status(400).send('Request expired or invalid permission selection. Select only requested permissions, including read.'); return; }
    res.set('Content-Security-Policy', `default-src 'none'; form-action 'self' ${new URL(redirect).origin}; frame-ancestors 'none'; base-uri 'none'`);
    res.redirect(redirect);
  });

  app.get('/mcp/apps', async (req, res) => {
    const cursor = typeof req.query.after === 'string' ? req.query.after : '';
    const rows = await oauth.store.db('mcp_records').where({ kind: 'grant', owner_id: req.user!.id }).where('id', '>', cursor).orderBy('id').limit(51).select('id', 'value');
    const next = rows.length > 50 ? rows[49].id : null;
    rows.splice(50);
    const grants = rows.map(row => oauth.store.unseal<McpGrant>(row.value)).filter(grant => grant.ownerId === req.user!.id && !grant.revoked && grant.expiresAt > Date.now());
    const activity = await loadMcpGrantActivity(oauth.store.db, grants.map(grant => grant.id));
    res.type('html').send(renderMcpPage('Your connected apps', `<p>These apps can act with your ProPR permissions. Revoking an app immediately invalidates its access and refresh tokens.</p>${grants.length ? `<ul class="apps">${grants.map(grant => renderConnectedApp(grant, csrf(req), activity.get(grant.id))).join('')}</ul>` : '<p class="empty" role="status">No connected apps.</p>'}${next ? `<p><a href="/mcp/apps?after=${encodeURIComponent(next)}">Next page</a></p>` : ''}`, undefined, { flat: true }));
  });
  app.post('/mcp/apps/revoke', async (req: Request, res: Response) => {
    if (typeof req.body.grant === 'string') await oauth.revokeGrant(req.body.grant, req.user!.id);
    res.redirect('/mcp/apps');
  });
  app.get('/mcp/artifacts/:id', async (req, res) => {
    const artifact = await oauth.store.get<Artifact>('artifact', req.params.id);
    if (!artifact || artifact.ownerId !== req.user!.id || !(await repositories(req)).includes(artifact.repository)) { res.status(404).send('Artifact not found'); return; }
    const goal = artifact.parentKind === 'goal';
    if (!await oauth.store.db(goal ? 'goals' : 'task_drafts').where({ [goal ? 'goal_id' : 'draft_id']: artifact.parentId, [goal ? 'owner_id' : 'user_id']: req.user!.id }).first()) { res.status(404).send('Artifact parent not found'); return; }
    res.set({ 'Content-Type': artifact.mimeType, 'Content-Disposition': `attachment; filename="${artifact.filename}"`, 'X-Content-Type-Options': 'nosniff' }).send(Buffer.from(artifact.data, 'base64'));
  });
}
