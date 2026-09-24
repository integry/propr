/**
 * Tracks which transaction, and which savepoint inside it, each statement on a
 * SQLite connection was issued under.
 *
 * A pending statement retry belongs where its statement was issued. One whose
 * transaction ended while it was backing off has to be abandoned rather than
 * run outside that transaction, and one whose nested transaction (a knex
 * savepoint) was rolled back has to be abandoned too, since a replay would
 * restore a write the rollback undid and let the parent commit it. The scope
 * also has to match exactly: a parent's statement that resumes while a nested
 * transaction is open has to be held back until that savepoint closes, or the
 * nested rollback would take the parent's write with it.
 *
 * The driver reports whether a transaction is open, but not which savepoints
 * are, so the savepoint statements are parsed here as they succeed. Not every
 * savepoint bounds a nested transaction, either: a caller can issue one
 * directly, and SQLite keeps such a savepoint open after `ROLLBACK TO` — it
 * can be rolled back to again, so it goes on bounding a scope until it is
 * released. Only a savepoint knex opened for a nested transaction is over
 * once it is rolled back to, since knex never touches it again.
 */

/** Whitespace and comments, which SQLite allows between any two tokens. */
export const SQL_TRIVIA = String.raw`(?:\s|--[^\n]*|/\*[\s\S]*?\*/)`;

/** A savepoint name, bare or in any of the quoting forms SQLite accepts. */
const SAVEPOINT_NAME = String.raw`("[^"]*"|'[^']*'|\`[^\`]*\`|\[[^\]]*\]|[^\s;"'\`\[\]()]+)`;

/**
 * The three statements that move savepoints on a connection, in the forms
 * SQLite accepts: `SAVEPOINT name`, `RELEASE [SAVEPOINT] name` and
 * `ROLLBACK [TRANSACTION] TO [SAVEPOINT] name`. knex opens a nested transaction
 * with the first and ends it with one of the other two. Groups 1 to 3 tell the
 * three apart; group 4 is the name.
 */
const SAVEPOINT_STATEMENT = new RegExp(
    `^${SQL_TRIVIA}*(?:(savepoint)|(release)(?:${SQL_TRIVIA}+savepoint)?`
    + `|(rollback)(?:${SQL_TRIVIA}+transaction)?${SQL_TRIVIA}+to(?:${SQL_TRIVIA}+savepoint)?)`
    + `${SQL_TRIVIA}+${SAVEPOINT_NAME}`,
    'i'
);

type SqliteConnection = {
    inTransaction?: boolean;
    /** Set by knex to the id of the transaction driving the connection. */
    __knexTxId?: unknown;
};

export function isInTransaction(connection: unknown): boolean {
    return typeof connection === 'object'
        && connection !== null
        && (connection as SqliteConnection).inTransaction === true;
}

/**
 * The id of the knex transaction driving a connection, which knex writes onto
 * the connection before issuing any of that transaction's own statements and
 * uses as the name of a nested transaction's savepoint. Read it before the
 * statement runs: it identifies the transaction that issued the statement,
 * not whichever one owns the connection once the statement is done.
 */
export function knexTransactionId(connection: unknown): string | undefined {
    const id = typeof connection === 'object' && connection !== null
        ? (connection as SqliteConnection).__knexTxId
        : undefined;
    return typeof id === 'string' ? id : undefined;
}

interface TransactionState {
    open: boolean;
    /** Counts the transaction boundaries this connection has crossed. */
    epoch: number;
    /**
     * The savepoints open inside the transaction, outermost first. Each is
     * its own object because identity is what matters: a rollback to a
     * savepoint keeps its name on the stack but replaces the entry, so a
     * statement issued under the old entry is no longer owned by anything.
     * A savepoint SQLite keeps open after `ROLLBACK TO` can be rolled back
     * to again, so the replacement bounds a scope of its own — unless knex
     * opened the savepoint for a nested transaction. knex ends one with
     * `ROLLBACK TO` alone and never rolls back to that savepoint again, so
     * the replacement is marked as rolled back and the statements that
     * follow belong to the enclosing scope.
     */
    savepoints: Savepoint[];
}

interface Savepoint {
    name: string;
    /** Opened by knex for a nested transaction rather than by the caller. */
    nested?: boolean;
    /** The nested transaction ended with `ROLLBACK TO`; nothing is undone by it now. */
    rolledBack?: boolean;
}

/**
 * The transaction a statement was issued in: the connection's transaction, and
 * every savepoint that was open inside it at the time.
 */
export type TransactionOwner = Pick<TransactionState, 'epoch' | 'savepoints'>;

/**
 * What each connection's transaction state was the last time a statement ran on
 * it. A pending retry compares against this to tell the transaction it was
 * issued in from whatever owns the connection now.
 */
