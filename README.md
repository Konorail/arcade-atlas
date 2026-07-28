# Arcade Atlas

轻量级机台管理与维修记录系统，围绕 **机台类型 → 具体机台 → 二维码 → 报修记录 → 维修日志** 建立完整维修历史。

## 功能范围

- 后台支持两种登录方式：
  - 用户名 + 密码
  - GitHub OAuth
- 安装脚本会明确要求你二选一完成首次部署
- 安装脚本支持首次安装、部署状态检测、版本检测、安全升级、重置部署、完全清理与健康检查
- 如果首次选择用户名 + 密码，部署完成后仍可在后台“认证设置”中补充并启用 GitHub OAuth
- 每台具体机台自动生成唯一 QR Token，并支持下载/重置二维码
- 首页可直接进入公开机台列表，按机台类型选择机台后提交报修
- 访客扫码进入机台详情页后，无需登录即可查看最近记录并以 Toast 反馈提交结果
- 首页会自动轮询最近 15 条报修记录与维修记录
- 后台支持报修状态流转、维修日志追加、机台/报修/维护记录软删除与机台历史追踪
- 服务端严格决定 `machine_id`、`repair_record_id`、`operator_id` 与时间字段

## 技术栈

- Node.js + TypeScript
- Express + EJS
- SQLite（`better-sqlite3`）
- `qrcode` 生成二维码图片

## 本地运行

1. 复制环境变量：

   ```bash
   cp .env.example .env
   ```

2. 选择后台登录方式：

   - **用户名 + 密码**
     - 设置 `AUTH_MODE=local`
     - 填写 `LOCAL_ADMIN_USERNAME`
     - 将密码哈希和盐写入：
       - `LOCAL_ADMIN_PASSWORD_HASH`
       - `LOCAL_ADMIN_PASSWORD_SALT`
     - 推荐直接运行部署脚本生成，不要手动写明文密码

   - **GitHub OAuth**
     - 设置 `AUTH_MODE=github`
     - 填写 `GITHUB_CLIENT_ID`
     - 填写 `GITHUB_CLIENT_SECRET`
     - 填写 `OAUTH_ALLOWLIST`
     - GitHub OAuth 回调地址固定为：

       ```text
       APP_URL/auth/github/callback
       ```

3. 安装依赖并启动开发环境：

   ```bash
   npm ci
   npm run dev
   ```

   如果你要按生产方式手动启动，请执行：

   ```bash
   npm run build
   npm run migrate
   npm run start
   ```

4. 打开浏览器访问：

   - 首页：`http://localhost:3000/`
   - 公开报修入口：`http://localhost:3000/repairs`
   - 后台登录：`http://localhost:3000/login`
   - 健康检查：`http://localhost:3000/health`

## 一键部署脚本

