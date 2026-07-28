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
OS_ID=""
OS_PRETTY_NAME=""
VERSION_CODENAME=""
INSTALL_STATE="fresh"
PROJECT_DIR_STATUS="missing"
GIT_REPO_STATUS="missing"
DOCKER_STATUS="missing"
DOCKER_COMPOSE_STATUS="missing"
DOCKER_SERVICE_STATUS="unknown"
ENV_FILE_STATUS="missing"
DATABASE_STATUS="missing"
CURRENT_INSTALL_VERSION="未安装"
CURRENT_CODE_VERSION="未知"
LATEST_VERSION="未知"
BUILD_STATUS="未执行"
MIGRATION_STATUS="未执行"
SERVICE_STATUS="未启动"
API_STATUS="未检查"
REDIS_STATUS="未启用"
CURRENT_USER_PERMISSION_STATUS="unknown"
PREVIOUS_DOCKER_SERVICE_RUNNING=0
PREVIOUS_NODE_SERVICE_RUNNING=0

log() {
  printf '[INFO] %s\n' "$*"
}

warn() {
  printf '[WARN] %s\n' "$*" >&2
}

error() {
  printf '[ERROR] %s\n' "$*" >&2
}

step() {
  printf '\n========== %s ==========\n' "$*"
}

fail_step() {
  local message="$1"
  shift || true
  error "$message"
  for item in "$@"; do
    [[ -n "$item" ]] && error "$item"
  done
  exit 1
}

usage() {
  cat <<'USAGE'
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
USAGE
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
  command -v "$command_name" >/dev/null 2>&1 || fail_step "缺少命令：$command_name"
}

path_is_within() {
  python3 - "$1" "$2" <<'PYTHON_PATH_IS_WITHIN'
import os
import sys

base_path = os.path.realpath(sys.argv[1])
candidate_path = os.path.realpath(sys.argv[2])

try:
    print("1" if os.path.commonpath([base_path, candidate_path]) == base_path else "0")
except ValueError:
    print("0")
PYTHON_PATH_IS_WITHIN
}

path_relative_to() {
  python3 - "$1" "$2" <<'PYTHON_PATH_RELATIVE_TO'
import os
import sys

base_path = os.path.realpath(sys.argv[1])
candidate_path = os.path.realpath(sys.argv[2])
print(os.path.relpath(candidate_path, base_path))
PYTHON_PATH_RELATIVE_TO
}

read_version_from_directory() {
  local directory="$1"
  local version_file="$directory/VERSION"
  local package_file="$directory/package.json"

  if [[ -f "$version_file" ]]; then
    awk 'NF {print; exit}' "$version_file"
    return 0
  fi

  if [[ -f "$package_file" ]]; then
    python3 - "$package_file" <<'PYTHON_READ_PACKAGE_VERSION'
import json
import sys

with open(sys.argv[1], 'r', encoding='utf-8') as handle:
    payload = json.load(handle)

print(str(payload.get('version', '')).strip())
PYTHON_READ_PACKAGE_VERSION
    return 0
  fi

  return 1
}

read_version_from_git_ref() {
  local directory="$1"
  local ref="$2"

  if git -C "$directory" cat-file -e "${ref}:VERSION" >/dev/null 2>&1; then
    git -C "$directory" show "${ref}:VERSION" | awk 'NF {print; exit}'
    return 0
  fi

  if git -C "$directory" cat-file -e "${ref}:package.json" >/dev/null 2>&1; then
    git -C "$directory" show "${ref}:package.json" | python3 -c 'import json, sys; print(str(json.load(sys.stdin).get("version", "")).strip())'
    return 0
  fi

  return 1
}

compare_versions() {
  python3 - "$1" "$2" <<'PYTHON_COMPARE_VERSIONS'
import re
import sys

def normalize(value: str) -> tuple[int, ...]:
    candidate = value.strip()
    if candidate.startswith("v"):
        candidate = candidate[1:]
    parts = [int(part) for part in re.findall(r"\d+", candidate)]
    while len(parts) < 3:
        parts.append(0)
    return tuple(parts[:3])

left = normalize(sys.argv[1])
right = normalize(sys.argv[2])
if left < right:
    print(-1)
elif left > right:
    print(1)
else:
    print(0)
PYTHON_COMPARE_VERSIONS
}

version_is_newer() {
  [[ "$(compare_versions "$1" "$2")" == "1" ]]
}

detect_database_state() {
  local database_path="$1"
  python3 - "$database_path" <<'PYTHON_CHECK_DATABASE_STATE'
import os
import sqlite3
import sys

database_path = sys.argv[1]
required_tables = {
    "users",
    "machine_types",
    "machines",
    "repair_records",
    "maintenance_logs",
    "admin_sessions",
    "app_settings",
}

if not os.path.exists(database_path):
    print("missing")
    raise SystemExit(0)

try:
    connection = sqlite3.connect(database_path)
    cursor = connection.cursor()
    cursor.execute("SELECT name FROM sqlite_master WHERE type = 'table'")
    tables = {row[0] for row in cursor.fetchall()}
    print("initialized" if required_tables.issubset(tables) else "present")
except sqlite3.DatabaseError:
    print("invalid")
finally:
    try:
        connection.close()
    except Exception:
        pass
PYTHON_CHECK_DATABASE_STATE
}

ensure_sudo() {
  if [[ "$(id -u)" -eq 0 ]]; then
    SUDO=""
    CURRENT_USER_PERMISSION_STATUS="root"
    return
  fi

  require_command sudo
  if ! sudo -v; then
    fail_step "当前用户没有可用的 sudo 权限，无法继续安装依赖或启动服务。"
  fi
  CURRENT_USER_PERMISSION_STATUS="sudo"
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
    return
  fi

  warn "缺少系统依赖：${missing[*]}"
  confirm "将通过 apt 自动安装以上依赖，是否继续？" || fail_step "用户取消安装依赖。"
  ensure_sudo
  if ! $SUDO apt-get update; then
    fail_step "apt update 失败。" "请检查服务器网络、DNS 或 APT 源配置后重试。" "建议执行：sudo apt-get update"
  fi
  if ! $SUDO apt-get install -y "${missing[@]}"; then
    fail_step "系统依赖安装失败。" "请执行：sudo apt-get install -y ${missing[*]}"
  fi
}

detect_os() {
  [[ -f /etc/os-release ]] || fail_step "无法识别当前系统。缺少 /etc/os-release。"
  # shellcheck disable=SC1091
  source /etc/os-release

  OS_ID="${ID:-}"
  OS_PRETTY_NAME="${PRETTY_NAME:-$OS_ID}"
  VERSION_CODENAME="${VERSION_CODENAME:-}"

  case "$OS_ID" in
    debian|ubuntu)
      ;;
    *)
      fail_step "当前脚本仅支持 Debian / Ubuntu。" "当前系统：${OS_PRETTY_NAME:-unknown}"
      ;;
  esac

  [[ -n "$VERSION_CODENAME" ]] || fail_step "无法识别当前系统版本代号 VERSION_CODENAME。" "请检查 /etc/os-release 是否包含 VERSION_CODENAME。"
  log "检测到系统：$OS_PRETTY_NAME"
  log "系统代号：$VERSION_CODENAME"
}

