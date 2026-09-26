"""Cloudflare Tunnel（cloudflared）穿透管理。

两种模式：
  1. quick  快速隧道：`cloudflared tunnel --url http://127.0.0.1:<port>`
     零配置，启用即得一个 https://xxx.trycloudflare.com 域名（每次启用会变）。
  2. named  命名隧道：固定域名 https://<你的域名>，需要域名托管在 Cloudflare，
     且本机已执行过一次 `cloudflared tunnel login`（生成 ~/.cloudflared/cert.pem）。
     后端会自动完成 tunnel create / route dns / run。

配置持久化在 SQLite（settings 表）：tunnel_mode / tunnel_hostname / tunnel_name /
tunnel_port / tunnel_autostart。
"""
import os
import re
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path

import config
import db

# cloudflared 家目录（证书、tunnel 凭证所在）
CF_DIR = Path(os.environ.get("CC_CLOUDFLARED_DIR", str(Path.home() / ".cloudflared")))
# 本项目生成的 ingress 配置
CONFIG_PATH = Path(__file__).parent / "cloudflared" / "config.yml"

_lock = threading.RLock()
_proc = None          # 当前 cloudflared 进程
_mode = None          # quick / named
_url = None           # 公网访问地址
_error = None         # 最近一次错误信息
_log = []             # 最近日志（最多 _LOG_MAX 行）
_installing = False   # 是否正在安装 cloudflared
_LOG_MAX = 200
_QUICK_URL_RE = re.compile(r"https://[A-Za-z0-9-]+\.trycloudflare\.com")
# cloudflared tunnel create 输出：Created tunnel xxx with id <uuid>
_TUNNEL_ID_RE = re.compile(r"with id ([0-9a-fA-F-]{36})")


def _append_log(line: str) -> None:
    line = line.rstrip("\r\n")
    if not line:
        return
    with _lock:
        _log.append(line)
        if len(_log) > _LOG_MAX:
            del _log[: len(_log) - _LOG_MAX]


# ---- cloudflared 可执行文件查找 ----
def find_cloudflared() -> str:
    """返回 cloudflared 可执行文件路径，找不到返回空串。"""
    exe = "cloudflared.exe" if os.name == "nt" else "cloudflared"
    # 1) 环境变量指定
    env_path = os.environ.get("CC_CLOUDFLARED")
    if env_path and Path(env_path).exists():
        return env_path
    # 2) 项目自带（tools 目录）
    local = Path(__file__).parent / "cloudflared" / exe
    if local.exists():
        return str(local)
    # 3) PATH
    found = shutil.which("cloudflared")
    if found:
        return found
    # 4) 常见安装位置
    candidates = []
    if os.name == "nt":
        pf = os.environ.get("ProgramFiles", r"C:\Program Files")
        pf86 = os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)")
        local = os.environ.get("LOCALAPPDATA", str(Path.home() / "AppData" / "Local"))
        candidates = [
            # winget 默认安装位置（实测）：C:\Program Files (x86)\cloudflared\cloudflared.exe
            Path(pf86) / "cloudflared" / "cloudflared.exe",
            Path(pf) / "cloudflared" / "cloudflared.exe",
            # 手动安装可能放在 Cloudflare 子目录
            Path(pf) / "Cloudflare" / "cloudflared.exe",
            Path(pf86) / "Cloudflare" / "cloudflared.exe",
            # winget 便携包 shim
            Path(local) / "Microsoft" / "WinGet" / "Links" / "cloudflared.exe",
            # scoop
            Path.home() / "scoop" / "shims" / "cloudflared.exe",
            Path.home() / "scoop" / "apps" / "cloudflared" / "current" / "cloudflared.exe",
        ]
        # winget 便携包解压目录：...\WinGet\Packages\Cloudflare.cloudflared_*\<ver>\cloudflared.exe
        pkg_root = Path(local) / "Microsoft" / "WinGet" / "Packages"
        if pkg_root.exists():
            for pat in ("Cloudflare.cloudflared*/*/cloudflared.exe",
                        "Cloudflare.cloudflared*/cloudflared.exe"):
                candidates.extend(sorted(pkg_root.glob(pat), reverse=True))
    else:
        candidates = [
            Path("/usr/local/bin/cloudflared"),
            Path("/usr/bin/cloudflared"),
            Path("/opt/homebrew/bin/cloudflared"),
        ]
    for c in candidates:
        if c.exists():
            return str(c)
    return ""