const transactionStates = new WeakMap<object, TransactionState>();

/**
 * Records a connection's transaction state and counts every boundary it
 * crosses.
 *
 * A transaction can only open or close on a statement, and every statement
 * passes through the patched `_query`, so this is called around each of them
 * rather than read on demand: a `ROLLBACK` followed by a `BEGIN` leaves the
 * connection looking exactly as it did before, and a retry that only looked
 * afterwards would take the new transaction for its own.
 */
export function observeTransaction(connection: unknown): TransactionState | undefined {
    if (typeof connection !== 'object' || connection === null) return undefined;
    const open = isInTransaction(connection);
    const seen = transactionStates.get(connection);
    if (!seen) {
        const first: TransactionState = { open, epoch: 0, savepoints: [] };
        transactionStates.set(connection, first);
        return first;
    }
    if (seen.open !== open) {
        seen.open = open;
        seen.epoch += 1;
        // COMMIT and ROLLBACK release every savepoint with the transaction.
        seen.savepoints = [];
    }
    return seen;
}

/** The name SQLite matches savepoints by: unquoted, case-insensitively. */
function savepointName(token: string): string {
    return token.replace(/^(["'`])([^]*)\1$|^\[([^]*)\]$/, '$2$3').toLowerCase();
}

/**
 * Records what a savepoint statement that succeeded did to the connection's
 * savepoints. The driver does not report those the way it reports whether a
 * transaction is open, and a statement that failed moved none of them.
 * `SAVEPOINT` pushes one; `RELEASE` pops the most recent one with that name
 * and everything above it; `ROLLBACK TO` does the same but leaves a fresh
 * entry in its place, since the writes made under the old one are gone.
 *
 * `issuedBy` is the knex transaction the statement was issued from, read
 * before it ran. A savepoint named after that transaction is the one knex
 * opened for it, which is what tells a nested transaction's savepoint from
 * one the caller issued: the first is over once it is rolled back to, the
 * second stays open until it is released.
 */
export function observeSavepoint(connection: unknown, sql: string, issuedBy?: string): void {
    const state = observeTransaction(connection);
    const moved = state && SAVEPOINT_STATEMENT.exec(sql);
    if (!state || !moved) return;
    const name = savepointName(moved[4]);
    const depth = moved[1] ? state.savepoints.length : state.savepoints.findLastIndex(s => s.name === name);
    if (depth < 0) return;
    const replaced = state.savepoints[depth];
    state.savepoints.length = depth;
    if (moved[1]) {
        const nested = issuedBy !== undefined && name === issuedBy.toLowerCase();
        state.savepoints.push(nested ? { name, nested: true } : { name });
    } else if (moved[3]) {
        state.savepoints.push(replaced.nested ? { name, nested: true, rolledBack: true } : { name });
    }
}

/**
 * Identifies the transaction a statement belongs to. A statement issued outside
 * one has no transaction to outlive, so it has nothing to identify either.
 */
export function transactionOwnership(connection: unknown): TransactionOwner | undefined {
    const state = observeTransaction(connection);
    return state?.open ? { epoch: state.epoch, savepoints: [...state.savepoints] } : undefined;
}

/**
 * Whether the transaction a statement was issued in is still the one open on
 * the connection: the same transaction, with every savepoint the statement
 * was issued under still open. A savepoint that was released or rolled back
 * to is a different entry now, so a statement issued under it is disowned
 * even though the connection's transaction never closed.
 */
export function stillOwnedBy(connection: unknown, owner: TransactionOwner): boolean {
    const state = observeTransaction(connection);
    if (!state?.open || state.epoch !== owner.epoch) return false;
    return owner.savepoints.every((savepoint, depth) => state.savepoints[depth] === savepoint);
}

/**
 * Whether the scope a statement was issued in is the innermost one open on
 * the connection: it is still owned, and no nested transaction has opened a
 * savepoint above it since. A statement replayed under such a savepoint would
 * have its write undone by that savepoint's rollback even though its own
 * transaction goes on to commit. A nested transaction's savepoint left
 * behind by `ROLLBACK TO` does not count — that transaction is over, and
 * what follows it belongs to the enclosing scope. A savepoint the caller
 * rolled back to does: SQLite keeps it open, and a further rollback to it
 * would take a replayed write with it.
 */
export function atScopeOf(connection: unknown, owner: TransactionOwner): boolean {
    if (!stillOwnedBy(connection, owner)) return false;
    const state = observeTransaction(connection) as TransactionState;
    return state.savepoints
        .slice(owner.savepoints.length)
        .every(savepoint => savepoint.rolledBack === true);
}
