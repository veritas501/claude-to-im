#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SERVICE_NAME="claude-to-im"
SYSTEMD_DIR="/etc/systemd/system"
SERVICE_SRC="$PROJECT_DIR/$SERVICE_NAME.service"

CTI_HOME="${CTI_HOME:-$HOME/.claude-to-im}"
SERVICE_DEST="$SYSTEMD_DIR/$SERVICE_NAME.service"

resolve_bun_path() {
  local p
  p="$(command -v bun 2>/dev/null || true)"
  [ -n "$p" ] && echo "$p" && return
  if [ -x "$HOME/.bun/bin/bun" ]; then
    echo "$HOME/.bun/bin/bun"
    return
  fi
  echo ""
}

BUN_PATH="$(resolve_bun_path)"
USER="$(whoami)"
GROUP="$(id -gn)"

generate_service() {
  local default_path="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
  local bun_dir
  bun_dir="$(dirname "$BUN_PATH" 2>/dev/null || true)"
  [ -n "$bun_dir" ] && default_path="$bun_dir:$default_path"

  cat > "$SERVICE_SRC" <<SERVICE
[Unit]
Description=Claude-to-IM Bridge Daemon
Documentation=https://github.com/veritas501/claude-to-im
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$USER
Group=$GROUP
Environment=HOME=$HOME
Environment=PATH=$default_path
Environment=CTI_HOME=$CTI_HOME
Environment=NODE_PATH=$PROJECT_DIR/node_modules

# Load credentials from config.env
EnvironmentFile=-$CTI_HOME/config.env

WorkingDirectory=$PROJECT_DIR
ExecStart=$PROJECT_DIR/daemon
Restart=on-failure
RestartSec=5

# Logging
StandardOutput=append:$CTI_HOME/logs/bridge.log
StandardError=append:$CTI_HOME/logs/bridge-error.log

# Security hardening
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=$CTI_HOME $HOME/im_chat /tmp
PrivateTmp=true

[Install]
WantedBy=multi-user.target
SERVICE

  echo "Generated: $SERVICE_SRC"
}

cmd_install() {
  if [ ! -f "$PROJECT_DIR/daemon" ]; then
    echo "Error: $PROJECT_DIR/daemon not found. Run 'bun run build' first."
    exit 1
  fi

  generate_service

  echo "Installing $SERVICE_NAME.service to $SYSTEMD_DIR ..."
  sudo cp "$SERVICE_SRC" "$SERVICE_DEST"
  sudo systemctl daemon-reload
  sudo systemctl enable "$SERVICE_NAME"

  echo ""
  echo "Installed. Start with: sudo systemctl start $SERVICE_NAME"
}

cmd_uninstall() {
  if [ ! -f "$SERVICE_DEST" ]; then
    echo "$SERVICE_NAME.service is not installed."
    exit 0
  fi

  echo "Stopping $SERVICE_NAME ..."
  sudo systemctl stop "$SERVICE_NAME" 2>/dev/null || true
  sudo systemctl disable "$SERVICE_NAME" 2>/dev/null || true
  sudo rm -f "$SERVICE_DEST"
  sudo systemctl daemon-reload

  echo "Uninstalled."
}

cmd_reload() {
  if [ ! -f "$PROJECT_DIR/daemon" ]; then
    echo "Error: $PROJECT_DIR/daemon not found. Run 'bun run build' first."
    exit 1
  fi

  generate_service
  sudo cp "$SERVICE_SRC" "$SERVICE_DEST"
  sudo systemctl daemon-reload
  sudo systemctl restart "$SERVICE_NAME"
  echo "Reloaded and restarted."
}

case "${1:-help}" in
  install)   cmd_install ;;
  uninstall) cmd_uninstall ;;
  reload)    cmd_reload ;;
  generate)
    generate_service
    echo "(service file only — not installed)"
    ;;
  *)
    echo "Usage: service.sh {install|uninstall|reload|generate}"
    echo ""
    echo "  install    Build, generate service file and install to systemd"
    echo "  uninstall  Stop and remove service from systemd"
    echo "  reload     Regenerate service file and restart daemon"
    echo "  generate   Generate service file without installing"
    ;;
esac
