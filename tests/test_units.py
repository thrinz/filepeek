"""Unit tests for pure helpers: auth primitives, path safety, file-type
detection, and the office/markdown renderers."""
import time
import zipfile

import pytest
from fastapi import HTTPException

import app as filepeek


# --- password hashing -----------------------------------------------------

def test_password_roundtrip():
    stored = filepeek.hash_password("hunter2", iterations=1000)
    assert filepeek.verify_password("hunter2", stored)
    assert not filepeek.verify_password("hunter3", stored)


@pytest.mark.parametrize("stored", ["", "garbage", "md5$1$ab$cd", "a$b$c$d"])
def test_verify_password_rejects_malformed(stored):
    assert not filepeek.verify_password("anything", stored)


# --- session cookies ------------------------------------------------------

def test_session_sign_and_validate():
    cookie = filepeek._sign_session(int(time.time()) + 60)
    assert filepeek._session_valid(cookie)


def test_session_expired():
    assert not filepeek._session_valid(filepeek._sign_session(int(time.time()) - 1))


def test_session_tampered():
    cookie = filepeek._sign_session(int(time.time()) + 60)
    expiry, _, sig = cookie.partition(".")
    assert not filepeek._session_valid(f"{expiry}.{'0' * len(sig)}")
    assert not filepeek._session_valid(f"{int(expiry) + 9999}.{sig}")
    assert not filepeek._session_valid(None)
    assert not filepeek._session_valid("no-dot")


# --- path safety ----------------------------------------------------------

def test_safe_path_inside_root(root):
    assert filepeek.safe_path("sub dir/nested.txt") == root / "sub dir" / "nested.txt"
    assert filepeek.safe_path("") == root
    assert filepeek.safe_path("/leading/slash") == root / "leading" / "slash"


@pytest.mark.parametrize("rel", ["..", "../..", "../outside.txt", "sub dir/../../evil"])
def test_safe_path_blocks_traversal(root, rel):
    with pytest.raises(HTTPException) as exc:
        filepeek.safe_path(rel)
    assert exc.value.status_code == 403


def test_to_rel(root):
    assert filepeek.to_rel(root) == ""
    assert filepeek.to_rel(root / "a" / "b") == "a/b"
    assert filepeek.to_rel(root.parent) == ""  # outside root collapses to root


# --- text/binary detection ------------------------------------------------

def test_is_text_file(root):
    assert filepeek.is_text_file(root / "notes.txt")
    assert not filepeek.is_text_file(root / "binary.bin")
    noext = root / "noext"
    noext.write_text("plain utf-8 content")
    assert filepeek.is_text_file(noext)
    empty = root / "empty"
    empty.touch()
    assert filepeek.is_text_file(empty)


# --- markdown page rendering ----------------------------------------------

def test_render_markdown_page_neutralizes_script_close():
    page = filepeek.render_markdown_page("x.md", "hello </script><b>bye</b>")
    assert "</script><b>" not in page
    assert "<\\/script" in page


def test_render_markdown_page_escapes_title():
    page = filepeek.render_markdown_page('<img src=x onerror="1">.md', "body")
    assert "<img src=x" not in page


# --- office readers -------------------------------------------------------

def test_read_sheet(tmp_path):
    openpyxl = pytest.importorskip("openpyxl")
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Data"
    ws.append(["name", "qty"])
    ws.append(["apple"])  # ragged row: should be padded
    path = tmp_path / "t.xlsx"
    wb.save(path)

    sheets = filepeek.read_sheet(path)
    assert sheets[0]["name"] == "Data"
    assert sheets[0]["rows"] == [["name", "qty"], ["apple", ""]]
    assert sheets[0]["truncated"] is False


DOCX_XML = """<?xml version="1.0"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
 <w:body>
  <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Section</w:t></w:r></w:p>
  <w:p><w:r><w:rPr><w:b/></w:rPr><w:t>bold bit</w:t></w:r><w:r><w:t> plain &amp; more</w:t></w:r></w:p>
  <w:tbl><w:tr><w:tc><w:p><w:r><w:t>cell</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
 </w:body>
</w:document>"""


def test_read_doc_html(tmp_path):
    path = tmp_path / "t.docx"
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("word/document.xml", DOCX_XML)
    html = filepeek.read_doc_html(path)
    assert "<h1>Section</h1>" in html
    assert "<strong>bold bit</strong>" in html
    assert "plain &amp; more" in html  # content is escaped
    assert "<table><tr><td><p>cell</p></td></tr></table>" in html


SLIDE_XML = """<?xml version="1.0"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
       xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
 <p:txBody>
  <a:p><a:r><a:t>{title}</a:t></a:r></a:p>
  <a:p><a:r><a:t>{body}</a:t></a:r></a:p>
 </p:txBody>
</p:sld>"""


def test_read_pptx_html(tmp_path):
    path = tmp_path / "t.pptx"
    with zipfile.ZipFile(path, "w") as z:
        # write out of order to check numeric slide sorting (slide10 after slide2)
        z.writestr("ppt/slides/slide10.xml", SLIDE_XML.format(title="Ten", body="b10"))
        z.writestr("ppt/slides/slide1.xml", SLIDE_XML.format(title="One", body="b1"))
        z.writestr("ppt/slides/slide2.xml", SLIDE_XML.format(title="Two", body="b2"))
    html = filepeek.read_pptx_html(path)
    assert html.index("<h2>One</h2>") < html.index("<h2>Two</h2>") < html.index("<h2>Ten</h2>")
    assert "<p>b1</p>" in html
    assert "Slide 3" in html  # slide10 is rendered third
