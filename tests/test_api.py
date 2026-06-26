"""API tests for every endpoint, driven through FastAPI's TestClient."""
import io
import os
import time
import zipfile

import app as filepeek


# --- /api/tree --------------------------------------------------------------

def test_tree_root_listing(client):
    data = client.get("/api/tree").json()
    names = [e["name"] for e in data["entries"]]
    assert names[0] == "sub dir"  # dirs sort first
    assert "readme.md" in names and "binary.bin" in names


def test_tree_subfolder_with_special_chars(client):
    data = client.get("/api/tree", params={"path": "sub dir"}).json()
    assert data["path"] == "sub dir"
    assert {"nested.txt", "notes.md", "deep"} <= {e["name"] for e in data["entries"]}


def test_tree_sort_modified(client, root):
    now = time.time()
    os.utime(root / "notes.txt", (now, now))
    os.utime(root / "readme.md", (now - 100, now - 100))
    entries = client.get("/api/tree", params={"sort": "modified"}).json()["entries"]
    files = [e["name"] for e in entries if not e["is_dir"]]
    assert files.index("notes.txt") < files.index("readme.md")


def test_tree_errors(client):
    assert client.get("/api/tree", params={"path": "missing"}).status_code == 404
    assert client.get("/api/tree", params={"path": "readme.md"}).status_code == 400
    assert client.get("/api/tree", params={"path": "../.."}).status_code == 403


# --- /api/file (read) -------------------------------------------------------

def test_get_text_file(client):
    data = client.get("/api/file", params={"path": "readme.md"}).json()
    assert data["is_text"] is True
    assert data["content"].startswith("# Hello")
    assert data["ext"] == ".md"


def test_get_binary_file(client):
    data = client.get("/api/file", params={"path": "binary.bin"}).json()
    assert data["is_text"] is False
    assert data["content"] is None


def test_get_file_errors(client):
    assert client.get("/api/file", params={"path": "nope.txt"}).status_code == 404
    assert client.get("/api/file", params={"path": "sub dir"}).status_code == 400
    assert client.get("/api/file", params={"path": "../etc/passwd"}).status_code == 403


def test_get_xlsx_renders_office(client, root):
    import openpyxl
    wb = openpyxl.Workbook()
    wb.active.append(["a", "b"])
    wb.save(root / "book.xlsx")
    data = client.get("/api/file", params={"path": "book.xlsx"}).json()
    assert data["office"]["type"] == "sheet"
    assert data["office"]["sheets"][0]["rows"] == [["a", "b"]]


def test_get_corrupt_docx_reports_error(client, root):
    (root / "bad.docx").write_bytes(b"not a zip")
    data = client.get("/api/file", params={"path": "bad.docx"}).json()
    assert "office_error" in data


# --- create / rename / delete -------------------------------------------------

def test_create_file_and_dir(client, root):
    assert client.post("/api/create", json={"path": "made.txt"}).status_code == 200
    assert (root / "made.txt").is_file()
    assert client.post("/api/create", json={"path": "made dir", "is_dir": True}).status_code == 200
    assert (root / "made dir").is_dir()
    assert client.post("/api/create", json={"path": "made.txt"}).status_code == 409
    assert client.post("/api/create", json={"path": "../evil.txt"}).status_code == 403


def test_rename(client, root):
    r = client.post("/api/rename", json={"path": "notes.txt", "name": "renamed.txt"})
    assert r.status_code == 200
    assert (root / "renamed.txt").exists() and not (root / "notes.txt").exists()


def test_rename_rejects_bad_names(client):
    for bad in ["a/b", "a\\b", "..", ".", "", "  "]:
        assert client.post("/api/rename", json={"path": "readme.md", "name": bad}).status_code == 400
    assert client.post("/api/rename", json={"path": "readme.md", "name": "page.html"}).status_code == 409
    assert client.post("/api/rename", json={"path": "ghost.txt", "name": "x"}).status_code == 404


def test_delete_file_and_folder(client, root):
    assert client.delete("/api/delete", params={"path": "readme.md"}).status_code == 200
    assert not (root / "readme.md").exists()
    assert client.delete("/api/delete", params={"path": "sub dir"}).status_code == 200
    assert not (root / "sub dir").exists()
    assert client.delete("/api/delete", params={"path": ""}).status_code == 403  # root
    assert client.delete("/api/delete", params={"path": "gone"}).status_code == 404


def test_delete_folder_drops_its_permlinks_and_bookmarks(client):
    assert client.post("/api/permlinks", json={"path": "sub dir/notes.md"}).status_code == 200
    assert client.post("/api/bookmarks", json={"path": "sub dir"}).status_code == 200
    client.delete("/api/delete", params={"path": "sub dir"})
    assert client.get("/api/permlinks").json()["permlinks"] == []
    assert client.get("/api/bookmarks").json()["bookmarks"] == []


# --- copy / move ---------------------------------------------------------------

