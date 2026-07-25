#!/usr/bin/env bash

set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/Konorail/arcade-atlas.git}"
TARGET_DIR="${TARGET_DIR:-/opt/arcade-atlas}"
MODE="${MODE:-docker}"
NON_INTERACTIVE=0
ASSUME_YES=0
SKIP_GIT_UPDATE=0
SUDO=""
DOCKER_BIN=(docker)

log() {
  printf '[INFO] %s\n' "$*"
}

warn() {
  printf '[WARN] %s\n' "$*" >&2
}

error() {
  printf '[ERROR] %s\n' "$*" >&2
}

die() {
  error "$*"
  exit 1
}

usage() {
  cat <<'EOF'
用法：
  bash scripts/bootstrap-deploy.sh [选项]

选项：
  --mode <docker|node>       部署模式，默认 docker
  --target-dir <path>        项目目录，默认 /opt/arcade-atlas
  --repo-url <url>           仓库地址，默认官方 GitHub 仓库
  --non-interactive          非交互模式，缺少必须配置时直接失败
  --yes                      对安装和启动类确认默认回答 yes
  --skip-git-update          跳过 git clone/pull，适合当前目录已有代码时使用
  --help                     显示帮助

示例：
  bash <(curl -fsSL https://raw.githubusercontent.com/Konorail/arcade-atlas/main/scripts/bootstrap-deploy.sh)
  bash scripts/bootstrap-deploy.sh --mode docker --target-dir /opt/arcade-atlas
EOF
}

confirm() {
  local prompt="$1"
  if [[ "$ASSUME_YES" -eq 1 ]]; then
    log "$prompt [auto-yes]"
    return 0
  fi

  if [[ "$NON_INTERACTIVE" -eq 1 ]]; then
    return 1
  fi

  local answer
  read -r -p "$prompt [y/N] " answer
  [[ "$answer" =~ ^[Yy]([Ee][Ss])?$ ]]
}

require_command() {
  local command_name="$1"
  command -v "$command_name" >/dev/null 2>&1 || die "缺少命令：$command_name"
}

ensure_sudo() {
  if [[ "$(id -u)" -eq 0 ]]; then
    SUDO=""
    return
  fi

  require_command sudo
  if ! sudo -v; then
    die "当前用户没有可用的 sudo 权限，无法继续安装依赖或启动服务。"
  fi
  SUDO="sudo"
}

install_apt_packages() {
  local packages=("$@")
  local missing=()
  local package

  for package in "${packages[@]}"; do
    if ! dpkg -s "$package" >/dev/null 2>&1; then
      missing+=("$package")
    fi
  done

  if [[ "${#missing[@]}" -eq 0 ]]; then
    log "系统依赖已满足：${packages[*]}"
    return
  fi

  warn "缺少系统依赖：${missing[*]}"
  confirm "将通过 apt 自动安装以上依赖，是否继续？" || die "用户取消安装依赖。"
  ensure_sudo
  $SUDO apt-get update
  $SUDO apt-get install -y "${missing[@]}"
}

detect_os() {
  [[ -f /etc/os-release ]] || die "无法识别当前系统。"
  # shellcheck disable=SC1091
  source /etc/os-release

  case "${ID:-}" in
    debian|ubuntu)
      log "检测到系统：${PRETTY_NAME:-$ID}"
      ;;
    *)
      die "当前脚本仅支持 Debian / Ubuntu，检测到：${PRETTY_NAME:-unknown}"
      ;;
  esac
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --mode)
        MODE="${2:-}"
        shift 2
        ;;
      --target-dir)
        TARGET_DIR="${2:-}"
        shift 2
        ;;
      --repo-url)
        REPO_URL="${2:-}"
        shift 2
        ;;
      --non-interactive)
        NON_INTERACTIVE=1
        shift
        ;;
      --yes)
        ASSUME_YES=1
        shift
        ;;
      --skip-git-update)
        SKIP_GIT_UPDATE=1
        shift
        ;;
      --help|-h)
        usage
        exit 0
        ;;
      *)
        die "未知参数：$1"
        ;;
    esac
  done

  case "$MODE" in
    docker|node) ;;
    *)
      die "--mode 仅支持 docker 或 node"
      ;;
  esac
}

ensure_base_commands() {
  install_apt_packages ca-certificates curl git
  require_command git
  require_command curl
}