detect_installation_state() {
  local env_file database_value database_path branch_name

  PROJECT_DIR_STATUS="missing"
  GIT_REPO_STATUS="missing"
  ENV_FILE_STATUS="missing"
  DATABASE_STATUS="missing"
  CURRENT_INSTALL_VERSION="未安装"
  CURRENT_CODE_VERSION="未知"
  LATEST_VERSION="未知"

  if [[ -d "$TARGET_DIR" ]]; then
    if [[ -n "$(find "$TARGET_DIR" -mindepth 1 -maxdepth 1 2>/dev/null)" ]]; then
      PROJECT_DIR_STATUS="present"
    else
      PROJECT_DIR_STATUS="empty"
    fi
  fi

  if [[ -d "$TARGET_DIR/.git" ]]; then
    local status
    GIT_REPO_STATUS="clean"
    status="$(git -C "$TARGET_DIR" status --porcelain 2>/dev/null || true)"
    if [[ -n "$status" ]]; then
      GIT_REPO_STATUS="dirty"
    fi
    CURRENT_INSTALL_VERSION="$(read_version_from_directory "$TARGET_DIR" 2>/dev/null || printf '未知')"
    CURRENT_CODE_VERSION="$CURRENT_INSTALL_VERSION"
  elif [[ -d "$TARGET_DIR" ]]; then
    GIT_REPO_STATUS="not-a-repo"
  fi

  if command -v docker >/dev/null 2>&1; then
    DOCKER_STATUS="installed"
    if docker compose version >/dev/null 2>&1; then
      DOCKER_COMPOSE_STATUS="installed"
    else
      DOCKER_COMPOSE_STATUS="missing"
    fi

    if docker info >/dev/null 2>&1; then
      DOCKER_SERVICE_STATUS="running"
    elif command -v systemctl >/dev/null 2>&1; then
      DOCKER_SERVICE_STATUS="$($SUDO systemctl is-active docker 2>/dev/null || printf 'stopped')"
    else
      DOCKER_SERVICE_STATUS="stopped"
    fi
  else
    DOCKER_STATUS="missing"
    DOCKER_COMPOSE_STATUS="missing"
    DOCKER_SERVICE_STATUS="missing"
  fi

  env_file="$TARGET_DIR/.env"
  if [[ -f "$env_file" ]]; then
    ENV_FILE_STATUS="present"
    database_value="$(read_env_value "$env_file" "DATABASE_PATH")"
  else
    database_value=""
  fi

  database_path="$(resolve_env_path "$database_value" "./data/arcade-atlas.sqlite")"
  DATABASE_STATUS="$(detect_database_state "$database_path")"

  if [[ "$GIT_REPO_STATUS" != "missing" || "$ENV_FILE_STATUS" == "present" || "$DATABASE_STATUS" != "missing" || "$PROJECT_DIR_STATUS" == "present" ]]; then
    INSTALL_STATE="installed"
  else
    INSTALL_STATE="fresh"
  fi

  if [[ "$GIT_REPO_STATUS" == "clean" || "$GIT_REPO_STATUS" == "dirty" ]]; then
    branch_name="$(git -C "$TARGET_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null || printf 'main')"
    if git -C "$TARGET_DIR" fetch --quiet origin "$branch_name" >/dev/null 2>&1 || git -C "$TARGET_DIR" fetch --quiet origin main >/dev/null 2>&1; then
      LATEST_VERSION="$(read_version_from_git_ref "$TARGET_DIR" "FETCH_HEAD" 2>/dev/null || printf '%s' "$CURRENT_INSTALL_VERSION")"
    fi
  fi
}

show_detection_summary() {
  step '安装状态检测'
  log "安装状态：$INSTALL_STATE"
  log "项目目录：$TARGET_DIR ($PROJECT_DIR_STATUS)"
  log "Git 仓库状态：$GIT_REPO_STATUS"
  log "Docker：$DOCKER_STATUS"
  log "Docker Compose：$DOCKER_COMPOSE_STATUS"
  log "Docker 服务：$DOCKER_SERVICE_STATUS"
  log ".env 配置：$ENV_FILE_STATUS"
  log "数据库状态：$DATABASE_STATUS"
  log "当前安装版本：$CURRENT_INSTALL_VERSION"
  log "当前代码版本：$CURRENT_CODE_VERSION"
  log "最新版本：$LATEST_VERSION"
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
        fail_step "未知参数：$1"
        ;;
    esac
  done

  case "$MODE" in
    docker|node) ;;
    *)
      fail_step "--mode 仅支持 docker 或 node"
      ;;
  esac
}

ensure_base_commands() {
  install_apt_packages ca-certificates curl git gnupg python3
  require_command git
  require_command curl
  require_command python3
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
    [[ -d "$TARGET_DIR" ]] || fail_step "指定了 --skip-git-update，但目录不存在：$TARGET_DIR"
    [[ -d "$TARGET_DIR/.git" ]] || fail_step "指定了 --skip-git-update，但目录不是 Git 仓库：$TARGET_DIR"
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
      fail_step "项目目录存在未提交改动，已停止以避免覆盖用户文件：$TARGET_DIR"
    fi
    log "已保留现有仓库，等待后续升级流程确认。"
    return
  fi

  if [[ -e "$TARGET_DIR" ]] && [[ -n "$(find "$TARGET_DIR" -mindepth 1 -maxdepth 1 2>/dev/null)" ]]; then
    fail_step "目标目录已存在且非空，为避免覆盖数据已停止：$TARGET_DIR"
  fi

  confirm "将克隆项目到 $TARGET_DIR，是否继续？" || fail_step "用户取消克隆项目。"
  if ! git clone "$REPO_URL" "$TARGET_DIR"; then
    fail_step "克隆仓库失败。" "请检查网络或仓库地址：$REPO_URL"
  fi
}

backup_existing_installation() {
  local env_file="$TARGET_DIR/.env"
  local database_value database_path backup_dir timestamp
  timestamp="$(date +%Y%m%d-%H%M%S)"
  backup_dir="$TARGET_DIR/.deploy/backups/$timestamp"
  mkdir -p "$backup_dir"

  if [[ -f "$env_file" ]]; then
    cp "$env_file" "$backup_dir/.env.backup"
  fi

  if [[ -d "$TARGET_DIR/data" ]]; then
    cp -a "$TARGET_DIR/data" "$backup_dir/data"
  fi

  database_value="$(read_env_value "$env_file" "DATABASE_PATH" 2>/dev/null || true)"
  database_path="$(resolve_env_path "$database_value" "./data/arcade-atlas.sqlite")"
  if [[ -f "$database_path" ]]; then
    cp "$database_path" "$backup_dir/$(basename "$database_path")"
    [[ -f "${database_path}-wal" ]] && cp "${database_path}-wal" "$backup_dir/$(basename "${database_path}-wal")"
    [[ -f "${database_path}-shm" ]] && cp "${database_path}-shm" "$backup_dir/$(basename "${database_path}-shm")"
  fi

  log "已创建升级备份：$backup_dir"
}