def _cf_version(exe: str) -> str:
    try:
        out = subprocess.run([exe, "--version"], capture_output=True, text=True, timeout=20)
        return (out.stdout or out.stderr).strip().splitlines()[0] if (out.stdout or out.stderr) else ""
    except Exception:
        return ""


# ---- 安装 ----
def install_cloudflared() -> dict:
    """后台线程安装 cloudflared。立即返回，用 status() 轮询进度。"""
    global _installing
    exe = find_cloudflared()
    if exe:
        return {"ok": True, "installed": True, "message": "cloudflared 已安装：%s" % exe}

    with _lock:
        if _installing:
            return {"ok": True, "installing": True, "message": "安装进行中，请稍候刷新查看"}
        _installing = True
        _log.clear()

    def _run():
        global _installing
        try:
            if os.name == "nt":
                _append_log("[install] 正在通过 winget 安装 Cloudflare.cloudflared ...")
                cmd = [
                    "winget", "install", "--id", "Cloudflare.cloudflared", "-e",
                    "--accept-source-agreements", "--accept-package-agreements",
                ]
            elif sys.platform == "darwin":
                _append_log("[install] 正在通过 brew 安装 cloudflared ...")
                cmd = ["brew", "install", "cloudflared"]
            else:
                _append_log("[install] 正在下载 cloudflared 官方二进制 ...")
                cmd = _linux_install_cmd()
                if not cmd:
                    _append_log("[install] 无法自动安装，请手动参考 README 安装 cloudflared")
                    return
            proc = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
            for line in (proc.stdout or "").splitlines():
                _append_log(line)
            for line in (proc.stderr or "").splitlines():
                _append_log(line)
            if proc.returncode == 0:
                _append_log("[install] 安装完成")
            else:
                _append_log("[install] 安装命令返回码 %s，若失败请手动安装" % proc.returncode)
        except FileNotFoundError:
            _append_log("[install] 未找到包管理器（winget/brew），请手动安装 cloudflared")
        except Exception as e:
            _append_log("[install] 安装失败：%s" % e)
        finally:
            with _lock:
                _installing = False
            # 安装后刷新 PATH 缓存：winget 安装的路径可能不在当前进程 PATH 中
            _refresh_path_cache()

    threading.Thread(target=_run, daemon=True).start()
    return {"ok": True, "installing": True, "message": "正在后台安装 cloudflared，请稍候刷新状态"}


def _linux_install_cmd() -> list:
    arch = os.uname().machine
    if arch in ("x86_64", "amd64"):
        suffix = "linux-amd64"
    elif arch in ("aarch64", "arm64"):
        suffix = "linux-arm64"
    else:
        return []
    url = "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-%s" % suffix
    return [
        "sh", "-c",
        "curl -fsSL %s -o /usr/local/bin/cloudflared && chmod +x /usr/local/bin/cloudflared" % url,
    ]


def _refresh_path_cache() -> None:
    """Windows 下 winget 装完后，把常见安装目录加入当前进程 PATH，便于立即找到。"""
    if os.name != "nt":
        return
    local = os.environ.get("LOCALAPPDATA", str(Path.home() / "AppData" / "Local"))
    for p in [
        r"C:\Program Files (x86)\cloudflared",
        r"C:\Program Files\cloudflared",
        r"C:\Program Files\Cloudflare",
        r"C:\Program Files (x86)\Cloudflare",
        os.path.join(local, "Microsoft", "WinGet", "Links"),
        str(Path.home() / "scoop" / "shims"),
    ]:
        if Path(p).exists() and p not in os.environ.get("PATH", ""):
            os.environ["PATH"] = p + os.pathsep + os.environ.get("PATH", "")


# ---- 配置读写 ----
def get_mode() -> str:
    return db.get_setting("tunnel_mode", "quick") or "quick"


def get_hostname() -> str:
    return db.get_setting("tunnel_hostname", "") or ""


def get_tunnel_name() -> str:
    return db.get_setting("tunnel_name", "ccw-console") or "ccw-console"


def get_port() -> int:
    try:
        return int(db.get_setting("tunnel_port", str(config.PORT)))
    except (TypeError, ValueError):
        return config.PORT


def get_autostart() -> bool:
    return db.get_setting("tunnel_autostart", "0") == "1"


