<p align="center">
  <img src="static/logo.svg" width="72" alt="filepeek logo"><br>
  <b>filepeek</b><br>
  A single-file web viewer for AI-generated files.
</p>

Claude (or any coding agent) just wrote a pile of `.md`, `.html`, and `.xlsx` files
into your WSL2 or Linux filesystem — and now you're squinting at raw markdown in a
terminal. filepeek serves any directory as a browsable web UI that *renders* what
agents produce:

- **Markdown** with Mermaid diagrams
- **HTML** pages, served directly
- **Office files** — xlsx, docx, pptx — rendered in the browser, no Office needed
- **Code** of ~60 file types, CSV/TSV tables, images, PDFs
- Plus: inline editing, upload/download, zip a folder, filename & content search,
  bookmarks, and permalinks for sharing rendered views

One Python file, one HTML file, no database.

## Quick start (local / WSL2)

```bash
git clone https://github.com/thrinz/filepeek && cd filepeek
./install.sh                                # creates .venv, installs deps
FILEPEEK_ROOT=~/projects .venv/bin/python app.py
```

Open http://localhost:8765. On WSL2, that URL works directly in your **Windows**
browser — localhost forwarding is automatic. No auth is required in local mode
because the server only listens on 127.0.0.1.

## Remote server (AWS, GCP, Azure, DigitalOcean, Linode, …)

Two ways, both end with HTTPS + password auth + a systemd service:

**A. Cloud-init (no SSH needed).** Paste [`deploy/cloud-init.yaml`](deploy/cloud-init.yaml)
into the "user data" box when creating the server. After first boot:

```bash
ssh root@<server-ip> cat /root/filepeek-credentials.txt
```

**B. One-liner over SSH** on a fresh Ubuntu/Debian or Fedora server:

```bash
curl -fsSL https://raw.githubusercontent.com/thrinz/filepeek/main/deploy/install-remote.sh | sudo bash
```

With a domain pointed at the server you get a trusted Let's Encrypt certificate:

```bash
curl -fsSL https://.../install-remote.sh | sudo FILEPEEK_DOMAIN=files.example.com bash
```

Prefer no public exposure at all? `FILEPEEK_MODE=tailscale` serves it only on your
[Tailscale](https://tailscale.com) network instead of installing Caddy.

## Security model

- **Local mode** (default): binds 127.0.0.1, no auth — nothing is exposed.
- **Remote mode**: auth turns on when `FILEPEEK_PASSWORD_HASH` and/or
  `FILEPEEK_TOKEN` is set. The app **refuses to start** on a non-loopback address
  without auth configured, because it grants read/write access to your files.
- Password login uses PBKDF2 hashing, signed HttpOnly session cookies, a per-IP
  lockout after repeated failures, and never stores the plaintext password.
- Scripted access: `Authorization: Bearer <FILEPEEK_TOKEN>`.
- HTTPS comes from the Caddy reverse proxy (or Tailscale) set up by the installer —
  don't expose the app port directly.
- Need multiple users or SSO? Put [oauth2-proxy](https://github.com/oauth2-proxy/oauth2-proxy)
  or [Authelia](https://www.authelia.com) in front — filepeek deliberately stays
  single-credential.

## Configuration

All via environment variables:

| Variable | Default | Purpose |
|---|---|---|
| `FILEPEEK_ROOT` | `$HOME` | Directory to serve |
| `FILEPEEK_HOST` | `127.0.0.1` | Bind address (`--host` flag also works) |
| `FILEPEEK_PORT` | `8765` | Port (`--port` flag also works) |
| `FILEPEEK_PASSWORD_HASH` | unset | Enables password login. Generate: `python app.py hash-password` |
| `FILEPEEK_TOKEN` | unset | Enables bearer-token auth for scripts/API |
| `FILEPEEK_SECRET` | random per start | Session-cookie signing key; set it to keep logins across restarts |
| `FILEPEEK_STATE_DIR` | app directory | Where bookmarks/permalinks JSON lives |

## License

[MIT](LICENSE)