update_repo_to_latest() {
  [[ -d "$TARGET_DIR/.git" ]] || fail_step "项目目录不是 Git 仓库，无法执行升级：$TARGET_DIR"
  [[ "$GIT_REPO_STATUS" != "dirty" ]] || fail_step "项目目录存在未提交改动，已停止升级以保护用户文件。"

  if ! git -C "$TARGET_DIR" pull --ff-only; then
    fail_step "git pull 失败。" "请手动执行：cd $TARGET_DIR && git pull --ff-only"
  fi

  CURRENT_CODE_VERSION="$(read_version_from_directory "$TARGET_DIR" 2>/dev/null || printf '未知')"
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
  [[ "$value" =~ ^https?://[^[:space:]/?#]+([:/?#].*)?$ ]] || fail_step "APP_URL 必须是合法的 http:// 或 https:// 地址。"
}

validate_port_value() {
  local value="$1"
  [[ "$value" =~ ^[0-9]+$ ]] || fail_step "PORT 必须是有效整数。"
  if (( value < 1 || value > 65535 )); then
    fail_step "PORT 必须是 1-65535 之间的整数。"
  fi
}

is_truthy_value() {
  local value="$1"
  case "${value,,}" in
    1|true|yes|on)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

resolve_env_path() {
  local path_value="$1"
  local default_value="$2"
  local candidate="$path_value"

  if [[ -z "$candidate" ]]; then
    candidate="$default_value"
  fi

  python3 - "$TARGET_DIR" "$candidate" <<'PYTHON_RESOLVE_PATH'
import os
import sys

target_dir = sys.argv[1]
candidate = sys.argv[2]
if os.path.isabs(candidate):
    print(os.path.normpath(candidate))
else:
    print(os.path.normpath(os.path.join(target_dir, candidate)))
PYTHON_RESOLVE_PATH
}

get_process_cmdline() {
  local pid="$1"

  if [[ -r "/proc/$pid/cmdline" ]]; then
    tr '\0' ' ' <"/proc/$pid/cmdline" | sed 's/[[:space:]]\+$//'
    return 0
  fi

  ps -p "$pid" -o command= 2>/dev/null | sed 's/^[[:space:]]*//'
}

get_process_cwd() {
  local pid="$1"
  [[ -e "/proc/$pid/cwd" ]] || return 1
  readlink -f "/proc/$pid/cwd"
}

process_listens_on_port() {
  local pid="$1"
  local port="$2"

  if command -v lsof >/dev/null 2>&1; then
    lsof -Pan -p "$pid" -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1
    return
  fi

  if command -v ss >/dev/null 2>&1; then
    ss -ltnp 2>/dev/null | grep -Eq "[:.]${port}[[:space:]].*pid=${pid},"
    return
  fi

  return 1
}

is_arcade_atlas_pid() {
  local pid="$1"
  local port="${2:-}"
  local process_cmdline process_cwd cwd_matches=0

  kill -0 "$pid" >/dev/null 2>&1 || return 1
  process_cmdline="$(get_process_cmdline "$pid" 2>/dev/null || true)"
  process_cwd="$(get_process_cwd "$pid" 2>/dev/null || true)"

  if [[ -n "$process_cwd" ]] && [[ "$process_cwd" == "$TARGET_DIR" ]]; then
    cwd_matches=1
  fi

  if [[ "$cwd_matches" -eq 1 ]]; then
    if [[ "$process_cmdline" == *"npm run start"* || "$process_cmdline" == *"node dist/server.js"* || "$process_cmdline" == *"/dist/server.js"* || "$process_cmdline" == *"arcade-atlas"* ]]; then
      return 0
    fi

    if [[ -n "$port" ]] && process_listens_on_port "$pid" "$port"; then
      return 0
    fi
  fi

  if [[ -n "$port" ]] && [[ "$process_cmdline" == *"$TARGET_DIR"* ]] && process_listens_on_port "$pid" "$port"; then
    return 0
  fi

  return 1
}

wait_for_pid_exit() {
  local pid="$1"
  local attempts="${2:-10}"
  local _remaining=0

  for ((_remaining = attempts; _remaining > 0; _remaining--)); do
    if ! kill -0 "$pid" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done

  ! kill -0 "$pid" >/dev/null 2>&1
}

wait_for_health_check() {
  local port="$1"
  local attempts="${2:-10}"
  local url="http://127.0.0.1:${port}/health"
  local response_body=""
  local _remaining=0

  for ((_remaining = attempts; _remaining > 0; _remaining--)); do
    response_body="$(curl -fsS "$url" 2>/dev/null || true)"
    if [[ -n "$response_body" ]]; then
      printf '%s' "$response_body"
      return 0
    fi
    sleep 2
  done

  return 1
}

validate_database_path_for_mode() {
  local env_file="$1"
  local raw_database_path resolved_database_path data_dir relative_path normalized_database_path
  local default_database_path="./data/arcade-atlas.sqlite"

  raw_database_path="$(read_env_value "$env_file" "DATABASE_PATH")"
  if [[ -z "$raw_database_path" ]]; then
    set_env_value "$env_file" "DATABASE_PATH" "$default_database_path"
    raw_database_path="$default_database_path"
  fi

  resolved_database_path="$(resolve_env_path "$raw_database_path" "$default_database_path")"
  data_dir="$TARGET_DIR/data"

  if [[ "$(path_is_within "$data_dir" "$resolved_database_path")" == "1" ]]; then
    relative_path="$(path_relative_to "$data_dir" "$resolved_database_path")"
    normalized_database_path="./data/${relative_path}"
    if [[ "$raw_database_path" != "$normalized_database_path" ]]; then
      set_env_value "$env_file" "DATABASE_PATH" "$normalized_database_path"
      log "已将 DATABASE_PATH 规范化为 $normalized_database_path"
    fi
    return
  fi

  if [[ "$MODE" == "docker" ]]; then
    fail_step "Docker 模式要求 DATABASE_PATH 指向 $TARGET_DIR/data 下的持久化目录，当前值不兼容：$raw_database_path" \
      "为避免容器静默创建新的空数据库，脚本已停止。" \
      "如果你正从 Node 部署切换到 Docker，请先将数据库迁移到 $TARGET_DIR/data/ 下，并把 DATABASE_PATH 设置为 ./data/<文件名> 后重试。"
  fi
}

detect_github_oauth_user_state() {
  local database_path="$1"
  python3 - "$database_path" <<'PYTHON_CHECK_GITHUB_USERS'
import os
import sqlite3
import sys

database_path = sys.argv[1]

if not os.path.exists(database_path):
    print("missing")
    raise SystemExit(0)

try:
    connection = sqlite3.connect(database_path)
    cursor = connection.cursor()
    cursor.execute("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'users' LIMIT 1")
    if cursor.fetchone() is None:
        print("missing")
        raise SystemExit(0)

    columns = {row[1] for row in cursor.execute("PRAGMA table_info(users)")}
    if "oauth_provider" in columns and "status" in columns:
        row = cursor.execute(
            "SELECT 1 FROM users WHERE auth_type = 'oauth' AND oauth_provider = 'github' AND status = 'active' LIMIT 1"
        ).fetchone()
    elif "oauth_provider" in columns:
        row = cursor.execute(
            "SELECT 1 FROM users WHERE auth_type = 'oauth' AND oauth_provider = 'github' LIMIT 1"
        ).fetchone()
    else:
        row = None

    print("present" if row else "missing")
except sqlite3.DatabaseError:
    print("unknown")
finally:
    try:
        connection.close()
    except Exception:
        pass
PYTHON_CHECK_GITHUB_USERS
}

validate_auth_configuration_before_start() {
  local env_file="$1"
  local auth_mode client_id client_secret allowlist allow_first_login
  local local_username password_hash password_salt database_path github_user_state
  local missing_items=()

  auth_mode="$(read_env_value "$env_file" "AUTH_MODE")"
  allow_first_login="$(read_env_value "$env_file" "ALLOW_FIRST_LOGIN")"

  case "$auth_mode" in
    local|both)
      local_username="$(read_env_value "$env_file" "LOCAL_ADMIN_USERNAME")"
      password_hash="$(read_env_value "$env_file" "LOCAL_ADMIN_PASSWORD_HASH")"
      password_salt="$(read_env_value "$env_file" "LOCAL_ADMIN_PASSWORD_SALT")"
      [[ -n "$local_username" ]] || missing_items+=("LOCAL_ADMIN_USERNAME")
      [[ -n "$password_hash" ]] || missing_items+=("LOCAL_ADMIN_PASSWORD_HASH")
      [[ -n "$password_salt" ]] || missing_items+=("LOCAL_ADMIN_PASSWORD_SALT")
      ;;
  esac

  case "$auth_mode" in
    github|both)
      client_id="$(read_env_value "$env_file" "GITHUB_CLIENT_ID")"
      client_secret="$(read_env_value "$env_file" "GITHUB_CLIENT_SECRET")"
      allowlist="$(read_env_value "$env_file" "OAUTH_ALLOWLIST")"
      [[ -n "$client_id" ]] || missing_items+=("GITHUB_CLIENT_ID")
      [[ -n "$client_secret" ]] || missing_items+=("GITHUB_CLIENT_SECRET")

      if [[ -z "$allowlist" ]] && ! is_truthy_value "$allow_first_login"; then
        database_path="$(resolve_env_path "$(read_env_value "$env_file" "DATABASE_PATH")" "./data/arcade-atlas.sqlite")"
        github_user_state="$(detect_github_oauth_user_state "$database_path")"
        case "$github_user_state" in
          missing)
            missing_items+=("OAUTH_ALLOWLIST")
            ;;
          unknown)
            warn "启动前未能读取现有数据库中的 GitHub 管理员账号信息：$database_path"
            warn "当前 OAUTH_ALLOWLIST 为空，如需限制首次登录，建议先补全该配置。"
            ;;
        esac
      fi
      ;;
  esac

  if [[ "${#missing_items[@]}" -gt 0 ]]; then
    fail_step "启动前认证配置检查失败：AUTH_MODE=${auth_mode:-未设置} 的配置不完整。" \
      "缺少以下配置：${missing_items[*]}" \
      "请先补全 $env_file 后再重新启动容器。"
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
      fail_step "缺少必须配置：$key"
    fi
    set_env_value "$env_file" "$key" "$new_value"
    return
  fi

  if [[ -n "$current_value" ]]; then
    read -r -p "$prompt [$current_value]: " new_value
    new_value="${new_value:-$current_value}"
  else
    read -r -p "$prompt: " new_value
  fi

  if [[ -z "$new_value" && "$allow_empty" -ne 1 ]]; then
    fail_step "配置 $key 不能为空。"
  fi

  set_env_value "$env_file" "$key" "$new_value"
}

