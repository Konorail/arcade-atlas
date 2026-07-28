# Arcade Atlas 部署说明

本文档说明如何在 Debian / Ubuntu 上部署 Arcade Atlas，并重点说明首次安装、已安装检测、版本升级、后台认证、Docker 安装与 Docker Compose Plugin 兼容逻辑。

---

## 一、支持的部署方式

1. **Docker Compose 一键部署**（推荐）
2. **Node.js 手动部署**

---

## 二、后台认证方式

安装时脚本会明确要求你选择其中一种：

1. **用户名 + 密码登录**
2. **GitHub OAuth 登录**

### 1. 用户名 + 密码登录

部署脚本会：

- 询问后台用户名
- 以不回显的方式询问后台密码
- 仅把密码哈希与盐写入 `.env`
- 不会把明文密码输出到终端
- 不会把真实密码写入 Git 仓库

部署完成后，直接使用该用户名和密码访问：

```text
APP_URL/login
```

### 2. GitHub OAuth 登录

脚本会直接告诉你要填写：

- Homepage URL：`APP_URL`
- Authorization callback URL：`APP_URL/auth/github/callback`
- GitHub Client ID 的用途
- GitHub Client Secret 的用途
- GitHub 用户 ID 白名单的填写方式

> 这里填写的是 GitHub 用户 **ID**，不是 GitHub 用户名。  
> 可访问 `https://api.github.com/users/你的GitHub用户名`，查看返回 JSON 中的 `id` 字段。

### 3. 安装后再启用 GitHub OAuth

如果首次部署选择了“用户名 + 密码”，仍然可以在部署完成后进入后台：

```text
/admin/auth-settings
```

在这里补充 GitHub OAuth 配置并切换为：

- `local`
- `github`
- `both`

也就是说，首次认证方式与后续 OAuth 启用已经解耦。

如果是 Docker 部署，后台保存认证配置后，请重启容器再让新配置生效。

---

## 三、关键环境变量

`.env.example` 已与实际代码保持一致：

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

说明：

- `AUTH_MODE`：`local` / `github` / `both`
- `LOCAL_ADMIN_USERNAME`：本地后台用户名
- `LOCAL_ADMIN_PASSWORD_HASH` / `LOCAL_ADMIN_PASSWORD_SALT`：本地后台密码哈希配置
- `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`：GitHub OAuth 配置
- `OAUTH_ALLOWLIST`：允许登录后台的 GitHub 用户列表，例如：`github:123456,github:789012`
- `ALLOW_FIRST_LOGIN`：只影响 GitHub OAuth 首次登录自动建号逻辑
- Docker 部署必须保持 `DATABASE_PATH` 位于仓库的 `./data/` 持久化目录下；推荐值为 `./data/arcade-atlas.sqlite`，容器工作目录是 `/app`，实际会落到 `/app/data/arcade-atlas.sqlite`

`.env` 已被 `.gitignore` 忽略；`.env.example` 仅保留占位符，不包含真实密钥。

---

## 四、Docker / Docker Compose Plugin 安装逻辑

部署脚本会按下面顺序执行：

1. 检查当前系统是否为 Debian / Ubuntu
2. 读取 `/etc/os-release`
3. 读取 `VERSION_CODENAME`
4. 检查项目目录、Git 仓库、`.env`、数据库、当前安装版本
5. 检查 `docker` 是否已安装
6. 检查 `docker compose version` 是否已可用
7. 如果 Plugin 不可用，则动态添加 Docker 官方仓库
8. 安装：
   - `docker-ce`
   - `docker-ce-cli`
   - `containerd.io`
   - `docker-buildx-plugin`
   - `docker-compose-plugin`
9. 安装完成后再次验证 `docker compose version`

### 1. 仓库地址生成规则

不会写死 `bullseye`、`bookworm`、`trixie`。

脚本会动态生成：

```text
https://download.docker.com/linux/<debian-or-ubuntu> ${VERSION_CODENAME} stable
```

例如：

- Debian 11 → `bullseye`
- Debian 12 → `bookworm`
- Debian 13 → `trixie`

### 2. 兼容场景

脚本已针对以下情况做了处理：

- Debian 11 / 12 / 13
- Ubuntu 常见 LTS 版本
- 已安装 Docker、但未安装 Compose Plugin
- 已安装旧版 `docker-compose`
- `docker compose version` 已经可用
- Docker 官方仓库不支持当前 `VERSION_CODENAME`

### 3. 失败时的处理方式

如果某一步失败，脚本会立刻停止，并给出清晰提示，例如：

- `apt update` 失败
- Docker 官方仓库不存在当前系统代号
- Docker GPG Key 配置失败
- Docker 组件安装失败
- Docker 服务启动失败
- `docker compose config` 失败
- 健康检查失败

---

## 五、Docker Compose 部署

