"""Claude Console 主入口：FastAPI 服务，提供文件浏览 + 会话控制 + 鉴权。"""
import os
from pathlib import Path

from fastapi import FastAPI, Request, Response
from fastapi.responses import JSONResponse, HTMLResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import config
import auth
import files
import claude_sessions
import db

app = FastAPI(title="Claude Console")

STATIC_DIR = Path(__file__).parent / "static"


# ---- 鉴权依赖 ----
# 无需登录即可访问的路径：登录接口、健康检查、以及登录页依赖的静态资源
PUBLIC_PATHS = ("/api/login", "/api/health", "/login.html", "/login.js", "/style.css", "/favicon")


@app.middleware("http")
async def auth_middleware(request: Request, call_next):
    """除登录接口和静态资源外，其余均需登录。"""
    path = request.url.path
    public = any(path.startswith(p) for p in PUBLIC_PATHS)
    if public or auth.is_authenticated(request):
        return await call_next(request)
    # 页面请求重定向到登录页，API 请求返回 401
    if path.startswith("/api/"):
        return JSONResponse({"error": "未登录"}, status_code=401)
    return Response(status_code=307, headers={"Location": "/login.html"})


@app.get("/api/health")
def health():
    return {"ok": True}


class LoginBody(BaseModel):
    username: str
    password: str


@app.post("/api/login")
def login(body: LoginBody, response: Response):
    if auth.try_login(body.username, body.password, response):
        return {"ok": True}
    return JSONResponse({"error": "账号或密码错误"}, status_code=401)


@app.post("/api/logout")
def logout(response: Response):
    auth.clear_session(response)
    return {"ok": True}


@app.get("/api/me")
def me(request: Request):
    return {"authenticated": auth.is_authenticated(request), "username": db.get_username()}


# ---- 系统管理 ----
@app.get("/api/admin/settings")
def admin_settings():
    """返回系统配置（脱敏）。"""
    return {
        "settings": db.get_all_settings(),
        "root_dir": db.get_root_dir(),
        "username": db.get_username(),
    }


class ChangePasswordBody(BaseModel):
    old_password: str
    new_password: str


@app.post("/api/admin/password")
def admin_change_password(body: ChangePasswordBody, response: Response):
    """修改登录密码。需校验旧密码；成功后轮换 secret_key 强制其他设备下线，
    并为当前设备重新签发 cookie 以保持登录。"""
    if not db.check_password(body.old_password):
        return JSONResponse({"error": "旧密码错误"}, status_code=400)
    if len(body.new_password) < 6:
        return JSONResponse({"error": "新密码至少 6 位"}, status_code=400)
    db.set_password(body.new_password)
    # 轮换签名密钥：其他设备旧 cookie 立即失效
    db.rotate_secret_key()
    # 当前设备重新签发，保持登录
    auth.reissue_session(db.get_username(), response)
    return {"ok": True}


class ChangeRootBody(BaseModel):
    root_dir: str


@app.post("/api/admin/root")
def admin_change_root(body: ChangeRootBody):
    """修改默认工作目录。校验目录存在。"""
    from pathlib import Path
    p = Path(body.root_dir)
    if not p.exists() or not p.is_dir():
        return JSONResponse({"error": "目录不存在或不是目录"}, status_code=400)
    db.set_root_dir(str(p))
    return {"ok": True, "root_dir": str(p)}


# ---- 文件浏览 ----
@app.get("/api/fs/list")
def fs_list(path: str = ""):
    try:
        return files.list_dir(path)
    except PermissionError:
        return JSONResponse({"error": "路径越界"}, status_code=403)
    except (FileNotFoundError, NotADirectoryError) as e:
        return JSONResponse({"error": str(e)}, status_code=404)


@app.get("/api/fs/read")
def fs_read(path: str):
    try:
        return files.read_file(path)
    except PermissionError:
        return JSONResponse({"error": "路径越界"}, status_code=403)
    except (FileNotFoundError, NotADirectoryError) as e:
        return JSONResponse({"error": str(e)}, status_code=404)


class WriteBody(BaseModel):
    path: str
    content: str


@app.post("/api/fs/write")
def fs_write(body: WriteBody):
    try:
        return files.write_file(body.path, body.content)
    except PermissionError:
        return JSONResponse({"error": "路径越界"}, status_code=403)
    except (FileNotFoundError, NotADirectoryError, IsADirectoryError) as e:
        return JSONResponse({"error": str(e)}, status_code=400)


# ---- 会话控制 ----
@app.get("/api/sessions")
def sessions():
    return {"sessions": claude_sessions.list_sessions()}


