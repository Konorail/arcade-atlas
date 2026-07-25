# Arcade Atlas

轻量级机台管理与维修记录系统，围绕**机台类型 → 具体机台 → 二维码 → 报修记录 → 维修日志**建立完整维修历史。

## 功能范围

- 后台通过 OAuth 登录管理机台类型、具体机台、报修记录与维修日志
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

2. 填写 GitHub OAuth 应用配置，并确保回调地址为：

   ```text
   http://localhost:3000/auth/github/callback
   ```

3. 安装依赖并启动：

   ```bash
   npm install
   npm run dev
   ```

4. 打开浏览器访问：

   - 首页：`http://localhost:3000/`
   - 后台登录：`http://localhost:3000/login`

## 部署说明

- 详细部署文档见 [DEPLOYMENT.md](./DEPLOYMENT.md)
- 文档同时提供：
  - Debian / Ubuntu 手动部署
  - Docker Compose 一键部署

## 一键部署脚本

- 推荐先阅读 [DEPLOYMENT.md](./DEPLOYMENT.md) 中的完整说明
- 远程一键拉取并部署：

  ```bash
  bash <(curl -fsSL https://raw.githubusercontent.com/Konorail/arcade-atlas/main/scripts/bootstrap-deploy.sh)
  ```

- 如果你已经在项目目录中，也可以直接运行：

  ```bash
  bash ./scripts/bootstrap-deploy-local.sh --mode docker
  ```

- 脚本会自动完成以下事项：
  - 检查 Debian / Ubuntu 系统版本
  - 检查并安装 Git、curl、Docker / Docker Compose 或 Node.js 所需依赖
  - 检查当前用户权限、端口占用、项目目录与 Git 状态
  - 保留已有 `.env`，仅补齐缺失项，不覆盖已有数据库
  - 提示你填写必须手动提供的配置，例如 `APP_URL`、`GITHUB_CLIENT_ID`、`GITHUB_CLIENT_SECRET`、`OAUTH_ALLOWLIST`
  - 自动执行构建、启动和健康检查

## 关键环境变量

- `APP_URL`：系统对外访问地址，用于拼接二维码访问链接
- `DATABASE_PATH`：SQLite 数据文件路径
- `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`：GitHub OAuth 配置
- `OAUTH_ALLOWLIST`：允许访问后台的 OAuth 用户列表，格式为 `provider:userId`
- `ALLOW_FIRST_LOGIN`：是否允许未在白名单内、且本地不存在的用户首次自动创建

## 主要路径

### 前台

- `GET /machine/:token`：扫码后的机台详情页
- `POST /machine/:token/repairs`：提交报修
- `GET /api/machines/:token`
- `GET /api/machines/:token/repairs`
- `POST /api/machines/:token/repairs`
- `GET /api/machines/:token/maintenance-logs`

### 认证

- `GET /auth/:provider/redirect`
- `GET /auth/:provider/callback`
- `GET /login`
- `GET /logout`

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

## 数据说明

启动时会自动初始化以下核心表：

- `users`
- `machine_types`
- `machines`
- `repair_records`
- `maintenance_logs`
- `admin_sessions`

其中维修日志会同时保存 `repair_record_id` 与 `machine_id`，并由服务端保证与对应报修记录一致。
