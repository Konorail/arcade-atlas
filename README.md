# Arcade Atlas

Arcade Atlas 是一个轻量级机台管理与维修记录系统，围绕“机台类型 → 具体机台 → 二维码 → 公开报修 → 状态流转 → 维修记录”保存可追溯历史。

## 当前功能

- 本地用户名密码、GitHub OAuth 或两者并用的后台登录
- `user` / `repair` / `admin` RBAC；机台和认证设置仅管理员可操作
- 机台类型、机台、唯一 QR Token、二维码下载与重置
- 扫码进入公共机台页、无需登录提交报修、查看近期记录
- 报修状态流转：`PENDING` → `PROCESSING` → `RESOLVED`
- 历史 `UNRESOLVED` 状态只保留展示，不允许作为新的流转目标
- 维修记录、机台历史、软删除与关联历史保护
- 首页展示真实机台总数、待处理报修、本月维修、较上月变化，以及最近 15 条报修和维修记录
- `/health`、公共 API 与受 RBAC 保护的后台 API

首页统计全部来自 SQLite：机台总数排除已软删除机台；待处理报修包含 `PENDING`、`PROCESSING`；月度维修按服务器本地自然月边界统计，并排除已软删除的机台、报修和维修记录。

## 运行基线

- **Node.js 22.x**（当前发布验证基线）
- npm 10（Node.js 22 官方自带版本即可）
- SQLite，由锁文件中的 `better-sqlite3` 提供
- Debian / Ubuntu 是一键部署脚本支持的 Linux 系统

`better-sqlite3` 是原生模块。Linux 手工部署需要 `python3`、`make`、`g++`；仓库的 Dockerfile 和 Node 部署脚本会准备相应构建工具。不要在生产环境跳过依赖安装脚本。

## 本地开发

1. 安装 Node.js 22.x。
2. 创建配置：

   ```bash
   cp .env.example .env
   ```

3. 至少配置一种认证方式。GitHub OAuth 见下文；本地登录需同时填写 `LOCAL_ADMIN_USERNAME`、`LOCAL_ADMIN_PASSWORD_HASH`、`LOCAL_ADMIN_PASSWORD_SALT`。部署脚本可以交互生成密码哈希，且不会保存明文密码。
4. 安装、迁移并启动：

   ```bash
   npm ci
   npm run build
   npm run migrate
   npm run dev
   ```

生产方式启动：

```bash
npm run build
npm run migrate
npm run start
```

默认地址：

- 首页：`http://localhost:3000/`
- 公开报修入口：`http://localhost:3000/repairs`
- 后台登录：`http://localhost:3000/login`
- 健康检查：`http://localhost:3000/health`

`npm run dev` 和 `npm run start` 在加载数据库模块时也会执行幂等 migration，但正式部署仍应显式执行 `npm run migrate`，让失败发生在服务切换之前。

## 可用 npm 命令

| 命令 | 用途 |
| --- | --- |
| `npm run dev` | 使用 `tsx watch` 启动开发服务 |
| `npm run lint` | TypeScript `--noEmit` 静态检查 |
| `npm run build` | 编译 `src/` 到 `dist/` |
| `npm run migrate` | 运行 `dist/db.js` 的数据库初始化与 migration |
| `npm run start` | 运行 `dist/server.js` |

项目当前没有 `npm test` 脚本。

## 环境变量

| 变量 | 说明 | 默认值 |
| --- | --- | --- |
| `APP_NAME` | 站点名称 | `Arcade Atlas` |
| `APP_URL` | 对外完整根地址；用于二维码和 OAuth callback | `http://localhost:3000` |
| `PORT` | HTTP 监听端口 | `3000` |
| `DATABASE_PATH` | SQLite 文件；相对路径基于项目工作目录 | `./data/arcade-atlas.sqlite` |
| `AUTH_MODE` | `local` / `github` / `both` | 无 GitHub 配置时为 `local` |
| `LOCAL_ADMIN_USERNAME` | 本地管理员用户名 | 空 |
| `LOCAL_ADMIN_PASSWORD_HASH` | scrypt 密码哈希（Base64） | 空 |
| `LOCAL_ADMIN_PASSWORD_SALT` | scrypt 盐（Base64） | 空 |
| `GITHUB_CLIENT_ID` | GitHub OAuth Client ID | 空 |
| `GITHUB_CLIENT_SECRET` | GitHub OAuth Client Secret | 空 |
| `OAUTH_ALLOWLIST` | 允许登录的 `github:用户ID`，逗号分隔 | 空 |
| `ALLOW_FIRST_LOGIN` | 是否允许不在白名单中的 OAuth 用户首次建号 | `false` |

