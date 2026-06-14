# Backup

filepeek can back up everything it serves to a **local/NAS folder** or an
**S3-compatible cloud bucket**, automatically on a schedule or on demand. This
protects the files your agents generate from loss.

> **Backups run only while filepeek is running.** The scheduler runs inside the
> filepeek process. If filepeek is stopped, scheduled backups do not run.

## No extra tools to install

There's nothing to install on the server beyond filepeek's normal dependencies:

- **Local/NAS** backups use the Python standard library.
- **Cloud** backups use the S3 API via `boto3` (a normal pip dependency, already
  in `requirements.txt`).

There is no rclone, no external binary, and no `rclone config` step.

## What gets backed up

By default the backup source is the whole of `FILEPEEK_ROOT` — the directory
filepeek serves. The Backup dialog shows a **folder checklist**: leave every
folder checked to back up the whole root (including folders added later), or
uncheck some to back up only specific top-level folders. In mirror mode,
deletions stay scoped to the folders you selected — unchecked folders at the
destination are never touched.

These paths are always excluded, whatever you select:

```
.git/        node_modules/   .venv/   venv/   __pycache__/
.cache/      .pytest_cache/   .mypy_cache/    *.pyc   .DS_Store
```

The filepeek state directory (`FILEPEEK_STATE_DIR`) is **always excluded** too,
so backup settings and logs are never copied into your backup.

## Destinations

Open the **☁ Backup** toolbar button and choose one.

### Local / NAS folder

A path on the server or a mounted network share:

```
/mnt/nas/filepeek-backup
```

No credentials. **Tip:** if you point this at a folder your desktop
Dropbox/OneDrive/Drive client already syncs, those files get to the cloud with
no cloud setup in filepeek at all.

### S3-compatible cloud

Paste four values — works with **AWS S3, Backblaze B2, Wasabi, Cloudflare R2,
and MinIO**:

| Field | Example | Notes |
|---|---|---|
| Bucket | `my-filepeek-backup` | Create it once in your provider's console |
| Prefix | `backups/laptop` | Optional folder within the bucket |
| Endpoint | `https://s3.us-west-002.backblazeb2.com` | Blank for AWS; set for B2/Wasabi/R2/MinIO |
| Region | `us-east-1` | Optional, provider-dependent |
| Access key ID | `004abc…` | From the provider console |
| Secret access key | `K001xyz…` | Stored server-side (see Security) |

No OAuth and no provider *app registration* — you only create a bucket and an
access key in the provider's console once, then paste them here. (Consumer
clouds like Google Drive / OneDrive / Dropbox require OAuth and aren't supported
as direct destinations — use a local folder synced by their desktop client
instead.)

Use **Test destination** to verify the target is reachable and writable before
relying on it.

## Modes

### Safe backup (default)

Adds and updates files at the destination, and **never deletes**. The right
default for "don't lose my data."

### Mirror backup (advanced)

Makes the destination **exactly match** the source — so files that exist only at
the destination are **deleted**.

> **Mirror mode can delete files from the destination. Use only with a dedicated
> backup folder.**

Because it deletes, mirror mode is gated: running it shows a **preview** of how
many files would be copied, updated, and deleted, and you must type **`MIRROR`**
to confirm before it runs.

## Scheduling

Set a frequency — every **5 / 15 / 60 minutes**, or **daily** — and enable
automatic backup. A single in-process worker runs the backup on that interval
while filepeek is up. Only one backup ever runs at a time: if a scheduled run is
in progress and you click **Backup now**, you'll get *"Backup already in
progress"* rather than a second run.

Backups are **incremental** — only new or changed files are copied (compared by
size and modification time locally, by size on S3), so routine runs are cheap
even on a large tree.

## Safety guards

A web-triggered backup can write to (and, in mirror mode, delete from) the
destination, so filepeek refuses dangerous local targets for **every** mode:

- System directories (`/`, `/etc`, `/usr`, `/var`, `/tmp`, `/home`, `/root`, …)
- Your home directory, the served root (`FILEPEEK_ROOT`), and the state dir
- A destination **inside** the source, or a source **inside** the destination
  (either would back the backup up into itself)

The real protection is that **copy is the default** and never deletes; the
denylist is a backstop, and mirror mode additionally requires the typed
confirmation above.

## Restore

There's no restore button — and you don't need one. Backups are **plain files**,
not an opaque archive, so restore is just a copy in the other direction:

- **Local/NAS:** copy the files back with any file manager, or
  `cp -a /mnt/nas/filepeek-backup/. /home/user/projects/`.
- **S3:** pull them down with the AWS CLI or any S3 tool, e.g.
  `aws s3 sync s3://my-bucket/backups/laptop /home/user/projects`.

## Status and logs

The Backup dialog shows the last run time, result (success/failed), and the file
and byte counts from the last run. **Logs** shows recent backup activity (stored
in the state directory and rotated so it can't grow without bound).

## Security

- The **S3 secret access key is stored server-side** in `backup_config.json`
  inside `FILEPEEK_STATE_DIR`, written with `0600` permissions. The state
  directory is never served, zipped, or backed up. The secret is **write-only**
  in the UI — it's never sent back to the browser after you save it.
- Use a **least-privilege** access key scoped to just the backup bucket where
  your provider supports it (e.g. an IAM policy limited to that bucket).

## Configuration

Backup settings (destination, frequency, mode, enabled) are stored in
`backup_config.json` inside `FILEPEEK_STATE_DIR`. For an unattended install you
can seed that file from your init script instead of using the UI.

> **Large first backups:** the initial run uploads everything (minus excludes),
> which can be large and slow on a fresh cloud bucket. Re-running is safe and
> resumes where it left off, since unchanged files are skipped.
