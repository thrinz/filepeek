#!/usr/bin/env bash
#
# filepeek remote installer — sets up filepeek on a fresh Ubuntu/Debian (or
# Fedora/RHEL-family) server with password auth, HTTPS, and a systemd service.
#
# Usage (as root, on the server):
#   curl -fsSL https://raw.githubusercontent.com/thrinz/filepeek/main/deploy/install-remote.sh | bash
#
# Options via environment variables:
#   FILEPEEK_DOMAIN    Domain pointing at this server. Enables trusted
#                      Let's Encrypt certificates. Without it, Caddy uses a
#                      self-signed cert (browser shows a one-time warning).
#   FILEPEEK_MODE      "public" (default: Caddy reverse proxy on 80/443) or
#                      "tailscale" (no public exposure; served on your tailnet).
#   FILEPEEK_ROOT_DIR  Directory to serve. Default: /srv/filepeek/files
#   FILEPEEK_REPO      Git repo to install from (default below).
#   TS_AUTHKEY         Tailscale auth key (tailscale mode; skips interactive login).
#
#   FILEPEEK_PHASE     "full" (default) — install + credentials + start.
#                      "image" — marketplace image build: install everything but
#                      generate NO credentials and leave the service disabled;
#                      installs a cloud-init per-instance hook instead.
#                      "firstboot" — run by that hook on a marketplace
#                      instance's first boot: credentials, config, start.
#
# Example with a domain:
#   curl -fsSL https://.../install-remote.sh | FILEPEEK_DOMAIN=files.example.com bash

set -euo pipefail

REPO="${FILEPEEK_REPO:-https://github.com/thrinz/filepeek}"
PHASE="${FILEPEEK_PHASE:-full}"
MODE="${FILEPEEK_MODE:-public}"
DOMAIN="${FILEPEEK_DOMAIN:-}"
DATA_DIR="${FILEPEEK_ROOT_DIR:-/srv/filepeek/files}"
APP_DIR=/opt/filepeek
STATE_DIR=/var/lib/filepeek
ENV_FILE=/etc/filepeek/filepeek.env
CREDS_FILE=/root/filepeek-credentials.txt
PORT=8765

PKG=""
PASSWORD=""
TOKEN=""
URL=""
CERT_NOTE=""

require_root() {
  if [ "$(id -u)" -ne 0 ]; then
    echo "ERROR: run as root (sudo)." >&2
    exit 1
  fi
}

detect_pkg() {
  if command -v apt-get >/dev/null 2>&1; then
    PKG=apt
    export DEBIAN_FRONTEND=noninteractive
  elif command -v dnf >/dev/null 2>&1; then
    PKG=dnf
  else
    echo "ERROR: unsupported distro (need apt or dnf)." >&2
    exit 1
  fi
}

install_packages() {
  echo "==> Installing system packages"
  if [ "$PKG" = apt ]; then
    apt-get update -qq
    apt-get install -y -qq python3 python3-venv git curl
  else
    dnf install -y -q python3 git curl
  fi
}

install_app() {
  echo "==> Installing filepeek to ${APP_DIR}"
  id -u filepeek >/dev/null 2>&1 || useradd --system --home-dir "$STATE_DIR" --shell /usr/sbin/nologin filepeek

  if [ -d "$APP_DIR/.git" ]; then
    git -C "$APP_DIR" pull --ff-only
  else
    git clone --depth 1 "$REPO" "$APP_DIR"
  fi

  python3 -m venv "$APP_DIR/.venv"
  "$APP_DIR/.venv/bin/python" -m pip install --quiet --upgrade pip
  "$APP_DIR/.venv/bin/python" -m pip install --quiet -r "$APP_DIR/requirements.txt"

  mkdir -p "$DATA_DIR" "$STATE_DIR" "$(dirname "$ENV_FILE")"
  chown -R filepeek:filepeek "$DATA_DIR" "$STATE_DIR"
  chown -R filepeek:filepeek "$APP_DIR"
}

install_service() {
  cp "$APP_DIR/filepeek.service" /etc/systemd/system/filepeek.service
  systemctl daemon-reload
}

generate_credentials() {
  echo "==> Generating credentials"
  PASSWORD="$(python3 -c 'import secrets; print(secrets.token_urlsafe(12))')"
  TOKEN="$(python3 -c 'import secrets; print(secrets.token_urlsafe(32))')"
  local secret hash
  secret="$(python3 -c 'import secrets; print(secrets.token_hex(32))')"
  hash="$("$APP_DIR/.venv/bin/python" "$APP_DIR/app.py" hash-password "$PASSWORD")"

  cat > "$ENV_FILE" <<EOF
FILEPEEK_ROOT=$DATA_DIR
FILEPEEK_STATE_DIR=$STATE_DIR
FILEPEEK_HOST=127.0.0.1
FILEPEEK_PORT=$PORT
FILEPEEK_PASSWORD_HASH=$hash
FILEPEEK_TOKEN=$TOKEN
FILEPEEK_SECRET=$secret
FILEPEEK_PASSWORD_MUST_CHANGE=1
EOF
  chown root:filepeek "$ENV_FILE"
  chmod 640 "$ENV_FILE"
}

