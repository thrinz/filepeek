<p align="center">
  <img src="static/logo.svg" width="72" alt="filepeek — viewer for AI-generated files"><br>
  <b>filepeek</b>
</p>

<h1 align="center">View AI-generated files in your browser</h1>

<p align="center">
  A single-file, self-hosted web viewer for the files AI agents produce —
  Markdown, HTML, Excel, Word, PowerPoint, CSV, code, images, and PDFs —
  rendered, not raw.
</p>

Claude Code, ChatGPT, Cursor, or any coding agent just wrote a pile of `.md`,
`.html`, and `.xlsx` files into your WSL2 or Linux filesystem — and now you're
squinting at raw markdown in a terminal. filepeek serves any directory as a
browsable web UI that *renders* what agents produce:

- **Markdown** rendered with **Mermaid diagram** support — read AI-written docs,
  plans, and reports the way they were meant to look
- **HTML** pages, served directly — preview agent-built dashboards and mockups
- **Office files** — view **xlsx, docx, pptx in the browser**, no Microsoft
  Office needed
- **Code** in ~60 languages, CSV/TSV as tables, images, PDFs
- **Track boards** — open a `.nts` file as a kanban/table task board with bugs,
  owners, labels, priorities, and checklists, edited in the browser and saved
  back as plain JSON
- **Automatic backup** — protect selected folders (or everything) to a local/NAS
  folder or any S3-compatible cloud (AWS, Backblaze B2, Wasabi, Cloudflare R2,
  MinIO), on a schedule or on demand
- Plus: inline editing, upload/download, zip a folder, filename & full-text
  search, bookmarks, and shareable permalinks of rendered views — every folder
  and file has a bookmarkable URL

One Python file, one HTML file, no database. Works on Linux, macOS, and
**WSL2** (open it straight from your Windows browser), or on a cloud VM with
HTTPS and password login via the one-line installer.

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

## Tracks — task boards in a file

Any file ending in `.nts` opens as an interactive **task board** instead of raw
text. It's a self-contained kanban/planner stored as plain JSON:

- **Three views** of the same board — **kanban** columns, a sortable **table**,
  and a cross-task **bugs** list.
- **Rich tasks** — title, description, owner, category, status, priority,
  start/due dates, labels, checklists, and comments.
- **Bug tracking** — file bugs against any task, each auto-numbered, with their
  own status.
- **Group and drag** — group columns by status, category, owner, or label, and
  drag cards between them.
- **New board** from the **Tracks** menu in the header, which also lists every
  `.nts` board in your tree.

Boards autosave back to the `.nts` file as JSON, so they're versionable,
diff-able, and portable — nothing lives in a database. Create a board from the
Tracks menu, or just make a file like `roadmap.nts` and open it.

## Backup

filepeek can back up everything it serves to a **local/NAS folder** or an
**S3-compatible cloud bucket**, on a schedule or on demand. Open the **☁ Backup**
toolbar button to configure it. Full details — setup, modes, safety, and restore
— are in **[docs/BACKUP.md](docs/BACKUP.md)**.

The essentials:

- **No external tools to install.** Local backups use the Python standard
  library; cloud backups use the S3 API (via `boto3`, a normal dependency).
  Nothing extra to set up on the server.
- **Back up everything or just some folders.** A checklist lets you pick which
  top-level folders to protect (or leave all checked to back up the whole served
  root, including folders added later). Mirror deletions stay scoped to the
  folders you selected.
- **Easy cloud setup.** For cloud, paste four values — endpoint, bucket, access
  key, secret — for any S3-compatible provider (AWS, Backblaze B2, Wasabi,
  Cloudflare R2, MinIO). No OAuth, no provider console app to register. (Don't
  want a credential at all? Use a local/NAS folder, or a folder your desktop
  Dropbox/OneDrive client already syncs.)
- **Safe by default.** The default mode **copies** — it only adds and updates
  files at the destination and never deletes. An advanced **mirror** mode makes
  the destination exactly match the source and *can delete* files there; it's
  gated behind a deletion preview and a typed confirmation. Mirror mode can
  delete files from the destination — use only with a dedicated backup folder.
- **Backups run only while filepeek is running.** The scheduler is in-process;
  if filepeek is stopped, backups don't run.
- **Guarded destinations.** filepeek refuses to back up to system directories,
  your home dir, the served root, or any path that overlaps the source (which
  would back up the backup). The state directory (`FILEPEEK_STATE_DIR`) is
  never served, zipped, or backed up, even if it sits inside `FILEPEEK_ROOT`,
  and the stored S3 secret is kept in a `0600` file there.
- **Restore is a plain file copy** — backups aren't an opaque format. Copy the
  files back from the destination with any tool (see the docs).

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
| `FILEPEEK_STATE_DIR` | app directory | Where bookmarks/permalinks/backup config lives (never served) |

## Development & tests

```bash
pip install -r requirements-dev.txt
pytest                              # unit + API tests (fast, no browser)
playwright install chromium         # one-time browser download
pytest -m e2e                       # browser end-to-end tests
```

The unit/API suite (`tests/test_units.py`, `tests/test_api.py`, `tests/test_auth.py`,
and the backup tests `tests/test_backup_units.py`/`tests/test_backup_api.py`)
covers path-traversal safety, auth/lockout, every endpoint, and the office-file
renderers. The e2e suite (`tests/test_e2e.py`) starts a real server against a temp
directory and drives the UI headlessly: navigation, URL deep links, browser history,
editing, and search. Both run in CI (`.github/workflows/ci.yml`).

## FAQ

**How do I view the Markdown files Claude Code or ChatGPT generates?**
Point filepeek at the folder your agent writes to (`FILEPEEK_ROOT=~/projects`)
and open http://localhost:8765 — every `.md` file renders with formatting,
tables, code blocks, and Mermaid diagrams instead of raw text.

**Can I open xlsx, docx, or pptx files without Microsoft Office?**
Yes. filepeek renders Excel workbooks (per-sheet tables), Word documents, and
PowerPoint slides directly in the browser using pure Python — no Office, no
LibreOffice, no cloud upload.

**Does it work on WSL2?**
That's the home turf. Run it inside WSL2 and open http://localhost:8765 in your
Windows browser — localhost forwarding is automatic, no setup.

**Is my data sent anywhere?**
No. filepeek is fully self-hosted and reads files straight off your disk. The
only external request is a CDN-hosted markdown renderer on permalink pages.

**How is this different from a static-site generator or `python -m http.server`?**
`http.server` gives you raw file listings; static-site generators need a build
step. filepeek renders files on the fly — drop a file in the folder and refresh —
and adds editing, search, uploads, and access control.

**Can I share a rendered file with someone else?**
Yes — run it on a server with the one-line installer (HTTPS + password) or on
your [Tailscale](https://tailscale.com) network, then send a permalink to any
HTML or Markdown file.

## License

[MIT](LICENSE)
