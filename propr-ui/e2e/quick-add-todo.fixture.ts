/** The API answers behind the quick-add To-do form; returns the to-dos it was asked to create. */
import type { Page } from '@playwright/test';

export async function fixture(page: Page) {
  const submissions: unknown[] = [];
  await page.routeWebSocket('**/socket.io/**', socket => socket.close());
  await page.route('**/api/**', async route => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (pathname === '/api/repos/todos' && request.method() === 'POST') {
      const body = request.postDataJSON();
      submissions.push(body);
      return route.fulfill({ json: { ...body, todoId: `todo-${submissions.length}` } });
    }
    const responses: Record<string, unknown> = {
      '/api/auth/demo-mode': { demoMode: false },
      '/api/auth/user': { id: 'preview-user', login: 'operator', username: 'operator', displayName: 'Operator', email: null, avatarUrl: null, role: 'member', permissions: [], authorizationSource: 'local' },
      '/api/instance/catalog': { repositories: [
        { id: 'alpha', name: 'acme/alpha', enabled: true },
        { id: 'billing', name: 'acme/billing', enabled: true },
      ], agents: [] },
      '/api/repositories/indexing-status': { repositories: [] },
      '/api/user/repo-preferences': { preferences: {} },
      '/api/repos/todos/categories': { categories: [{ categoryId: 'bugs', name: 'Bugs', orderIndex: 0 }] },
      '/api/notifications': { notifications: [], unreadCount: 0, nextCursor: null },
      '/api/notifications/unread-count': { unreadCount: 0 },
      '/api/notifications/config': { push: { configured: false, vapidPublicKey: null } },
      '/api/notifications/preferences': { preferences: {}, quietHours: {}, badgeEnabled: false },
    };
    return route.fulfill(pathname in responses
      ? { json: responses[pathname] }
      : { status: 503, json: { error: 'Optional endpoint unavailable in to-do browser test' } });
  });
  return submissions;
}