start_service() {
  echo "==> Starting filepeek service"
  systemctl enable --now filepeek.service
}

install_caddy() {
  echo "==> Installing Caddy (HTTPS reverse proxy)"
  if [ "$PKG" = apt ]; then
    apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
      | gpg --batch --yes --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
      > /etc/apt/sources.list.d/caddy-stable.list
    apt-get update -qq
    apt-get install -y -qq caddy
  else
    dnf install -y -q 'dnf-command(copr)'
    dnf copr enable -y -q @caddy/caddy
    dnf install -y -q caddy
  fi
}

configure_caddy() {
  if [ -n "$DOMAIN" ]; then
    cat > /etc/caddy/Caddyfile <<EOF
$DOMAIN {
    reverse_proxy 127.0.0.1:$PORT
}
EOF
    URL="https://$DOMAIN"
  else
    cat > /etc/caddy/Caddyfile <<EOF
:443 {
    tls internal
    reverse_proxy 127.0.0.1:$PORT
}
EOF
    local public_ip
    public_ip="$(curl -fsS --max-time 5 https://ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')"
    URL="https://$public_ip"
    CERT_NOTE="(self-signed cert: your browser will warn once — to fix, point a domain
   at this server, set it in /etc/caddy/Caddyfile, and: systemctl restart caddy)"
  fi
  systemctl enable caddy >/dev/null 2>&1 || true
  systemctl restart caddy

  if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
    ufw allow 80/tcp >/dev/null
    ufw allow 443/tcp >/dev/null
  fi
}

setup_tailscale() {
  echo "==> Installing Tailscale"
  curl -fsSL https://tailscale.com/install.sh | sh
  if [ -n "${TS_AUTHKEY:-}" ]; then
    tailscale up --authkey="$TS_AUTHKEY"
    tailscale serve --bg "$PORT"
    URL="https://$(tailscale status --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))')"
  else
    CERT_NOTE="Tailscale is installed but not connected. Finish setup with:
   tailscale up
   tailscale serve --bg $PORT"
    URL="https://<your-machine>.<your-tailnet>.ts.net (after the steps above)"
  fi
}

install_firstboot_hooks() {
  echo "==> Installing first-boot credential hook (marketplace image)"
  # cloud-init runs per-instance scripts exactly once per new instance
  mkdir -p /var/lib/cloud/scripts/per-instance
  cat > /var/lib/cloud/scripts/per-instance/001-filepeek.sh <<'EOF'
#!/bin/bash
FILEPEEK_PHASE=firstboot bash /opt/filepeek/deploy/install-remote.sh >> /var/log/filepeek-firstboot.log 2>&1
EOF
  chmod +x /var/lib/cloud/scripts/per-instance/001-filepeek.sh

  # Show credentials on SSH login (marketplace convention)
  cat > /etc/update-motd.d/99-filepeek <<'EOF'
#!/bin/sh
if [ -f /root/filepeek-credentials.txt ]; then
  echo "********************************************************"
  cat /root/filepeek-credentials.txt
  echo "********************************************************"
fi
EOF
  chmod +x /etc/update-motd.d/99-filepeek
}

write_summary() {
  cat > "$CREDS_FILE" <<EOF
filepeek — installed $(date -u +%Y-%m-%dT%H:%M:%SZ)

URL:                $URL
Temporary password: $PASSWORD   (you'll set your own on first login)
API token:          $TOKEN   (use as:  Authorization: Bearer <token>)

Files served from:  $DATA_DIR
Config:             $ENV_FILE
Reset the password: remove $STATE_DIR/auth.json, then 'systemctl restart filepeek'
                    to revert to the temporary password above (forces a change again).
EOF
  chmod 600 "$CREDS_FILE"

  echo
  echo "============================================================"
  echo " filepeek is running."
  echo
  echo "   URL:                $URL"
  [ -n "$CERT_NOTE" ] && echo "   Note:      $CERT_NOTE"
  echo "   Temporary password: $PASSWORD   (set your own on first login)"
  echo "   API token:          $TOKEN"
  echo
  echo " Credentials also saved to $CREDS_FILE"
  echo " Files are served from $DATA_DIR — put your files there."
  echo "============================================================"
}

require_root
detect_pkg

case "$PHASE" in
  full)
    if [ "$MODE" != "public" ] && [ "$MODE" != "tailscale" ]; then
      echo "ERROR: FILEPEEK_MODE must be 'public' or 'tailscale'." >&2
      exit 1
    fi
    install_packages
    install_app
    install_service
    generate_credentials
    start_service
    if [ "$MODE" = "public" ]; then
      install_caddy
      configure_caddy
    else
      setup_tailscale
    fi
    write_summary
    ;;
  image)
    install_packages
    install_app
    install_service
    install_caddy
    install_firstboot_hooks
    echo "==> Image build complete (no credentials generated; service disabled)"
    ;;
  firstboot)
    # Marketplace instances are always public mode; user can add a domain later
    generate_credentials
    start_service
    configure_caddy
    write_summary
    ;;
  *)
    echo "ERROR: FILEPEEK_PHASE must be 'full', 'image', or 'firstboot'." >&2
    exit 1
    ;;
esac
