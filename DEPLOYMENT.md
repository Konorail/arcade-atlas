# Arcade Atlas 部署说明

本文档提供两种部署方式，并且同时保留：

1. **手动部署**：适合 Debian / Ubuntu 服务器做长期运行、接入 systemd 与 Nginx。
2. **一键部署**：适合快速上线或测试，使用 Docker Compose 直接启动。

如果你希望直接用脚本完成拉取、环境检查、配置补全、安装、启动与健康检查，可以使用仓库内的 [`scripts/bootstrap-deploy.sh`](./scripts/bootstrap-deploy.sh)。

---

## 一、部署前准备

### 1. 服务器建议

- 操作系统：Debian 12+ / Ubuntu 22.04+
- CPU：1 核及以上
- 内存：2 GB 及以上
- 磁盘：至少 5 GB 可用空间
- 网络：可以访问 GitHub OAuth 所需的 GitHub 接口

### 2. 必备信息

部署前请先准备：

- 服务器公网 IP 或域名
- 一个 GitHub OAuth App
- 允许登录后台的 GitHub 用户 ID

### 3. GitHub OAuth 回调地址

系统后台登录依赖 GitHub OAuth。创建 GitHub OAuth App 时，回调地址需要与最终访问地址一致：

- 本地测试示例：`http://localhost:3000/auth/github/callback`
- 生产环境示例：`https://atlas.example.com/auth/github/callback`

只要 `APP_URL` 变化，GitHub OAuth App 中的回调地址也要同步修改。

---

## 二、环境变量说明

部署时至少需要确认以下配置：

```env
APP_NAME=Arcade Atlas
APP_URL=https://atlas.example.com
PORT=3000
DATABASE_PATH=./data/arcade-atlas.sqlite
GITHUB_CLIENT_ID=your-github-client-id
GITHUB_CLIENT_SECRET=your-github-client-secret
OAUTH_ALLOWLIST=github:123456,github:789012
ALLOW_FIRST_LOGIN=false
```

字段说明：

- `APP_NAME`：站点名称
- `APP_URL`：系统对外访问地址，二维码和 OAuth 回调都依赖它
- `PORT`：应用监听端口，通常保持 `3000`
- `DATABASE_PATH`：SQLite 数据库文件路径，默认使用项目目录下的 `./data/arcade-atlas.sqlite`
- `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`：GitHub OAuth 凭据
- `OAUTH_ALLOWLIST`：允许登录后台的 GitHub 用户列表，格式为 `github:用户ID`
- `ALLOW_FIRST_LOGIN`：是否允许首位访问者在不在白名单时自动创建管理员

> 建议生产环境将 `ALLOW_FIRST_LOGIN` 保持为 `false`，并明确配置 `OAUTH_ALLOWLIST`。

---

## 三、方案 A：Debian / Ubuntu 手动部署

以下步骤适用于 Debian / Ubuntu 服务器。

### 1. 安装系统依赖

```bash
sudo apt update
sudo apt install -y curl git build-essential python3 nginx
```

安装 Node.js 22 LTS：

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
```

确认版本：

```bash
node -v
npm -v
```

### 2. 创建部署目录

```bash
sudo mkdir -p /opt/arcade-atlas
sudo chown -R "$USER":"$USER" /opt/arcade-atlas
cd /opt/arcade-atlas
```

将项目代码放入该目录后，目录结构建议如下：

```text
/opt/arcade-atlas/
├── .env
├── data/
├── dist/
├── public/
├── src/
├── views/
├── package.json
└── package-lock.json
```

### 3. 配置环境变量

复制示例文件：

```bash
cp .env.example .env
```

编辑 `.env`：

```bash
nano .env
```

最少需要改成生产环境实际值：

- `APP_URL` 改成真实访问地址
- `DATABASE_PATH` 改成服务器上的持久化路径，例如 `/opt/arcade-atlas/data/arcade-atlas.sqlite`
- `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` 填入真实 OAuth 信息
- `OAUTH_ALLOWLIST` 填入允许登录后台的 GitHub 用户 ID

### 4. 安装依赖并构建

```bash
npm ci
npm run build
```

### 5. 首次前台启动检查

先前台运行一次，确认配置正常：

```bash
npm run start
```

浏览器访问：

- 首页：`http://服务器IP:3000/`
- 登录页：`http://服务器IP:3000/login`

确认可以启动后，按 `Ctrl + C` 停止。

### 6. 配置 systemd 常驻运行

创建服务文件：

```bash
sudo nano /etc/systemd/system/arcade-atlas.service
```

写入以下内容：

```ini
[Unit]
Description=Arcade Atlas
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/arcade-atlas
EnvironmentFile=/opt/arcade-atlas/.env
ExecStart=/usr/bin/node /opt/arcade-atlas/dist/server.js
Restart=always
RestartSec=5
User=www-data
Group=www-data

[Install]
WantedBy=multi-user.target
```

为运行用户准备目录权限：

```bash
sudo chown -R www-data:www-data /opt/arcade-atlas
```

启动并设置开机自启：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now arcade-atlas
sudo systemctl status arcade-atlas
```

查看日志：

```bash
sudo journalctl -u arcade-atlas -f
```

### 7. 配置 Nginx 反向代理

创建站点配置：

```bash
sudo nano /etc/nginx/sites-available/arcade-atlas
```

示例配置：

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
    }
}
```