prompt_secret_value() {
  local prompt="$1"
  local value=""
  if [[ "$NON_INTERACTIVE" -eq 1 ]]; then
    fail_step "非交互模式下缺少安全输入值：$prompt"
  fi

  read -r -s -p "$prompt: " value
  printf '\n' >&2
  [[ -n "$value" ]] || fail_step "输入不能为空。"
  printf '%s' "$value"
}

hash_password_for_env() {
  local secret_value="$1"
  PASSWORD_INPUT="$secret_value" python3 <<'PYTHON_HASH_PASSWORD'
import base64
import hashlib
import os
import secrets
password = os.environ['PASSWORD_INPUT'].encode('utf-8')
salt = secrets.token_bytes(16)
digest = hashlib.scrypt(password, salt=salt, n=16384, r=8, p=1)
print(base64.b64encode(salt).decode('ascii'))
print(base64.b64encode(digest).decode('ascii'))
PYTHON_HASH_PASSWORD
}

configure_local_auth() {
  local env_file="$1"
  local username current_username password password_confirm hash_output salt hash password_hash password_salt

  current_username="$(read_env_value "$env_file" "LOCAL_ADMIN_USERNAME")"
  prompt_value "$env_file" "LOCAL_ADMIN_USERNAME" "请输入后台登录用户名" "$current_username"
  username="$(read_env_value "$env_file" "LOCAL_ADMIN_USERNAME")"

  if [[ "$NON_INTERACTIVE" -eq 1 ]]; then
    password_hash="$(read_env_value "$env_file" "LOCAL_ADMIN_PASSWORD_HASH")"
    password_salt="$(read_env_value "$env_file" "LOCAL_ADMIN_PASSWORD_SALT")"
    [[ -n "$password_hash" && -n "$password_salt" ]] || fail_step "AUTH_MODE=local 时，非交互模式必须预先提供 LOCAL_ADMIN_PASSWORD_HASH 和 LOCAL_ADMIN_PASSWORD_SALT。"
  else
    while true; do
      secret_input="$(prompt_secret_value '请输入后台登录密码（至少 8 位，不会回显）')"
      printf -v password '%s' "$secret_input"
      if [[ "${#password}" -lt 8 ]]; then
        warn "密码长度不能少于 8 位，请重新输入。"
        continue
      fi
      password_confirm="$(prompt_secret_value '请再次输入后台登录密码确认')"
      if [[ "$password" != "$password_confirm" ]]; then
        warn "两次输入的密码不一致，请重新输入。"
        continue
      fi
      break
    done

    hash_output="$(hash_password_for_env "$password")"
    salt="$(printf '%s\n' "$hash_output" | sed -n '1p')"
    hash="$(printf '%s\n' "$hash_output" | sed -n '2p')"
    set_env_value "$env_file" "LOCAL_ADMIN_PASSWORD_SALT" "$salt"
    set_env_value "$env_file" "LOCAL_ADMIN_PASSWORD_HASH" "$hash"
  fi

  set_env_value "$env_file" "AUTH_MODE" "local"
  set_env_value "$env_file" "GITHUB_CLIENT_ID" ""
  set_env_value "$env_file" "GITHUB_CLIENT_SECRET" ""
  set_env_value "$env_file" "OAUTH_ALLOWLIST" ""
  set_env_value "$env_file" "ALLOW_FIRST_LOGIN" "false"
  log "已写入本地管理员用户名：$username"
}

