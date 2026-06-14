"""Backup API endpoints — native local engine and S3 (mocked with moto)."""
import time

import app as filepeek


def wait_backup_idle(client, timeout=30):
    deadline = time.time() + timeout
    while time.time() < deadline:
        s = client.get("/api/backup/status").json()
        if not s["running"]:
            return s
        time.sleep(0.02)
    raise AssertionError("backup did not finish in time")


# --- config -----------------------------------------------------------------

def test_config_defaults(client):
    cfg = client.get("/api/backup/config").json()
    assert cfg["enabled"] is False
    assert cfg["mode"] == "copy"
    assert cfg["source_path"]


def test_save_local_config(client, tmp_path):
    dest = tmp_path / "backup-dest"
    r = client.post("/api/backup/config", json={
        "type": "local", "destination": str(dest), "frequency_minutes": 15, "mode": "copy",
    })
    assert r.status_code == 200
    assert r.json()["destination"] == str(dest.resolve())


def test_save_rejects_bad_frequency(client, tmp_path):
    r = client.post("/api/backup/config", json={
        "type": "local", "destination": str(tmp_path / "b"), "frequency_minutes": 7,
    })
    assert r.status_code == 400


def test_save_rejects_bad_mode(client, tmp_path):
    r = client.post("/api/backup/config", json={
        "type": "local", "destination": str(tmp_path / "b"), "mode": "mirror",
    })
    assert r.status_code == 400


def test_enable_without_destination_rejected(client):
    assert client.post("/api/backup/config", json={"enabled": True}).status_code == 400


def test_save_rejects_destination_inside_source(client, root):
    r = client.post("/api/backup/config", json={"type": "local", "destination": str(root / "backup")})
    assert r.status_code == 400
    assert "inside the source" in r.json()["detail"]


def test_save_rejects_forbidden_destination(client):
    assert client.post("/api/backup/config", json={"type": "local", "destination": "/etc"}).status_code == 400


def test_run_without_destination_409(client):
    assert client.post("/api/backup/run", json={}).status_code == 409


def test_mirror_run_requires_acknowledgement(client, tmp_path):
    client.post("/api/backup/config", json={
        "type": "local", "destination": str(tmp_path / "b"), "mode": "sync",
    })
    r = client.post("/api/backup/run", json={})
    assert r.status_code == 400
    assert "confirm" in r.json()["detail"].lower()


def test_concurrent_run_409(client, tmp_path):
    client.post("/api/backup/config", json={"type": "local", "destination": str(tmp_path / "b")})
    assert filepeek._backup_lock.acquire(blocking=False)
    try:
        assert client.post("/api/backup/run", json={}).status_code == 409
    finally:
        filepeek._backup_lock.release()


# --- local backup -----------------------------------------------------------

def test_test_destination_local(client, tmp_path):
    dest = tmp_path / "nas"
    client.post("/api/backup/config", json={"type": "local", "destination": str(dest)})
    r = client.post("/api/backup/test")
    assert r.status_code == 200 and r.json()["ok"] is True
    assert dest.is_dir()
    assert not (dest / ".filepeek-backup-test").exists()


def test_local_copy_backup(client, root, tmp_path):
    dest = tmp_path / "nas"
    client.post("/api/backup/config", json={"type": "local", "destination": str(dest)})
    r = client.post("/api/backup/run", json={})
    assert r.status_code == 200 and r.json()["started"] is True
    s = wait_backup_idle(client)
    assert s["last_status"] == "success", s["last_message"]
    assert (dest / "readme.md").exists()
    assert (dest / "sub dir" / "nested.txt").exists()
    assert s["files_copied"] >= 4


def test_local_copy_never_deletes(client, root, tmp_path):
    dest = tmp_path / "nas"
    dest.mkdir()
    (dest / "extra.txt").write_text("keep me\n")
    client.post("/api/backup/config", json={"type": "local", "destination": str(dest)})
    client.post("/api/backup/run", json={})
    wait_backup_idle(client)
    assert (dest / "extra.txt").exists()


def test_local_excludes_git_and_state(client, root, tmp_path):
    (root / ".git").mkdir()
    (root / ".git" / "HEAD").write_text("ref\n")
    dest = tmp_path / "nas"
    client.post("/api/backup/config", json={"type": "local", "destination": str(dest)})
    client.post("/api/backup/run", json={})
    wait_backup_idle(client)
    assert (dest / "readme.md").exists()
    assert not (dest / ".git").exists()


