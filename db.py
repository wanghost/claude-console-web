"""SQLite 存储层：持久化系统配置（用户密码、默认工作目录等）。

数据库文件：claude-console-web/console.db（程序当前目录下）
表：
  settings(key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)

密码使用 PBKDF2 哈希存储，不存明文。
"""
import hashlib
import os
import sqlite3
import threading
from datetime import datetime
from pathlib import Path

# 数据库文件直接放在程序当前目录（claude-console-web/）下
DB_PATH = Path(__file__).parent / "console.db"

_lock = threading.Lock()
_conn = None

# 默认配置（首次运行时写入 DB）。环境变量可覆盖这些默认值。
DEFAULTS = {
    "username": os.environ.get("CC_USERNAME", "admin"),
    # 默认密码的哈希在 init 时计算，这里先用占位，实际通过 set_password 写入
    "root_dir": os.environ.get("CC_ROOT", r"D:\Workspace"),
    "secret_key": os.environ.get("CC_SECRET", "please-change-this-secret-key"),
}

# 默认密码（首次运行时用于初始化）。之后修改保存在 DB，不再读这里。
DEFAULT_PASSWORD = os.environ.get("CC_PASSWORD", "change-me-please")


def _get_conn() -> sqlite3.Connection:
    global _conn
    if _conn is None:
        DB_PATH.parent.mkdir(parents=True, exist_ok=True)
        _conn = sqlite3.connect(str(DB_PATH), check_same_thread=False)
        _conn.execute("PRAGMA journal_mode=WAL")
        _init_schema(_conn)
    return _conn


def _init_schema(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT,
            updated_at TEXT
        )
        """
    )
    conn.commit()
    # 首次写入默认值
    _init_defaults(conn)


def _init_defaults(conn: sqlite3.Connection) -> None:
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    for k, v in DEFAULTS.items():
        cur = conn.execute("SELECT value FROM settings WHERE key=?", (k,))
        if cur.fetchone() is None:
            conn.execute("INSERT INTO settings (key, value, updated_at) VALUES (?,?,?)", (k, v, now))
    # 密码：首次写入默认密码的哈希
    cur = conn.execute("SELECT value FROM settings WHERE key='password_hash'")
    if cur.fetchone() is None:
        conn.execute(
            "INSERT INTO settings (key, value, updated_at) VALUES (?,?,?)",
            ("password_hash", _hash_password(DEFAULT_PASSWORD), now),
        )
    conn.commit()


# ---- 密码哈希 ----
def _hash_password(password: str, salt: bytes = None) -> str:
    """PBKDF2-HMAC-SHA256 哈希，返回 salt$hash 形式。"""
    if salt is None:
        salt = os.urandom(16)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, 200_000)
    return salt.hex() + "$" + dk.hex()


def verify_password(password: str, stored: str) -> bool:
    try:
        salt_hex, hash_hex = stored.split("$", 1)
        salt = bytes.fromhex(salt_hex)
        expected = _hash_password(password, salt)
        return hmac_compare(expected, stored)
    except (ValueError, TypeError):
        return False


def hmac_compare(a: str, b: str) -> bool:
    import hmac as _hmac
    return _hmac.compare_digest(a.encode(), b.encode())


# ---- 通用配置读写 ----
def get_setting(key: str, default: str = None) -> str:
    with _lock:
        conn = _get_conn()
        cur = conn.execute("SELECT value FROM settings WHERE key=?", (key,))
        row = cur.fetchone()
    return row[0] if row else default


def set_setting(key: str, value: str) -> None:
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    with _lock:
        conn = _get_conn()
        conn.execute(
            "INSERT INTO settings (key, value, updated_at) VALUES (?,?,?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
            (key, value, now),
        )
        conn.commit()


# ---- 业务配置封装 ----
def get_username() -> str:
    return get_setting("username", "admin")


def set_username(value: str) -> None:
    set_setting("username", value)


def get_password_hash() -> str:
    return get_setting("password_hash", "")


def set_password(new_password: str) -> None:
    """修改密码：写入新的 PBKDF2 哈希。"""
    set_setting("password_hash", _hash_password(new_password))


def check_password(password: str) -> bool:
    stored = get_password_hash()
    if not stored:
        return False
    return verify_password(password, stored)


def get_root_dir() -> str:
    return get_setting("root_dir", r"D:\Workspace")


def set_root_dir(value: str) -> None:
    set_setting("root_dir", value)


def get_secret_key() -> str:
    return get_setting("secret_key", "please-change-this-secret-key")


def rotate_secret_key() -> str:
    """生成新的随机签名密钥并保存，使所有已签发的登录 token 立即失效。"""
    import secrets
    new_key = secrets.token_hex(32)
    set_setting("secret_key", new_key)
    return new_key


def get_all_settings() -> dict:
    """返回所有配置（脱敏：不含密码哈希明文）。"""
    with _lock:
        conn = _get_conn()
        cur = conn.execute("SELECT key, value, updated_at FROM settings")
        rows = cur.fetchall()
    result = {}
    for key, value, updated_at in rows:
        result[key] = {"value": value, "updated_at": updated_at}
    # 密码哈希脱敏
    if "password_hash" in result:
        result["password_hash"]["value"] = "***（已加密存储）***"
    return result