configure_github_auth() {
  local env_file="$1"
  local app_url callback_url client_id client_secret allowlist allow_first_login

  app_url="$(read_env_value "$env_file" "APP_URL")"
  callback_url="${app_url%/}/auth/github/callback"

  cat <<GITHUB_OAUTH_HELP

【GitHub OAuth 登录配置】
你需要先在 GitHub 创建一个 OAuth App。
如果你还没有创建，请打开 GitHub Developer Settings → OAuth Apps → New OAuth App。

Homepage URL：
$app_url

Authorization callback URL：
$callback_url

接下来会要求你填写：
- GitHub Client ID：OAuth App 的公开客户端标识
- GitHub Client Secret：OAuth App 的私密密钥，输入时不会回显
- 允许登录后台的 GitHub 用户：这里填写 GitHub 用户 ID，不是用户名
  获取方式示例：在浏览器打开 https://api.github.com/users/你的GitHub用户名 ，找到返回 JSON 中的 id 字段
  多个用户示例：github:123456,github:789012
GITHUB_OAUTH_HELP

  client_id="$(read_env_value "$env_file" "GITHUB_CLIENT_ID")"
  prompt_value "$env_file" "GITHUB_CLIENT_ID" "GitHub Client ID（用途：OAuth App 的公开客户端标识）" "$client_id"

  if [[ "$NON_INTERACTIVE" -eq 1 ]]; then
    client_secret="$(read_env_value "$env_file" "GITHUB_CLIENT_SECRET")"
    [[ -n "$client_secret" ]] || fail_step "AUTH_MODE=github 时，非交互模式必须预先提供 GITHUB_CLIENT_SECRET。"
  else
    client_secret="$(prompt_secret_value 'GitHub Client Secret（用途：OAuth App 的私密密钥，不会回显）')"
    set_env_value "$env_file" "GITHUB_CLIENT_SECRET" "$client_secret"
  fi

  allowlist="$(read_env_value "$env_file" "OAUTH_ALLOWLIST")"
  prompt_value "$env_file" "OAUTH_ALLOWLIST" "允许登录后台的 GitHub 用户 ID（示例 github:123456,github:789012）" "$allowlist"

  allow_first_login="$(read_env_value "$env_file" "ALLOW_FIRST_LOGIN")"
  if [[ -z "$allow_first_login" ]]; then
    set_env_value "$env_file" "ALLOW_FIRST_LOGIN" "false"
  fi

  set_env_value "$env_file" "AUTH_MODE" "github"
  set_env_value "$env_file" "LOCAL_ADMIN_USERNAME" ""
  set_env_value "$env_file" "LOCAL_ADMIN_PASSWORD_HASH" ""
  set_env_value "$env_file" "LOCAL_ADMIN_PASSWORD_SALT" ""

  log "GitHub OAuth 回调地址：$callback_url"
}

choose_auth_mode() {
  local env_file="$1"
  local auth_mode
  auth_mode="$(read_env_value "$env_file" "AUTH_MODE")"

  if [[ "$NON_INTERACTIVE" -eq 1 ]]; then
    case "$auth_mode" in
      local)
        configure_local_auth "$env_file"
        return
        ;;
      github)
        configure_github_auth "$env_file"
        return
        ;;
      *)
        fail_step "非交互模式必须在 .env 中提供 AUTH_MODE，且只能是 local 或 github。"
        ;;
    esac
  fi

  while true; do
    cat <<'AUTH_MODE_MENU'

请选择后台登录方式：
  [1] 用户名 + 密码登录
  [2] GitHub OAuth 登录
AUTH_MODE_MENU
    read -r -p '请输入 1 或 2: ' auth_mode
    case "$auth_mode" in
      1)
        configure_local_auth "$env_file"
        return
        ;;
      2)
        configure_github_auth "$env_file"
        return
        ;;
      *)
        warn '无效选择，请输入 1 或 2。'
        ;;
    esac
  done
}