def test_copy_file(client, root):
    r = client.post("/api/copy", json={"path": "readme.md", "dest_dir": "sub dir"})
    assert r.status_code == 200
    assert (root / "sub dir" / "readme.md").exists() and (root / "readme.md").exists()


def test_move_folder(client, root):
    client.post("/api/create", json={"path": "target", "is_dir": True})
    r = client.post("/api/move", json={"path": "sub dir", "dest_dir": "target"})
    assert r.status_code == 200
    assert (root / "target" / "sub dir" / "nested.txt").exists()
    assert not (root / "sub dir").exists()


def test_transfer_guards(client):
    # same place
    assert client.post("/api/move", json={"path": "readme.md", "dest_dir": ""}).status_code == 400
    # folder into itself / its own child
    assert client.post("/api/copy", json={"path": "sub dir", "dest_dir": "sub dir"}).status_code == 400
    assert client.post("/api/copy", json={"path": "sub dir", "dest_dir": "sub dir/deep"}).status_code == 400
    # existing name without overwrite
    client.post("/api/copy", json={"path": "readme.md", "dest_dir": "sub dir"})
    assert client.post("/api/copy", json={"path": "readme.md", "dest_dir": "sub dir"}).status_code == 409
    assert client.post("/api/copy",
                       json={"path": "readme.md", "dest_dir": "sub dir", "overwrite": True}).status_code == 200
    # the root itself
    assert client.post("/api/move", json={"path": "", "dest_dir": "sub dir"}).status_code == 403


# --- save / upload / download ----------------------------------------------------

def test_save_file(client, root):
    r = client.put("/api/file", json={"path": "new/deep/file.txt", "content": "saved ✓"})
    assert r.status_code == 200
    assert (root / "new" / "deep" / "file.txt").read_text() == "saved ✓"
    assert client.put("/api/file", json={"path": "sub dir", "content": "x"}).status_code == 400


def test_upload(client, root):
    r = client.post("/api/upload", files={"file": ("up.txt", b"uploaded")},
                    data={"target_dir": "sub dir"})
    assert r.status_code == 200
    assert (root / "sub dir" / "up.txt").read_bytes() == b"uploaded"
    # duplicate without overwrite
    r = client.post("/api/upload", files={"file": ("up.txt", b"x")}, data={"target_dir": "sub dir"})
    assert r.status_code == 409
    r = client.post("/api/upload", files={"file": ("up.txt", b"two")},
                    data={"target_dir": "sub dir", "overwrite": "true"})
    assert r.status_code == 200
    assert (root / "sub dir" / "up.txt").read_bytes() == b"two"
    assert client.post("/api/upload", files={"file": ("x.txt", b"")},
                       data={"target_dir": "missing"}).status_code == 404


def test_request_size_cap(client):
    too_big = str(filepeek.MAX_TRANSFER_BYTES + 1)
    r = client.post("/api/upload", headers={"content-length": too_big}, content=b"")
    assert r.status_code == 413


def test_download_and_raw(client):
    r = client.get("/api/download", params={"path": "readme.md"})
    assert r.status_code == 200
    assert "attachment" in r.headers["content-disposition"]
    r = client.get("/api/raw", params={"path": "readme.md"})
    assert r.status_code == 200
    # no filename is set, so there's no header at all — browsers default to inline
    assert "attachment" not in r.headers.get("content-disposition", "")
    assert client.get("/api/download", params={"path": "sub dir"}).status_code == 404


# --- zip jobs ---------------------------------------------------------------------

