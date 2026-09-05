"""文件浏览模块：列出目录、读取/写入文件，严格限制在 ROOT_DIR 内，防路径穿越。"""
from pathlib import Path
from typing import Optional

import config


def _resolve(rel_path: Optional[str]) -> Path:
    """把相对路径解析为绝对路径，并确保在根目录内。"""
    root = config.get_root_dir().resolve()
    if not rel_path or rel_path in ("", "/", "."):
        return root
    # 去掉开头斜杠，避免被当成绝对路径
    rel_path = rel_path.lstrip("/\\")
    candidate = (root / rel_path).resolve()
    # 防路径穿越：解析后必须仍在 root 内
    if not str(candidate).startswith(str(root)):
        raise PermissionError("路径越界")
    return candidate


def abs_to_rel(abs_path: str) -> Optional[str]:
    """把绝对路径转换为相对根目录的路径；若不在根目录内则返回 None。"""
    root = config.get_root_dir().resolve()
    try:
        abs_p = Path(abs_path).resolve()
    except (OSError, ValueError):
        return None
    if not str(abs_p).startswith(str(root)):
        return None
    rel = abs_p.relative_to(root)
    return str(rel).replace("\\", "/")


def list_dir(rel_path: Optional[str]) -> dict:
    """列出目录内容，返回条目信息。"""
    path = _resolve(rel_path)
    if not path.exists():
        raise FileNotFoundError(f"不存在: {rel_path}")
    if not path.is_dir():
        raise NotADirectoryError(f"不是目录: {rel_path}")

    root = config.get_root_dir().resolve()
    entries = []
    for child in sorted(path.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower())):
        try:
            stat = child.stat()
        except OSError:
            continue
        entries.append({
            "name": child.name,
            "path": str(child.relative_to(root)).replace("\\", "/"),
            "is_dir": child.is_dir(),
            "size": stat.st_size if child.is_file() else None,
            "mtime": stat.st_mtime,
        })
    return {
        "path": rel_path or "/",
        "entries": entries,
    }


def read_file(rel_path: str, limit: int = None) -> dict:
    """读取文件内容（文本优先，二进制则标记）。"""
    path = _resolve(rel_path)
    if not path.exists():
        raise FileNotFoundError(f"不存在: {rel_path}")
    if not path.is_file():
        raise NotADirectoryError(f"不是文件: {rel_path}")

    limit = limit or config.PREVIEW_LIMIT
    size = path.stat().st_size
    try:
        data = path.read_bytes()
    except OSError as e:
        raise OSError(f"读取失败: {e}")

    # 尝试按 UTF-8 解码，失败则当二进制
    try:
        text = data.decode("utf-8")
        truncated = len(data) > limit
        return {
            "path": rel_path,
            "size": size,
            "encoding": "utf-8",
            "truncated": truncated,
            "content": text[:limit] if truncated else text,
        }
    except UnicodeDecodeError:
        # 二进制：返回标记，不返回内容
        return {
            "path": rel_path,
            "size": size,
            "encoding": "binary",
            "truncated": False,
            "content": None,
        }


def write_file(rel_path: str, content: str) -> dict:
    """写入文本文件（覆盖）。"""
    path = _resolve(rel_path)
    if path.is_dir():
        raise IsADirectoryError(f"目标是目录: {rel_path}")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    return {"path": rel_path, "written": len(content)}