### 1. 直接运行脚本

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/Konorail/arcade-atlas/main/scripts/bootstrap-deploy.sh)
```

如果仓库已经在本地：

```bash
bash ./scripts/bootstrap-deploy-local.sh --mode docker
```

### 2. 脚本完成的工作

- 检查系统环境与当前用户权限
- 检测是否为首次安装或已安装环境
- 输出 Git / Docker / Compose / `.env` / 数据库 / 版本检测结果
- 检查或安装 Docker
- 检查或安装 Docker Compose Plugin
- 首次安装时选择后台认证方式
- 自动生成 `.env`，已有 `.env` 则保留现有配置并补齐缺失键
- 已安装环境升级前自动备份 `.env`、数据库文件和 `data/`
- 在启动前预检查认证配置
- 执行 `docker compose config`
- 执行 `docker compose build`
- 停止旧的 `arcade-atlas` 容器
- 执行 `docker compose run --rm arcade-atlas npm run migrate`
- 执行 `docker compose up -d`
- 执行健康检查：`/health`
- 输出版本、服务状态、访问地址与登录方式

### 3. 升级确认与安全策略

如果脚本检测到当前环境已经安装，会继续读取：

- 当前安装版本
- 当前代码版本
- 最新版本

当检测到新版本时，会提示是否升级；如果输入 `N`，脚本会直接退出，不会修改当前环境。

升级过程中会遵循以下规则：

- 不覆盖现有 `.env`
- 不清空数据库文件
- 不删除 `data/` 目录中的用户数据
- 先备份，再拉取代码并完成构建预检查
- 实际服务切换顺序固定为：停止旧服务 → 执行 Migration → 启动新服务 → 健康检查
- 如果 Migration 失败，脚本会输出明确错误，并尝试恢复之前正在运行的服务，避免停在半升级状态

### 4. 持久化数据

`docker-compose.yml` 会把宿主机目录映射到容器：

```text
./data -> /app/data
```

默认情况下，`.env` 中的：

```text
DATABASE_PATH=./data/arcade-atlas.sqlite
```

会在容器内解析为：

```text
/app/data/arcade-atlas.sqlite
```

因此容器重建后数据库仍然保留，只要宿主机 `data` 目录没有删除即可。

如果你从旧的 Node 部署切换到 Docker，而 `.env` 中仍是旧的绝对路径（例如 `/opt/arcade-atlas/data/arcade-atlas.sqlite`），脚本会自动规范化为 `./data/arcade-atlas.sqlite`。如果 `DATABASE_PATH` 指向 `./data/` 之外的位置，脚本会直接停止并要求先迁移数据库，避免容器静默创建新的空数据库。

### 5. 健康检查

项目提供：

```text
GET /health
```

`docker-compose.yml` 已使用该地址配置健康检查。

接口会返回：

- 当前应用版本
- API 状态
- 数据库初始化状态
- Redis 是否启用（当前仓库未启用）
- 基础前端可用状态

---

## 六、Node.js 手动部署

### 1. 安装依赖

```bash
sudo apt-get update
sudo apt-get install -y curl git build-essential python3
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
```

### 2. 安装项目依赖并构建

```bash
npm ci
npm run build
```

### 3. 执行 Migration

在升级现有 Node 服务时，顺序必须是：

1. 先确认升级
2. 备份现有 `.env`、数据库和 `data/`
3. 停止旧服务
4. 执行 `npm run migrate`
5. 重新启动服务
6. 执行健康检查

如果用户取消确认，脚本不会停止当前运行中的 Node 服务。

```bash
npm run migrate
```

### 4. 以 nohup 方式启动服务

```bash
mkdir -p .deploy
nohup npm run start > .deploy/app.log 2>&1 &
echo $! > .deploy/arcade-atlas.pid
```

相关运行文件：

- PID 文件：`.deploy/arcade-atlas.pid`
- 日志文件：`.deploy/app.log`

停止旧的 Node 服务前，脚本会校验 PID 对应进程的命令行、工作目录或监听端口；如果无法确认该 PID 仍属于 Arcade Atlas，则不会执行 `kill`，而是提示用户手动处理。

---

## 七、部署后检查

建议确认：

1. 首页可以打开
2. `/repairs` 可按分类看到机台并进入公开报修页
3. `/health` 返回正常
4. `/health` 中的 `version`、`checks.database` 与 `database.initialized` 正常
5. 首页最近 15 条报修记录与维修记录能自动刷新
6. 公开报修页提交成功后会显示 Toast，失败时会显示错误提示
7. `/login` 能看到正确的登录方式
8. 用户名密码模式下可直接登录后台
9. GitHub OAuth 模式下能正常跳转并回调
10. `/admin/auth-settings` 可查看当前认证配置
11. 数据库文件正确落在 `DATABASE_PATH` 所指位置

---

## 八、常见问题

### 1. `docker compose version` 不可用

请先检查：

```bash
docker compose version
```

如果失败，再检查：

```bash
. /etc/os-release
echo "$ID $VERSION_CODENAME"
cat /etc/apt/sources.list.d/docker.list
sudo apt-get update
```

### 2. GitHub OAuth 回调失败

请确认：

- `APP_URL` 是否正确
- GitHub OAuth App 的 Homepage URL 是否等于 `APP_URL`
- GitHub OAuth App 的 callback URL 是否等于 `APP_URL/auth/github/callback`
- 当前 GitHub 用户 ID 是否已加入 `OAUTH_ALLOWLIST`

### 3. 本地用户名密码无法登录

请确认：

- `AUTH_MODE` 是否为 `local` 或 `both`
- `LOCAL_ADMIN_USERNAME` 是否存在
- `LOCAL_ADMIN_PASSWORD_HASH` 与 `LOCAL_ADMIN_PASSWORD_SALT` 是否存在
- 部署后是否已重启服务

### 4. 健康检查失败

Docker 部署可检查：

```bash
docker compose ps
docker compose logs --tail=200
```

Node 部署可检查：

```bash
cat .deploy/app.log
cat .deploy/arcade-atlas.pid
```
