# Arcade Atlas 正式部署说明

本文档以 Debian / Ubuntu 正式环境为目标。推荐 Docker Compose；仓库同时支持 Node.js 22 + `nohup`。仓库没有 systemd unit、PM2 配置或独立前端打包器，因此不要使用不存在的命令或假定存在 `build/` 前端产物。

## 1. 发布基线与目录

- Node.js：**22.x**，当前已验证版本为 22.23.2
- npm：Node.js 22 自带 npm 10
- `better-sqlite3`：以 `package-lock.json` 锁定版本为准；当前包要求 Node `>=22`
- 应用入口：`dist/server.js`
- migration 入口：`dist/db.js`
- 模板：`views/`
- 静态资源：`public/`
- 默认数据库：`data/arcade-atlas.sqlite`
- 默认端口：`3000`

Node.js 22 仍处于官方 LTS 支持周期。`better-sqlite3` 为原生模块；其发行包包含常见 LTS 平台预编译文件，但部署仍应准备编译工具，以覆盖当前平台没有可用预编译文件的情况。Dockerfile 安装 `python3 make g++`，Node 脚本安装 `build-essential python3`。

应用使用 `process.cwd()` 解析 `dist/`、`views/`、`public/`、`.env` 和相对数据库路径。所有手工命令必须在仓库根目录执行。

## 2. Linux 准备

一键脚本支持带 `apt` 的 Debian / Ubuntu。手工 Node 部署先安装：

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl git build-essential python3
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v
npm -v
```

`node -v` 必须为 `v22.x`。脚本不会接受更高但未经当前发布流程验证的主版本；此时请切换 Node 版本或使用 Docker。

Docker 部署使用 Docker 官方 APT 仓库。脚本会读取真实 `VERSION_CODENAME`，安装 `docker-ce`、CLI、containerd、Buildx 与 Compose Plugin，并验证 `docker compose version`。仅支持 Docker 官方仓库已经发布对应代号的 Debian / Ubuntu。

## 3. 获取代码

```bash
sudo mkdir -p /opt/arcade-atlas
sudo chown "$USER:$USER" /opt/arcade-atlas
git clone https://github.com/Konorail/arcade-atlas.git /opt/arcade-atlas
cd /opt/arcade-atlas
```

升级时只使用 fast-forward 更新。目录有未提交改动时，一键脚本会拒绝自动拉取，以免覆盖本地文件。

## 4. 环境变量

```bash
cp .env.example .env
chmod 600 .env
```

模板包含：

```env
APP_NAME=Arcade Atlas
APP_URL=http://localhost:3000
PORT=3000
DATABASE_PATH=./data/arcade-atlas.sqlite
AUTH_MODE=local
LOCAL_ADMIN_USERNAME=
LOCAL_ADMIN_PASSWORD_HASH=
LOCAL_ADMIN_PASSWORD_SALT=
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=
OAUTH_ALLOWLIST=
ALLOW_FIRST_LOGIN=false
```

正式环境必须修改 `APP_URL` 为最终 HTTPS 根地址，不带结尾斜杠。`DATABASE_PATH` 的相对路径基于仓库根目录。

认证模式：

- `local`：本地管理员三项必须同时设置
- `github`：GitHub Client ID 和 Secret 必须同时设置
- `both`：两组配置都必须有效

一键脚本会交互生成本地密码的 scrypt 哈希/盐，只把 Base64 结果写入 `.env`，不保存明文。已有 `.env` 不会被模板覆盖；脚本只追加模板中缺失的键，并保留管理员和 OAuth 配置。

GitHub OAuth App：

```text
Homepage URL: https://atlas.example.com
Authorization callback URL: https://atlas.example.com/auth/github/callback
```

`OAUTH_ALLOWLIST` 使用数字 ID，例如 `github:123456,github:789012`。除非明确接受自动建号，否则保持 `ALLOW_FIRST_LOGIN=false`。

## 5. SQLite 路径与权限

Docker 模式必须让数据库位于持久化的 `./data/` 内：

```env
DATABASE_PATH=./data/arcade-atlas.sqlite
```

Compose 映射 `./data:/app/data`。脚本会拒绝 Docker 模式下指向 `data/` 外的路径，避免容器内静默创建新空库。

Node 模式可使用绝对路径，但运行用户必须对数据库文件和父目录有读写权限。SQLite WAL 还会创建 `-wal`、`-shm` 文件，因此只给主文件写权限不够：

```bash
mkdir -p data
chmod 750 data
# 按实际运行用户设置，不要无条件使用 777
chown -R arcade-atlas:arcade-atlas data
```

项目没有文件上传目录。数据库及可能由运维放入 `data/` 的文件是唯一由 Compose 持久化的项目数据；机台类型中的历史 `image` 字段不是当前上传功能。

## 6. 一键 Fresh Install

推荐：

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/Konorail/arcade-atlas/main/scripts/bootstrap-deploy.sh)
```

或者在仓库目录：

```bash
bash ./scripts/bootstrap-deploy-local.sh --mode docker
```

流程：

