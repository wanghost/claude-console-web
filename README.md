# Claude Console Web

轻量级 Claude Code 远程操控台。本地浏览文件、查看/回复正在运行的 Claude 会话，手机通过浏览器远程访问（配合固定公网 IP或内网穿透）。

> 跨平台：支持 Windows、Linux、macOS（Python 3.9+）。会话路径解析已兼容 Windows 盘符与 Linux 绝对路径两种转义格式。

## 功能

| 功能 | 说明 |
|------|------|
| 文件浏览 | 浏览本地目录树、查看/编辑文本文件 |
| 会话查看 | 列出 Claude Code 的所有历史会话，查看消息内容 |
| 会话回复 | 对指定会话发消息，用 `claude -p --resume` 继续该会话 |
| 会话参数 | 回复/新建时可切换模型、权限模式、Effort |
| 新建会话 | 选工作目录 + 输入首条消息，用 `claude -p --session-id` 开启全新会话 |
| 会话目录联动 | 会话详情页一键「打开所在目录」，直接跳到该会话的项目目录浏览文件 |
| 系统管理 | 在线修改登录密码（改后强制其他设备下线）、设置默认工作目录（存 SQLite） |
| 鉴权 | 账号密码登录，登录态存 cookie |
| 移动端 | 响应式界面，手机浏览器可直接用 |

## 快速开始（一键启动）

### 方式一：一键启动脚本（推荐）

- **Windows**：双击 `start.bat`
- **Linux / macOS**：`bash start.sh`

脚本会自动：

1. 检查 Python 环境
2. 首次运行时自动创建虚拟环境并安装依赖
3. 获取本机局域网 IP
4. 以 `0.0.0.0` 启动服务（支持局域网/公网访问）
5. 自动打开浏览器（Windows 版）

启动后命令行会显示本机访问地址和局域网访问地址（手机同一 WiFi 下用局域网地址）。

### 方式二：手动启动

Windows：

```bash
cd claude-console-web
python -m venv venv
venv\Scripts\python.exe -m pip install -r requirements.txt
venv\Scripts\python.exe -m uvicorn main:app --host 0.0.0.0 --port 8080
```

Linux / macOS：

```bash
cd claude-console-web
python3 -m venv venv
venv/bin/pip install -r requirements.txt
venv/bin/python -m uvicorn main:app --host 0.0.0.0 --port 8080
```

> 依赖：fastapi、uvicorn、itsdangerous、python-multipart

### 修改密码（务必）

登录后点顶部「系统」标签，在「系统管理」里在线修改密码、设置默认工作目录。配置会持久化到 SQLite（`console.db`，位于程序当前目录下）。

> 也可以在首次启动前用环境变量指定初始值（之后以数据库为准）：

Windows：

```bash
set CC_USERNAME=你的账号
set CC_PASSWORD=你的初始密码
set CC_SECRET=一段随机字符串
set CC_ROOT=D:\Workspace
```

Linux / macOS：

```bash
export CC_USERNAME=你的账号
export CC_PASSWORD=你的初始密码
export CC_SECRET=一段随机字符串
export CC_ROOT=/home/you/workspace
```

### 访问

- 本机：`http://localhost:8080`
- 手机：`http://<电脑的局域网IP>:8080`（同一 WiFi）
- 公网：`http://<电脑的公网IP>:8080`（需在路由器/防火墙放行 8080 端口）

## 配置项（config.py，均可用环境变量覆盖）

| 环境变量 | 默认值 | 说明 |
|----------|--------|------|
| `CC_HOST` | `0.0.0.0` | 监听地址，公网访问需 0.0.0.0 |
| `CC_PORT` | `8080` | 端口 |
| `CC_USERNAME` | `admin` | 登录账号 |
| `CC_PASSWORD` | `admin123` | 登录密码（务必改） |
| `CC_SECRET` | - | 会话签名密钥（务必改） |
| `CC_ROOT` | `D:\Workspace`（Windows）/ `~/workspace`（Linux） | 文件浏览根目录，可改为任意目录 |
| `CC_CLAUDE_CLI` | `claude` | claude 命令路径 |
| `CC_REPLY_TIMEOUT` | `600` | 会话回复超时（秒） |

## 配置存储

系统配置（用户名、密码哈希、默认工作目录、签名密钥）存储在 SQLite 数据库 `console.db`（程序当前目录下）的 `settings` 表中：

- **密码**：PBKDF2-HMAC-SHA256（20 万次迭代）哈希存储，不存明文
- **默认工作目录**：在线修改后立即生效（文件浏览、新建会话目录列表随之更新）
- **环境变量**：`CC_USERNAME`/`CC_PASSWORD`/`CC_ROOT`/`CC_SECRET` 仅作为**首次初始化**的默认值，之后以数据库为准

## API 一览

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/login` | 登录 `{username, password}` |
| POST | `/api/logout` | 退出 |
| GET | `/api/fs/list?path=` | 列目录 |
| GET | `/api/fs/read?path=` | 读文件 |
| POST | `/api/fs/write` | 写文件 `{path, content}` |
| GET | `/api/sessions` | 会话列表 |
| GET | `/api/sessions/dirs` | 新建会话可选目录 |
| GET | `/api/sessions/options` | 可切换的模型/权限模式/Effort 取值 |
| POST | `/api/sessions` | 新建会话 `{cwd, prompt, model?, permission_mode?, effort?}` |
| GET | `/api/sessions/{id}` | 会话消息历史（含 cwd） |
| GET | `/api/sessions/{id}/cwd` | 会话工作目录对应的文件路径 |
| POST | `/api/sessions/{id}/reply` | 回复会话 `{prompt, model?, permission_mode?, effort?}` |
| GET | `/api/jobs/{job_id}` | 查询回复任务进度 |
| GET | `/api/admin/settings` | 查看系统配置（脱敏） |
| POST | `/api/admin/password` | 修改密码 `{old_password, new_password}` |
| POST | `/api/admin/root` | 修改默认工作目录 `{root_dir}` |

## 会话回复的实现原理

Claude Code 的会话记录在 `~/.claude/projects/<项目>/<session-id>.jsonl`，每行一条 JSON 消息。回复会话时，后端执行：

```bash
claude -p "你的消息" --resume <session-id> --output-format text
```

在会话所属的项目目录下以「print 模式」续接该会话，跑一轮问答后返回结果。前端轮询 `/api/jobs/{job_id}` 获取进度，完成后刷新会话展示新消息。

## 安全建议

1. **务必修改默认密码**：首次登录后到「系统」标签修改，否则任何人扫到你的公网 IP 就能登录。
2. 建议把默认工作目录限制到指定目录（如 `D:\Workspace`），而非整个磁盘。
3. 生产环境建议在前面套一层 HTTPS（如 Caddy/Nginx 反代 + 证书）。
4. 如无公网访问需求，把 `CC_HOST` 设为 `127.0.0.1` 仅本机访问。

## 后续可扩展

- 插件管理（`claude plugin` 命令 + `~/.claude/plugins/` 目录）
- 会话实时状态（解析 `sessions/` 目录判断是否在运行）
- 多用户、权限分级
- 更多配置项入 SQLite（回复超时、CLI 路径等）
