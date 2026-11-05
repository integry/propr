import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import knex from 'knex';

/** Register ownership before setup can fail; release in reverse acquisition order.
 * A failed release must neither skip the remaining resources nor pass the test. */
export class ExtensionTestResources {
  private releases: Array<() => unknown | Promise<unknown>> = [];
  defer(release: () => unknown | Promise<unknown>) { this.releases.push(release); }
  async close() {
    const errors: unknown[] = [];
    for (const release of this.releases.splice(0).reverse()) {
      try { await release(); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, 'Extension fixture cleanup failed');
  }
  database() {
    const handles: Array<{ open: boolean }> = [];
    const database = knex({
      client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true,
      pool: { afterCreate(connection: { open: boolean }, done: (error: null, connection: unknown) => void) {
        handles.push(connection); done(null, connection);
      } },
    });
    const pool = database.client.pool;
    this.defer(async () => {
      await database.destroy();
      assert.ok(handles.every(handle => !handle.open), 'All native SQLite handles must be closed');
      assert.equal(pool.numUsed(), 0);
      assert.equal(pool.numFree(), 0);
    });
    return database;
  }
}
const scopes = new WeakMap<TestContext, ExtensionTestResources>();
export function extensionTestResources(t: TestContext): ExtensionTestResources {
  let scope = scopes.get(t);
  if (!scope) {
    scope = new ExtensionTestResources(); scopes.set(t, scope);
    t.after(() => scope!.close());
  }
  return scope;
}