def save_settings(mode: str = None, hostname: str = None, name: str = None,
                  port: int = None, autostart: bool = None) -> dict:
    if mode:
        db.set_setting("tunnel_mode", mode)
    if hostname is not None:
        db.set_setting("tunnel_hostname", hostname.strip())
    if name:
        db.set_setting("tunnel_name", name.strip())
    if port:
        db.set_setting("tunnel_port", str(int(port)))
    if autostart is not None:
        db.set_setting("tunnel_autostart", "1" if autostart else "0")
    return {
        "mode": get_mode(),
        "hostname": get_hostname(),
        "name": get_tunnel_name(),
        "port": get_port(),
        "autostart": get_autostart(),
    }


# ---- 进程读取 ----
def _read_stream(stream) -> None:
    global _url
    try:
        for line in iter(stream.readline, ""):
            if not line:
                break
            _append_log(line)
            if _url is None:
                m = _QUICK_URL_RE.search(line)
                if m:
                    with _lock:
                        _url = m.group(0)
    except Exception:
        pass
    finally:
        try:
            stream.close()
        except Exception:
            pass


def _popen_kwargs() -> dict:
    kwargs = {
        "stdout": subprocess.PIPE,
        "stderr": subprocess.STDOUT,
        "text": True,
        "encoding": "utf-8",
        "errors": "replace",
        "bufsize": 1,
    }
    if os.name == "nt":
        kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW  # 0x08000000，避免弹出黑窗
    return kwargs


def is_running() -> bool:
    return _proc is not None and _proc.poll() is None


# ---- 启动 / 停止 ----
def start(mode: str = None, hostname: str = None, port: int = None,
          name: str = None, autostart: bool = None) -> dict:
    """启动穿透。mode: quick | named。"""
    global _proc, _mode, _url, _error

    mode = (mode or get_mode()).strip().lower()
    if mode not in ("quick", "named"):
        return {"ok": False, "error": "模式必须是 quick 或 named"}
    hostname = (hostname or get_hostname()).strip()
    name = (name or get_tunnel_name()).strip()
    port = int(port or get_port())
    if autostart is not None:
        db.set_setting("tunnel_autostart", "1" if autostart else "0")
    save_settings(mode=mode, hostname=hostname, name=name, port=port)

    exe = find_cloudflared()
    if not exe:
        return {"ok": False, "error": "未检测到 cloudflared，请先安装", "need_install": True}

    if is_running():
        return {"ok": True, "running": True, "url": _url, "message": "穿透已在运行"}

    if mode == "named" and not hostname:
        return {"ok": False, "error": "固定域名模式需要填写域名（如 ccw.example.com）"}
    if mode == "named" and not _has_cert():
        return {
            "ok": False,
            "error": "尚未登录 Cloudflare。请在本机终端执行一次：cloudflared tunnel login，"
                     "浏览器完成授权后再回来启用（会生成 cert.pem）。",
            "need_login": True,
        }

    with _lock:
        _error = None
        _url = None
        _log.clear()
        _mode = mode

    try:
        if mode == "quick":
            cmd = [exe, "tunnel", "--no-autoupdate", "--url", "http://127.0.0.1:%d" % port]
        else:
            cfg = _write_named_config(exe, name, hostname, port)
            cmd = [exe, "--config", str(cfg), "tunnel", "--no-autoupdate", "run", name]
        _proc = subprocess.Popen(cmd, **_popen_kwargs())
    except Exception as e:
        with _lock:
            _error = str(e)
        return {"ok": False, "error": "启动失败：%s" % e}

    threading.Thread(target=_read_stream, args=(_proc.stdout,), daemon=True).start()

    # 等待公网地址出现（quick 模式需要 cloudflared 输出 URL）
    if mode == "quick":
        deadline = time.time() + 30
        while time.time() < deadline:
            with _lock:
                if _url or _error:
                    break
            if _proc.poll() is not None:
                break
            time.sleep(0.4)
    else:
        time.sleep(2.0)
        with _lock:
            _url = "https://" + hostname
        if _proc.poll() is not None:
            with _lock:
                _error = _error or "cloudflared 进程已退出，请查看日志"

    with _lock:
        running = is_running()
        return {
            "ok": running,
            "running": running,
            "mode": mode,
            "url": _url,
            "hostname": hostname,
            "port": port,
            "error": _error,
            "log": list(_log[-40:]),
        }


def stop() -> dict:
    """停止穿透。"""
    global _proc, _url, _error
    if not is_running():
        _proc = None
        _url = None
        return {"ok": True, "running": False, "message": "穿透未在运行"}
    pid = _proc.pid
    try:
        _proc.terminate()
        try:
            _proc.wait(timeout=8)
        except subprocess.TimeoutExpired:
            if os.name == "nt":
                subprocess.run(["taskkill", "/F", "/PID", str(pid), "/T"],
                               capture_output=True, timeout=15)
            else:
                _proc.kill()
                _proc.wait(timeout=5)
    except Exception as e:
        with _lock:
            _error = str(e)
    _proc = None
    _url = None
    _append_log("[stop] 穿透已停止")
    return {"ok": True, "running": False, "message": "穿透已停止"}


