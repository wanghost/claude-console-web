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


def verify_token(token: str) -> bool:
    """校验 token 是否合法且未过期。"""
    try:
        parts = token.rsplit(":", 2)
        if len(parts) != 3:
            return False
        username, ts, sig = parts
        now = int(datetime.now(timezone.utc).timestamp())
        # 有效期 30 天
        if now - int(ts) > 30 * 86400:
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
            max_age=30 * 86400,
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
        max_age=30 * 86400,
    )


def is_authenticated(request: Request) -> bool:
    token = request.cookies.get(COOKIE_NAME)
    return bool(token and verify_token(token))


def clear_session(response: Response):
    response.delete_cookie(COOKIE_NAME)