@app.get("/api/sessions/dirs")
def session_dirs():
    """列出可用于新建会话的目录：文件根目录下的一级子目录 + 历史会话 cwd 去重。"""
    result = []
    seen = set()
    # 1) 文件根目录下的一级子目录
    root = config.get_root_dir()
    if root.exists():
        try:
            for child in sorted(root.iterdir(), key=lambda p: p.name.lower()):
                if child.is_dir() and not child.name.startswith("."):
                    rel = files.abs_to_rel(str(child))
                    if rel and rel not in seen:
                        seen.add(rel)
                        result.append({"path": str(child), "rel": rel, "name": child.name})
        except OSError:
            pass
    # 2) 历史会话里的 cwd（可能更深层，如 root/proj/subdir）
    for s in claude_sessions.list_sessions():
        cwd = s.get("cwd")
        if not cwd:
            continue
        rel = files.abs_to_rel(cwd)
        if rel and rel not in seen:
            seen.add(rel)
            name = Path(cwd).name or cwd
            result.append({"path": cwd, "rel": rel, "name": name})
    return {"dirs": result}


@app.get("/api/sessions/options")
def session_options():
    """返回会话可切换的模型/权限模式/Effort 的合法取值。"""
    return {
        "models": claude_sessions.MODELS,
        "permission_modes": claude_sessions.PERMISSION_MODES,
        "efforts": claude_sessions.EFFORTS,
    }


@app.get("/api/sessions/{session_id}")
def session_detail(session_id: str):
    try:
        return claude_sessions.get_session_messages(session_id)
    except FileNotFoundError as e:
        return JSONResponse({"error": str(e)}, status_code=404)


@app.get("/api/sessions/{session_id}/cwd")
def session_cwd(session_id: str):
    """返回会话工作目录对应的文件浏览相对路径（用于「打开所在目录」）。"""
    try:
        data = claude_sessions.get_session_messages(session_id)
    except FileNotFoundError as e:
        return JSONResponse({"error": str(e)}, status_code=404)
    cwd = data.get("cwd")
    if not cwd:
        return {"rel_path": None, "cwd": None}
    rel = files.abs_to_rel(cwd)
    return {"rel_path": rel, "cwd": cwd}


class ReplyBody(BaseModel):
    prompt: str
    model: str = None
    permission_mode: str = None
    effort: str = None


class CreateBody(BaseModel):
    cwd: str
    prompt: str
    model: str = None
    permission_mode: str = None
    effort: str = None


def _validate_session_params(model, permission_mode, effort):
    """校验会话参数是否在合法取值内，非法则返回错误信息，合法返回 None。"""
    if model and model not in claude_sessions.MODELS:
        return f"非法模型: {model}，可选 {claude_sessions.MODELS}"
    if permission_mode and permission_mode not in claude_sessions.PERMISSION_MODES:
        return f"非法权限模式: {permission_mode}，可选 {claude_sessions.PERMISSION_MODES}"
    if effort and effort not in claude_sessions.EFFORTS:
        return f"非法 Effort: {effort}，可选 {claude_sessions.EFFORTS}"
    return None


@app.post("/api/sessions")
def session_create(body: CreateBody):
    """新建会话：在 cwd 目录下用首条消息开启全新会话。"""
    if not body.cwd or not body.prompt.strip():
        return JSONResponse({"error": "cwd 和 prompt 不能为空"}, status_code=400)
    # 校验 cwd 必须在文件根目录内，防越界
    if files.abs_to_rel(body.cwd) is None:
        return JSONResponse({"error": "目录不在允许范围内"}, status_code=403)
    err = _validate_session_params(body.model, body.permission_mode, body.effort)
    if err:
        return JSONResponse({"error": err}, status_code=400)
    job = claude_sessions.create_session(
        body.cwd, body.prompt.strip(),
        model=body.model, permission_mode=body.permission_mode, effort=body.effort,
    )
    return job


@app.post("/api/sessions/{session_id}/reply")
def session_reply(session_id: str, body: ReplyBody):
    err = _validate_session_params(body.model, body.permission_mode, body.effort)
    if err:
        return JSONResponse({"error": err}, status_code=400)
    try:
        job = claude_sessions.reply_session(
            session_id, body.prompt,
            model=body.model, permission_mode=body.permission_mode, effort=body.effort,
        )
        return job
    except FileNotFoundError as e:
        return JSONResponse({"error": str(e)}, status_code=404)


@app.get("/api/jobs/{job_id}")
def job_status(job_id: str):
    job = claude_sessions.get_job(job_id)
    if not job:
        return JSONResponse({"error": "任务不存在"}, status_code=404)
    return job


# ---- 静态前端 ----
app.mount("/", StaticFiles(directory=str(STATIC_DIR), html=True), name="static")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host=config.HOST, port=config.PORT, reload=False)