相关变量必须成组配置。本地管理员三项缺任意一项、GitHub Client 两项缺任意一项，应用都会明确报错并停止。

GitHub OAuth App 应配置：

```text
Homepage URL: APP_URL
Authorization callback URL: APP_URL/auth/github/callback
```

白名单使用 GitHub 数字用户 ID，而不是用户名。空数据库中的首个获准 OAuth 用户会成为管理员；后续自动创建用户为普通用户。已有本地管理员会按相同用户名更新密码哈希，不会重置其他业务数据。

## 数据库与 migration

- 默认数据库：`./data/arcade-atlas.sqlite`
- 启动时启用 WAL 与外键检查
- `schema_migrations` 记录已执行 migration；重复运行具有幂等性
- migration 会保留旧 OAuth 用户、RBAC、机台类型、机台、QR Token、报修、维修记录和 session
- 旧字段只在已有 migration 中转换；无需手工修改数据库结构
- 不要把正在使用的 SQLite 主文件当作普通文件热复制；使用部署脚本备份，或停服后连同数据库状态一起备份

## 一键安装与升级

从服务器直接运行（默认 Docker 模式）：

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/Konorail/arcade-atlas/main/scripts/bootstrap-deploy.sh)
```

仓库已经存在时：

```bash
bash ./scripts/bootstrap-deploy-local.sh --mode docker
# 或使用脚本实际支持的 Node + nohup 模式
bash ./scripts/bootstrap-deploy-local.sh --mode node
```

脚本只支持 Debian / Ubuntu，并使用 `set -euo pipefail`。它会检测安装状态、Git 状态、运行模式、health、部署状态文件和版本；保留现有 `.env`，只补充缺失键；升级前用 SQLite Backup API 创建一致性数据库快照并备份 `data/`；随后执行 build、停旧服务、migration、启动和严格 health 检查。

脚本以根目录 `VERSION` 识别代码版本，以 `.deploy/deployment-state.env` 记录已成功部署版本。存在未提交代码时拒绝自动 `git pull`。关键失败不会静默继续。

升级命令、备份位置、重置/清理边界和回滚限制见 [DEPLOYMENT.md](./DEPLOYMENT.md)。仓库没有 systemd unit 或 PM2 配置；正式环境优先使用 Docker Compose，Node 模式仅使用脚本实现的 PID 文件与 `nohup`。

## 主要路由

公共页面和 API：

- `GET /`、`GET /login`、`GET /repairs`
- `GET /machine/:token`、`POST /machine/:token/repairs`
- `GET /api/public/overview`
- `GET /api/machines/:token`
- `GET|POST /api/machines/:token/repairs`
- `GET /api/machines/:token/maintenance-logs`

后台页面：

- `/admin`
- `/admin/auth-settings`
- `/admin/machine-types`、`/admin/machine-types/:id`
- `/admin/machines`、`/admin/machines/:id`
- `/admin/repairs`、`/admin/repairs/:id`
- `/admin/maintenance-logs`、`/admin/maintenance-logs/:id`

后台 API 使用对应的 `/api/admin/...` 路径并执行相同 RBAC。未知页面返回项目错误页，未知 API 返回 JSON 404。

## 常见问题

- **`EBADENGINE`**：确认 `node -v` 为 `v22.x`，不要用未经本发布流程验证的主版本。
- **`better-sqlite3` / `node-gyp` 安装失败**：Linux 安装 `build-essential python3`；Windows 本地开发需要 Visual Studio 的“Desktop development with C++”，或使用 Docker。
- **health 返回 503**：检查 `DATABASE_PATH`、目录权限和 migration；数据库未完整初始化不会被视为健康。
- **OAuth callback 失败**：确认 `APP_URL` 与 GitHub OAuth App 完全一致，并检查数字用户 ID 白名单。
- **后台被重定向到 `/login`**：session 无效或未登录；403 表示已登录但 RBAC 角色不足。
- **Docker 重建后出现空库**：确认 `DATABASE_PATH=./data/arcade-atlas.sqlite` 且 `./data:/app/data` 挂载存在，不要把数据库指向容器未持久化路径。
- **端口被占用**：修改 `.env` 的 `PORT`，并同步反向代理 upstream。

正式部署、HTTPS、Nginx、日志、备份、更新与回滚请阅读 [DEPLOYMENT.md](./DEPLOYMENT.md)。
