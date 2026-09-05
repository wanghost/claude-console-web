"""鉴权模块：账号密码登录 + 会话 cookie。账号密码、签名密钥从 SQLite 读取。"""
import hmac
import hashlib
from datetime import datetime, timezone

from fastapi import Request, Response

import db

COOKIE_NAME = "cc_session"


def _secret_key() -> str:
    return db.get_secret_key()


def _make_token(username: str) -> str:
    """基于时间戳 + HMAC 生成带时效的会话 token。"""
    now = int(datetime.now(timezone.utc).timestamp())
    payload = f"{username}:{now}"
    sig = hmac.new(_secret_key().encode(), payload.encode(), hashlib.sha256).hexdigest()
    return f"{payload}:{sig}"


def _max_age() -> int:
    """cookie 过期时长（秒），取会话超时分钟数换算。"""
    return db.get_session_timeout() * 60


def verify_token(token: str) -> bool:
    """校验 token 是否合法且未过期（空闲超时）。"""
    try:
        parts = token.rsplit(":", 2)
        if len(parts) != 3:
            return False
        username, ts, sig = parts
        now = int(datetime.now(timezone.utc).timestamp())
        # 空闲超时：距最后活动时间超过配置分钟数即失效
        if now - int(ts) > _max_age():
            return False
        payload = f"{username}:{ts}"
        expected = hmac.new(_secret_key().encode(), payload.encode(), hashlib.sha256).hexdigest()
        return hmac.compare_digest(expected, sig) and username == db.get_username()
    except (ValueError, TypeError):
        return False


def try_login(username: str, password: str, response: Response) -> bool:
    """校验账号密码，成功则签发 cookie。"""
    if username == db.get_username() and db.check_password(password):
        token = _make_token(username)
        response.set_cookie(
            COOKIE_NAME,
            token,
            httponly=True,
            samesite="lax",
            max_age=_max_age(),
        )
        return True
    return False


def reissue_session(username: str, response: Response) -> None:
    """用当前（可能是新轮换后的）secret_key 重新签发 cookie。

    用于改密码轮换密钥后，让当前设备继续登录，而其他设备旧 cookie 失效。
    """
    token = _make_token(username)
    response.set_cookie(
        COOKIE_NAME,
        token,
        httponly=True,
        samesite="lax",
        max_age=_max_age(),
    )


def is_authenticated(request: Request) -> bool:
    token = request.cookies.get(COOKIE_NAME)
    if not token:
        return False
    if not verify_token(token):
        return False
    return True


def refresh_session_activity(request: Request, response: Response) -> None:
    """空闲超时滑动：请求有效时重新签发 cookie，刷新最后活动时间。"""
    token = request.cookies.get(COOKIE_NAME)
    if not token:
        return
    try:
        username = token.rsplit(":", 2)[0]
    except (ValueError, IndexError):
        return
    response.set_cookie(
        COOKIE_NAME,
        _make_token(username),
        httponly=True,
        samesite="lax",
        max_age=_max_age(),
    )


def clear_session(response: Response):
    response.delete_cookie(COOKIE_NAME)