clone_or_update_repo() {
  local parent_dir
  parent_dir="$(dirname "$TARGET_DIR")"

  if [[ ! -d "$parent_dir" ]]; then
    ensure_sudo
    $SUDO mkdir -p "$parent_dir"
  fi

  if [[ ! -w "$parent_dir" ]] && [[ ! -d "$TARGET_DIR" ]]; then
    ensure_sudo
    $SUDO mkdir -p "$TARGET_DIR"
    $SUDO chown "$(id -u):$(id -g)" "$TARGET_DIR"
  fi

  if [[ "$SKIP_GIT_UPDATE" -eq 1 ]]; then
    [[ -d "$TARGET_DIR" ]] || die "指定了 --skip-git-update，但目录不存在：$TARGET_DIR"
    [[ -d "$TARGET_DIR/.git" ]] || die "指定了 --skip-git-update，但目录不是 Git 仓库：$TARGET_DIR"
    local status
    status="$(git -C "$TARGET_DIR" status --porcelain)"
    if [[ -n "$status" ]]; then
      warn "当前项目目录存在未提交改动，脚本将保留这些文件并跳过 Git 更新。"
    else
      log "当前项目目录 Git 状态干净。"
    fi
    log "已跳过 Git 拉取，使用现有目录：$TARGET_DIR"
    return
  fi

  if [[ -d "$TARGET_DIR/.git" ]]; then
    log "检测到已有仓库：$TARGET_DIR"
    local status
    status="$(git -C "$TARGET_DIR" status --porcelain)"
    if [[ -n "$status" ]]; then
      die "项目目录存在未提交改动，已停止以避免覆盖用户文件：$TARGET_DIR"
    fi

    confirm "将执行 git pull --ff-only 更新项目，这可能影响当前服务，是否继续？" || die "用户取消更新项目。"
    git -C "$TARGET_DIR" pull --ff-only
    return
  fi

  if [[ -e "$TARGET_DIR" ]] && [[ -n "$(find "$TARGET_DIR" -mindepth 1 -maxdepth 1 2>/dev/null)" ]]; then
    die "目标目录已存在且非空，为避免覆盖数据已停止：$TARGET_DIR"
  fi

  confirm "将克隆项目到 $TARGET_DIR，是否继续？" || die "用户取消克隆项目。"
  git clone "$REPO_URL" "$TARGET_DIR"
}

append_missing_env_keys() {
  local env_file="$1"
  local example_file="$2"
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -z "$line" || "$line" == \#* ]] && continue
    local key="${line%%=*}"
    grep -qE "^${key}=" "$env_file" || printf '%s\n' "$line" >>"$env_file"
  done <"$example_file"
}

read_env_value() {
  local env_file="$1"
  local key="$2"
  awk -F= -v target="$key" '$1 == target {print substr($0, index($0, "=") + 1)}' "$env_file" | tail -n 1
}