def _has_cert() -> bool:
    return (CF_DIR / "cert.pem").exists()


def _find_credentials(name: str) -> str:
    """找到 tunnel 凭证 json：优先 <name>.json，其次目录下唯一的 uuid.json。"""
    if not CF_DIR.exists():
        return ""
    direct = CF_DIR / (name + ".json")
    if direct.exists():
        return str(direct)
    uuids = [p for p in CF_DIR.glob("*.json")
             if _TUNNEL_ID_RE.search(p.stem) or re.fullmatch(r"[0-9a-fA-F-]{36}", p.stem)]
    if len(uuids) == 1:
        return str(uuids[0])
    # 多个时优先最近修改的
    if uuids:
        return str(sorted(uuids, key=lambda p: p.stat().st_mtime, reverse=True)[0])
    return ""


def _write_named_config(exe: str, name: str, hostname: str, port: int) -> Path:
    """确保 tunnel 已创建并写好 ingress 配置，返回配置文件路径。"""
    CF_DIR.mkdir(parents=True, exist_ok=True)
    creds = _find_credentials(name)
    if not creds:
        _append_log("[named] 未找到 tunnel 凭证，正在创建 tunnel：%s" % name)
        proc = subprocess.run([exe, "tunnel", "create", name],
                              capture_output=True, text=True, timeout=120)
        out = (proc.stdout or "") + (proc.stderr or "")
        for line in out.splitlines():
            _append_log(line)
        if proc.returncode != 0 and "already exists" not in out.lower():
            raise RuntimeError("创建 tunnel 失败：" + out.strip()[:500])
        time.sleep(1.0)
        creds = _find_credentials(name)
        if not creds:
            raise RuntimeError("创建 tunnel 后仍未找到凭证文件，请检查 %s 目录" % CF_DIR)

    # DNS 路由（幂等；已存在会报 already exists，忽略即可）
    route = subprocess.run([exe, "tunnel", "route", "dns", name, hostname],
                           capture_output=True, text=True, timeout=120)
    route_out = (route.stdout or "") + (route.stderr or "")
    for line in route_out.splitlines():
        _append_log(line)

    creds_posix = str(creds).replace("\\", "/")
    cfg_text = (
        "tunnel: {name}\n"
        "credentials-file: {creds}\n"
        "\n"
        "ingress:\n"
        "  - hostname: {hostname}\n"
        "    service: http://127.0.0.1:{port}\n"
        "  - service: http_status:404\n"
    ).format(name=name, creds=creds_posix, hostname=hostname, port=port)
    CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
    CONFIG_PATH.write_text(cfg_text, encoding="utf-8")
    _append_log("[named] 已写入配置：%s" % CONFIG_PATH)
    return CONFIG_PATH


# ---- 状态 ----
def status() -> dict:
    global _error
    exe = find_cloudflared()
    with _lock:
        running = is_running()
        # 进程意外退出时同步状态
        if _proc is not None and not running and not _error:
            _error = "cloudflared 进程已退出，请查看日志"
        return {
            "installed": bool(exe),
            "installing": _installing,
            "cloudflared_path": exe,
            "cloudflared_version": _cf_version(exe) if exe else "",
            "running": running,
            "mode": _mode or get_mode(),
            "url": _url,
            "hostname": get_hostname(),
            "name": get_tunnel_name(),
            "port": get_port(),
            "autostart": get_autostart(),
            "cert_ready": _has_cert(),
            "error": _error,
            "log": list(_log[-60:]),
        }


def auto_start_if_enabled() -> None:
    """服务启动时按配置自动拉起穿透（后台线程，失败不影响主服务）。"""
    if not get_autostart():
        return

    def _run():
        try:
            time.sleep(1.5)  # 等服务自身监听起来
            if not find_cloudflared():
                _append_log("[auto] 未检测到 cloudflared，跳过自动穿透")
                return
            res = start()
            _append_log("[auto] 自动穿透：%s" % (res.get("url") or res.get("error")))
        except Exception as e:
            _append_log("[auto] 自动穿透失败：%s" % e)

    threading.Thread(target=_run, daemon=True).start()
