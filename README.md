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
| 外网穿透 | 内置 Cloudflare Tunnel，系统页一键启用即得 https 域名，无需公网 IP |
| 扫码访问 | 穿透启用后可一键生成二维码（离线生成，不依赖外网），手机扫码直达 |
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
- 公网：**用下面的 Cloudflare 穿透**，无需公网 IP、无需路由器放行端口

## 外网访问（Cloudflare Tunnel）

在「系统」页最上方的「外网穿透（Cloudflare）」卡片里点一下「启用穿透」，即可拿到一个 https 公网域名。

### 方式一：随机域名（推荐先试这个）

零配置、零成本。启用后 Cloudflare 分配一个 `https://xxxx.trycloudflare.com` 域名，手机、外网任意设备直接访问。

> 域名每次启用都会变；停止后失效。适合临时远程、手机连回去看一眼。

启用后地址右侧有「二维码」按钮，点开即可生成二维码（本地生成，不依赖任何外部服务），手机扫码直接打开；还能下载成 PNG 存着。

### 方式二：固定域名

需要你有一个**托管在 Cloudflare 上的域名**（NS 指向 Cloudflare，免费套餐即可）：

1. 本机终端执行一次授权（只需一次，会打开浏览器让你登录 Cloudflare 并选域名）：

   ```bash
   cloudflared tunnel login
   ```

   Windows 授权文件在 `C:\Users\<你>\.cloudflared\cert.pem`，Linux/macOS 在 `~/.cloudflared/cert.pem`。

2. 系统页选「固定域名」，填入要用的域名（如 `ccw.example.com`），点「启用穿透」。
   程序会自动完成 `tunnel create`、DNS 路由（CNAME）与启动，之后地址固定为 `https://ccw.example.com`。

### 自动启用

勾选「服务启动时自动启用穿透」后，下次启动服务会自动拉起穿透，做到开机即用。

### 命令行启用（不开网页也能用）

```bash
# Windows（PowerShell）
.\enable-tunnel.ps1                                  # 随机域名
.\enable-tunnel.ps1 -Mode named -Hostname ccw.example.com
.\enable-tunnel.ps1 -Stop                            # 停止

# Linux / macOS
./enable-tunnel.sh                                   # 随机域名
./enable-tunnel.sh named ccw.example.com
./enable-tunnel.sh --stop                            # 停止
```

### 安装 cloudflared

系统页会检测，未安装时点「安装 cloudflared」即可（Windows 走 winget、macOS 走 brew、Linux 下官方二进制）。也可手动装：

- Windows：`winget install --id Cloudflare.cloudflared -e`
- macOS：`brew install cloudflared`
- Linux：见 [官方下载页](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)

> 穿透把控制台暴露到公网，**启用前务必先把默认密码改掉**（系统页「修改密码」）。

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
| GET | `/api/tunnel/status` | Cloudflare 穿透状态（是否安装/运行中/公网地址/日志） |
| POST | `/api/tunnel/start` | 启用穿透 `{mode:"quick"\|"named", hostname?, name?, port?, autostart?}` |
| POST | `/api/tunnel/stop` | 停止穿透 |
| POST | `/api/tunnel/config` | 保存穿透配置（含是否随服务自动启用） |
| POST | `/api/tunnel/install` | 后台安装 cloudflared |

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