prepare_env_file() {
  local env_file="$TARGET_DIR/.env"
  local example_file="$TARGET_DIR/.env.example"
  local env_created=0
  [[ -f "$example_file" ]] || fail_step "缺少环境变量模板：$example_file"

  if [[ ! -f "$env_file" ]]; then
    cp "$example_file" "$env_file"
    env_created=1
    log "已创建 .env：$env_file"
  else
    log "检测到已有 .env，将保留现有配置并补全缺失项。"
  fi

  append_missing_env_keys "$env_file" "$example_file"

  local default_database_path="./data/arcade-atlas.sqlite"
  local app_url port database_path

  app_url="$(read_env_value "$env_file" "APP_URL")"
  if [[ -z "$app_url" || "$app_url" == "http://localhost:3000" ]]; then
    if [[ "$NON_INTERACTIVE" -eq 1 ]]; then
      fail_step "必须配置 APP_URL，不能保留默认值 http://localhost:3000。"
    fi
    prompt_value "$env_file" "APP_URL" "请输入系统最终访问地址（例如 https://atlas.example.com 或 http://服务器IP:3000）" "${app_url:-http://localhost:3000}"
    app_url="$(read_env_value "$env_file" "APP_URL")"
  fi
  validate_http_url "$app_url"

  port="$(read_env_value "$env_file" "PORT")"
  if [[ -z "$port" ]]; then
    set_env_value "$env_file" "PORT" "3000"
    port="3000"
  fi
  validate_port_value "$port"

  database_path="$(read_env_value "$env_file" "DATABASE_PATH")"
  if [[ -z "$database_path" || "$database_path" == "./data/arcade-atlas.sqlite" ]]; then
    set_env_value "$env_file" "DATABASE_PATH" "$default_database_path"
  fi

  if [[ "$env_created" -eq 1 ]]; then
    choose_auth_mode "$env_file"
  else
    local auth_mode
    auth_mode="$(read_env_value "$env_file" "AUTH_MODE")"
    if [[ -z "$auth_mode" ]]; then
      choose_auth_mode "$env_file"
    else
      log "检测到已有 AUTH_MODE=${auth_mode}，将保留现有认证配置。"
    fi
  fi
  mkdir -p "$TARGET_DIR/data"
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
  local port new_port
  port="$(read_env_value "$env_file" "PORT")"
  [[ -n "$port" ]] || fail_step "无法读取 PORT 配置。"
  validate_port_value "$port"

  if port_in_use "$port"; then
    if [[ "$MODE" == "docker" ]] && command -v docker >/dev/null 2>&1; then
      if docker ps --format '{{.Names}}' 2>/dev/null | grep -qx 'arcade-atlas'; then
        log "端口 $port 当前由现有 arcade-atlas 容器占用，允许原位升级。"
        return
      fi
    fi

    if [[ "$MODE" == "node" ]] && [[ -f "$TARGET_DIR/.deploy/arcade-atlas.pid" ]]; then
      local existing_pid
      existing_pid="$(cat "$TARGET_DIR/.deploy/arcade-atlas.pid" 2>/dev/null || true)"
      if [[ -n "$existing_pid" ]] && is_arcade_atlas_pid "$existing_pid" "$port"; then
        log "端口 $port 当前由现有 Arcade Atlas Node 进程占用，允许原位升级。"
        return
      fi
    fi

    warn "端口 $port 已被占用。"
    if [[ "$NON_INTERACTIVE" -eq 1 ]]; then
      fail_step "端口冲突，请先释放端口或修改 .env 中的 PORT。" "建议执行：ss -ltnp | grep :$port"
    fi

    read -r -p '请输入新的监听端口，或直接回车取消部署: ' new_port
    [[ -n "$new_port" ]] || fail_step "用户取消部署。"
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
    return
  fi

  warn '当前 Node.js 不存在或版本低于 22。'
  confirm '将安装 Node.js 22 LTS，这可能更新系统中的 node/npm，是否继续？' || fail_step '用户取消安装 Node.js。'
  ensure_sudo
  if ! curl -fsSL https://deb.nodesource.com/setup_22.x | $SUDO -E bash -; then
    fail_step 'Node.js 安装脚本执行失败。' '请检查网络后重试，或手动安装 Node.js 22 LTS。'
  fi
  if ! $SUDO apt-get install -y nodejs; then
    fail_step 'Node.js 安装失败。' '建议执行：sudo apt-get install -y nodejs'
  fi
  require_command node
  require_command npm
}

set_docker_command() {
  if docker info >/dev/null 2>&1; then
    DOCKER_BIN=(docker)
  else
    ensure_sudo
    DOCKER_BIN=("$SUDO" "docker")
    if ! "${DOCKER_BIN[@]}" info >/dev/null 2>&1; then
      fail_step 'Docker 已安装，但当前用户仍无法访问 Docker 守护进程。' '请执行：sudo systemctl status docker' '如需当前用户直接使用 Docker，可将用户加入 docker 组后重新登录。'
    fi
  fi
}

ensure_docker_repository() {
  local repo_base="https://download.docker.com/linux/${OS_ID}"
  local release_url="${repo_base}/dists/${VERSION_CODENAME}/Release"
  local keyring_dir='/etc/apt/keyrings'
  local keyring_path="${keyring_dir}/docker.asc"
  local repo_line

  log "检查 Docker 官方仓库是否支持当前系统代号：$VERSION_CODENAME"
  if ! curl -fsSLI "$release_url" >/dev/null 2>&1; then
    fail_step 'Docker 官方仓库暂不支持当前系统版本。' \
      "系统：$OS_PRETTY_NAME" \
      "仓库地址：$release_url" \
      '请先确认 https://download.docker.com/linux/ 下是否已发布当前版本，或改用受支持的 Debian / Ubuntu 版本。'
  fi

  ensure_sudo
  $SUDO install -m 0755 -d "$keyring_dir"
  if ! curl -fsSL "${repo_base}/gpg" | $SUDO tee "$keyring_path" >/dev/null; then
    fail_step '写入 Docker GPG key 失败。' "请检查网络后重试：${repo_base}/gpg"
  fi
  $SUDO chmod a+r "$keyring_path"

  repo_line="deb [arch=$(dpkg --print-architecture) signed-by=$keyring_path] $repo_base $VERSION_CODENAME stable"
  if [[ -f /etc/apt/sources.list.d/docker.list ]] && grep -Fq "$repo_line" /etc/apt/sources.list.d/docker.list; then
    log 'Docker 官方 APT 源已存在。'
  else
    printf '%s\n' "$repo_line" | $SUDO tee /etc/apt/sources.list.d/docker.list >/dev/null
    log '已写入 Docker 官方 APT 源。'
  fi

  if ! $SUDO apt-get update; then
    fail_step 'Docker 官方仓库 apt update 失败。' '请检查 APT 源配置、代理和网络连通性。' '建议执行：sudo apt-get update'
  fi
}

install_docker_runtime() {
  if command -v docker-compose >/dev/null 2>&1; then
    warn '检测到旧版 docker-compose 命令。脚本将优先安装并使用 docker compose plugin。'
  fi

  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    log "Docker Compose Plugin 已可用：$(docker compose version | head -n 1)"
    set_docker_command
    return
  fi

  warn '当前未检测到可用的 Docker Compose Plugin。'
  confirm '将安装或修复 Docker Engine 与 Docker Compose Plugin，是否继续？' || fail_step '用户取消安装 Docker。'
  install_apt_packages ca-certificates curl gnupg
  ensure_docker_repository

  if ! $SUDO apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin; then
    fail_step 'Docker 组件安装失败。' \
      '请执行：sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin' \
      '如果提示找不到软件包，请检查 Docker 官方 APT 源是否已正确写入。'
  fi

  if command -v systemctl >/dev/null 2>&1; then
    if ! $SUDO systemctl enable --now docker; then
      fail_step 'Docker 服务启动失败。' '请执行：sudo systemctl status docker' '或：sudo journalctl -u docker -n 100 --no-pager'
    fi
  fi

  if ! docker compose version >/dev/null 2>&1; then
    fail_step 'Docker Compose Plugin 安装后仍不可用。' '请执行：docker compose version' '并检查 /usr/libexec/docker/cli-plugins 或 /usr/lib/docker/cli-plugins 是否存在 compose 插件。'
  fi

  set_docker_command
}

show_environment_summary() {
  log "部署模式：$MODE"
  log "项目目录：$TARGET_DIR"
  log "仓库地址：$REPO_URL"
  log "当前用户：$(id -un)"
  log "用户权限：${CURRENT_USER_PERMISSION_STATUS:-unknown}"
  log "系统：$OS_PRETTY_NAME"
  log "系统代号：$VERSION_CODENAME"
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

run_database_migrations() {
  step '执行数据库 Migration'
  if [[ "$MODE" == "docker" ]]; then
    (
      cd "$TARGET_DIR"
      "${DOCKER_BIN[@]}" compose run --rm arcade-atlas npm run migrate
    )
  else
    (
      cd "$TARGET_DIR"
      npm run migrate
    )
  fi

  MIGRATION_STATUS="已完成"
}

check_docker_container_status() {
  local container_name='arcade-atlas'
  local inspect_output

  inspect_output="$("${DOCKER_BIN[@]}" inspect --format '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$container_name" 2>/dev/null || true)"
  [[ -n "$inspect_output" ]] || fail_step '未检测到 arcade-atlas 容器。' "请执行：cd $TARGET_DIR && docker compose ps"

  case "$inspect_output" in
    running\ healthy|running\ none)
      log "Docker 容器状态正常：$inspect_output"
      ;;
    *)
      fail_step 'Docker 容器状态异常。' "当前状态：$inspect_output" "请执行：cd $TARGET_DIR && docker compose ps && docker compose logs --tail=200"
      ;;
  esac
}

