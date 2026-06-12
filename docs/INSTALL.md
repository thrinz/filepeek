# Installing filepeek

filepeek runs in two very different postures, and the setup differs accordingly:

- **Local / WSL2** — binds `127.0.0.1`, no auth, nothing exposed. One command.
- **Remote server** — public or tailnet-only, always with auth + HTTPS + systemd.

---

## Local / WSL2

### Prerequisites

- Python 3.9+ with the `venv` module. On Debian/Ubuntu:

  ```bash
  sudo apt install python3-venv
  ```

  (`install.sh` checks for this and tells you the exact package name if it's missing.)

### Install and run

```bash
git clone https://github.com/thrinz/filepeek && cd filepeek
./install.sh                                  # creates .venv, installs deps
FILEPEEK_ROOT=~/projects .venv/bin/python app.py
```

Open **http://localhost:8765**. Without `FILEPEEK_ROOT`, filepeek serves your
home directory.

### WSL2 notes

- **The URL works directly in your Windows browser.** WSL2 forwards
  `localhost` automatically — no port proxying, no firewall rules.
- **Serving Windows folders:** point `FILEPEEK_ROOT` at a `/mnt` path, e.g.
  `FILEPEEK_ROOT=/mnt/c/Users/you/Documents`. Browsing works fine; note that
  `/mnt/c` is slower than the Linux filesystem, so content search over large
  trees will be noticeably slower there.
- **No auth is needed** because the server only listens on `127.0.0.1` inside
  your WSL2 VM. Other machines on your network cannot reach it. (If you bind
  `0.0.0.0` to change that, filepeek refuses to start without auth configured —
  see the [security model](../README.md#security-model).)

### Keeping it running

For an always-on local instance, run it as a user service instead of keeping a
terminal open:

```bash
mkdir -p ~/.config/systemd/user
cat > ~/.config/systemd/user/filepeek.service <<EOF
[Unit]
Description=filepeek (local)

[Service]
Environment=FILEPEEK_ROOT=%h/projects
ExecStart=$PWD/.venv/bin/python $PWD/app.py
Restart=on-failure

[Install]
WantedBy=default.target
EOF
systemctl --user enable --now filepeek
```

On WSL2 this requires systemd to be enabled (`/etc/wsl.conf` →
`[boot] systemd=true`, default on current WSL versions).

### Local configuration

| Variable | Default | Purpose |
|---|---|---|
| `FILEPEEK_ROOT` | `$HOME` | Directory to serve |
| `FILEPEEK_PORT` | `8765` | Port (`--port` flag also works) |
| `FILEPEEK_STATE_DIR` | app directory | Where bookmarks/permalinks JSON lives |

---

## Remote server

All remote paths end in the same place: filepeek as a hardened systemd service
(`filepeek.service`, dedicated user, `NoNewPrivileges`, `PrivateTmp`), password
auth + bearer token generated for you, and HTTPS in front. Pick by how you want
to install and how you want to expose it:

| Option | Exposure | HTTPS | You need | Best for |
|---|---|---|---|---|
| **A. Cloud-init** | Public (Caddy on 80/443) | Self-signed, or Let's Encrypt with a domain | Nothing — paste at server creation | Fresh cloud servers, zero SSH |
| **B. One-liner over SSH** | Public (Caddy on 80/443) | Self-signed, or Let's Encrypt with a domain | Root SSH access | Existing servers |
| **C. Tailscale mode** | Tailnet only — no public ports | Automatic via Tailscale | A [Tailscale](https://tailscale.com) account | Private access without exposing anything |
| **D. Manual** | Your choice | Your reverse proxy | Reading 200 lines of bash | Auditing, custom setups |

Supported distros: Ubuntu/Debian and Fedora/RHEL-family (the installer detects
`apt` vs `dnf`).

### A. Cloud-init (no SSH needed)

Paste [`deploy/cloud-init.yaml`](../deploy/cloud-init.yaml) into the "user
data" box when creating the server:

| Provider | Where to paste |
|---|---|
| AWS EC2 | Launch instance → Advanced details → User data |
| Google Cloud | Create instance → Advanced → Automation (metadata key `user-data`) |
| Azure | Create VM → Advanced → Custom data |
| DigitalOcean | Create Droplet → Advanced Options → Add Initialization scripts |
| Linode | Create Linode → Add User Data |

After first boot:

```bash
ssh root@<server-ip> cat /root/filepeek-credentials.txt
```

To get a trusted certificate instead of self-signed, set `FILEPEEK_DOMAIN` on
the `runcmd` line inside the YAML before pasting (the domain's DNS must already
point at the server).

### B. One-liner over SSH

On a fresh server, as root:

```bash
curl -fsSL https://raw.githubusercontent.com/thrinz/filepeek/main/deploy/install-remote.sh | sudo bash
```

With a domain pointed at the server (trusted Let's Encrypt certificate):

```bash
curl -fsSL https://raw.githubusercontent.com/thrinz/filepeek/main/deploy/install-remote.sh \
  | sudo FILEPEEK_DOMAIN=files.example.com bash
```

Credentials are printed at the end and saved to `/root/filepeek-credentials.txt`.

Installer options (all via environment variables):

| Variable | Default | Purpose |
|---|---|---|
| `FILEPEEK_DOMAIN` | unset | Enables Let's Encrypt; otherwise self-signed cert (one-time browser warning) |
| `FILEPEEK_MODE` | `public` | `public` (Caddy on 80/443) or `tailscale` |
| `FILEPEEK_ROOT_DIR` | `/srv/filepeek/files` | Directory to serve |
| `TS_AUTHKEY` | unset | Tailscale auth key — skips the interactive login in tailscale mode |

### C. Tailscale mode (no public exposure)

```bash
curl -fsSL https://raw.githubusercontent.com/thrinz/filepeek/main/deploy/install-remote.sh \
  | sudo FILEPEEK_MODE=tailscale bash
```

No Caddy, no open ports 80/443 — filepeek is reachable only from devices on
your tailnet, with HTTPS handled by Tailscale. Pass `TS_AUTHKEY=tskey-...` to
skip the interactive `tailscale up` login (useful in cloud-init).

### D. Manual install

If you'd rather not pipe a script into bash (reasonable!), the installer is
~280 lines of commented bash doing exactly this — read it, then do it by hand:

1. Clone to `/opt/filepeek`, run `install.sh` there.
2. Generate a password hash: `.venv/bin/python app.py hash-password`.
3. Write `/etc/filepeek/filepeek.env` with `FILEPEEK_PASSWORD_HASH`,
   `FILEPEEK_TOKEN`, `FILEPEEK_SECRET`, `FILEPEEK_ROOT`, and
   `FILEPEEK_HOST=127.0.0.1`.
4. Create a `filepeek` system user; install the provided
   [`filepeek.service`](../filepeek.service) unit; `systemctl enable --now filepeek`.
5. Put your reverse proxy of choice (Caddy, nginx, Traefik) in front for HTTPS.
   **Don't expose port 8765 directly** — TLS is the proxy's job.

### Where things live (installed layout)

| Path | What |
|---|---|
| `/opt/filepeek` | App code + venv |
| `/srv/filepeek/files` | Served directory (change with `FILEPEEK_ROOT_DIR`) |
| `/etc/filepeek/filepeek.env` | All configuration & secrets (root-only) |
| `/var/lib/filepeek` | Bookmarks/permalinks state |
| `/root/filepeek-credentials.txt` | Generated password & token |

### Managing the service

```bash
systemctl status filepeek            # is it running?
journalctl -u filepeek -f            # logs
sudo systemctl restart filepeek      # after config changes

# Change the password
cd /opt/filepeek && sudo .venv/bin/python app.py hash-password
# → put the new hash in /etc/filepeek/filepeek.env, then restart

# Update to the latest version
cd /opt/filepeek && sudo git pull && sudo systemctl restart filepeek
```