validate_http_url() {
  local value="$1"
  [[ "$value" =~ ^https?://[^[:space:]]+$ ]] || die "APP_URL 必须是合法的 http:// 或 https:// 地址。"
}

validate_port_value() {
  local value="$1"
  [[ "$value" =~ ^[0-9]+$ ]] || die "PORT 必须是 1-65535 之间的整数。"
  if (( value < 1 || value > 65535 )); then
    die "PORT 必须是 1-65535 之间的整数。"
  fi
}

set_env_value() {
  local env_file="$1"
  local key="$2"
  local value="$3"
  local temp_file
  temp_file="$(mktemp)"
  awk -v target="$key" -v replacement="$value" -F= '
    BEGIN { found = 0 }
    $1 == target {
      print target "=" replacement
      found = 1
      next
    }
    { print $0 }
    END {
      if (!found) {
        print target "=" replacement
      }
    }
  ' "$env_file" >"$temp_file"
  mv "$temp_file" "$env_file"
}

prompt_value() {
  local env_file="$1"
  local key="$2"
  local prompt="$3"
  local current_value="$4"
  local allow_empty="${5:-0}"
  local new_value="$current_value"

  if [[ "$NON_INTERACTIVE" -eq 1 ]]; then
    if [[ -z "$new_value" && "$allow_empty" -ne 1 ]]; then
      die "缺少必须配置：$key"
    fi
    return
  fi

  if [[ -n "$current_value" ]]; then
    read -r -p "$prompt [$current_value]: " new_value
    new_value="${new_value:-$current_value}"
  else
    read -r -p "$prompt: " new_value
  fi

  if [[ -z "$new_value" && "$allow_empty" -ne 1 ]]; then
    die "配置 $key 不能为空。"
  fi

  set_env_value "$env_file" "$key" "$new_value"
}

prepare_env_file() {
  local env_file="$TARGET_DIR/.env"
  local example_file="$TARGET_DIR/.env.example"
  [[ -f "$example_file" ]] || die "缺少环境变量模板：$example_file"

  if [[ ! -f "$env_file" ]]; then
    cp "$example_file" "$env_file"
    log "已创建 .env：$env_file"
  else
    log "检测到已有 .env，将保留现有配置并补全缺失项。"
  fi

  append_missing_env_keys "$env_file" "$example_file"

  local default_database_path
  if [[ "$MODE" == "docker" ]]; then
    default_database_path="/app/data/arcade-atlas.sqlite"
  else
    default_database_path="$TARGET_DIR/data/arcade-atlas.sqlite"
  fi

  local app_url
  app_url="$(read_env_value "$env_file" "APP_URL")"
  if [[ -z "$app_url" || "$app_url" == "http://localhost:3000" ]]; then
    [[ "$NON_INTERACTIVE" -eq 1 ]] && die "必须配置 APP_URL，不能保留默认值 http://localhost:3000。"
    prompt_value "$env_file" "APP_URL" "请输入系统对外访问地址（例如 https://atlas.example.com 或 http://服务器IP:3000）" "${app_url:-http://localhost:3000}"
    app_url="$(read_env_value "$env_file" "APP_URL")"
  fi
  validate_http_url "$app_url"

  local port
  port="$(read_env_value "$env_file" "PORT")"
  if [[ -z "$port" ]]; then
    set_env_value "$env_file" "PORT" "3000"
    port="3000"
  fi
  validate_port_value "$port"

  local database_path
  database_path="$(read_env_value "$env_file" "DATABASE_PATH")"
  if [[ -z "$database_path" || "$database_path" == "/home/runner/work/arcade-atlas/arcade-atlas/data/arcade-atlas.sqlite" ]]; then
    set_env_value "$env_file" "DATABASE_PATH" "$default_database_path"
  fi

  local client_id
  client_id="$(read_env_value "$env_file" "GITHUB_CLIENT_ID")"
  if [[ -z "$client_id" || "$client_id" == "your-github-client-id" ]]; then
    [[ "$NON_INTERACTIVE" -eq 1 ]] && die "必须配置 GITHUB_CLIENT_ID。"
    prompt_value "$env_file" "GITHUB_CLIENT_ID" "请输入 GitHub OAuth Client ID" ""
  fi

  local client_secret
  client_secret="$(read_env_value "$env_file" "GITHUB_CLIENT_SECRET")"
  if [[ -z "$client_secret" || "$client_secret" == "your-github-client-secret" ]]; then
    [[ "$NON_INTERACTIVE" -eq 1 ]] && die "必须配置 GITHUB_CLIENT_SECRET。"
    prompt_value "$env_file" "GITHUB_CLIENT_SECRET" "请输入 GitHub OAuth Client Secret" ""
  fi

  local oauth_allowlist
  oauth_allowlist="$(read_env_value "$env_file" "OAUTH_ALLOWLIST")"
  if [[ -z "$oauth_allowlist" || "$oauth_allowlist" == "github:123456,github:789012" ]]; then
    [[ "$NON_INTERACTIVE" -eq 1 ]] && die "必须配置 OAUTH_ALLOWLIST。"
    prompt_value "$env_file" "OAUTH_ALLOWLIST" "请输入允许登录后台的 GitHub 用户 ID 列表（示例 github:123456,github:789012）" ""
  fi

  local allow_first_login
  allow_first_login="$(read_env_value "$env_file" "ALLOW_FIRST_LOGIN")"
  if [[ -z "$allow_first_login" ]]; then
    set_env_value "$env_file" "ALLOW_FIRST_LOGIN" "false"
  fi

  if [[ "$MODE" == "node" ]]; then
    mkdir -p "$TARGET_DIR/data"
  fi
}

port_in_use() {
  local port="$1"

  if command -v lsof >/dev/null 2>&1; then
    lsof -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1
    return
  fi

  if command -v ss >/dev/null 2>&1; then
    ss -ltn | awk '{print $4}' | grep -Eq "(^|:)$port$"
    return
  fi

  return 1
}

check_port() {
  local env_file="$TARGET_DIR/.env"
  local port
  port="$(read_env_value "$env_file" "PORT")"
  [[ -n "$port" ]] || die "无法读取 PORT 配置。"
  validate_port_value "$port"

  if port_in_use "$port"; then
    warn "端口 $port 已被占用。"
    if [[ "$NON_INTERACTIVE" -eq 1 ]]; then
      die "端口冲突，请先释放端口或修改 .env 中的 PORT。"
    fi

    local new_port
    read -r -p "请输入新的监听端口，或直接回车取消部署: " new_port
    [[ -n "$new_port" ]] || die "用户取消部署。"
    validate_port_value "$new_port"
    set_env_value "$env_file" "PORT" "$new_port"
    log "已将 PORT 更新为 $new_port"
  fi
}

install_node_runtime() {
  install_apt_packages build-essential python3

  local node_major=""
  if command -v node >/dev/null 2>&1; then
    node_major="$(node -p "process.versions.node.split('.')[0]")"
  fi

  if [[ -n "$node_major" && "$node_major" -ge 22 ]]; then
    log "Node.js 版本满足要求：$(node -v)"
  else
    warn "当前 Node.js 不存在或版本低于 22。"
    confirm "将安装 Node.js 22 LTS，这可能更新系统中的 node/npm，是否继续？" || die "用户取消安装 Node.js。"
    ensure_sudo
    curl -fsSL https://deb.nodesource.com/setup_22.x | $SUDO -E bash -
    $SUDO apt-get install -y nodejs
  fi

  require_command node
  require_command npm
}

install_docker_runtime() {
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    log "Docker 与 Docker Compose 已满足要求。"
  else
    warn "未检测到可用的 Docker / Docker Compose。"
    confirm "将通过 apt 自动安装 docker.io 和 docker-compose-plugin，是否继续？" || die "用户取消安装 Docker。"
    ensure_sudo
    $SUDO apt-get update
    $SUDO apt-get install -y docker.io docker-compose-plugin
    $SUDO systemctl enable --now docker
  fi

  if docker info >/dev/null 2>&1; then
    DOCKER_BIN=(docker)
  else
    ensure_sudo
    DOCKER_BIN=($SUDO docker)
  fi
}

show_environment_summary() {
  log "部署模式：$MODE"
  log "项目目录：$TARGET_DIR"
  log "仓库地址：$REPO_URL"
  log "当前用户：$(id -un)"
  if command -v docker >/dev/null 2>&1; then
    log "Docker：$(docker --version 2>/dev/null || true)"
  fi
  if command -v node >/dev/null 2>&1; then
    log "Node.js：$(node -v 2>/dev/null || true)"
  fi
  if command -v npm >/dev/null 2>&1; then
    log "npm：$(npm -v 2>/dev/null || true)"
  fi
}

run_docker_deploy() {
  local env_file="$TARGET_DIR/.env"
  local port
  port="$(read_env_value "$env_file" "PORT")"

  confirm "将通过 docker compose 构建并启动服务，这可能重建现有容器，是否继续？" || die "用户取消启动 Docker 服务。"

  (
    cd "$TARGET_DIR"
    "${DOCKER_BIN[@]}" compose up -d --build
  )

  run_health_check "$port"
}

run_node_deploy() {
  local env_file="$TARGET_DIR/.env"
  local port
  port="$(read_env_value "$env_file" "PORT")"
  local pid_file="$TARGET_DIR/.deploy/arcade-atlas.pid"
  mkdir -p "$TARGET_DIR/.deploy"

  (
    cd "$TARGET_DIR"
    npm ci
    npm run build
  )

  if [[ -f "$pid_file" ]] && kill -0 "$(cat "$pid_file")" >/dev/null 2>&1; then
    confirm "检测到旧的 Node 进程仍在运行，将重启该进程，是否继续？" || die "用户取消重启 Node 服务。"
    kill "$(cat "$pid_file")"
  fi

  confirm "将以 nohup 方式启动 Node 服务，这会占用端口 $port，是否继续？" || die "用户取消启动 Node 服务。"
  (
    cd "$TARGET_DIR"
    nohup npm run start >"$TARGET_DIR/.deploy/app.log" 2>&1 &
    echo $! >"$pid_file"
  )

  run_health_check "$port"
}

run_health_check() {
  local port="$1"
  local url="http://127.0.0.1:${port}/"
  local attempt

  for attempt in 1 2 3 4 5 6 7 8 9 10; do
    if curl -fsS -o /dev/null "$url"; then
      log "健康检查通过：$url"
      return
    fi
    sleep 2
  done

  die "健康检查失败，请检查服务日志和 .env 配置：$url"
}

main() {
  parse_args "$@"
  detect_os
  ensure_base_commands
  clone_or_update_repo
  show_environment_summary

  if [[ "$MODE" == "docker" ]]; then
    install_docker_runtime
  else
    install_node_runtime
  fi

  prepare_env_file
  check_port

  if [[ "$MODE" == "docker" ]]; then
    run_docker_deploy
  else
    run_node_deploy
  fi

  log "部署完成。"
  log "请确认以下用户自定义配置已填写正确：APP_URL、GITHUB_CLIENT_ID、GITHUB_CLIENT_SECRET、OAUTH_ALLOWLIST"
  log "更多部署说明见：$TARGET_DIR/DEPLOYMENT.md"
}

main "$@"
