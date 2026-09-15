#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
source "$SCRIPT_DIR/bootstrap-deploy.sh"

assert_eq() {
  local expected="$1"
  local actual="$2"
  local message="$3"
  if [[ "$expected" != "$actual" ]]; then
    printf 'assertion failed: %s\nexpected: %s\nactual:   %s\n' "$message" "$expected" "$actual" >&2
    exit 1
  fi
}

test_state_file_round_trip() {
  local temp_dir
  temp_dir="$(mktemp -d)"
  trap 'rm -rf "$temp_dir"' RETURN

  TARGET_DIR="$temp_dir/project"
  mkdir -p "$TARGET_DIR/.deploy"
  cat >"$TARGET_DIR/package.json" <<'EOF'
{"name":"arcade-atlas","version":"1.1.0"}
EOF
  cat >"$TARGET_DIR/.env" <<'EOF'
APP_URL=http://atlas.example.com
PORT=3000
APP_BIND_HOST=0.0.0.0
HOST_PORT_BIND_IP=127.0.0.1
TRUST_PROXY_CIDRS=127.0.0.1/8
DATABASE_PATH=./data/arcade-atlas.sqlite
EOF

  MODE="docker"
  ACCESS_MODE="managed_https"
  ACCESS_DOMAIN="atlas.example.com"
  PROXY_KIND="nginx"
  PROXY_MANAGED="true"
  TLS_ENABLED="false"
  TLS_MANAGED="true"
  ACME_PROVIDER_VALUE="letsencrypt"
  CURRENT_APP_URL="http://atlas.example.com"
  DESIRED_APP_URL="https://atlas.example.com"

  write_deployment_state_file partial

  DEPLOYMENT_STATE_FILE_STATUS="missing"
  STATE_FILE_DEPLOY_MODE=""
  STATE_FILE_DEPLOY_STATUS=""
  STATE_FILE_ACCESS_MODE=""
  STATE_FILE_PROXY=""
  STATE_FILE_PROXY_MANAGED=""
  STATE_FILE_TLS_ENABLED=""
  STATE_FILE_TLS_MANAGED=""
  STATE_FILE_ACME_PROVIDER=""
  STATE_FILE_DOMAIN=""

  detect_deployment_state_file_status

  assert_eq "present" "$DEPLOYMENT_STATE_FILE_STATUS" "state file should be readable"
  assert_eq "partial" "$STATE_FILE_DEPLOY_STATUS" "deploy status should round-trip"
  assert_eq "managed_https" "$STATE_FILE_ACCESS_MODE" "access mode should round-trip"
  assert_eq "nginx" "$STATE_FILE_PROXY" "proxy should round-trip"
  assert_eq "true" "$STATE_FILE_PROXY_MANAGED" "proxy ownership should round-trip"
  assert_eq "false" "$STATE_FILE_TLS_ENABLED" "tls enabled should round-trip"
  assert_eq "true" "$STATE_FILE_TLS_MANAGED" "tls managed should round-trip"
  assert_eq "letsencrypt" "$STATE_FILE_ACME_PROVIDER" "acme provider should round-trip"
}

test_legacy_state_file_compatibility() {
  local temp_dir
  temp_dir="$(mktemp -d)"
  trap 'rm -rf "$temp_dir"' RETURN

  TARGET_DIR="$temp_dir/project"
  mkdir -p "$TARGET_DIR/.deploy"
  cat >"$TARGET_DIR/package.json" <<'EOF'
{"name":"arcade-atlas","version":"1.1.0"}
EOF
  cat >"$TARGET_DIR/.env" <<'EOF'
APP_URL=https://atlas.example.com
PORT=3000
APP_BIND_HOST=127.0.0.1
HOST_PORT_BIND_IP=127.0.0.1
TRUST_PROXY_CIDRS=127.0.0.1/8
DATABASE_PATH=./data/arcade-atlas.sqlite
EOF
  cat >"$TARGET_DIR/.deploy/deployment-state.env" <<'EOF'
DEPLOY_MODE=docker
DEPLOY_STATUS=healthy
DEPLOY_VERSION=1.1.0
TARGET_DIR=__TARGET_DIR__
UPDATED_AT=2026-09-15T00:00:00Z
EOF
  python3 - "$TARGET_DIR/.deploy/deployment-state.env" "$TARGET_DIR" <<'PY'
from pathlib import Path
import sys
path = Path(sys.argv[1])
target_dir = sys.argv[2]
path.write_text(path.read_text().replace("__TARGET_DIR__", target_dir), encoding="utf-8")
PY

  detect_deployment_state_file_status

  assert_eq "present" "$DEPLOYMENT_STATE_FILE_STATUS" "legacy state should remain valid"
  assert_eq "external_proxy" "$STATE_FILE_ACCESS_MODE" "legacy https app_url should infer external proxy"
  assert_eq "false" "$STATE_FILE_PROXY_MANAGED" "legacy installs default to unmanaged proxy"
  assert_eq "true" "$STATE_FILE_TLS_ENABLED" "legacy https app_url should infer tls enabled"
  assert_eq "false" "$STATE_FILE_TLS_MANAGED" "legacy installs default to unmanaged tls"
}

test_access_mode_runtime_defaults() {
  MODE="docker"
  ACCESS_MODE="external_proxy"
  apply_access_mode_runtime_defaults
  assert_eq "0.0.0.0" "$APP_BIND_HOST_VALUE" "docker external proxy should keep container listener reachable"
  assert_eq "127.0.0.1" "$HOST_PORT_BIND_IP_VALUE" "external proxy should bind docker publish ip to localhost"

  MODE="node"
  ACCESS_MODE="external_proxy"
  apply_access_mode_runtime_defaults
  assert_eq "127.0.0.1" "$APP_BIND_HOST_VALUE" "node external proxy should bind runtime to localhost"

  ACCESS_MODE="direct_http"
  apply_access_mode_runtime_defaults
  assert_eq "0.0.0.0" "$APP_BIND_HOST_VALUE" "direct http should expose node runtime"
  assert_eq "0.0.0.0" "$HOST_PORT_BIND_IP_VALUE" "direct http should expose docker publish ip"
}

test_state_file_round_trip
test_legacy_state_file_compatibility
test_access_mode_runtime_defaults

printf 'bootstrap-deploy tests passed\n'