def _wait_for_zip(client, job, timeout=10.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        status = client.get("/api/zip/status", params={"job": job}).json()
        if status["status"] != "running":
            return status
        time.sleep(0.05)
    raise AssertionError("zip job did not finish in time")


def test_zip_folder_lifecycle(client):
    job = client.post("/api/zip", json={"path": "sub dir"}).json()["job"]
    status = _wait_for_zip(client, job)
    assert status["status"] == "done"
    assert status["done"] == status["total"] == 3

    r = client.get("/api/zip/download", params={"job": job})
    assert r.status_code == 200
    names = set(zipfile.ZipFile(io.BytesIO(r.content)).namelist())
    assert names == {"nested.txt", "notes.md", "deep/leaf.py"}
    # the job is reaped after download
    assert client.get("/api/zip/status", params={"job": job}).status_code == 404


def test_zip_errors(client):
    assert client.post("/api/zip", json={"path": "readme.md"}).status_code == 404
    assert client.get("/api/zip/status", params={"job": "nope"}).status_code == 404
    assert client.get("/api/zip/download", params={"job": "nope"}).status_code == 404
    assert client.delete("/api/zip", params={"job": "nope"}).json() == {"ok": True}


# --- search -----------------------------------------------------------------------

def test_search_filename(client):
    matches = client.get("/api/search/filename", params={"q": "NESTED"}).json()["matches"]
    assert [m["path"] for m in matches] == ["sub dir/nested.txt"]


def test_search_content(client):
    matches = client.get("/api/search/content", params={"q": "needle"}).json()["matches"]
    assert len(matches) == 1
    assert matches[0]["path"] == "sub dir/nested.txt"
    assert matches[0]["line"] == 1
    assert "needle" in matches[0]["snippet"]


def test_search_content_skips_binary(client):
    matches = client.get("/api/search/content", params={"q": "binary-ish"}).json()["matches"]
    assert matches == []


# --- permlinks & bookmarks ----------------------------------------------------------

def test_permlinks_crud(client):
    assert client.post("/api/permlinks", json={"path": "readme.md"}).status_code == 200
    client.post("/api/permlinks", json={"path": "readme.md"})  # idempotent
    links = client.get("/api/permlinks").json()["permlinks"]
    assert [l["path"] for l in links] == ["readme.md"]
    client.delete("/api/permlinks", params={"path": "readme.md"})
    assert client.get("/api/permlinks").json()["permlinks"] == []


def test_permlink_rejects_non_renderable(client):
    assert client.post("/api/permlinks", json={"path": "notes.txt"}).status_code == 400
    assert client.post("/api/permlinks", json={"path": "ghost.md"}).status_code == 404


def test_bookmarks_crud(client):
    assert client.post("/api/bookmarks", json={"path": "sub dir"}).status_code == 200
    marks = client.get("/api/bookmarks").json()["bookmarks"]
    assert [m["path"] for m in marks] == ["sub dir"]
    client.delete("/api/bookmarks", params={"path": "sub dir"})
    assert client.get("/api/bookmarks").json()["bookmarks"] == []


def test_bookmark_rejects_files(client):
    assert client.post("/api/bookmarks", json={"path": "readme.md"}).status_code == 404


# --- recents ------------------------------------------------------------------------

def test_recents_crud_and_dedupe(client):
    assert client.post("/api/recents", json={"path": "readme.md"}).status_code == 200
    assert client.post("/api/recents", json={"path": "notes.txt"}).status_code == 200
    client.post("/api/recents", json={"path": "readme.md"})  # revisit -> moves to front, no dupe
    recents = client.get("/api/recents").json()["recents"]
    assert [r["path"] for r in recents] == ["readme.md", "notes.txt"]
    assert "visited" in recents[0]
    client.delete("/api/recents", params={"path": "readme.md"})
    assert [r["path"] for r in client.get("/api/recents").json()["recents"]] == ["notes.txt"]
    client.delete("/api/recents")  # no path -> clear all
    assert client.get("/api/recents").json()["recents"] == []


def test_recent_rejects_dirs_and_missing(client):
    assert client.post("/api/recents", json={"path": "sub dir"}).status_code == 404
    assert client.post("/api/recents", json={"path": "ghost.md"}).status_code == 404


def test_recents_capped_at_limit(client, root, monkeypatch):
    monkeypatch.setattr("app.RECENTS_LIMIT", 3)
    for i in range(5):
        (root / f"r{i}.txt").write_text("x")
        assert client.post("/api/recents", json={"path": f"r{i}.txt"}).status_code == 200
    recents = client.get("/api/recents").json()["recents"]
    assert [r["path"] for r in recents] == ["r4.txt", "r3.txt", "r2.txt"]


def test_delete_folder_drops_its_recents(client, root):
    client.post("/api/recents", json={"path": "sub dir/nested.txt"})
    client.post("/api/recents", json={"path": "readme.md"})
    client.delete("/api/delete", params={"path": "sub dir"})
    assert [r["path"] for r in client.get("/api/recents").json()["recents"]] == ["readme.md"]


# --- / and /view ----------------------------------------------------------------------

def test_index_serves_ui(client):
    r = client.get("/")
    assert r.status_code == 200
    assert "<title>" in r.text and "filepeek" in r.text.lower()


def test_view_html_served_directly(client):
    r = client.get("/view", params={"path": "page.html"})
    assert r.text == "<h1>hi</h1>\n"


def test_view_markdown_rendered(client):
    r = client.get("/view", params={"path": "readme.md"})
    assert "marked" in r.text  # client-side renderer is wired in
    assert "# Hello" in r.text  # raw source embedded


def test_view_markdown_script_breakout_neutralized(client, root):
    (root / "evil.md").write_text("</script><script>alert(1)</script>")
    r = client.get("/view", params={"path": "evil.md"})
    assert "</script><script>alert(1)" not in r.text


def test_view_other_files_inline(client):
    r = client.get("/view", params={"path": "binary.bin"})
    assert r.status_code == 200
    assert "attachment" not in r.headers.get("content-disposition", "")


def test_view_errors(client):
    assert client.get("/view", params={"path": "ghost.html"}).status_code == 404
    assert client.get("/view", params={"path": "../../etc/passwd"}).status_code == 403
