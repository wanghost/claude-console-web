"""收藏存储层：SQLite 持久化用户收藏的发言（跨会话、跟随账号）。

表：
  favorites(session_id TEXT, msg_id TEXT, text TEXT, ts TEXT, created_at TEXT,
            PRIMARY KEY(session_id, msg_id))

复用 db.py 的数据库连接（console.db）。
"""
import sqlite3
import threading
from datetime import datetime

import db

_lock = threading.Lock()


def _conn() -> sqlite3.Connection:
    c = db._get_conn()
    _init_schema(c)
    return c


def _init_schema(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS favorites (
            session_id TEXT NOT NULL,
            msg_id     TEXT NOT NULL,
            text       TEXT,
            ts         TEXT,
            created_at TEXT,
            PRIMARY KEY (session_id, msg_id)
        )
        """
    )
    conn.commit()


def list_favorites() -> list:
    """返回全部收藏，按收藏时间倒序。"""
    with _lock:
        c = _conn()
        cur = c.execute(
            "SELECT session_id, msg_id, text, ts, created_at FROM favorites "
            "ORDER BY created_at DESC, rowid DESC"
        )
        rows = cur.fetchall()
    return [
        {
            "sessionId": r[0],
            "msgId": r[1],
            "text": r[2] or "",
            "ts": r[3] or "",
            "time": r[4] or "",
        }
        for r in rows
    ]


def favorite_ids() -> list:
    """返回所有已收藏的 'session_id::msg_id' 标识列表（供前端快速判断高亮）。"""
    with _lock:
        c = _conn()
        cur = c.execute("SELECT session_id, msg_id FROM favorites")
        rows = cur.fetchall()
    return [r[0] + "::" + r[1] for r in rows]


def add_favorite(session_id: str, msg_id: str, text: str = "", ts: str = "") -> dict:
    """添加收藏（幂等：已存在则更新 text/ts）。"""
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    with _lock:
        c = _conn()
        c.execute(
            "INSERT INTO favorites (session_id, msg_id, text, ts, created_at) "
            "VALUES (?,?,?,?,?) "
            "ON CONFLICT(session_id, msg_id) DO UPDATE SET "
            "text=excluded.text, ts=excluded.ts",
            (session_id, str(msg_id), text, ts, now),
        )
        c.commit()
    return {"ok": True}


def remove_favorite(session_id: str, msg_id: str) -> dict:
    with _lock:
        c = _conn()
        c.execute(
            "DELETE FROM favorites WHERE session_id=? AND msg_id=?",
            (session_id, str(msg_id)),
        )
        c.commit()
    return {"ok": True}


def is_favorited(session_id: str, msg_id: str) -> bool:
    with _lock:
        c = _conn()
        cur = c.execute(
            "SELECT 1 FROM favorites WHERE session_id=? AND msg_id=?",
            (session_id, str(msg_id)),
        )
        return cur.fetchone() is not None
