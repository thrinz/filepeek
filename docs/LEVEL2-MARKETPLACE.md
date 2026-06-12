# Level 2: Marketplace 1-Click Images — What's Needed

Goal: filepeek appears as a preinstalled app option when someone creates a
DigitalOcean Droplet or a Linode. Both marketplaces accept individual
developers and listing is free.

## Already done

- `deploy/install-remote.sh` supports the three phases marketplace images need:
  - `FILEPEEK_PHASE=image` — build-time install: packages, app, Caddy, systemd
    unit, **no credentials**, service left disabled. Installs a cloud-init
    per-instance hook and an SSH-login MOTD banner.
  - `FILEPEEK_PHASE=firstboot` — runs once on each new customer instance via
    the hook: generates the per-instance password/token, writes the env file
    and Caddyfile, starts everything, saves `/root/filepeek-credentials.txt`.
  - `FILEPEEK_PHASE=full` — the regular Level 1 curl|bash path (unchanged).

This solves the core marketplace constraint: an image is built once but every
customer must get unique credentials.

## Hard prerequisites (blockers)

1. **Public GitHub repo** — the image build clones it. All `REPLACE-ME` URLs
   in `deploy/` and `README.md` must point at the real repo first.
2. **A support URL** — both marketplaces require one (GitHub Issues is fine).
3. **Brand assets** — app logo (we have `static/logo.svg`; DO wants PNG
   renders too), one-paragraph description, category, and screenshots of the UI.
4. **A real end-to-end test of Level 1** on a throwaway VPS — the marketplace
   review process will exercise exactly this path.

## DigitalOcean Marketplace

**Artifact:** a Droplet *snapshot image* in your DO account, built with Packer.

What's needed:
- A DO account + API token; Packer installed locally (`packer` CLI with the
  `digitalocean` plugin). Build cost: a few cents (the build droplet runs for
  ~10 minutes).
- A Packer template (`deploy/marketplace/digitalocean/filepeek.pkr.hcl`) that:
  1. Boots `ubuntu-24-04-x64`, waits for cloud-init.
  2. Runs `FILEPEEK_PHASE=image bash install-remote.sh`.
  3. Runs DigitalOcean's required cleanup + validation scripts from
     [digitalocean/marketplace-partners](https://github.com/digitalocean/marketplace-partners)
     (they scrub SSH host keys, root password, logs; the img-check script
     **fails the image** if SSH keys remain or ufw is off — so the image phase
     should also enable ufw allowing 22/80/443).
  4. Snapshots the droplet.
- **Submission:** create a vendor account at the DO Marketplace vendor portal,
  create the app listing (name, description, assets, support URL), attach the
  snapshot, submit for review. Reviews typically take days–weeks; they boot
  the image and check the first-login experience (our MOTD banner with the
  credentials file is the expected pattern).
- Reference examples: [digitalocean/droplet-1-clicks](https://github.com/digitalocean/droplet-1-clicks).

## Linode (Akamai) Marketplace

**Artifact:** a StackScript (bash, runs on first boot of a stock distro image)
plus listing metadata — no image build at all, which makes Linode the easier
of the two.

What's needed:
- A StackScript (`deploy/marketplace/linode/filepeek-stackscript.sh`) that
  declares UDF fields (Linode renders them as a form at create time — e.g.
  optional domain) and runs `install-remote.sh` in `full` mode. UDFs arrive as
  env vars, so this is a ~20-line wrapper.
- Their requirements per [Linode's developer docs](https://www.linode.com/docs/products/tools/marketplace/developers/):
  - Deployment must be fully hands-off — all input via UDF fields, no
    command-line steps before the app is usable. (We comply.)
  - Must deploy on shared plans up to 16GB (we run on the smallest).
  - A designated support URL.
- **Submission:** a pull request to
  [akamai-compute-marketplace/marketplace-apps](https://github.com/akamai-compute-marketplace/marketplace-apps)
  containing the StackScript, a metadata `.md`/`.txt` file (description,
  display info), and an assets folder (logo). Note their reviewers prefer the
  StackScript-bootstraps-Ansible structure used by existing apps in that repo —
  be prepared to restructure into their Ansible layout if asked.

## Suggested order

1. Publish the GitHub repo, fix `REPLACE-ME`, license, support URL.
2. Smoke-test Level 1 on a throwaway $5 VPS (both with and without a domain).
3. Linode first (no image pipeline; fastest review feedback).
4. DigitalOcean second (Packer template + vendor portal).

## Maintenance obligation

Marketplaces expect images/scripts to stay current: security review may
re-check periodically, and a stale image (old Ubuntu base, broken install)
gets delisted. Each filepeek release means re-running the Packer build and
updating the snapshot in the DO listing; the Linode StackScript pulls from
`main` so it usually needs no change.
