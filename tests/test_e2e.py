"""Browser end-to-end tests (Playwright, headless Chromium).

Run with:  pytest -m e2e
Needs:     pip install -r requirements-dev.txt && playwright install chromium

A real server subprocess is started against a temp root, and a headless
browser drives the UI: navigation, URL deep links, history, editing, search.
Set FILEPEEK_TEST_CHROMIUM=/path/to/chrome to use a specific browser binary.
"""
import os
import socket
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

import pytest

pytestmark = pytest.mark.e2e
sync_api = pytest.importorskip("playwright.sync_api", reason="playwright not installed")

APP_DIR = Path(__file__).resolve().parent.parent

E2E_FILES = {
    "readme.md": "# Hello e2e\n",
    "docs & files/guide.md": "# Guide\n",
    "docs & files/sub dir/hello.md": "hello world\n",
}


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture(scope="module")
def server(tmp_path_factory):
    """A live filepeek server (subprocess) on a free port, serving a temp root."""
    base_dir = tmp_path_factory.mktemp("e2e")
    root = base_dir / "root"
    state = base_dir / "state"
    state.mkdir()
    for rel, content in E2E_FILES.items():
        p = root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(content)

    port = _free_port()
    env = {**os.environ, "FILEPEEK_ROOT": str(root), "FILEPEEK_STATE_DIR": str(state)}
    proc = subprocess.Popen(
        [sys.executable, "app.py", "--port", str(port)],
        cwd=APP_DIR, env=env,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    base = f"http://127.0.0.1:{port}"
    try:
        deadline = time.time() + 15
        while True:
            try:
                urllib.request.urlopen(base + "/api/tree", timeout=1)
                break
            except OSError:
                if proc.poll() is not None or time.time() > deadline:
                    raise RuntimeError("server failed to start")
                time.sleep(0.1)
        yield {"base": base, "root": root}
    finally:
        proc.terminate()
        proc.wait(timeout=10)


@pytest.fixture(scope="module")
def browser():
    exe = os.environ.get("FILEPEEK_TEST_CHROMIUM")
    with sync_api.sync_playwright() as p:
        browser = p.chromium.launch(executable_path=exe) if exe else p.chromium.launch()
        yield browser
        browser.close()


@pytest.fixture
def page(browser, server):
    page = browser.new_page()
    page.goto(server["base"])
    page.wait_for_selector("#tree")
    yield page
    page.close()


def url_path(page) -> str:
    """The decoded ?path= value of the page's current URL ('' at the root)."""
    qs = urllib.parse.urlparse(page.url).query
    return urllib.parse.parse_qs(qs).get("path", [""])[0]


def row(page, rel):
    return page.locator(f'#tree [data-path="{rel}"]')


# --- navigation & URL sync ----------------------------------------------------

def test_root_lists_entries(page):
    assert row(page, "readme.md").is_visible()
    assert row(page, "docs & files").is_visible()
    assert url_path(page) == ""


def test_folder_click_updates_url_and_breadcrumb(page):
    row(page, "docs & files").click()
    row(page, "docs & files/guide.md").wait_for()
    assert url_path(page) == "docs & files"
    assert "docs & files" in page.locator("#breadcrumb").inner_text()

    row(page, "docs & files/sub dir").click()
    row(page, "docs & files/sub dir/hello.md").wait_for()
    assert url_path(page) == "docs & files/sub dir"


def test_browser_back_and_forward(page):
    row(page, "docs & files").click()
    row(page, "docs & files/guide.md").wait_for()
    row(page, "docs & files/sub dir").click()
    row(page, "docs & files/sub dir/hello.md").wait_for()

    page.go_back()
    row(page, "docs & files/guide.md").wait_for()
    assert url_path(page) == "docs & files"

    page.go_forward()
    row(page, "docs & files/sub dir/hello.md").wait_for()
    assert url_path(page) == "docs & files/sub dir"


def test_deep_link_to_folder(browser, server):
    page = browser.new_page()
    target = urllib.parse.quote("docs & files/sub dir")
    page.goto(f"{server['base']}/?path={target}")
    row(page, "docs & files/sub dir/hello.md").wait_for()
    page.close()


def test_deep_link_to_file(browser, server):
    page = browser.new_page()
    target = urllib.parse.quote("docs & files/sub dir/hello.md")
    page.goto(f"{server['base']}/?path={target}")
    page.wait_for_selector('#file-info:has-text("hello.md")')
    page.close()


# --- viewing & editing ----------------------------------------------------------

def test_open_file_shows_content_and_updates_url(page):
    row(page, "readme.md").click()
    page.wait_for_selector('#file-info:has-text("readme.md")')
    assert url_path(page) == "readme.md"


def test_edit_and_save_persists_to_disk(page, server):
    row(page, "readme.md").click()
    page.wait_for_selector('#file-info:has-text("readme.md")')
    page.click("#btn-edit")
    page.fill("#editor", "# changed by e2e\n")
    page.click("#btn-save")
    page.wait_for_selector('#toast:has-text("Saved")')
    assert (server["root"] / "readme.md").read_text() == "# changed by e2e\n"


# --- create & search --------------------------------------------------------------

def test_new_folder_via_prompt(page, server):
    page.once("dialog", lambda d: d.accept("brand new folder"))
    page.click("#btn-new-folder")
    row(page, "brand new folder").wait_for()
    assert (server["root"] / "brand new folder").is_dir()


def test_filename_search_navigates_to_file(page):
    page.click("#btn-search")  # reveals the filename search box
    page.fill("#search-filename", "hello")
    item = page.locator('#filename-dropdown div', has_text="hello.md").first
    item.click()
    page.wait_for_selector('#file-info:has-text("hello.md")')
    assert url_path(page) == "docs & files/sub dir/hello.md"