1. 识别系统、权限、安装状态、Git 和运行服务
2. 安装缺失的 Docker/Compose 或 Node 22 工具链
3. 创建 `.env`，收集 `APP_URL` 和首次认证配置
4. 验证端口、数据库持久化路径和认证配置
5. 执行 `npm ci` / Docker build
6. 执行 `npm run build`
7. 停止旧服务（Fresh install 无旧服务）
8. 执行 `npm run migrate`
9. 启动应用
10. 要求 `/health` 同时返回 HTTP 2xx、`status: ok`、`database.initialized: true`

脚本使用 `set -euo pipefail`，关键安装、构建、migration、启动或 health 失败会停止并输出诊断，不会把数据库异常标记为成功。

## 7. 手工 Docker Compose 部署

```bash
cd /opt/arcade-atlas
docker compose --env-file .env config
docker compose --env-file .env build
docker compose --env-file .env run --rm arcade-atlas npm run migrate
docker compose --env-file .env up -d
docker compose ps
curl -fsS http://127.0.0.1:3000/health
```

Dockerfile 在镜像中运行 `npm ci`、`npm run build`、`npm prune --omit=dev`，启动命令是 `node dist/server.js`，与 `package.json` 一致。Compose healthcheck 使用 Node 内置 `fetch`，数据库未初始化时应用返回 503，容器不会被误判健康。

## 8. 手工 Node 部署

```bash
cd /opt/arcade-atlas
npm ci
npm run lint
npm run build
npm run migrate
mkdir -p .deploy
nohup npm run start > .deploy/app.log 2>&1 &
echo $! > .deploy/arcade-atlas.pid
curl -fsS http://127.0.0.1:3000/health
```

一键脚本的 Node 模式也只支持这个 PID 文件 + `nohup` 方案。停止进程前会校验 PID 的命令行、工作目录或监听端口，无法确认归属就拒绝 `kill`。

仓库没有 systemd unit 或 PM2 配置。本发布不把手写 systemd/PM2 服务视为已验证部署方式；正式环境优先选择 Docker Compose 的 `restart: unless-stopped`。

## 9. Nginx 与 HTTPS

下面是最小 Nginx 反向代理示例：

```nginx
server {
    listen 80;
    server_name atlas.example.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 60s;
    }
}
```

应用端口应只允许反向代理或受信网络访问；Compose 当前会把 `${PORT}` 发布到宿主机，需由防火墙限制公网直连。配置完成后：

```bash
sudo nginx -t
sudo systemctl reload nginx
```

HTTPS 证书由现有基础设施或 Certbot 管理。启用 HTTPS 后同步更新：

- `.env` 的 `APP_URL=https://atlas.example.com`
- GitHub OAuth Homepage URL
- GitHub OAuth callback URL
- Nginx HTTPS server block

然后重启应用。Cookie 是否设置 `Secure` 由 `APP_URL` 是否为 HTTPS 决定，因此该值不能错误地保留为 HTTP。

## 10. 静态资源与模板

Express 从运行工作目录加载：

- `public/styles.css`
- `public/app.js`
- `views/*.ejs`
- `views/partials/*.ejs`

不要只复制 `dist/` 后从另一目录启动；这会丢失模板、静态文件、`VERSION` 和 `.env`。Dockerfile已经复制这些资源。项目没有单独的前端 `dist`，也没有额外 bundler 命令。

## 11. 日志与健康检查

Docker：

```bash
docker compose ps
docker compose logs --tail=200 arcade-atlas
docker inspect --format '{{json .State.Health}}' arcade-atlas
```

Node：

```bash
tail -n 200 .deploy/app.log
cat .deploy/arcade-atlas.pid
```

健康检查：

```bash
curl -i http://127.0.0.1:3000/health
```

成功必须同时满足 HTTP 200、`status: "ok"`、`checks.database: "ok"`、`database.initialized: true`。数据库不完整时返回 HTTP 503。健康响应当前明确显示 Redis 为 `not-configured`，项目不依赖 Redis。

## 12. 备份

一键升级备份位于：

```text
<项目目录>/.deploy/backups/upgrade-YYYYMMDD-HHMMSS/
```

重置/清理前备份默认位于：

```text
/opt/arcade-atlas-backups/<操作>-YYYYMMDD-HHMMSS/
```

备份包含 `.env.backup`、`data/`，并使用 Python SQLite Backup API 覆盖数据库副本后执行 `PRAGMA integrity_check`。`database-source-path.txt` 记录源路径；即使应用使用 WAL，也不会依赖不一致的普通热复制。

人工备份建议在停服后执行，或使用 SQLite 在线 backup API。必须同时保护 `.env`，否则本地管理员和 OAuth 配置无法完整恢复。将备份复制到项目目录之外并定期验证：

```bash
python3 - <<'PY'
import sqlite3
db = sqlite3.connect('/path/to/backup.sqlite')
print(db.execute('PRAGMA integrity_check').fetchone()[0])
db.close()
PY
```

## 13. 安全更新

重新运行一键脚本即可。已安装环境会显示状态，并提供升级、重置、完全清理或退出：

