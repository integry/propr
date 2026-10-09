import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

/**
 * Instance access offers the matching trigger whitelist change after a user is
 * added or removed. With PROPR_CAPTURE_PREVIEWS set the offers are captured.
 */

const member = (githubUserId: string, githubUsername: string, role: 'admin' | 'member') => ({
  githubUserId, githubUsername, role, source: 'local', createdByUserId: '1042',
  createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z',
});

async function installFixture(page: Page, initialMembers: ReturnType<typeof member>[], whitelist: string[]): Promise<void> {
  let members = [...initialMembers];
  await page.routeWebSocket('**/socket.io/**', socket => socket.close());
  await page.route('**/api/**', async route => {
    const request = route.request();
    const { pathname } = new URL(request.url());
    if (pathname === '/api/admin/members' && request.method() === 'POST') {
      const added = member('3001', (request.postDataJSON() as { username: string }).username, 'member');
      members = [...members, added];
      return route.fulfill({ status: 201, json: { member: added } });
    }
    if (pathname.startsWith('/api/admin/members/') && request.method() === 'DELETE') {
      members = members.filter(entry => entry.githubUserId !== pathname.split('/').pop());
      return route.fulfill({ status: 204, body: '' });
    }
    const responses: Record<string, unknown> = {
      '/api/auth/demo-mode': { demoMode: false },
      '/api/auth/user': {
        id: '1042', login: 'preview', username: 'preview', displayName: 'Preview Operator',
        email: null, avatarUrl: null, role: 'admin',
        permissions: ['instance.manage_settings', 'instance.manage_members', 'instance.manage_agents'],
        authorizationSource: 'local',
      },
      '/api/admin/members': { members, bootstrapAdmins: [] },
      '/api/admin/role-audit': { entries: [] },
      '/api/config/settings': { github_user_whitelist: whitelist },
      '/api/notifications/unread-count': { unreadCount: 0 },
      '/api/notifications/config': { push: { configured: false, vapidPublicKey: null } },
    };
    if (pathname in responses) return route.fulfill({ json: responses[pathname] });
    return route.fulfill({ status: 503, json: { error: 'Unavailable in the access fixture' } });
  });
}

async function capture(page: Page, name: string): Promise<void> {
  if (!process.env.PROPR_CAPTURE_PREVIEWS) return;
  const directory = path.resolve('../.propr/previews');
  await mkdir(directory, { recursive: true });
  await page.screenshot({ animations: 'disabled', path: path.join(directory, `${name}.png`) });
}

test('offers a trigger whitelist addition after adding a user', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await installFixture(page, [member('1042', 'preview', 'admin')], ['preview']);
  await page.goto('/admin/members');

  await expect(page.getByRole('heading', { name: 'Assigned instance roles' })).toBeVisible();
  await page.getByPlaceholder('GitHub username').fill('octocat');
  await page.getByRole('button', { name: 'Add user' }).click();
  await expect(page.getByRole('status')).toContainText('@octocat is not on the trigger whitelist');
  await expect(page.getByRole('button', { name: 'Add to trigger whitelist' })).toBeVisible();
  await capture(page, 'access-add-whitelist-offer');
});

test('offers a trigger whitelist removal after removing a user', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await installFixture(page, [member('1042', 'preview', 'admin'), member('3001', 'octocat', 'member')], ['preview', 'octocat']);
  await page.goto('/admin/members');

  await expect(page.getByText('· on trigger whitelist').first()).toBeVisible();
  page.once('dialog', dialog => void dialog.accept());
  await page.getByRole('button', { name: 'Remove octocat' }).click();
  await expect(page.getByRole('status')).toContainText('@octocat is still on the trigger whitelist');
  await capture(page, 'access-remove-whitelist-offer');
});
