"""全局配置。所有可调项集中在此，可用环境变量覆盖。"""
import os
import tempfile
from pathlib import Path

# 监听地址：0.0.0.0 表示对公网开放（配合固定 IP），本机调试可改 127.0.0.1
HOST = os.environ.get("CC_HOST", "0.0.0.0")
PORT = int(os.environ.get("CC_PORT", "8080"))

# 登录账号密码（务必修改为强密码）
USERNAME = os.environ.get("CC_USERNAME", "admin")
PASSWORD = os.environ.get("CC_PASSWORD", "change-me-please")

# 会话签名密钥：用于签发登录 cookie。不设则每次重启登录态失效。
SECRET_KEY = os.environ.get("CC_SECRET", "please-change-this-secret-key")

# 文件浏览的根目录。存储在 SQLite 中（默认 D:\Workspace），可在「系统管理」里在线修改。
# 通过 get_root_dir() 动态读取；环境变量 CC_ROOT 仅作为首次初始化的默认值。
def get_root_dir() -> Path:
    import db
    return Path(db.get_root_dir())

# Claude 数据目录（会话 jsonl 所在位置）
CLAUDE_DIR = Path(os.environ.get("CC_CLAUDE_DIR", str(Path.home() / ".claude")))
PROJECTS_DIR = CLAUDE_DIR / "projects"

# claude CLI 路径
CLAUDE_CLI = os.environ.get("CC_CLAUDE_CLI", "claude")

# 会话回复超时（秒）
REPLY_TIMEOUT = int(os.environ.get("CC_REPLY_TIMEOUT", "600"))

# 文件预览大小上限（字节），超过则只显示前 N 字节
PREVIEW_LIMIT = int(os.environ.get("CC_PREVIEW_LIMIT", "200_000"))

# 临时目录（存会话语境备份等）
TMP_DIR = Path(tempfile.gettempdir()) / "claude-console-web"
TMP_DIR.mkdir(parents=True, exist_ok=True)