stop_existing_docker_service() {
  local running_services=""
  running_services="$(
    cd "$TARGET_DIR"
    "${DOCKER_BIN[@]}" compose ps --status running --services 2>/dev/null || true
  )"

  if printf '%s\n' "$running_services" | grep -qx 'arcade-atlas'; then
    log '检测到旧的 Docker 服务，正在停止 arcade-atlas 容器。'
    (
      cd "$TARGET_DIR"
      "${DOCKER_BIN[@]}" compose stop arcade-atlas
    ) || fail_step '停止旧的 Docker 服务失败。' "请执行：cd $TARGET_DIR && docker compose stop arcade-atlas"
    PREVIOUS_DOCKER_SERVICE_RUNNING=1
  else
    PREVIOUS_DOCKER_SERVICE_RUNNING=0
  fi
}

restore_docker_service_after_failed_migration() {
  local port="$1"

  [[ "$PREVIOUS_DOCKER_SERVICE_RUNNING" -eq 1 ]] || return 1

  warn '数据库 Migration 失败，正在尝试恢复之前的 Docker 服务。'
  if ! (
    cd "$TARGET_DIR"
    "${DOCKER_BIN[@]}" compose start arcade-atlas
  ); then
    warn '恢复旧的 Docker 服务失败。'
    return 1
  fi

  if wait_for_health_check "$port" 10 >/dev/null; then
    log '已恢复之前的 Docker 服务。'
    return 0
  fi

  warn '旧的 Docker 服务恢复后未通过健康检查。'
  return 1
}

run_docker_deploy() {
  local env_file="$TARGET_DIR/.env"
  local port
  port="$(read_env_value "$env_file" "PORT")"
  validate_auth_configuration_before_start "$env_file"

  confirm '将按“停止旧服务 → 数据库 Migration → 启动新服务”的顺序执行 Docker 升级，是否继续？' || fail_step '用户取消启动 Docker 服务。'

  (
    cd "$TARGET_DIR"
    if ! "${DOCKER_BIN[@]}" compose config >/dev/null; then
      fail_step 'docker compose config 检查失败。' "请执行：cd $TARGET_DIR && docker compose config"
    fi
    if ! "${DOCKER_BIN[@]}" compose build; then
      fail_step 'Docker 镜像构建失败。' "请执行：cd $TARGET_DIR && docker compose build"
    fi
  )
  BUILD_STATUS="已通过"

  stop_existing_docker_service

  if ! run_database_migrations; then
    MIGRATION_STATUS="失败"
    restore_docker_service_after_failed_migration "$port" || true
    fail_step '数据库 Migration 执行失败。' \
      '脚本已停止启动新容器，以避免留下不可用状态。' \
      "请执行：cd $TARGET_DIR && docker compose run --rm arcade-atlas npm run migrate" \
      "如需检查现有容器状态，请执行：cd $TARGET_DIR && docker compose ps && docker compose logs --tail=200"
  fi

  (
    cd "$TARGET_DIR"
    if ! "${DOCKER_BIN[@]}" compose up -d; then
      fail_step 'Docker Compose 启动失败。' \
        "请执行：cd $TARGET_DIR && docker compose ps" \
        "请执行：cd $TARGET_DIR && docker compose logs --tail=200"
    fi
  )

  check_docker_container_status
  run_health_check "$port"
}

stop_existing_node_service() {
  local pid_file="$TARGET_DIR/.deploy/arcade-atlas.pid"
  local env_file="$TARGET_DIR/.env"
  local existing_pid=""
  local port=""

  [[ -f "$pid_file" ]] || return
  existing_pid="$(cat "$pid_file" 2>/dev/null || true)"
  port="$(read_env_value "$env_file" "PORT" 2>/dev/null || true)"
  if [[ -n "$existing_pid" ]] && kill -0 "$existing_pid" >/dev/null 2>&1; then
    if ! is_arcade_atlas_pid "$existing_pid" "$port"; then
      local process_cmdline process_cwd
      process_cmdline="$(get_process_cmdline "$existing_pid" 2>/dev/null || true)"
      process_cwd="$(get_process_cwd "$existing_pid" 2>/dev/null || true)"
      fail_step "PID 文件中的进程无法确认属于 Arcade Atlas，已拒绝执行 kill：$existing_pid" \
        "检测到的工作目录：${process_cwd:-unknown}" \
        "检测到的命令行：${process_cmdline:-unknown}" \
        "请手动确认该 PID 后再处理，避免因 PID 复用误杀其他进程。"
    fi

    log "检测到旧的 Node 服务进程，正在停止：$existing_pid"
    PREVIOUS_NODE_SERVICE_RUNNING=1
    kill "$existing_pid" >/dev/null 2>&1 || fail_step "停止旧的 Node 服务失败：$existing_pid"
    if ! wait_for_pid_exit "$existing_pid" 10; then
      warn "Node 服务进程 $existing_pid 在 10 秒内未退出，尝试强制结束。"
      kill -KILL "$existing_pid" >/dev/null 2>&1 || fail_step "强制结束旧的 Node 服务失败：$existing_pid"
      wait_for_pid_exit "$existing_pid" 5 || fail_step "旧的 Node 服务仍未退出：$existing_pid"
    fi
  else
    PREVIOUS_NODE_SERVICE_RUNNING=0
  fi
  rm -f "$pid_file"
}

start_node_service() {
  local pid_file="$1"
  (
    cd "$TARGET_DIR"
    nohup npm run start >"$TARGET_DIR/.deploy/app.log" 2>&1 &
    echo $! >"$pid_file"
  )
}

restore_node_service_after_failed_migration() {
  local port="$1"
  local pid_file="$2"

  [[ "$PREVIOUS_NODE_SERVICE_RUNNING" -eq 1 ]] || return 1

  warn '数据库 Migration 失败，正在尝试恢复之前的 Node 服务。'
  if ! start_node_service "$pid_file"; then
    warn '重新启动旧的 Node 服务失败。'
    return 1
  fi

  if wait_for_health_check "$port" 10 >/dev/null; then
    log '已恢复之前的 Node 服务。'
    return 0
  fi

  warn '旧的 Node 服务恢复后未通过健康检查。'
  return 1
}

