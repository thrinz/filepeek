"""Native backup engine for filepeek: local/NAS copy and S3-compatible upload.

No external binary — local backups use the Python stdlib, S3 backups use boto3
(which talks to AWS, Backblaze B2, Wasabi, Cloudflare R2, MinIO, … via an
endpoint URL). Pure-ish functions, kept free of app globals so they unit test
directly. The app layer owns config, scheduling, and the run lock.

"copy" mode adds/updates and never deletes. "sync" (mirror) makes the
destination exactly match the source, deleting extraneous files there.
"""
import fnmatch
import os
import shutil
from pathlib import Path

# Never backed up: VCS and dependency dirs, editor/OS cruft. The app also adds
# the filepeek state dir (config, logs, secrets) when it sits inside the source.
DEFAULT_EXCLUDES = [
    ".git/**",
    "node_modules/**",
    ".venv/**",
    "venv/**",
    "__pycache__/**",
    ".cache/**",
    ".pytest_cache/**",
    ".mypy_cache/**",
    ".DS_Store",
    "*.pyc",
]

# Filesystem locations a web-triggered backup must never write to, even in copy
# mode. A backstop — copy-by-default and the mirror confirmation are the real
# protection — so it need not be exhaustive.
_FORBIDDEN_DIRS = [
    "/", "/etc", "/usr", "/var", "/tmp", "/boot", "/root",
    "/sys", "/dev", "/proc", "/bin", "/sbin", "/lib", "/lib64", "/opt", "/home",
]


class BackupError(Exception):
    """A backup request was rejected by a guard or failed in a reportable way."""


# --- excludes ---------------------------------------------------------------

def build_excludes(source: Path, state_dir: Path) -> list:
    """Default excludes, plus the state dir if it lives inside the backup source."""
    excludes = list(DEFAULT_EXCLUDES)
    try:
        rel = state_dir.resolve().relative_to(source.resolve())
        excludes.append(f"{rel}/**")
    except ValueError:
        pass  # state dir is outside the source — already not included
    return excludes


def is_excluded(rel_path: str, excludes: list) -> bool:
    """True if a source-relative path matches an exclude pattern.

    'name/**' excludes anything where 'name' is a path component (so '.git'
    anywhere is skipped). Other patterns fnmatch the basename or the full path.
    """
    parts = rel_path.split("/")
    base = parts[-1]
    for pat in excludes:
        if pat.endswith("/**"):
            if pat[:-3] in parts:
                return True
        elif fnmatch.fnmatch(base, pat) or fnmatch.fnmatch(rel_path, pat):
            return True
    return False


def _source_bases(root: Path, sources: list) -> list:
    """The directories to walk. Empty sources = the whole root; otherwise each
    selected subfolder (relative to root). Paths are always reported relative to
    root, so the destination preserves the root's folder structure."""
    if not sources:
        return [root]
    bases = []
    for s in sources:
        d = (root / s.strip("/")).resolve()
        if d == root or root in d.parents:  # stay within root
            bases.append(d)
    return bases


def iter_backup_files(root: Path, sources: list, excludes: list):
    """Yield (absolute_path, root_relative_posix_path) for files to back up,
    across all selected source folders."""
    root = root.resolve()
    for base in _source_bases(root, sources):
        if not base.is_dir():
            continue
        for dirpath, dirnames, filenames in os.walk(base):
            d = Path(dirpath)
            keep = []
            for name in dirnames:
                rel = str((d / name).relative_to(root)).replace(os.sep, "/")
                if not is_excluded(rel, excludes):
                    keep.append(name)
            dirnames[:] = keep
            for name in filenames:
                fp = d / name
                if fp.is_symlink():
                    continue
                rel = str(fp.relative_to(root)).replace(os.sep, "/")
                if not is_excluded(rel, excludes):
                    yield fp, rel


def _is_managed(rel: str, sources: list) -> bool:
    """Whether a destination-relative path falls within the backed-up scope.
    Mirror mode only deletes within this scope, so unselected folders at the
    destination are never touched."""
    if not sources:
        return True  # whole root is managed
    for p in sources:
        p = p.strip("/")
        if rel == p or rel.startswith(p + "/"):
            return True
    return False


# --- destination guards -----------------------------------------------------

def _forbidden_paths(root: Path, state_dir: Path) -> set:
    paths = {Path(p) for p in _FORBIDDEN_DIRS}
    paths.add(Path.home())
    paths.add(root.resolve())
    paths.add(state_dir.resolve())
    return paths


