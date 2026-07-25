# Arcade Atlas

轻量级机台管理与维修记录系统，围绕 **机台类型 → 具体机台 → 二维码 → 报修记录 → 维修日志** 建立完整维修历史。

## 功能范围

- 后台支持两种登录方式：
  - 用户名 + 密码
  - GitHub OAuth
- 安装脚本会明确要求你二选一完成首次部署
- 如果首次选择用户名 + 密码，部署完成后仍可在后台“认证设置”中补充并启用 GitHub OAuth
- 每台具体机台自动生成唯一 QR Token，并支持下载/重置二维码
- 访客扫码进入机台详情页后，无需登录即可查看最近记录并提交报修
- 后台支持报修状态流转、维修日志追加、机台历史追踪
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

3. 安装依赖并启动：

   ```bash
   npm ci
   npm run dev
   ```

4. 打开浏览器访问：

   - 首页：`http://localhost:3000/`
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

1. 检查系统环境
2. 检查 / 安装 Docker
3. 检查 / 安装 Docker Compose Plugin
4. 要求你选择后台认证方式
5. 生成 `.env`
6. 启动 Docker Compose
7. 启动前检查认证配置是否完整
8. 执行健康检查
9. 输出最终访问地址与登录方式

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

- `GET /machine/:token`
- `POST /machine/:token/repairs`
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
- `GET /api/admin/machine-types`
- `POST /api/admin/machine-types`
- `PATCH /api/admin/machine-types/:id`
- `GET /api/admin/machines`
- `POST /api/admin/machines`
- `GET /api/admin/machines/:id`
- `PATCH /api/admin/machines/:id`
- `POST /api/admin/machines/:id/regenerate-qr`
- `GET /api/admin/repairs`
- `GET /api/admin/repairs/:id`
- `PATCH /api/admin/repairs/:id/status`
- `GET /api/admin/repairs/:id/maintenance-logs`
- `POST /api/admin/repairs/:id/maintenance-logs`

## 部署说明

完整部署文档见 [DEPLOYMENT.md](./DEPLOYMENT.md)。