run_node_deploy() {
  local env_file="$TARGET_DIR/.env"
  local port pid_file
  port="$(read_env_value "$env_file" "PORT")"
  pid_file="$TARGET_DIR/.deploy/arcade-atlas.pid"
  mkdir -p "$TARGET_DIR/.deploy"
  validate_auth_configuration_before_start "$env_file"

  (
    cd "$TARGET_DIR"
    npm ci
    npm run build
  )
  BUILD_STATUS="已通过"

  confirm "将按“停止旧服务 → 数据库 Migration → nohup 启动新服务”的顺序执行 Node 升级，这会占用端口 $port，是否继续？" || fail_step '用户取消启动 Node 服务。'

  stop_existing_node_service

  if ! run_database_migrations; then
    MIGRATION_STATUS="失败"
    restore_node_service_after_failed_migration "$port" "$pid_file" || true
    fail_step '数据库 Migration 执行失败。' \
      '脚本已停止启动新服务，以避免留下不可用状态。' \
      "请执行：cd $TARGET_DIR && npm run migrate" \
      "如需检查 Node 日志，请查看：$TARGET_DIR/.deploy/app.log"
  fi

  start_node_service "$pid_file" || fail_step 'Node 服务启动失败。' "请检查日志：$TARGET_DIR/.deploy/app.log"

  run_health_check "$port"
}

run_health_check() {
  local port="$1"
  local url="http://127.0.0.1:${port}/health"
  local response_body=""
  response_body="$(wait_for_health_check "$port" 10 || true)"
  if [[ -n "$response_body" ]]; then
    log "健康检查通过：$url"
    API_STATUS="正常"
    if printf '%s' "$response_body" | grep -q '"initialized"[[:space:]]*:[[:space:]]*true'; then
      DATABASE_STATUS="正常"
    else
      DATABASE_STATUS="异常"
    fi
    SERVICE_STATUS="正常"
    return
  fi

  fail_step '健康检查失败。' \
    "失败地址：$url" \
    "如果是 Docker 部署，请执行：cd $TARGET_DIR && docker compose ps && docker compose logs --tail=200" \
    "如果是 Node 部署，请检查：$TARGET_DIR/.deploy/app.log"
}

show_final_summary() {
  local env_file="$TARGET_DIR/.env"
  local app_url auth_mode login_url callback_url username allowlist deployed_version
  app_url="$(read_env_value "$env_file" "APP_URL")"
  auth_mode="$(read_env_value "$env_file" "AUTH_MODE")"
  login_url="${app_url%/}/login"
  deployed_version="$(read_version_from_directory "$TARGET_DIR" 2>/dev/null || printf '未知')"

  step 'Arcade Atlas 部署完成'
  log "版本：$deployed_version"
  log "服务状态：$SERVICE_STATUS"
  log "API：$API_STATUS"
  log "数据库：$DATABASE_STATUS"
  log "Redis：$REDIS_STATUS"
  log "前端构建：$BUILD_STATUS"
  log "Migration：$MIGRATION_STATUS"
  log "访问地址：$app_url"
  log "后台登录地址：$login_url"

  case "$auth_mode" in
    local)
      username="$(read_env_value "$env_file" "LOCAL_ADMIN_USERNAME")"
      log '后台登录方式：用户名 + 密码'
      log "后台用户名：$username"
      log '密码不会再次显示；如需修改，请重新运行部署脚本生成新的密码哈希。'
      ;;
    github)
      callback_url="${app_url%/}/auth/github/callback"
      allowlist="$(read_env_value "$env_file" "OAUTH_ALLOWLIST")"
      log '后台登录方式：GitHub OAuth'
      log "Homepage URL：$app_url"
      log "Authorization callback URL：$callback_url"
      log 'GitHub OAuth App 中需要填写：'
      log "  - Homepage URL: $app_url"
      log "  - Authorization callback URL: $callback_url"
      log '  - GitHub Client ID: 你在 GitHub OAuth App 中看到的公开客户端标识'
      log '  - GitHub Client Secret: 你在 GitHub OAuth App 中生成的私密密钥'
      log "允许登录的 GitHub 用户：$allowlist"
      ;;
    both)
      callback_url="${app_url%/}/auth/github/callback"
      username="$(read_env_value "$env_file" "LOCAL_ADMIN_USERNAME")"
      allowlist="$(read_env_value "$env_file" "OAUTH_ALLOWLIST")"
      log '后台登录方式：用户名 + 密码 + GitHub OAuth'
      log "后台用户名：$username"
      log "GitHub OAuth 回调地址：$callback_url"
      log "允许登录的 GitHub 用户：$allowlist"
      ;;
  esac

  log "更多部署说明见：$TARGET_DIR/DEPLOYMENT.md"
}

handle_existing_installation() {
  if [[ "$INSTALL_STATE" != "installed" ]]; then
    return
  fi

  [[ "$GIT_REPO_STATUS" != "not-a-repo" ]] || fail_step "检测到已有项目目录，但目录不是 Git 仓库：$TARGET_DIR" "请先备份自定义文件后重新部署，或手动转换为 Git 仓库。"

  if [[ "$LATEST_VERSION" != "未知" ]] && [[ "$CURRENT_INSTALL_VERSION" != "未安装" ]] && version_is_newer "$LATEST_VERSION" "$CURRENT_INSTALL_VERSION"; then
    printf '当前版本：%s\n最新版本：%s\n' "$CURRENT_INSTALL_VERSION" "$LATEST_VERSION"
    confirm '检测到新版本，是否升级？' || {
      log '已取消升级，当前版本保持不变。'
      exit 0
    }
  else
    log '当前已安装版本已是最新，继续执行安全重建与健康检查。'
  fi

  backup_existing_installation
  if [[ "$SKIP_GIT_UPDATE" -eq 0 ]]; then
    step '拉取最新代码'
    update_repo_to_latest
  else
    log '已启用 --skip-git-update，升级流程将使用当前本地代码。'
  fi
}

main() {
  parse_args "$@"
  step '检查系统环境'
  detect_os
  ensure_sudo
  ensure_base_commands
  detect_installation_state
  show_detection_summary

  step '准备项目代码'
  if [[ "$INSTALL_STATE" == "installed" ]]; then
    handle_existing_installation
  else
    clone_or_update_repo
  fi
  show_environment_summary

  if [[ "$MODE" == "docker" ]]; then
    step '检查 / 安装 Docker 与 Docker Compose Plugin'
    install_docker_runtime
  else
    step '检查 / 安装 Node.js 运行环境'
    install_node_runtime
  fi

  step '生成并检查 .env 配置'
  prepare_env_file
  validate_database_path_for_mode "$TARGET_DIR/.env"
  check_port

  if [[ "$MODE" == "docker" ]]; then
    step '启动 Docker Compose 服务'
    run_docker_deploy
  else
    step '启动 Node 服务'
    run_node_deploy
  fi

  show_final_summary
}

main "$@"
