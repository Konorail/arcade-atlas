#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

exec bash "$SCRIPT_DIR/bootstrap-deploy.sh" --skip-git-update --target-dir "$PROJECT_DIR" "$@"
