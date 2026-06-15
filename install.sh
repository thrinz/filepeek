#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"
REPO="$(pwd)"

# --service installs a systemd *user* service so filepeek runs in the background
# and auto-starts on boot (handy on WSL2 — reach localhost:PORT from Windows any
# time, no terminal). Default is the simple foreground run.
SERVICE=0
for arg in "$@"; do
  case "$arg" in
    --service|--systemd) SERVICE=1 ;;
    -h|--help)
      echo "usage: ./install.sh [--service]"
      echo "  --service   also install + start a systemd user service (auto-starts on boot)"
      echo "  env: FILEPEEK_ROOT (dir to serve, default \$HOME), FILEPEEK_PORT (default 8765)"
      exit 0 ;;
    *) echo "unknown option: $arg (try --help)" >&2; exit 1 ;;
  esac
done

ROOT="${FILEPEEK_ROOT:-$HOME}"
PORT="${FILEPEEK_PORT:-8765}"

# Ensure python venv is available
if ! python3 -m venv --help >/dev/null 2>&1; then
  echo "ERROR: python3-venv is not available." >&2
  PYV="$(python3 -c 'import sys;print(f"python{sys.version_info.major}.{sys.version_info.minor}")')"
  echo "Install it first:  sudo apt install ${PYV}-venv" >&2
  exit 1
fi

if [ ! -d .venv ]; then
  python3 -m venv .venv
fi

# Some distros split out ensurepip; if so try the matching apt pkg hint below
.venv/bin/python -m ensurepip --upgrade 2>/dev/null || true
.venv/bin/python -m pip install --upgrade pip
.venv/bin/python -m pip install -r requirements.txt

if [ "$SERVICE" -eq 0 ]; then
  echo
  echo "Install complete. Run with:"
  echo "  .venv/bin/python app.py                      # serves \$HOME on http://127.0.0.1:8765"
  echo "  FILEPEEK_ROOT=~/projects .venv/bin/python app.py   # serve a specific directory"
  echo
  echo "Run it in the background, auto-starting on boot:"
  echo "  FILEPEEK_ROOT=~/projects ./install.sh --service"
  echo
  echo "For a remote server (HTTPS, password auth, systemd service), use:"
  echo "  deploy/install-remote.sh"
  exit 0
fi

# --- systemd user service -------------------------------------------------
echo
echo "==> installing systemd user service (serving $ROOT on port $PORT)"
if [ ! -d /run/systemd/system ]; then
  cat >&2 <<MSG
    !! systemd is not running — the user service needs it.
       On WSL2: add the following to /etc/wsl.conf, then run 'wsl --shutdown' in
       Windows (PowerShell) and reopen the terminal:

           [boot]
           systemd=true

MSG
  exit 1
fi

mkdir -p "$HOME/.config/systemd/user"
sed -e "s|@REPO@|$REPO|g" -e "s|@ROOT@|$ROOT|g" -e "s|@PORT@|$PORT|g" \
  "$REPO/deploy/filepeek-user.service" > "$HOME/.config/systemd/user/filepeek.service"
systemctl --user daemon-reload
systemctl --user enable filepeek.service
systemctl --user restart filepeek.service

# Start at boot without a login (WSL2 especially).
if ! loginctl enable-linger "$USER" 2>/dev/null; then
  echo "    !! could not enable linger; run manually: sudo loginctl enable-linger $USER"
fi

# Surface a real startup failure instead of a silent one.
sleep 2
if ! systemctl --user is-active --quiet filepeek.service; then
  echo "    !! filepeek failed to start. Recent logs:" >&2
  journalctl --user -u filepeek --no-pager -n 15 >&2 || true
  ss -ltnp 2>/dev/null | grep -E ":$PORT" >&2 || true
  exit 1
fi

echo
echo "============================================================"
echo " filepeek is running — open it at:"
echo
echo "     http://localhost:$PORT     (serving $ROOT)"
echo
echo " It auto-starts on boot (systemd user service). Manage it with:"
echo "     systemctl --user status  filepeek"
echo "     systemctl --user restart filepeek"
echo "     journalctl --user -u filepeek -f      # live logs"
echo "============================================================"
echo "(Add a login: generate a hash with '.venv/bin/python app.py hash-password',"
echo " put FILEPEEK_PASSWORD_HASH=... in ~/.config/filepeek/filepeek.env, then restart.)"
