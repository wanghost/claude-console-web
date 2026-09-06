"""Claude 会话模块：解析会话 jsonl、列出会话、恢复并回复。

会话文件位置：~/.claude/projects/<项目转义>/<session-id>.jsonl
每行一条 JSON 记录。关键 type：
  - "user"       -> message.content[].text 为用户输入
  - "assistant"  -> message.content 为助手回复
  - "last-prompt"-> lastPrompt 为最近一次输入
记录中含 cwd 字段，指示该项目目录。
"""
import json
import re
import subprocess
import threading
from datetime import datetime
from pathlib import Path
from typing import Optional

import config


def _parse_ts(ts: str) -> Optional[str]:
    try:
        return datetime.fromisoformat(ts.replace("Z", "+00:00")).strftime("%Y-%m-%d %H:%M")
    except (ValueError, TypeError):
        return None


def _extract_text(content) -> str:
    """从 message.content 提取纯文本。content 可能是 str 或 list[{type:text,...}]。"""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for item in content:
            if isinstance(item, dict):
                if item.get("type") == "text" and item.get("text"):
                    parts.append(item["text"])
                elif item.get("type") == "tool_use":
                    parts.append(f"[工具调用: {item.get('name', '')}]")
                elif item.get("type") == "tool_result":
                    continue
            elif isinstance(item, str):
                parts.append(item)
        return "".join(parts)
    return ""


def _decode_project_dir(dirname: str) -> str:
    """把 Claude 的目录转义名还原为可读路径，兼容 Windows 与 Linux。

    Claude Code 的 project 目录转义规则（不同平台略有差异）：
      - Windows：'d--Workspace-03zsxn' -> 'D:\\Workspace\\03zsxn'
                盘符小写 + '--'，路径分隔符 '\\' 与 '-' 都转成 '-'。
      - Linux：'/home/user/project' -> '-home-user-project'
              根 '/' 转成前导 '-'，后续 '/' 转成 '-'。

    这里做「尽力还原」：先按 Windows 盘符格式尝试，否则按 Linux 绝对路径格式尝试，
    都失败则原样返回。
    """
    # 1) Windows 盘符格式：'d--...'（单字母盘符 + '--'）
    if len(dirname) >= 3 and dirname[1:3] == "--" and dirname[0].isalpha():
        rest = dirname[3:]
        segs = rest.split("-")
        return f"{dirname[0].upper()}:\\" + "\\".join(segs)

    # 2) Linux 绝对路径格式：以 '-' 开头表示根目录 '/'
    if dirname.startswith("-"):
        segs = dirname[1:].split("-")
        return "/" + "/".join(segs)

    return dirname


def list_sessions() -> list:
    """列出所有会话，按最近活动时间倒序。"""
    sessions = []
    projects_dir = config.PROJECTS_DIR
    if not projects_dir.exists():
        return sessions

    for project_dir in projects_dir.iterdir():
        if not project_dir.is_dir():
            continue
        for f in project_dir.iterdir():
            if not f.suffix == ".jsonl":
                continue
            session_id = f.stem
            info = _summarize_session(f, session_id)
            if info:
                info["project_dir"] = _decode_project_dir(project_dir.name)
                sessions.append(info)

    sessions.sort(key=lambda s: s.get("mtime", 0), reverse=True)
    return sessions


def _summarize_session(path: Path, session_id: str) -> Optional[dict]:
    """提取单个会话的摘要：标题、消息数、最近时间、cwd。"""
    try:
        mtime = path.stat().st_mtime
    except OSError:
        mtime = 0

    title = session_id[:8]
    cwd = None
    last_ts = None
    user_msgs = 0
    assistant_msgs = 0
    last_prompt = None
    running = False

    try:
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    rec = json.loads(line)
                except json.JSONDecodeError:
                    continue
                rtype = rec.get("type")
                ts = rec.get("timestamp")
                if ts:
                    last_ts = _parse_ts(ts) or last_ts
                if rtype == "user":
                    msg = rec.get("message", {})
                    text = _extract_text(msg.get("content"))
                    # 只统计「含真实文本」的 user 消息，排除纯 tool_result 回填记录
                    if text:
                        user_msgs += 1
                        if not title or title == session_id[:8]:
                            title = text[:60]
                    cwd = cwd or rec.get("cwd")
                elif rtype == "assistant":
                    assistant_msgs += 1
                elif rtype == "last-prompt":
                    last_prompt = rec.get("lastPrompt")
                # 判断是否在运行中：有 queue-operation 的 enqueue 但无对应完成标记
    except OSError:
        return None

    # 标题优先级：last-prompt > 首条用户消息 > session id
    if last_prompt:
        title = last_prompt[:60]

    return {
        "session_id": session_id,
        "title": title,
        "user_msgs": user_msgs,
        "assistant_msgs": assistant_msgs,
        "last_ts": last_ts,
        "mtime": mtime,
        "cwd": cwd,
    }


def get_session_messages(session_id: str) -> dict:
    """读取指定会话的完整消息历史。"""
    path = _find_session_file(session_id)
    if not path:
        raise FileNotFoundError(f"会话不存在: {session_id}")

    messages = []
    cwd = None
    with open(path, "r", encoding="utf-8", errors="replace") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            rtype = rec.get("type")
            if rtype == "user":
                cwd = cwd or rec.get("cwd")
            if rtype not in ("user", "assistant"):
                continue
            msg = rec.get("message", {})
            content = msg.get("content")
            text = _extract_text(content)
            if not text:
                continue
            messages.append({
                "id": str(len(messages)),
                "role": rtype,
                "text": text,
                "ts": _parse_ts(rec.get("timestamp")),
            })
    return {"session_id": session_id, "messages": messages, "cwd": cwd}


