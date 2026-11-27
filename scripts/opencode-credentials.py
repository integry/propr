"""Transfer OpenCode 2 credential rows between the mounted and disposable databases."""

import json
import os
import sqlite3
import sys
from pathlib import Path

COLUMNS = "id, integration_id, label, value, connector_id, method_id, active, time_created, time_updated"
# The v1 auth.json OAuth fields an OpenCode 2 token refresh can change.
OAUTH_REFRESH_FIELDS = ("refresh", "access", "expires")


def has_credential_table(source):
    return source is not None and bool(
        source.execute("SELECT 1 FROM sqlite_master WHERE name='credential'").fetchone()
    )


def read_auth_json(path):
    try:
        return json.loads(path.read_text())
    except (FileNotFoundError, ValueError):
        return None


def seed(source, runtime, runtime_auth):
    rows = source.execute(f"SELECT {COLUMNS} FROM credential").fetchall() if has_credential_table(source) else []
    with runtime:
        if rows:
            # The source DB is authoritative even if a stale legacy auth.json remains.
            runtime.execute("DELETE FROM credential")
            runtime.executemany(f"INSERT INTO credential ({COLUMNS}) VALUES (?,?,?,?,?,?,?,?,?)", rows)
        # Otherwise the credentials came from auth.json, which OpenCode already
        # imported into the runtime database. Keep those rows and record them
        # as missing from the host, so sync can persist them and any refresh.
        runtime.execute(
            "CREATE TABLE propr_original_credential AS SELECT id, value, ? AS on_host FROM credential",
            (1 if rows else 0,),
        )
        if not has_credential_table(source):
            # Without a host credential table, auth.json is the only host store.
            # Remember what was imported so sync can detect concurrent edits.
            runtime.execute("CREATE TABLE propr_original_auth_json (content TEXT)")
            runtime.execute(
                "INSERT INTO propr_original_auth_json VALUES (?)", (json.dumps(read_auth_json(runtime_auth)),)
            )


def sync_auth_json(runtime, host_auth):
    original = json.loads(runtime.execute("SELECT content FROM propr_original_auth_json").fetchone()[0])
    current = read_auth_json(host_auth)
    if not isinstance(original, dict) or not isinstance(current, dict):
        return
    changed = False
    for integration_id, value in runtime.execute("""
        SELECT current.integration_id, current.value
        FROM credential AS current JOIN propr_original_credential AS original USING (id)
        WHERE original.on_host = 0 AND current.value != original.value
    """):
        seeded = original.get(integration_id)
        refreshed = json.loads(value)
        # Only refresh OAuth entries the host still holds exactly as seeded, so
        # a host login or logout during the run wins.
        if not isinstance(seeded, dict) or seeded.get("type") != "oauth" or refreshed.get("type") != "oauth":
            continue
        if current.get(integration_id) != seeded:
            continue
        current[integration_id] = {**seeded, **{k: refreshed[k] for k in OAUTH_REFRESH_FIELDS if k in refreshed}}
        changed = True
    if not changed:
        return
    # Write atomically next to the original and keep its permissions. Create
    # the temp file owner-only so the tokens are never readable by others,
    # whatever the umask or data dir mode.
    temporary = host_auth.with_name(f"{host_auth.name}.propr-tmp-{os.getpid()}")
    mode = host_auth.stat().st_mode & 0o7777
    try:
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode & 0o600 or 0o600)
        with os.fdopen(fd, "w") as handle:
            handle.write(json.dumps(current, indent=2))
        os.chmod(temporary, mode)
        os.replace(temporary, host_auth)
    finally:
        temporary.unlink(missing_ok=True)


def sync(source, runtime, host_auth):
    if not runtime.execute("SELECT 1 FROM sqlite_master WHERE name='propr_original_credential'").fetchone():
        return
    if not has_credential_table(source):
        # Never create a database or table in the host data dir: a pinned 1.x
        # CLI runs its own migrations against it. Refresh auth.json instead,
        # which OpenCode 2 imports into the next disposable database.
        if runtime.execute("SELECT 1 FROM sqlite_master WHERE name='propr_original_auth_json'").fetchone():
            sync_auth_json(runtime, host_auth)
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


def connect(path, mode):
    return sqlite3.connect(Path(path).as_uri() + "?mode=" + mode, uri=True)


if __name__ == "__main__":
    action, source_path, runtime_path = sys.argv[1:]
    # The host may have only auth.json; never create opencode.db there.
    source = connect(source_path, "ro" if action == "seed" else "rw") if Path(source_path).is_file() else None
    try:
        with connect(runtime_path, "rw") as runtime:
            if action == "seed":
                seed(source, runtime, Path(runtime_path).with_name("auth.json"))
            else:
                sync(source, runtime, Path(source_path).with_name("auth.json"))
    finally:
        if source is not None:
            source.close()
