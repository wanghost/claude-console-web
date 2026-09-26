"""文件浏览模块：列出目录、读取/写入文件，严格限制在 ROOT_DIR 内，防路径穿越。"""
import ast
import json
import shutil
import subprocess
from pathlib import Path
from typing import Optional

import config

try:
    import yaml
except ImportError:  # pragma: no cover
    yaml = None


class SyntaxError_(Exception):
    """文件语法/格式校验失败。message 含具体错误信息。"""


def _check_brackets(content: str) -> Optional[str]:
    """括号配对检查，返回错误描述或 None。用于无专用解析器的语言。"""
    pairs = {"(": ")", "[": "]", "{": "}"}
    closers = {")": "(", "]": "[", "}": "{"}
    stack = []
    line = 1
    col = 0
    # 忽略字符串中的括号（简化处理，跳过引号内字符）
    in_str = None
    i = 0
    n = len(content)
    while i < n:
        ch = content[i]
        if ch == "\n":
            line += 1
            col = 0
        else:
            col += 1
        if in_str:
            if ch == "\\":
                i += 1
            elif ch == in_str:
                in_str = None
        elif ch in ("'", '"', "`"):
            in_str = ch
        elif ch in pairs:
            stack.append((ch, line, col))
        elif ch in closers:
            if not stack or stack[-1][0] != closers[ch]:
                return f"第 {line} 行第 {col} 列：多余的 '{ch}'"
            stack.pop()
        i += 1
    if stack:
        ch, line, col = stack[-1]
        return f"第 {line} 行第 {col} 列：'{ch}' 未闭合"
    return None


def validate_syntax(rel_path: str, content: str) -> Optional[str]:
    """按扩展名校验语法/格式。返回错误描述字符串；无错误返回 None。"""
    p = Path(rel_path)
    ext = p.suffix.lower()

    try:
        if ext == ".json":
            json.loads(content)
        elif ext in (".py", ".pyw"):
            ast.parse(content)
        elif ext in (".yaml", ".yml"):
            if yaml is None:
                return None
            try:
                yaml.safe_load(content)
            except yaml.YAMLError as e:
                return f"YAML 格式错误：{e}"
        elif ext in (".xml", ".html", ".htm", ".svg", ".xhtml"):
            import xml.etree.ElementTree as ET
            try:
                ET.fromstring(content)
            except ET.ParseError as e:
                return f"XML/HTML 解析错误：{e}"
        elif ext in (".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx"):
            # 优先用 node --check 严格校验；无 node 则括号匹配降级
            node = shutil.which("node")
            if node:
                try:
                    r = subprocess.run(
                        [node, "--check", "--input-type=module", "-e", content],
                        capture_output=True, text=True, encoding="utf-8", errors="replace",
                        timeout=15,
                    )
                    if r.returncode != 0:
                        return "JS/TS 语法错误：" + (r.stderr or r.stdout or "未知").strip()
                except (subprocess.TimeoutExpired, OSError):
                    return _check_brackets(content)
            else:
                return _check_brackets(content)
        elif ext == ".css":
            err = _check_brackets(content)
            if err:
                return "CSS 括号错误：" + err
        # 其余扩展名不校验
    except json.JSONDecodeError as e:
        return f"JSON 格式错误：第 {e.lineno} 行第 {e.colno} 列：{e.msg}"
    except SyntaxError as e:
        return f"Python 语法错误：第 {e.lineno} 行：{e.msg}"
    except Exception as e:  # 校验器自身异常（含 yaml），不阻断保存
        return None
    return None


def _is_within(path: Path, root: Path) -> bool:
    """判断 path 是否在 root 内（含 root 自身），跨平台安全。

    用 relative_to 而非字符串 startswith，避免前缀误判（如 /data vs /database）。
    """
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


def _resolve(rel_path: Optional[str]) -> Path:
    """把相对路径解析为绝对路径，并确保在根目录内。"""
    root = config.get_root_dir().resolve()
    if not rel_path or rel_path in ("", "/", "."):
        return root
    # 去掉开头斜杠，避免被当成绝对路径
    rel_path = rel_path.lstrip("/\\")
    candidate = (root / rel_path).resolve()
    # 防路径穿越：解析后必须仍在 root 内
    if not _is_within(candidate, root):
        raise PermissionError("路径越界")
    return candidate


def abs_to_rel(abs_path: str) -> Optional[str]:
    """把绝对路径转换为相对根目录的路径；若不在根目录内则返回 None。"""
    root = config.get_root_dir().resolve()
    try:
        abs_p = Path(abs_path).resolve()
    except (OSError, ValueError):
        return None
    if not _is_within(abs_p, root):
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
    """写入文本文件（覆盖）。写前按扩展名校验语法/格式。"""
    path = _resolve(rel_path)
    if path.is_dir():
        raise IsADirectoryError(f"目标是目录: {rel_path}")

    # 保存前校验语法/格式
    err = validate_syntax(rel_path, content)
    if err:
        raise SyntaxError_(err)

    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    return {"path": rel_path, "written": len(content)}


def mkdir_dir(rel_path: str) -> dict:
    """在指定相对路径下创建目录。rel_path 为要创建的目录路径。"""
    path = _resolve(rel_path)
    if path.exists():
        raise FileExistsError(f"已存在: {rel_path}")
    path.mkdir(parents=True)
    return {"path": rel_path, "created": True}


def create_file(rel_path: str) -> dict:
    """在指定相对路径下创建空文件。rel_path 为要创建的文件路径。"""
    path = _resolve(rel_path)
    if path.exists():
        raise FileExistsError(f"已存在: {rel_path}")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.touch()
    return {"path": rel_path, "created": True}


def rename(old_rel_path: str, new_name: str) -> dict:
    """重命名文件或目录。new_name 为新的名称（不含路径）。"""
    if not new_name or new_name in ("", "."):
        raise ValueError("名称不能为空")
    if "/" in new_name or "\\" in new_name:
        raise ValueError("名称不能包含路径分隔符")
    src = _resolve(old_rel_path)
    if not src.exists():
        raise FileNotFoundError(f"不存在: {old_rel_path}")
    dst = src.parent / new_name
    if dst.exists():
        raise FileExistsError(f"已存在: {new_name}")
    src.rename(dst)
    new_rel = abs_to_rel(str(dst))
    return {"old_path": old_rel_path, "path": new_rel, "renamed": True}


def upload_file(dir_rel_path: str, filename: str, data: bytes) -> dict:
    """上传文件到指定目录。filename 为原始文件名（不含路径）。

    - 目标目录 dir_rel_path 必须已存在且为目录。
    - 文件已存在则报错（不覆盖，避免误覆盖）。
    - 文件名只取 basename，防路径穿越。
    """
    if not filename or filename in ("", "."):
        raise ValueError("文件名不能为空")
    # 只保留 basename，丢弃任何路径成分（防 ../ 穿越）
    safe_name = Path(filename).name
    if not safe_name or safe_name in ("", ".", ".."):
        raise ValueError("文件名非法")
    dir_path = _resolve(dir_rel_path)
    if not dir_path.exists():
        raise FileNotFoundError(f"目录不存在: {dir_rel_path}")
    if not dir_path.is_dir():
        raise NotADirectoryError(f"不是目录: {dir_rel_path}")
    dst = dir_path / safe_name
    if dst.exists():
        raise FileExistsError(f"文件已存在: {safe_name}")
    dst.write_bytes(data)
    new_rel = abs_to_rel(str(dst))
    return {"path": new_rel, "name": safe_name, "size": len(data), "uploaded": True}