```bash
cd /opt/arcade-atlas
bash ./scripts/bootstrap-deploy-local.sh --mode docker
```

升级保障：

- 以部署状态文件识别已成功部署版本，以 `VERSION` / Git ref 检测代码版本
- 新版本提示确认；取消时不停止当前服务
- 不覆盖 `.env`，不删除 `data/`
- Git 工作树脏时拒绝自动拉取
- 先做一致性备份，再更新代码与构建
- 服务切换顺序：停旧服务 → migration → 启新服务 → strict health
- migration 可重复运行；`schema_migrations` 防止重复转换

Node 模式执行 `npm ci`，因为仓库包含锁文件且正式部署要求可重现依赖；不要用 `npm install` 替代升级流程。Docker build 同样使用 `npm ci`。

## 14. 回滚

脚本不会自动回滚 Git commit 或已构建镜像。migration 失败时会尝试重新启动升级前仍存在的服务实例，但这不是完整代码回滚；如果前面的 migration 已经成功提交了一部分步骤，应先人工判断旧代码是否兼容。

完整回滚流程：

1. 停止当前应用，确认没有进程写数据库
2. 保存失败现场的 `.env`、数据库和日志
3. 从升级前 snapshot 恢复数据库与所需 `data/` 文件
4. 恢复 `.env.backup`（只在确认需要时，避免覆盖事后合法配置）
5. 将代码切回明确记录的上一 commit / release
6. 重新 `npm ci && npm run build` 或重新构建 Docker 镜像
7. 不要让旧代码执行只适用于新版本的 migration
8. 启动并检查 `/health`、登录、机台、报修和维修记录

在没有可恢复备份和明确上一 commit 的情况下，不要执行破坏性数据库回退。

## 15. 数据库升级兼容性

当前 migration 顺序：

1. 重建早期 OAuth-only `users` 表以支持本地认证
2. 创建当前基础表和 migration 记录表
3. 补齐用户认证列与 RBAC；只有无管理员时才提升最早用户
4. 补齐机台类型 `version`
5. 增加机台软删除并移除旧 `location`
6. 扩展报修历史状态并增加软删除
7. 合并旧维修 `result` / `content`，增加软删除
8. 在相关列存在后创建软删除索引

所有结构转换保留主键和外键关系。正式升级前仍必须在数据库副本上运行：

```bash
npm run build
DATABASE_PATH=/path/to/copy.sqlite npm run migrate
```

再检查：

```bash
python3 - <<'PY'
import sqlite3
db = sqlite3.connect('/path/to/copy.sqlite')
print('integrity:', db.execute('PRAGMA integrity_check').fetchone()[0])
print('foreign keys:', db.execute('PRAGMA foreign_key_check').fetchall())
print('migrations:', db.execute('SELECT name, applied_at FROM schema_migrations ORDER BY applied_at').fetchall())
db.close()
PY
```

## 16. 部署后功能检查

至少人工确认：

1. `/health` 为 200 且数据库正常
2. `/` 的真实统计、最近 15 条报修/维修正常
3. `/repairs` 能选择机台
4. 扫码后的 `/machine/:token` 能提交报修
5. `/login` 显示预期认证方式
6. 本地登录或 GitHub OAuth 能进入后台
7. `repair` 只能访问报修/维修；`admin` 可访问认证、机台类型和机台管理
8. 机台详情二维码能下载，重置后旧 token 失效
9. 报修可以流转并新增维修记录
10. 404 页面和未知 API 返回正确格式
11. 公共页面 light/dark、移动布局和浏览器 console 正常

## 17. 常见错误

### `npm ci` 报 `EBADENGINE`

使用 `node -v` 检查，切换到 Node 22.x。不要通过 `--force` 隐藏版本错误。

### `better-sqlite3` / `node-gyp` 失败

```bash
sudo apt-get install -y build-essential python3
node -v
npm ci
```

确认 CPU / libc 平台受支持。没有预编译文件时会从源码构建；关键编译失败不可使用 `--ignore-scripts` 绕过。

### SQLite `readonly database` / `unable to open database file`

检查 `DATABASE_PATH`、父目录存在性与运行用户权限。WAL 需要目录可写。Docker 检查 `./data:/app/data` 挂载。

### health 返回 503

检查日志并重新运行 `npm run migrate`。不要让反向代理把 503 改写为 200。

### GitHub OAuth callback/state 错误

核对 HTTPS `APP_URL`、callback URL、Client Secret、浏览器 Cookie 和系统时间。白名单必须使用数字 ID。

### 所有用户一起被限流

应用对 `/auth`、`/admin`、`/api/admin` 有速率限制。确认反向代理传递真实客户端地址，限制应用端口只允许受信代理访问，并在正式上线前结合代理拓扑验证限流行为。

### 更新被“dirty worktree”阻止

先审查 `git status --short`。提交、备份或移走明确属于运维的改动后，再运行升级；不要强制覆盖未知文件。

### 容器健康但页面不可访问

检查端口映射、防火墙、Nginx upstream 和 `APP_URL`。容器内部 health 只证明应用与数据库可用，不证明外部 DNS / TLS 已正确配置。
