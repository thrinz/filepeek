#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

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

echo
echo "Install complete. Run with:"
echo "  .venv/bin/python app.py                      # serves \$HOME on http://127.0.0.1:8765"
echo "  FILEPEEK_ROOT=~/projects .venv/bin/python app.py   # serve a specific directory"
echo
echo "For a remote server (HTTPS, password auth, systemd service), use:"
echo "  deploy/install-remote.sh"
