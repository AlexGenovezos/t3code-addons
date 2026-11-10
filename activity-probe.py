#!/usr/bin/env python3
"""Read-only T3 V2 activity summary. No thread content or credentials leave this process."""
import json
import os
import sqlite3
import sys
import time
from datetime import datetime, timezone, timedelta
from pathlib import Path

TERMINAL = "'completed','interrupted','failed','cancelled','rolled_back'"


def database_activity(db, now=None):
    now = now or datetime.now(timezone.utc)
    checks = [
        ("runs", f"SELECT 1 FROM orchestration_v2_projection_runs WHERE status NOT IN ({TERMINAL}) LIMIT 1"),
        ("attempts", f"SELECT 1 FROM orchestration_v2_projection_run_attempts WHERE status NOT IN ({TERMINAL}) LIMIT 1"),
        ("provider turns", f"SELECT 1 FROM orchestration_v2_projection_provider_turns WHERE status NOT IN ({TERMINAL}) LIMIT 1"),
        ("subagents", f"SELECT 1 FROM orchestration_v2_projection_subagents WHERE status NOT IN ({TERMINAL}) LIMIT 1"),
        ("requests", "SELECT 1 FROM orchestration_v2_projection_runtime_requests WHERE status NOT IN ('resolved','cancelled','expired') LIMIT 1"),
        ("effects", "SELECT 1 FROM orchestration_v2_effect_outbox WHERE status NOT IN ('succeeded','failed','cancelled') LIMIT 1"),
        # Require the upstream partial index: never scan historical tool payloads.
        ("background work", "SELECT 1 FROM orchestration_v2_projection_turn_items INDEXED BY orchestration_v2_projection_turn_items_shell_pending_idx WHERE type IN ('command_execution','dynamic_tool','subagent') AND status NOT IN ('completed','interrupted','failed','cancelled') LIMIT 1"),
        ("provider background work", "SELECT 1 FROM orchestration_v2_projection_provider_threads WHERE json_array_length(payload_json, '$.pendingBackgroundTasks') > 0 LIMIT 1"),
    ]
    for label, sql in checks:
        if db.execute(sql).fetchone():
            return {"idle": False, "reason": label}
    # Avoid restarting into an imminent automation. Future schedules do not block all night.
    for (value,) in db.execute("SELECT next_run_at FROM scheduled_tasks WHERE enabled = 1 AND next_run_at IS NOT NULL"):
        if datetime.fromisoformat(value.replace('Z', '+00:00')) <= now + timedelta(minutes=10):
            return {"idle": False, "reason": "automation due soon"}
    # Detect activity between polls, even when it started and finished within one minute.
    row = db.execute("SELECT MAX(sequence) FROM orchestration_v2_events").fetchone()
    return {"idle": True, "revision": str(row[0] or 0)}


def probe(state_dir=None):
    root = Path(state_dir or Path.home() / ".t3/userdata")
    runtime = json.loads((root / "server-runtime.json").read_text())
    os.kill(runtime["pid"], 0)
    environment = (root / "environment-id").read_text().strip()
    if not environment:
        raise ValueError("Missing environment identity")
    deadline = time.monotonic() + 3
    db = sqlite3.connect((root / "statev2.sqlite").as_uri() + "?mode=ro", uri=True, timeout=1)
    try:
        db.execute("PRAGMA query_only = ON")
        db.set_progress_handler(lambda: int(time.monotonic() > deadline), 1000)
        db.execute("BEGIN")
        result = database_activity(db)
        db.rollback()
    finally:
        db.close()
    latest = json.loads((root / "server-runtime.json").read_text())
    if (latest.get("pid"), latest.get("startedAt")) != (runtime.get("pid"), runtime.get("startedAt")):
        raise ValueError("Server restarted during probe")
    os.kill(runtime["pid"], 0)
    return {"environmentId": environment, "checkedAt": int(time.time() * 1000), **result}


if __name__ == "__main__":
    try:
        print(json.dumps(probe(sys.argv[1] if len(sys.argv) > 1 else None)))
    except Exception:
        print(json.dumps({"idle": False, "unknown": True, "reason": "Activity could not be verified"}))