推荐使用仓库提供的部署脚本：

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/Konorail/arcade-atlas/main/scripts/bootstrap-deploy.sh)
```

如果已经在仓库目录中：

```bash
bash ./scripts/bootstrap-deploy-local.sh --mode docker
```

脚本会按以下顺序执行：

1. 检测是否为首次安装、已安装且健康，或已安装但异常
2. 输出 Git / Docker / Compose / `.env` / 数据库 / health check / 版本状态
3. 已安装且健康时提供：升级 / 重置部署 / 完全清理 / 退出
4. 已安装但异常时提示优先执行重置部署恢复
5. 首次安装时生成 `.env` 并要求选择后台认证方式
6. 检查 / 安装 Docker 或 Node.js 运行环境
7. 升级前自动备份 `.env`、数据库文件与 `data/`
8. 重置部署会先备份到 `/opt/arcade-atlas-backups/`，仅清理运行态文件，再继续重新部署
9. 实际切换顺序固定为：停止旧服务 → 执行数据库 Migration → 启动服务 → 健康检查
10. 输出版本、服务状态、访问地址与登录方式

如果检测到新版本，脚本会提示：

```text
当前版本：vX.Y.Z
最新版本：vX.Y.Z
检测到新版本，是否升级？ [y/N]
```

如果选择 `N`，脚本会保留当前环境不变并安全退出。

Node 模式下，任何需要停止旧服务的确认都会发生在停止 `Arcade Atlas` 进程之前；如果用户取消，当前运行服务不会被影响。

### 重置部署与完全清理

- **重置部署**：保留 `.env`、`data/`、SQLite 数据库和业务数据，仅清理 `node_modules`、`dist`、`build`、`.deploy/`、PID / 日志与 `arcade-atlas` 容器，然后继续执行重新部署
- **重置部署备份目录**：`/opt/arcade-atlas-backups/`
- **完全清理**：仅删除 Arcade Atlas 自身代码、配置、数据目录、部署状态文件、容器和镜像，不会执行 `docker system prune`，也不会移除 Docker / Node.js / npm / 系统依赖
- **完全清理前**：脚本会输出完整路径、校验目录签名文件，并要求输入 `DELETE ARCADE ATLAS` 进行二次确认

### Docker Compose Plugin 安装说明

脚本会先检查：

- `docker` 是否存在
- `docker compose version` 是否可用
- 当前系统是否为 Debian / Ubuntu
- `/etc/os-release` 中的 `VERSION_CODENAME`
- Docker 官方 APT 源与 GPG Key 是否存在

如果系统还没有 Compose Plugin，脚本会使用当前真实的 `VERSION_CODENAME` 动态添加 Docker 官方仓库，例如：

```text
https://download.docker.com/linux/debian ${VERSION_CODENAME} stable
```

不会写死 `bullseye`、`bookworm` 或其他版本名。

## 关键环境变量

- `APP_NAME`：站点名称
- `APP_URL`：系统最终访问地址，用于二维码和 OAuth 回调
- `PORT`：应用监听端口
- `DATABASE_PATH`：SQLite 数据文件路径
- `AUTH_MODE`：后台认证模式，支持 `local` / `github` / `both`
- `LOCAL_ADMIN_USERNAME`：本地后台用户名
- `LOCAL_ADMIN_PASSWORD_HASH`：本地后台密码哈希
- `LOCAL_ADMIN_PASSWORD_SALT`：本地后台密码盐
- `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`：GitHub OAuth 配置
- `OAUTH_ALLOWLIST`：允许访问后台的 GitHub 用户列表，格式为 `github:用户ID`
- `ALLOW_FIRST_LOGIN`：是否允许未在白名单内、且本地不存在的 GitHub 用户首次自动创建

## 版本与升级

- 仓库根目录的 `VERSION` 文件用于标记当前应用版本
- `/health` 会返回当前版本、数据库初始化状态和基础服务检查结果
- 升级时脚本不会覆盖现有 `.env`，会优先保留数据库与 `data/` 目录内容
- Docker 模式会强制校验 `DATABASE_PATH` 是否落在容器可访问且持久化的 `./data/` 目录
- 如果从旧的 Node 部署切换到 Docker，脚本会把仓库内 `data/` 目录下的旧绝对路径自动规范化为 `./data/...`
- 如果 `DATABASE_PATH` 指向 Docker 容器外部不可持久化的位置，脚本会直接停止，避免静默创建新的空数据库

## Node nohup 部署说明

- 脚本的 Node 模式会使用 `nohup npm run start` 后台启动服务
- PID 文件位置：`/opt/arcade-atlas/.deploy/arcade-atlas.pid`（本地仓库模式即 `<仓库目录>/.deploy/arcade-atlas.pid`）
- 日志位置：`/opt/arcade-atlas/.deploy/app.log`（本地仓库模式即 `<仓库目录>/.deploy/app.log`）
- 停止旧服务前，脚本会校验 PID 当前进程是否仍属于 Arcade Atlas；若无法确认，则拒绝 `kill`

## Docker 数据目录

- 宿主机持久化目录：`<仓库目录>/data`
- 容器内挂载目录：`/app/data`
- Docker 部署请保持 `DATABASE_PATH=./data/arcade-atlas.sqlite`，对应容器内实际路径 `/app/data/arcade-atlas.sqlite`

## 后台认证设置

部署完成后，进入后台可打开：

- `GET /admin/auth-settings`

你可以在这里：

- 切换后台认证方式
- 补充或修改 GitHub OAuth Client ID / Client Secret
- 修改 GitHub 用户 ID 白名单
- 在首次部署选择“用户名 + 密码”后，后续再启用 GitHub OAuth
- Docker 部署修改认证配置后，请重启容器再让新配置生效

## 主要路径

### 前台

- `GET /`
- `GET /repairs`
- `GET /machine/:token`
- `POST /machine/:token/repairs`
- `GET /api/public/overview`
- `GET /api/machines/:token`
- `GET /api/machines/:token/repairs`
- `POST /api/machines/:token/repairs`
- `GET /api/machines/:token/maintenance-logs`

### 认证

- `GET /login`
- `POST /login`
- `GET /logout`
- `GET /auth/:provider/redirect`
- `GET /auth/:provider/callback`
- `GET /admin/auth-settings`
- `POST /admin/auth-settings`

### 后台

- `GET /admin`
- `GET /admin/machine-types`
- `GET /admin/machines`
- `GET /admin/repairs`
- `GET /admin/maintenance-logs`
- `GET /admin/maintenance-logs/:id`
- `GET /api/admin/machine-types`
- `POST /api/admin/machine-types`
- `PATCH /api/admin/machine-types/:id`
- `GET /api/admin/machines`
- `POST /api/admin/machines`
- `GET /api/admin/machines/:id`
- `PATCH /api/admin/machines/:id`
- `DELETE /api/admin/machines/:id`
- `POST /api/admin/machines/:id/regenerate-qr`
- `GET /api/admin/repairs`
- `GET /api/admin/repairs/:id`
- `PATCH /api/admin/repairs/:id/status`
- `DELETE /api/admin/repairs/:id`
- `GET /api/admin/repairs/:id/maintenance-logs`
- `POST /api/admin/repairs/:id/maintenance-logs`
- `GET /api/admin/maintenance-logs`
- `GET /api/admin/maintenance-logs/:id`
- `DELETE /api/admin/maintenance-logs/:id`

## 部署说明

完整部署文档见 [DEPLOYMENT.md](./DEPLOYMENT.md)。
