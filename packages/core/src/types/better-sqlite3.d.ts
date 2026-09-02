declare module 'better-sqlite3' {
    interface RunResult { changes: number }
    interface Statement {
        run(...parameters: unknown[]): RunResult;
        get(...parameters: unknown[]): unknown;
        all(...parameters: unknown[]): unknown[];
    }
    interface Transaction<T> {
        (): T;
        immediate(): T;
    }
    class BetterSqlite3Database {
        constructor(filename: string);
        pragma(source: string): unknown;
        exec(source: string): void;
        prepare(source: string): Statement;
        transaction<T>(operation: () => T): Transaction<T>;
        close(): void;
    }
    namespace BetterSqlite3Database {
        type Database = BetterSqlite3Database;
    }
    export default BetterSqlite3Database;
}