def test_local_mirror_preview_and_run(client, root, tmp_path):
    dest = tmp_path / "nas"
    dest.mkdir()
    (dest / "stale.txt").write_text("old\n")
    client.post("/api/backup/config", json={"type": "local", "destination": str(dest), "mode": "sync"})
    preview = client.post("/api/backup/preview").json()
    assert preview["delete"] == 1
    assert any(i["path"] == "stale.txt" for i in preview["items"])

    r = client.post("/api/backup/run", json={"acknowledge_mirror": True})
    assert r.status_code == 200
    s = wait_backup_idle(client)
    assert s["last_status"] == "success", s["last_message"]
    assert not (dest / "stale.txt").exists()


def test_backup_selected_folders_only(client, root, tmp_path):
    dest = tmp_path / "nas"
    # config exposes the top-level folders available to pick
    cfg = client.get("/api/backup/config").json()
    assert "sub dir" in cfg["available_folders"]
    # back up only "sub dir"
    r = client.post("/api/backup/config", json={
        "type": "local", "destination": str(dest), "sources": ["sub dir"],
    })
    assert r.status_code == 200
    assert r.json()["sources"] == ["sub dir"]
    client.post("/api/backup/run", json={})
    wait_backup_idle(client)
    assert (dest / "sub dir" / "nested.txt").exists()
    assert not (dest / "readme.md").exists()  # top-level file not selected


def test_backup_rejects_bad_source(client, root, tmp_path):
    r = client.post("/api/backup/config", json={
        "type": "local", "destination": str(tmp_path / "nas"), "sources": ["nope"],
    })
    assert r.status_code == 400


def test_logs_after_run(client, root, tmp_path):
    client.post("/api/backup/config", json={"type": "local", "destination": str(tmp_path / "nas")})
    client.post("/api/backup/run", json={})
    wait_backup_idle(client)
    assert "manual copy OK" in client.get("/api/backup/logs").json()["logs"]


# --- S3 backup (moto) -------------------------------------------------------

def _save_s3(client, s3cfg):
    return client.post("/api/backup/config", json={"type": "s3", "s3": s3cfg})


def test_save_s3_secret_is_write_only(client, s3_bucket):
    r = _save_s3(client, s3_bucket["cfg"])
    assert r.status_code == 200
    cfg = r.json()
    assert cfg["s3"]["secret_access_key"] == ""   # never echoed back
    assert cfg["s3"]["has_secret"] is True
    # re-saving with an empty secret keeps the stored one (so test/run still work)
    again = _save_s3(client, {**s3_bucket["cfg"], "secret_access_key": ""})
    assert again.status_code == 200


def test_s3_test_destination(client, s3_bucket):
    _save_s3(client, s3_bucket["cfg"])
    r = client.post("/api/backup/test")
    assert r.status_code == 200 and r.json()["ok"] is True


def test_s3_copy_backup(client, root, s3_bucket):
    _save_s3(client, s3_bucket["cfg"])
    client.post("/api/backup/run", json={})
    s = wait_backup_idle(client)
    assert s["last_status"] == "success", s["last_message"]
    keys = {o["Key"] for o in s3_bucket["client"].list_objects_v2(
        Bucket="test-bucket").get("Contents", [])}
    assert "backup/readme.md" in keys
    assert "backup/sub dir/nested.txt" in keys
    assert not any(".git" in k for k in keys)


def test_s3_mirror_preview_and_run(client, root, s3_bucket):
    _save_s3(client, {**s3_bucket["cfg"]})
    # seed an extraneous object under the prefix
    s3_bucket["client"].put_object(Bucket="test-bucket", Key="backup/stale.txt", Body=b"old")
    client.post("/api/backup/config", json={"type": "s3", "s3": s3_bucket["cfg"], "mode": "sync"})
    preview = client.post("/api/backup/preview").json()
    assert preview["delete"] == 1

    client.post("/api/backup/run", json={"acknowledge_mirror": True})
    s = wait_backup_idle(client)
    assert s["last_status"] == "success", s["last_message"]
    keys = {o["Key"] for o in s3_bucket["client"].list_objects_v2(
        Bucket="test-bucket").get("Contents", [])}
    assert "backup/stale.txt" not in keys
