"""Shared fixtures: a temp file tree as FILEPEEK_ROOT and a TestClient against it.

The app reads its configuration (ROOT, state files, auth) into module globals at
import time, so tests monkeypatch those globals rather than setting env vars.
"""
import sys
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import app as filepeek  # noqa: E402

SAMPLE_FILES = {
    "readme.md": "# Hello\nsome *markdown* content\n",
    "notes.txt": "alpha beta gamma\n",
    "page.html": "<h1>hi</h1>\n",
    "sub dir/nested.txt": "a needle in here\n",
    "sub dir/notes.md": "# nested markdown\n",
    "sub dir/deep/leaf.py": "print('x')\n",
}


@pytest.fixture
def root(tmp_path, monkeypatch):
    """A populated root directory, with app globals pointed at it."""
    root = tmp_path / "root"
    state = tmp_path / "state"
    state.mkdir()
    for rel, content in SAMPLE_FILES.items():
        p = root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(content)
    (root / "binary.bin").write_bytes(b"\x00\x01\x02binary-ish")

    monkeypatch.setattr(filepeek, "ROOT", root.resolve())
    monkeypatch.setattr(filepeek, "STATE_DIR", state)
    monkeypatch.setattr(filepeek, "PERMLINKS_FILE", state / "permlinks.json")
    monkeypatch.setattr(filepeek, "BOOKMARKS_FILE", state / "bookmarks.json")
    monkeypatch.setattr(filepeek, "BACKUP_CONFIG_FILE", state / "backup_config.json")
    monkeypatch.setattr(filepeek, "BACKUP_LOG_FILE", state / "backup.log")
    return root


@pytest.fixture
def client(root):
    """TestClient with auth disabled (the default when no env vars are set)."""
    return TestClient(filepeek.app)


@pytest.fixture
def auth_client(root, monkeypatch):
    """TestClient with password + token auth enabled. Password: secret123."""
    monkeypatch.setattr(filepeek, "PASSWORD_HASH",
                        filepeek.hash_password("secret123", iterations=1000))
    monkeypatch.setattr(filepeek, "API_TOKEN", "tok-abc")
    monkeypatch.setattr(filepeek, "AUTH_ENABLED", True)
    monkeypatch.setattr(time, "sleep", lambda s: None)  # skip the failed-login delay
    filepeek._login_failures.clear()
    return TestClient(filepeek.app)


# --- S3 fixture (mocked, no real cloud) -------------------------------------

@pytest.fixture
def s3_bucket(monkeypatch):
    """A mocked S3 bucket 'test-bucket' via moto. Yields the S3 config dict
    filepeek would store, plus a live boto3 client to assert against."""
    from moto import mock_aws
    import boto3
    with mock_aws():
        client = boto3.client("s3", region_name="us-east-1")
        client.create_bucket(Bucket="test-bucket")
        cfg = {
            "bucket": "test-bucket", "prefix": "backup", "endpoint": "",
            "region": "us-east-1", "access_key_id": "testing",
            "secret_access_key": "testing",
        }
        yield {"cfg": cfg, "client": client}
