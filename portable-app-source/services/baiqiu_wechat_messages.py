import json
import os
import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path


@contextmanager
def open_store():
    root = Path(os.environ.get("HERMES_HOME") or Path.home() / ".hermes") / "weixin"
    root.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(root / "desktop-messages.db", timeout=3)
    try:
        with connection:
            connection.execute("CREATE TABLE IF NOT EXISTS messages (sequence INTEGER PRIMARY KEY AUTOINCREMENT, identity TEXT UNIQUE NOT NULL, payload TEXT NOT NULL)")
            connection.execute("CREATE TABLE IF NOT EXISTS metadata (name TEXT PRIMARY KEY, value REAL NOT NULL)")
            yield connection
    finally:
        connection.close()


def start_capture():
    with open_store() as connection:
        connection.execute("INSERT OR IGNORE INTO metadata VALUES ('started', ?)", (time.time(),))


def store_message(payload):
    identity = str(payload.get("messageId") or "")
    if not identity:
        raise ValueError("WeChat message identity missing")
    key = json.dumps([payload.get("chatId"), payload.get("role"), identity], ensure_ascii=False)
    with open_store() as connection:
        existing = connection.execute("SELECT sequence,payload FROM messages WHERE identity=?", (key,)).fetchone()
        if existing:
            stored = json.loads(existing[1])
            if any(stored.get(field) != payload.get(field) for field in ("role", "chatId", "text", "attachments")):
                raise ValueError("Conflicting WeChat message identity")
            return existing[0]
        connection.execute("INSERT OR IGNORE INTO messages(identity,payload) VALUES (?,?)", (key, json.dumps(payload, ensure_ascii=False)))
        return connection.execute("SELECT sequence FROM messages WHERE identity=?", (key,)).fetchone()[0]


def read_messages(after=0, limit=500):
    with open_store() as connection:
        started = connection.execute("SELECT value FROM metadata WHERE name='started'").fetchone()
        rows = connection.execute("SELECT sequence,payload FROM messages WHERE sequence>? ORDER BY sequence LIMIT ?", (max(0, int(after)), min(2000, max(1, int(limit))))).fetchall()
    return {"messages": [{**json.loads(row[1]), "journal": True, "sequence": row[0]} for row in rows],
        "cursor": rows[-1][0] if rows else after, "started": started[0] if started else None}
