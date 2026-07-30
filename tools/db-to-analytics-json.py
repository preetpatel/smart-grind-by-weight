#!/usr/bin/env python3
"""Dump a grinder SQLite database into the web analytics JSON format.

Development helper for the web flasher's Analytics tab: it produces the same
JSON shape as the tab's "Export JSON" button, so charts can be developed and
verified against real session data without a BLE pull (use "Import JSON" in
the browser to load the result).

Usage:
    python3 tools/db-to-analytics-json.py                       # default DB, stdout
    python3 tools/db-to-analytics-json.py -o grind-data.json    # write to file
    python3 tools/db-to-analytics-json.py --db other.db -o out.json
"""

import argparse
import json
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path

EXPORT_FORMAT = "sgbw-analytics"
EXPORT_VERSION = 1

DEFAULT_DB = Path(__file__).parent / "database" / "grinder_data.db"


def rows_as_dicts(conn, query, params=()):
    cursor = conn.execute(query, params)
    columns = [description[0] for description in cursor.description]
    return [dict(zip(columns, row)) for row in cursor.fetchall()]


def load_device_reports(conn):
    try:
        rows = rows_as_dicts(conn, "SELECT kind, captured_at, content FROM device_reports")
    except sqlite3.OperationalError:
        return None  # older databases have no device_reports table
    if not rows:
        return None

    reports = {}
    for row in rows:
        content = row["content"]
        if row["kind"] == "system_info":
            try:
                content = json.loads(content)
            except (TypeError, json.JSONDecodeError):
                content = {}
        reports[row["kind"]] = content
        reports.setdefault("captured_at", row["captured_at"])
    return reports


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--db", default=str(DEFAULT_DB), help="Path to grinder_data.db")
    parser.add_argument("-o", "--output", help="Output JSON file (default: stdout)")
    args = parser.parse_args()

    db_path = Path(args.db)
    if not db_path.exists():
        print(f"[ERROR] Database not found: {db_path}", file=sys.stderr)
        return 1

    exported_at = datetime.now(timezone.utc).isoformat()
    with sqlite3.connect(db_path) as conn:
        sessions = rows_as_dicts(conn, "SELECT * FROM grind_sessions ORDER BY session_id")
        records = []
        for session in sessions:
            session.pop("received_at", None)  # SQLite bookkeeping, not part of the BLE payload
            session_id = session["session_id"]
            records.append({
                "session_id": session_id,
                "session": session,
                "events": rows_as_dicts(
                    conn, "SELECT * FROM grind_events WHERE session_id = ? ORDER BY event_sequence_id", (session_id,)),
                "measurements": rows_as_dicts(
                    conn, "SELECT * FROM grind_measurements WHERE session_id = ? ORDER BY sequence_id", (session_id,)),
                "pulledAt": exported_at,
            })
        device_reports = load_device_reports(conn)

    payload = {
        "format": EXPORT_FORMAT,
        "version": EXPORT_VERSION,
        "exportedAt": exported_at,
        "sessions": records,
    }
    if device_reports:
        payload["deviceReports"] = device_reports

    output = json.dumps(payload)
    if args.output:
        Path(args.output).write_text(output)
        total_events = sum(len(r["events"]) for r in records)
        total_measurements = sum(len(r["measurements"]) for r in records)
        print(f"[OK] Wrote {len(records)} sessions ({total_events} events, "
              f"{total_measurements} measurements) to {args.output}")
    else:
        print(output)
    return 0


if __name__ == "__main__":
    sys.exit(main())
