"""Auth middleware, login flow, token access, and lockout behavior."""
import app as filepeek


# --- auth disabled (local mode) --------------------------------------------

def test_no_auth_by_default(client):
    assert client.get("/api/tree").status_code == 200


def test_login_page_redirects_home_when_auth_off(client):
    r = client.get("/login", follow_redirects=False)
    assert r.status_code == 303 and r.headers["location"] == "/"


# --- auth enabled -----------------------------------------------------------

def test_api_requires_auth(auth_client):
    r = auth_client.get("/api/tree")
    assert r.status_code == 401


def test_browser_redirected_to_login(auth_client):
    r = auth_client.get("/", headers={"accept": "text/html"}, follow_redirects=False)
    assert r.status_code == 303 and r.headers["location"] == "/login"


def test_exempt_paths(auth_client):
    assert auth_client.get("/login").status_code == 200
    assert auth_client.get("/static/logo.svg").status_code == 200
    # other static files are NOT exempt
    assert auth_client.get("/static/index.html").status_code == 401


def test_login_wrong_password(auth_client):
    r = auth_client.post("/login", data={"password": "wrong"})
    assert r.status_code == 401
    assert "Wrong password" in r.text


def test_login_success_sets_session(auth_client):
    r = auth_client.post("/login", data={"password": "secret123"}, follow_redirects=False)
    assert r.status_code == 303
    assert filepeek.SESSION_COOKIE in r.cookies
    # the cookie jar now grants API access
    assert auth_client.get("/api/tree").status_code == 200


def test_logout_clears_session(auth_client):
    auth_client.post("/login", data={"password": "secret123"})
    assert auth_client.get("/api/tree").status_code == 200
    auth_client.post("/logout")
    assert auth_client.get("/api/tree").status_code == 401


def test_bearer_token(auth_client):
    ok = {"Authorization": "Bearer tok-abc"}
    assert auth_client.get("/api/tree", headers=ok).status_code == 200
    bad = {"Authorization": "Bearer wrong"}
    assert auth_client.get("/api/tree", headers=bad).status_code == 401
    assert auth_client.get("/api/tree", headers={"Authorization": "tok-abc"}).status_code == 401


def test_forged_session_cookie_rejected(auth_client):
    auth_client.cookies.set(filepeek.SESSION_COOKIE, "9999999999.deadbeef")
    assert auth_client.get("/api/tree").status_code == 401


def test_lockout_after_repeated_failures(auth_client):
    for _ in range(filepeek.LOGIN_MAX_FAILURES):
        auth_client.post("/login", data={"password": "wrong"})
    r = auth_client.post("/login", data={"password": "secret123"})  # even the right password
    assert r.status_code == 429


def test_backup_endpoints_require_auth(auth_client):
    assert auth_client.get("/api/backup/config").status_code == 401
    assert auth_client.get("/api/backup/status").status_code == 401
    assert auth_client.get("/api/backup/logs").status_code == 401
    assert auth_client.post("/api/backup/config", json={"type": "local", "destination": "/x"}).status_code == 401
    assert auth_client.post("/api/backup/test").status_code == 401
    assert auth_client.post("/api/backup/preview").status_code == 401
    assert auth_client.post("/api/backup/run", json={}).status_code == 401


def test_lockout_counter_resets_on_success(auth_client):
    for _ in range(filepeek.LOGIN_MAX_FAILURES - 1):
        auth_client.post("/login", data={"password": "wrong"})
    r = auth_client.post("/login", data={"password": "secret123"}, follow_redirects=False)
    assert r.status_code == 303
    # failures were cleared; a fresh wrong attempt is a 401, not a lockout
    assert auth_client.post("/login", data={"password": "wrong"}).status_code == 401