def validate_local_destination(dest: str, source: Path, root: Path, state_dir: Path) -> str:
    """Validate a local/NAS destination path; return the resolved path.

    Guards apply to every mode (copy and mirror):
      - reject empty / Windows-style paths
      - reject a forbidden system dir (/, /etc, ~, ROOT, STATE_DIR, ...)
      - reject destination == source, or either nested in the other
        (nesting makes the backup copy itself)
      - reject a destination that is an ancestor of ROOT/STATE_DIR/home
    """
    raw = (dest or "").strip()
    if not raw:
        raise BackupError("Destination path is required")
    if len(raw) >= 2 and raw[1] == ":":
        raise BackupError("Windows-style paths are not supported")
    d = Path(raw).expanduser().resolve()
    src = source.resolve()

    if d in _forbidden_paths(root, state_dir):
        raise BackupError(f"Refusing to back up to '{d}' — choose a dedicated backup folder")
    if d == src:
        raise BackupError("Destination cannot be the same folder as the source")
    if src == d or src in d.parents:
        raise BackupError("Destination is inside the source folder — that would back up the backup")
    if d in src.parents:
        raise BackupError("Destination contains the source folder — choose a separate location")
    for sensitive in (root.resolve(), state_dir.resolve(), Path.home()):
        if d in sensitive.parents:
            raise BackupError(f"Destination contains '{sensitive}' — choose a separate location")
    return str(d)


def validate_s3_config(cfg: dict) -> dict:
    """Validate the S3 destination fields; return a normalized dict."""
    bucket = (cfg.get("bucket") or "").strip()
    key = (cfg.get("access_key_id") or "").strip()
    secret = (cfg.get("secret_access_key") or "").strip()
    if not bucket:
        raise BackupError("S3 bucket is required")
    if not key or not secret:
        raise BackupError("S3 access key and secret are required")
    if "/" in bucket or bucket.startswith("-"):
        raise BackupError(f"Invalid S3 bucket name: {bucket!r}")
    return {
        "bucket": bucket,
        "prefix": (cfg.get("prefix") or "").strip().strip("/"),
        "endpoint": (cfg.get("endpoint") or "").strip(),   # blank = AWS
        "region": (cfg.get("region") or "").strip(),
        "access_key_id": key,
        "secret_access_key": secret,
    }


# --- local backup -----------------------------------------------------------

def run_local_backup(root: Path, sources: list, dest: str, mode: str, excludes: list,
                     progress_cb=None) -> dict:
    """Copy (or mirror) the selected folders → a local/NAS folder. Returns {files, bytes}."""
    destp = Path(dest)
    destp.mkdir(parents=True, exist_ok=True)
    files = bytes_copied = 0
    seen = set()
    for fp, rel in iter_backup_files(root, sources, excludes):
        seen.add(rel)
        target = destp / rel
        try:
            st = fp.stat()
        except OSError:
            continue
        # incremental: copy only when missing or size/mtime differs
        if target.exists():
            ts = target.stat()
            if ts.st_size == st.st_size and int(ts.st_mtime) >= int(st.st_mtime):
                continue
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(fp, target)
        files += 1
        bytes_copied += st.st_size
        if progress_cb:
            progress_cb(f"{files} files, {bytes_copied} bytes")
    if mode == "sync":
        _mirror_prune_local(destp, seen, sources)
    return {"files": files, "bytes": bytes_copied}


def _mirror_prune_local(destp: Path, keep_rel: set, sources: list) -> None:
    """Delete destination files that aren't in the backed-up set — but only
    within the managed scope, so unselected folders are left untouched."""
    for dirpath, dirnames, filenames in os.walk(destp, topdown=False):
        d = Path(dirpath)
        for name in filenames:
            rel = str((d / name).relative_to(destp)).replace(os.sep, "/")
            if _is_managed(rel, sources) and rel not in keep_rel:
                (d / name).unlink(missing_ok=True)
        for name in dirnames:
            sub = d / name
            try:
                next(sub.iterdir())
            except StopIteration:
                sub.rmdir()  # remove now-empty dir
            except OSError:
                pass


def preview_local(root: Path, sources: list, dest: str, mode: str, excludes: list) -> dict:
    """Dry-run a local backup: counts and a capped item list (for mirror)."""
    destp = Path(dest)
    copy = update = 0
    items = []
    seen = set()
    for fp, rel in iter_backup_files(root, sources, excludes):
        seen.add(rel)
        target = destp / rel
        if not target.exists():
            copy += 1
            _add_item(items, rel, "copy")
        else:
            st, ts = fp.stat(), target.stat()
            if ts.st_size != st.st_size or int(ts.st_mtime) < int(st.st_mtime):
                update += 1
                _add_item(items, rel, "update")
    delete = 0
    if mode == "sync" and destp.exists():
        for dirpath, _, filenames in os.walk(destp):
            d = Path(dirpath)
            for name in filenames:
                rel = str((d / name).relative_to(destp)).replace(os.sep, "/")
                if _is_managed(rel, sources) and rel not in seen:
                    delete += 1
                    _add_item(items, rel, "delete")
    return _preview_result(copy, update, delete, items)


# --- S3 backup --------------------------------------------------------------

