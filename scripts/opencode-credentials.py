"""Transfer OpenCode 2 credential rows between the mounted and disposable databases."""

import sqlite3
import sys
from pathlib import Path


def seed(source, runtime):
    # Old stores can have a session database alongside v1 auth.json. OpenCode
    # itself migrates that JSON when it initializes the disposable database.
    if not source.execute("SELECT 1 FROM sqlite_master WHERE name='credential'").fetchone():
        return
    columns = "id, integration_id, label, value, connector_id, method_id, active, time_created, time_updated"
    rows = source.execute(f"SELECT {columns} FROM credential").fetchall()
    with runtime:
        # The source DB is authoritative even if a stale legacy auth.json remains.
        runtime.execute("DELETE FROM credential")
        runtime.executemany(f"INSERT INTO credential ({columns}) VALUES (?,?,?,?,?,?,?,?,?)", rows)
        runtime.execute("CREATE TABLE propr_original_credential AS SELECT id, value FROM credential")


def sync(source, runtime):
    if not runtime.execute("SELECT 1 FROM sqlite_master WHERE name='propr_original_credential'").fetchone():
        return
    changes = runtime.execute("""
        SELECT current.value, current.time_updated, current.id, original.value
        FROM credential AS current JOIN propr_original_credential AS original USING (id)
        WHERE current.value != original.value
    """)
    # Persist refreshes only if the host still holds the value we started with.
    # Concurrent logins, revocations and unrelated sessions stay intact.
    with source:
        source.executemany("UPDATE credential SET value=?, time_updated=? WHERE id=? AND value=?", changes)


if __name__ == "__main__":
    action, source_path, runtime_path = sys.argv[1:]
    mode = "ro" if action == "seed" else "rw"
    with sqlite3.connect(Path(source_path).as_uri() + "?mode=" + mode, uri=True) as source:
        with sqlite3.connect(Path(runtime_path).as_uri() + "?mode=rw", uri=True) as runtime:
            {"seed": seed, "sync": sync}[action](source, runtime)
