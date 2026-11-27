"""Transfer OpenCode 2 credential rows between the mounted and disposable databases."""

import json
import os
import sqlite3
import sys
from pathlib import Path

COLUMNS = "id, integration_id, label, value, connector_id, method_id, active, time_created, time_updated"
# The v1 auth.json OAuth fields an OpenCode 2 token refresh can change.
OAUTH_REFRESH_FIELDS = ("refresh", "access", "expires")


# Tables that only OpenCode 2 creates; a 1.x database (e.g. from 1.19.6) has
# `data_migration` and none of these (2.4.2 also adds kv, job, automation,
# blob, instruction_* and worktree). Update this list if OpenCode 2 renames
# them. Checked by schema, not row count, because a 2.x host whose last
# credential was logged out has an empty table but a stale auth.json.
OPENCODE2_MARKER_TABLES = ("session_v2", "machine")


def has_table(db, name):
    return db is not None and bool(db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (name,)).fetchone())


def is_opencode2_store(source):
    """Whether the host database is an OpenCode 2 credential store.

    Its credential table is then authoritative, even when empty. Otherwise (no
    database, no credential table, or a 1.x schema) auth.json is the host store.
    """
    return has_table(source, "credential") and any(has_table(source, name) for name in OPENCODE2_MARKER_TABLES)


def read_auth_json(path):
    try:
        return json.loads(path.read_text())
    except (FileNotFoundError, ValueError):
        return None


def seed(source, runtime, runtime_auth):
    opencode2 = is_opencode2_store(source)
    with runtime:
        if opencode2:
            # An OpenCode 2 host: its credential table is the host store and is
            # authoritative even if empty. OpenCode 2 logout never touches the
            # legacy auth.json, so drop anything the runtime imported from it.
            rows = source.execute(f"SELECT {COLUMNS} FROM credential").fetchall()
            runtime.execute("DELETE FROM credential")
            runtime.executemany(f"INSERT INTO credential ({COLUMNS}) VALUES (?,?,?,?,?,?,?,?,?)", rows)
        # Otherwise the host is still on OpenCode 1.x: 1.x ignores the database
        # credential table, so auth.json is the only host store. OpenCode
        # already imported it into the runtime database; keep those rows.
        runtime.execute("CREATE TABLE propr_original_credential AS SELECT id, value FROM credential")
        if not opencode2:
            # Remember what was imported so sync writes refreshes back to
            # auth.json and can detect host logins made during the run.
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
        WHERE current.value != original.value
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
    if runtime.execute("SELECT 1 FROM sqlite_master WHERE name='propr_original_auth_json'").fetchone():
        # A 1.x host store: refresh auth.json, never the host database. A 1.x
        # CLI ignores (and may migrate) that database, and once its table has
        # rows the next seed would prefer them over later host logins.
        sync_auth_json(runtime, host_auth)
        return
    if not is_opencode2_store(source):
        return
    changes = runtime.execute("""
        SELECT current.value, current.time_updated, current.id, original.value
        FROM credential AS current JOIN propr_original_credential AS original USING (id)
        WHERE current.value != original.value
    """).fetchall()
    # Persist refreshes only if the host still holds the value we started with,
    # so concurrent logins, revocations and unrelated sessions stay intact.
    with source:
        source.executemany("UPDATE credential SET value=?, time_updated=? WHERE id=? AND value=?", changes)


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