启用站点并重载：

```bash
sudo ln -s /etc/nginx/sites-available/arcade-atlas /etc/nginx/sites-enabled/arcade-atlas
sudo nginx -t
sudo systemctl reload nginx
```

如果使用 HTTPS，建议再配合证书工具（如 Let's Encrypt）为域名启用 TLS，并将 `APP_URL` 配置为 `https://你的域名`。

### 8. 更新流程

后续更新版本时可按以下顺序执行：

```bash
cd /opt/arcade-atlas
npm ci
npm run build
sudo systemctl restart arcade-atlas
```

### 9. 数据备份

数据库默认为 SQLite 文件，备份时只需要保存 `DATABASE_PATH` 对应的数据库文件及其所在目录即可。

例如：

```bash
cp /opt/arcade-atlas/data/arcade-atlas.sqlite /opt/arcade-atlas/data/arcade-atlas.sqlite.bak
```

---

## 四、方案 B：Docker Compose 一键部署

仓库已提供 `Dockerfile` 和 `docker-compose.yml`，可直接在 Debian / Ubuntu 上一键启动。

### 0. 使用自动部署脚本（推荐）

直接远程执行脚本：

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/Konorail/arcade-atlas/main/scripts/bootstrap-deploy.sh)
```

如果远程脚本下载失败，可回退为先克隆仓库再运行本地脚本：

```bash
git clone https://github.com/Konorail/arcade-atlas.git
cd arcade-atlas
bash ./scripts/bootstrap-deploy-local.sh --mode docker
```

如果已经在项目目录中，可直接运行：

```bash
bash ./scripts/bootstrap-deploy-local.sh --mode docker
```

脚本默认会：

- 检查当前系统是否为 Debian / Ubuntu
- 检查并补装 Git、curl、Docker、Docker Compose 等依赖
- 检查当前用户权限
- 自动 clone 或 pull 项目代码
- 检查 Git 工作区是否干净，避免覆盖本地改动
- 如果已在仓库目录中运行本地脚本，会直接使用当前目录并跳过 Git 更新
- 检查 `.env` 是否存在，并仅补齐缺失配置
- 保留已有数据库和重要配置
- 对必须由用户提供的配置进行提示或交互输入
- 在启动前提醒可能影响现有服务的操作
- 启动容器并自动做健康检查

支持参数：

```bash
bash ./scripts/bootstrap-deploy.sh --mode docker --target-dir /opt/arcade-atlas
```

### 1. 安装 Docker 与 Compose

```bash
sudo apt update
sudo apt install -y docker.io docker-compose-plugin
sudo systemctl enable --now docker
```

### 2. 准备项目与环境变量

进入项目目录：

```bash
cd /opt/arcade-atlas
```

复制环境变量模板：

```bash
cp .env.example .env
```

至少修改以下字段：

- `APP_URL`
- `GITHUB_CLIENT_ID`
- `GITHUB_CLIENT_SECRET`
- `OAUTH_ALLOWLIST`

`docker-compose.yml` 会自动将容器内数据库路径固定为 `/app/data/arcade-atlas.sqlite`，并跟随 `.env` 中的 `PORT` 暴露对应端口，因此一键部署时通常无需额外修改 `DATABASE_PATH`。

### 3. 一键启动

```bash
docker compose up -d --build
```

启动后可查看状态：

```bash
docker compose ps
docker compose logs -f
```

默认会：

- 构建应用镜像
- 自动安装依赖并编译 TypeScript
- 将宿主机 `./data` 目录挂载到容器 `/app/data`
- 对外暴露 `3000` 端口

### 4. 访问系统

浏览器访问：

- `http://服务器IP:3000/`
- `http://服务器IP:3000/login`

如果前面接了 Nginx 或云负载均衡，请把 `APP_URL` 设置为最终对外域名。

### 5. 停止与更新

停止服务：

```bash
docker compose down
```

更新并重新部署：

```bash
docker compose down
docker compose up -d --build
```

### 6. 数据持久化

`docker-compose.yml` 已将数据库目录映射到宿主机：

```text
./data -> /app/data
```

因此重建容器不会丢失 SQLite 数据，但删除宿主机 `data` 目录会导致数据库丢失。

---

## 五、部署后检查清单

部署完成后建议逐项确认：

- 首页可以正常打开
- `/login` 可以跳转到 GitHub OAuth
- OAuth 回调后可以进入 `/admin`
- 新建机台后可以打开二维码对应页面
- 提交报修后后台可以看到记录
- 数据库文件已按预期落在 `DATABASE_PATH` 指定位置

---

## 六、常见问题

### 1. 登录后提示无法进入后台

优先检查：

- `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` 是否填写正确
- GitHub OAuth 回调地址是否与 `APP_URL` 完全一致
- 当前 GitHub 用户 ID 是否已经加入 `OAUTH_ALLOWLIST`

### 2. 二维码打开后地址不正确

通常是 `APP_URL` 配置错误。修改后重启应用即可。

### 3. 数据库文件没有生成

请检查：

- `DATABASE_PATH` 是否可写
- 运行用户是否有目录权限
- Docker 部署时宿主机 `./data` 目录是否可写

### 4. 端口无法访问

请检查：

- 应用是否已启动
- `PORT` 是否与反向代理配置一致
- 服务器防火墙 / 安全组是否放行对应端口