def _s3_client(s3: dict):
    import boto3
    kwargs = {
        "aws_access_key_id": s3["access_key_id"],
        "aws_secret_access_key": s3["secret_access_key"],
    }
    if s3.get("endpoint"):
        kwargs["endpoint_url"] = s3["endpoint"]
    if s3.get("region"):
        kwargs["region_name"] = s3["region"]
    return boto3.client("s3", **kwargs)


def _s3_key(prefix: str, rel: str) -> str:
    return f"{prefix}/{rel}" if prefix else rel


def _s3_list(client, bucket: str, prefix: str) -> dict:
    """Map of {object_key: size} under prefix (handles pagination)."""
    out = {}
    token = None
    base = f"{prefix}/" if prefix else ""
    while True:
        kw = {"Bucket": bucket, "Prefix": base}
        if token:
            kw["ContinuationToken"] = token
        resp = client.list_objects_v2(**kw)
        for obj in resp.get("Contents", []):
            out[obj["Key"]] = obj["Size"]
        if resp.get("IsTruncated"):
            token = resp.get("NextContinuationToken")
        else:
            break
    return out


def s3_test(s3: dict) -> None:
    """Probe write+delete a tiny object so misconfig surfaces before a real run."""
    from botocore.exceptions import BotoCoreError, ClientError
    client = _s3_client(s3)
    key = _s3_key(s3["prefix"], ".filepeek-backup-test")
    try:
        client.put_object(Bucket=s3["bucket"], Key=key, Body=b"ok")
        client.delete_object(Bucket=s3["bucket"], Key=key)
    except (BotoCoreError, ClientError) as e:
        raise BackupError(f"S3 destination not writable: {e}")


def _s3_rel(prefix: str, key: str) -> str:
    """The root-relative path of an object key (inverse of _s3_key)."""
    if prefix and key.startswith(prefix + "/"):
        return key[len(prefix) + 1:]
    return key


def run_s3_backup(root: Path, sources: list, s3: dict, mode: str, excludes: list,
                  progress_cb=None) -> dict:
    """Upload (or mirror) the selected folders → an S3-compatible bucket."""
    from botocore.exceptions import BotoCoreError, ClientError
    client = _s3_client(s3)
    existing = _s3_list(client, s3["bucket"], s3["prefix"])
    files = bytes_copied = 0
    seen = set()
    try:
        for fp, rel in iter_backup_files(root, sources, excludes):
            key = _s3_key(s3["prefix"], rel)
            seen.add(key)
            size = fp.stat().st_size
            if existing.get(key) == size:
                continue  # unchanged (size match) — skip
            client.upload_file(str(fp), s3["bucket"], key)
            files += 1
            bytes_copied += size
            if progress_cb:
                progress_cb(f"{files} files, {bytes_copied} bytes")
        if mode == "sync":
            stale = [k for k in existing
                     if k not in seen and _is_managed(_s3_rel(s3["prefix"], k), sources)]
            for i in range(0, len(stale), 1000):  # delete_objects caps at 1000
                client.delete_objects(
                    Bucket=s3["bucket"],
                    Delete={"Objects": [{"Key": k} for k in stale[i:i + 1000]]},
                )
    except (BotoCoreError, ClientError) as e:
        raise BackupError(f"S3 backup failed: {e}")
    return {"files": files, "bytes": bytes_copied}


def preview_s3(root: Path, sources: list, s3: dict, mode: str, excludes: list) -> dict:
    from botocore.exceptions import BotoCoreError, ClientError
    client = _s3_client(s3)
    try:
        existing = _s3_list(client, s3["bucket"], s3["prefix"])
    except (BotoCoreError, ClientError) as e:
        raise BackupError(f"S3 preview failed: {e}")
    copy = update = 0
    items = []
    seen = set()
    for fp, rel in iter_backup_files(root, sources, excludes):
        key = _s3_key(s3["prefix"], rel)
        seen.add(key)
        if key not in existing:
            copy += 1
            _add_item(items, rel, "copy")
        elif existing[key] != fp.stat().st_size:
            update += 1
            _add_item(items, rel, "update")
    delete = 0
    if mode == "sync":
        for key in existing:
            if key not in seen and _is_managed(_s3_rel(s3["prefix"], key), sources):
                delete += 1
                _add_item(items, _s3_rel(s3["prefix"], key), "delete")
    return _preview_result(copy, update, delete, items)


# --- shared preview helpers -------------------------------------------------

_PREVIEW_ITEM_CAP = 200


def _add_item(items: list, path: str, action: str) -> None:
    if len(items) < _PREVIEW_ITEM_CAP:
        items.append({"path": path, "action": action})


def _preview_result(copy: int, update: int, delete: int, items: list) -> dict:
    total = copy + update + delete
    return {"copy": copy, "update": update, "delete": delete,
            "items": items, "truncated": total > _PREVIEW_ITEM_CAP}