def _find_session_file(session_id: str) -> Optional[Path]:
    """在 projects 目录下查找 session_id 对应的 jsonl。"""
    projects_dir = config.PROJECTS_DIR
    if not projects_dir.exists():
        return None
    for project_dir in projects_dir.iterdir():
        if not project_dir.is_dir():
            continue
        candidate = project_dir / f"{session_id}.jsonl"
        if candidate.exists():
            return candidate
    return None


# ---- 回复 / 继续会话 ----

# 保存正在运行的回复任务，用于查询状态
_running_jobs: dict[str, dict] = {}
_jobs_lock = threading.Lock()


def _find_project_cwd(session_id: str) -> Optional[str]:
    """从会话文件中找出 cwd，用于 --continue 时定位项目目录。"""
    path = _find_session_file(session_id)
    if not path:
        return None
    cwd = None
    with open(path, "r", encoding="utf-8", errors="replace") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            if rec.get("type") == "user":
                cwd = rec.get("cwd") or cwd
                if cwd:
                    break
    return cwd


def _run_claude_job(job: dict, cmd: list, cwd: Optional[str]) -> None:
    """在后台线程中执行 claude print 命令，并把结果写回 job。

    job 需已包含 job_id、status 等字段，本函数负责填充 output/error/status。
    """
    def _worker():
        try:
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=config.REPLY_TIMEOUT,
                cwd=cwd,
            )
            out = (result.stdout or "").strip()
            err = (result.stderr or "").strip()
            job["status"] = "done" if result.returncode == 0 else "error"
            job["output"] = out
            if result.returncode != 0 and not out:
                job["error"] = err or f"退出码 {result.returncode}"
        except subprocess.TimeoutExpired:
            job["status"] = "timeout"
            job["error"] = f"超过 {config.REPLY_TIMEOUT}s 未完成"
        except Exception as e:  # noqa: BLE001
            job["status"] = "error"
            job["error"] = str(e)

    threading.Thread(target=_worker, daemon=True).start()


def _make_job(session_id: str, prompt: str, extra: Optional[dict] = None) -> dict:
    """构造一个 job 记录。"""
    import uuid
    job = {
        "job_id": uuid.uuid4().hex[:16],
        "session_id": session_id,
        "status": "running",
        "prompt": prompt,
        "output": "",
        "error": None,
        "started": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
    }
    if extra:
        job.update(extra)
    with _jobs_lock:
        _running_jobs[job["job_id"]] = job
    return job


# Claude CLI 可切换的会话参数及其合法取值
# 真实模型名。当前环境走 GLM 中转（open.bigmodel.cn/api/anthropic），
# 实际可用模型为 glm-5.3 和 glm-5.3-flash（映射自 ~/.claude/settings.json 的 env）。
MODELS = ["default", "glm-5.3", "glm-5.3-flash"]
PERMISSION_MODES = ["default", "acceptEdits", "auto", "bypassPermissions", "dontAsk", "plan"]
EFFORTS = ["default", "low", "medium", "high", "xhigh", "max"]


def _build_cmd(extra_args: dict) -> list:
    """把可选参数（model/permission_mode/effort）拼进 claude 命令。

    extra_args 中值为 None 或 "default" 的参数会被忽略（用全局默认）。
    """
    cmd = [config.CLAUDE_CLI]
    model = (extra_args.get("model") or "").strip()
    perm = (extra_args.get("permission_mode") or "").strip()
    effort = (extra_args.get("effort") or "").strip()
    if model and model != "default":
        cmd += ["--model", model]
    if perm and perm != "default":
        cmd += ["--permission-mode", perm]
    if effort and effort != "default":
        cmd += ["--effort", effort]
    return cmd


def reply_session(session_id: str, prompt: str, model: str = None,
                  permission_mode: str = None, effort: str = None) -> dict:
    """对指定会话发起一次回复。用 claude -p --resume <id> 在 print 模式下续接。

    可切换 model / permission_mode / effort（传 None 或 "default" 表示用全局默认）。
    """
    cwd = _find_project_cwd(session_id)
    job = _make_job(session_id, prompt, extra={
        "model": model, "permission_mode": permission_mode, "effort": effort,
    })
    cmd = _build_cmd({
        "model": model, "permission_mode": permission_mode, "effort": effort,
    })
    cmd += ["-p", prompt, "--resume", session_id, "--output-format", "text"]
    _run_claude_job(job, cmd, cwd)
    return job


def create_session(cwd: str, prompt: str, model: str = None,
                   permission_mode: str = None, effort: str = None) -> dict:
    """新建一个会话：用 --session-id 指定新 UUID，在 cwd 目录下跑首条消息。"""
    import uuid
    session_id = str(uuid.uuid4())
    job = _make_job(session_id, prompt, extra={
        "is_new": True, "cwd": cwd,
        "model": model, "permission_mode": permission_mode, "effort": effort,
    })
    cmd = _build_cmd({
        "model": model, "permission_mode": permission_mode, "effort": effort,
    })
    cmd += ["-p", prompt, "--session-id", session_id, "--output-format", "text"]
    _run_claude_job(job, cmd, cwd)
    return job


def get_job(job_id: str) -> Optional[dict]:
    with _jobs_lock:
        job = _running_jobs.get(job_id)
        if not job:
            return None
        return dict(job)
