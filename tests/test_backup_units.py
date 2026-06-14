"""Unit tests for backup guards, excludes, and S3 config validation."""
from pathlib import Path

import pytest

import backup


def test_default_excludes_cover_vcs_and_cruft():
    for pat in (".git/**", "node_modules/**", "__pycache__/**", "*.pyc"):
        assert pat in backup.DEFAULT_EXCLUDES


def test_build_excludes_adds_state_dir_when_nested(tmp_path):
    source = tmp_path / "data"
    source.mkdir()
    state = source / ".filepeek-state"
    excludes = backup.build_excludes(source, state)
    assert ".filepeek-state/**" in excludes


def test_build_excludes_omits_state_dir_when_outside(tmp_path):
    source = tmp_path / "data"
    source.mkdir()
    state = tmp_path / "state"  # sibling, not inside source
    excludes = backup.build_excludes(source, state)
    assert not any("state" in e for e in excludes if e not in backup.DEFAULT_EXCLUDES)


# --- destination guards -------------------------------------------------------

def _validate(dest, source, root=None, state=None):
    root = root or source
    state = state or (source.parent / "state")
    return backup.validate_local_destination(dest, source, root, state)


def test_valid_destination(tmp_path):
    source = tmp_path / "projects"
    source.mkdir()
    dest = tmp_path / "backup"
    out = _validate(str(dest), source)
    assert out == str(dest.resolve())


def test_reject_empty(tmp_path):
    with pytest.raises(backup.BackupError):
        _validate("", tmp_path / "src")


def test_reject_destination_equals_source(tmp_path):
    source = tmp_path / "projects"
    source.mkdir()
    with pytest.raises(backup.BackupError):
        _validate(str(source), source)


def test_reject_destination_inside_source(tmp_path):
    source = tmp_path / "projects"
    source.mkdir()
    with pytest.raises(backup.BackupError) as e:
        _validate(str(source / "backup"), source)
    assert "inside the source" in str(e.value)


def test_reject_source_inside_destination(tmp_path):
    source = tmp_path / "a" / "b" / "projects"
    source.mkdir(parents=True)
    dest = tmp_path / "a"  # ancestor of source
    with pytest.raises(backup.BackupError):
        _validate(str(dest), source)


@pytest.mark.parametrize("dest", ["/", "/etc", "/usr", "/var", "/tmp", "/home", "/root"])
def test_reject_forbidden_system_dirs(dest, tmp_path):
    source = tmp_path / "projects"
    source.mkdir()
    with pytest.raises(backup.BackupError):
        _validate(dest, source)


def test_reject_home_dir(tmp_path):
    source = tmp_path / "projects"
    source.mkdir()
    with pytest.raises(backup.BackupError):
        _validate(str(Path.home()), source)


def test_reject_state_dir(tmp_path):
    source = tmp_path / "projects"
    source.mkdir()
    state = tmp_path / "state"
    state.mkdir()
    with pytest.raises(backup.BackupError):
        backup.validate_local_destination(str(state), source, source, state)


def test_reject_root_dir(tmp_path):
    source = tmp_path / "projects"
    source.mkdir()
    root = tmp_path / "served-root"
    root.mkdir()
    with pytest.raises(backup.BackupError):
        backup.validate_local_destination(str(root), source, root, tmp_path / "state")


def test_reject_windows_path(tmp_path):
    with pytest.raises(backup.BackupError):
        _validate("C:\\backup", tmp_path / "src")


# --- exclude matcher ----------------------------------------------------------

@pytest.mark.parametrize("rel", [
    ".git/HEAD", "sub/.git/config", "node_modules/x/index.js",
    "a/__pycache__/m.pyc", "foo.pyc", ".DS_Store", "x/.DS_Store",
])
def test_excluded_paths(rel):
    assert backup.is_excluded(rel, backup.DEFAULT_EXCLUDES)


@pytest.mark.parametrize("rel", [
    "readme.md", "src/app.py", "docs/guide.md", "data/notes.txt", "gitignore.txt",
])
def test_not_excluded_paths(rel):
    assert not backup.is_excluded(rel, backup.DEFAULT_EXCLUDES)


def test_iter_backup_files_skips_excluded(tmp_path):
    (tmp_path / "keep.md").write_text("x")
    (tmp_path / "sub").mkdir()
    (tmp_path / "sub" / "k.txt").write_text("x")
    (tmp_path / ".git").mkdir()
    (tmp_path / ".git" / "HEAD").write_text("ref")
    (tmp_path / "junk.pyc").write_text("x")
    rels = {rel for _, rel in backup.iter_backup_files(tmp_path, [], backup.DEFAULT_EXCLUDES)}
    assert rels == {"keep.md", "sub/k.txt"}


def test_iter_backup_files_selected_folders(tmp_path):
    for f in ["a/x.txt", "a/y.txt", "b/z.txt", "c/w.txt"]:
        p = tmp_path / f
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text("data")
    rels = {rel for _, rel in backup.iter_backup_files(tmp_path, ["a", "b"], backup.DEFAULT_EXCLUDES)}
    assert rels == {"a/x.txt", "a/y.txt", "b/z.txt"}  # c excluded (not selected)


def test_is_managed_scope():
    assert backup._is_managed("anything", [])           # whole root manages all
    assert backup._is_managed("a/x.txt", ["a", "b"])
    assert backup._is_managed("a", ["a"])
    assert not backup._is_managed("c/w.txt", ["a", "b"])  # unselected folder unmanaged


# --- S3 config validation -----------------------------------------------------

def test_valid_s3_config():
    out = backup.validate_s3_config({
        "bucket": "my-bucket", "prefix": "/backup/", "access_key_id": "k",
        "secret_access_key": "s", "endpoint": "https://s3.example.com", "region": "us-east-1",
    })
    assert out["bucket"] == "my-bucket"
    assert out["prefix"] == "backup"  # stripped


@pytest.mark.parametrize("cfg", [
    {"bucket": "", "access_key_id": "k", "secret_access_key": "s"},
    {"bucket": "b", "access_key_id": "", "secret_access_key": "s"},
    {"bucket": "b", "access_key_id": "k", "secret_access_key": ""},
    {"bucket": "bad/name", "access_key_id": "k", "secret_access_key": "s"},
])
def test_invalid_s3_config(cfg):
    with pytest.raises(backup.BackupError):
        backup.validate_s3_config(cfg)
