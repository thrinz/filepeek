# filepeek — Status & Roadmap

_Last updated: 2026-06-12_

## Shipped

- **Open source on GitHub** — [github.com/thrinz/filepeek](https://github.com/thrinz/filepeek), MIT licensed, topics set, all `REPLACE-ME` URLs fixed.
- **filepeek.dev live** — landing page (SEO schema + FAQ), narrated 78-second tour video, screenshots. Deployed via GitHub Pages workflow; HTTPS enforced. Any push touching `site/` redeploys automatically.
- **CI** — unit/API/auth suite (68 tests) + browser e2e on Python 3.10 & 3.12, runs on every push/PR.
- **Mermaid in markdown** — ```mermaid fences now render as diagrams (was: raw code; only `.mmd` files rendered).

## Verified vs. not

| Area | Status |
|---|---|
| App endpoints, auth, path-traversal, office renderers | ✅ automated tests (CI) |
| UI: navigation, editing, search, deep links | ✅ e2e tests (CI) |
| Markdown/Mermaid/xlsx/HTML/CSV/JSON/SVG/code views | ✅ manually verified in browser |
| Pages deploy, domain, HTTPS | ✅ verified live |
| `deploy/install-remote.sh` (all modes) | ❌ **never run on a real server** |
| `deploy/cloud-init.yaml` | ❌ untested |
| Domain / Let's Encrypt path | ❌ untested |
| Tailscale access path (`tailscale serve` + browser, incl. iPhone) | ✅ verified on iOS |
| Tailscale mode via installer (`FILEPEEK_MODE=tailscale`) | ❌ untested |
| `install.sh` on a clean machine | ❌ only run against existing venv |
| Mermaid-fence rendering | ⚠️ manual only — needs an e2e test |

## Pending — testing (do first)

1. **VPS smoke test of the remote installer** — throwaway $5 server, three runs:
   plain (`curl | sudo bash`), with `FILEPEEK_DOMAIN`, and `FILEPEEK_MODE=tailscale`.
   This gates everything marketplace-related; reviewers exercise exactly this path.
2. **cloud-init path** — paste `deploy/cloud-init.yaml` as user data on a fresh server.
3. **Add an e2e test for mermaid fences** (assert `#preview svg` appears for a md file with a mermaid block).

## Pending — development

### Marketplace (see [LEVEL2-MARKETPLACE.md](LEVEL2-MARKETPLACE.md))
- **Linode first** (no image build): StackScript wrapper with UDF fields → PR to
  akamai-compute-marketplace/marketplace-apps with metadata + logo assets.
- **DigitalOcean second**: Packer template (`FILEPEEK_PHASE=image` + DO cleanup/validation
  scripts), enable ufw (22/80/443) in the image phase, vendor account, submit snapshot.
- **Brand assets**: PNG renders of `static/logo.svg` (DO requirement), listing copy,
  reuse tour screenshots.

### Repo polish (quick wins)
- [ ] Cut a release: tag `v0.1.0` + GitHub Release.
- [ ] Set repo homepage field → https://filepeek.dev
- [ ] README: link to filepeek.dev and the tour video.
- [ ] Serve the installer from the site: `https://filepeek.dev/install.sh`
      (copy `deploy/install-remote.sh` into `site/` at deploy time) — shorter and
      survives account/repo renames.
- [ ] Bump GitHub Actions to Node 24-compatible versions (Node 20 deprecation
      warning; forced June 16, 2026).

### Housekeeping
- [ ] Rotate the ElevenLabs API key (was pasted in a chat session).
- [ ] Marketplace maintenance obligation (once listed): re-run Packer build per release
      for DO; Linode StackScript pulls from `main` so usually no change.

## Suggested order

1. VPS smoke test (gates everything)
2. Repo polish quick wins (an hour, all scriptable)
3. Linode listing (fastest review)
4. DigitalOcean listing (Packer pipeline)
