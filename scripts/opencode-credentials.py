"""Transfer OpenCode 2 credential rows between the mounted and disposable databases."""

import sqlite3
import sys
from pathlib import Path

COLUMNS = "id, integration_id, label, value, connector_id, method_id, active, time_created, time_updated"


def seed(source, runtime):
    # Old stores can have a session database alongside v1 auth.json. OpenCode
    # itself migrates that JSON when it initializes the disposable database.
    if not source.execute("SELECT 1 FROM sqlite_master WHERE name='credential'").fetchone():
        return
    rows = source.execute(f"SELECT {COLUMNS} FROM credential").fetchall()
    with runtime:
        if rows:
            # The source DB is authoritative even if a stale legacy auth.json remains.
            runtime.execute("DELETE FROM credential")
            runtime.executemany(f"INSERT INTO credential ({COLUMNS}) VALUES (?,?,?,?,?,?,?,?,?)", rows)
        # OpenCode 1.x creates the table but leaves it empty; its credentials
        # live in auth.json, which OpenCode already imported into the runtime
        # database. Keep those rows and record them as missing from the host,
        # so sync can move them (and any refresh) into the host database.
        runtime.execute(
            "CREATE TABLE propr_original_credential AS SELECT id, value, ? AS on_host FROM credential",
            (1 if rows else 0,),
        )


def sync(source, runtime):
    if not runtime.execute("SELECT 1 FROM sqlite_master WHERE name='propr_original_credential'").fetchone():
        return
    if not source.execute("SELECT 1 FROM sqlite_master WHERE name='credential'").fetchone():
        return
    changes = runtime.execute("""
        SELECT current.value, current.time_updated, current.id, original.value
        FROM credential AS current JOIN propr_original_credential AS original USING (id)
        WHERE original.on_host = 1 AND current.value != original.value
    """).fetchall()
    # Imported from auth.json: copy every surviving row, refreshed or not.
    # Once the host table is non-empty it becomes authoritative for the next
    # seed, so leaving unchanged rows behind would drop those logins.
    imported = runtime.execute(f"""
        SELECT {", ".join("current." + column.strip() for column in COLUMNS.split(","))}
        FROM credential AS current JOIN propr_original_credential AS original USING (id)
        WHERE original.on_host = 0
    """).fetchall()
    # Persist refreshes only if the host still holds the value we started with,
    # and imported rows only if the host still has no credential with that id
    # or for that integration. Concurrent logins, revocations and unrelated
    # sessions stay intact. auth.json is left untouched for pinned 1.x CLIs.
    with source:
        source.executemany("UPDATE credential SET value=?, time_updated=? WHERE id=? AND value=?", changes)
        source.executemany(
            f"""INSERT INTO credential ({COLUMNS}) SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9
            WHERE NOT EXISTS (SELECT 1 FROM credential WHERE id=?1 OR integration_id=?2)""",
            imported,
        )


if __name__ == "__main__":
    action, source_path, runtime_path = sys.argv[1:]
    mode = "ro" if action == "seed" else "rw"
    with sqlite3.connect(Path(source_path).as_uri() + "?mode=" + mode, uri=True) as source:
        with sqlite3.connect(Path(runtime_path).as_uri() + "?mode=rw", uri=True) as runtime:
            {"seed": seed, "sync": sync}[action](source, runtime)
