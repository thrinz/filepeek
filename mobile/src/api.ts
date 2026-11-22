import { loadConnection, saveConnection, type AuthMode, type Connection } from './storage';

// ─────────────────────────────────────────────────────────────────────────────
// Auth model (see filepeek app.py)
//
// POST /api/login trades the root password or an API key for a session token,
// which every call sends as `Authorization: Bearer <token>`. The WebView can
// only attach that header to the page request itself, so /api/preview answers a
// Bearer request with the session cookie too; the images / PDF data the page
// then loads authenticate with that.
//
// A server running with auth disabled answers /api/me with 200 and needs no
// token at all (mode 'none').
// ─────────────────────────────────────────────────────────────────────────────

export class AuthError extends Error {}
export class NetworkError extends Error {}
/** The server understood the request and said no (4xx/5xx with a `detail`). */
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

export type Entry = {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
  modified: string;
  modified_ts: number;
};

export type PermLink = { path: string; name: string; created: string };

export type Bookmark = { path: string; name: string; created: string };

/** A search result; `line` and `snippet` are set for content matches only. */
export type SearchHit = { path: string; name: string; line?: number; snippet?: string };

export type PickedFile = { uri: string; name: string; mimeType?: string };

/** Strip whitespace + trailing slashes. Keeps an explicit scheme if one was typed. */
export function normalizeBase(input: string): string {
  return input.trim().replace(/\/+$/, '');
}

/**
 * Base URLs to try for what the user typed. With an explicit scheme there is
 * exactly one; a bare host tries HTTPS first (`tailscale serve`), then plain
 * HTTP (LAN / raw tailnet IP on :8765).
 */
export function candidateBases(input: string): string[] {
  const u = normalizeBase(input);
  if (!u) return [];
  if (/^https?:\/\//i.test(u)) return [u];
  return [`https://${u}`, `http://${u}`];
}

export function authHeaders(conn: Connection): Record<string, string> {
  return conn.token ? { Authorization: `Bearer ${conn.token}` } : {};
}

const enc = encodeURIComponent;

export const previewUrl = (c: Connection, path: string) => `${c.base}/api/preview?path=${enc(path)}`;
export const downloadUrl = (c: Connection, path: string) => `${c.base}/api/download?path=${enc(path)}`;
/** The shareable link the web UI also hands out for HTML/Markdown files. */
export const permLinkUrl = (c: Connection, path: string) => `${c.base}/view?path=${enc(path)}`;

export const canPermLink = (name: string) => /\.(html?|md|markdown)$/i.test(name);

async function request<T>(base: string, token: string, path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      ...init,
      headers: {
        Accept: 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(init.headers as Record<string, string> | undefined),
      },
    });
  } catch {
    throw new NetworkError(`Can't reach ${base}. Is the server up and on your tailnet?`);
  }
  if (res.status === 204) return undefined as T;
  let body: any = null;
  try {
    body = await res.json();
  } catch {
    // non-JSON body (e.g. a proxy error page)
  }
  if (res.ok) return body as T;
  const detail = typeof body?.detail === 'string' ? body.detail : '';
  if (res.status === 401) throw new AuthError(detail || 'Session expired.');
  if (res.status === 403 && /password change/i.test(detail)) {
    throw new ApiError(
      'This server still has its temporary password. Open it in a browser once to set a new one, then connect here.',
      403,
    );
  }
  throw new ApiError(detail || `Request failed (HTTP ${res.status}).`, res.status);
}

const json = (method: string, data: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(data),
});

async function postLogin(base: string, mode: AuthMode, secret: string): Promise<string> {
  try {
    const creds = mode === 'apikey' ? { apikey: secret.trim() } : { password: secret };
    return (await request<{ token: string }>(base, '', '/api/login', json('POST', creds))).token;
  } catch (e) {
    // A server from before /api/login existed bounces the call at its auth gate.
    if (e instanceof AuthError && e.message === 'Not authenticated') {
      throw new ApiError('This filepeek server is older than the app. Update and restart it, then connect again.', 401);
    }
    if (e instanceof ApiError && e.status === 429) throw new AuthError(e.message);
    throw e;
  }
}

/** Sign in (or confirm no login is needed) and verify. Persists the connection on success. */
export async function connect(input: string, mode: 'password' | 'apikey', secret: string): Promise<Connection> {
  const bases = candidateBases(input);
  if (bases.length === 0) throw new NetworkError('Enter your filepeek URL.');
  let lastError: unknown;
  for (const base of bases) {
    try {
      const conn = await connectTo(base, mode, secret);
      await saveConnection(conn);
      return conn;
    } catch (e) {
      lastError = e;
      // Only an unreachable host is worth retrying on the other scheme; a
      // wrong password or a server-side refusal is the final answer.
      if (!(e instanceof NetworkError)) throw e;
    }
  }
  // Typing https:// for a server that only speaks plain HTTP looks exactly like
  // an unreachable host, so say what to try.
  if (/^https:\/\/[^/]+:\d+$/i.test(bases[0]) && bases.length === 1) {
    throw new NetworkError(`Can't reach ${bases[0]}. If the server isn't behind HTTPS, use http:// instead.`);
  }
  throw lastError;
}

async function connectTo(base: string, mode: 'password' | 'apikey', secret: string): Promise<Connection> {
  try {
    const me = await request<{ auth_enabled?: boolean }>(base, '', '/api/me');
    if (typeof me?.auth_enabled !== 'boolean') {
      throw new ApiError(`${base} doesn't look like a filepeek server.`, 0);
    }
    return { base, mode: 'none', secret: '', token: '' }; // no login on this server
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) {
      throw new ApiError(`${base} isn't a filepeek server, or it's older than this app (update and restart it).`, 404);
    }
    if (!(e instanceof AuthError)) throw e;
  }
  if (!secret) throw new AuthError(mode === 'apikey' ? 'Enter your API key.' : 'Enter the password.');
  return { base, mode, secret, token: await postLogin(base, mode, secret) };
}

/**
 * Get a fresh session token from the stored credential. Updates `conn` in
 * place — every screen holds the same object, so they all pick up the token.
 */
export async function relogin(conn: Connection): Promise<void> {
  if (conn.mode === 'none') throw new AuthError('This server now requires a login.');
  conn.token = await postLogin(conn.base, conn.mode, conn.secret);
  await saveConnection(conn);
}

/**
 * Run an authed request, transparently signing in again once on AuthError
 * (token expired, or the server restarted with a new signing secret).
 */
async function authed<T>(conn: Connection, path: string, init?: RequestInit): Promise<T> {
  try {
    return await request<T>(conn.base, conn.token, path, init);
  } catch (e) {
    if (!(e instanceof AuthError)) throw e;
    await relogin(conn);
    return await request<T>(conn.base, conn.token, path, init);
  }
}

export const fetchMe = (c: Connection) => authed<{ role: string; auth_enabled: boolean }>(c, '/api/me');

export const listDir = (c: Connection, path: string) =>
  authed<{ path: string; entries: Entry[] }>(c, `/api/tree?path=${enc(path)}`);

export const createItem = (c: Connection, path: string, isDir: boolean) =>
  authed<Entry>(c, '/api/create', json('POST', { path, is_dir: isDir }));

export const listPermLinks = (c: Connection) => authed<{ permlinks: PermLink[] }>(c, '/api/permlinks');

export const addPermLink = (c: Connection, path: string) =>
  authed<{ path: string }>(c, '/api/permlinks', json('POST', { path }));

export const deletePermLink = (c: Connection, path: string) =>
  authed<{ ok: boolean }>(c, `/api/permlinks?path=${enc(path)}`, { method: 'DELETE' });

// Both searches cover the whole tree (limited to what the caller may see) and
// skip dot-folders, node_modules, virtualenvs and build output.
export const searchFilename = async (c: Connection, q: string) =>
  (await authed<{ matches: SearchHit[] }>(c, `/api/search/filename?q=${enc(q)}`)).matches;

export const searchContent = async (c: Connection, q: string) =>
  (await authed<{ matches: SearchHit[] }>(c, `/api/search/content?q=${enc(q)}`)).matches;

export const renameItem = (c: Connection, path: string, name: string) =>
  authed<Entry>(c, '/api/rename', json('POST', { path, name }));

export type FileContent = { path: string; name: string; size: number; is_text: boolean; content: string | null };

/** A file's metadata, plus its text when it is a text file the server can inline. */
export const fetchFile = (c: Connection, path: string) => authed<FileContent>(c, `/api/file?path=${enc(path)}`);

export const saveFile = (c: Connection, path: string, content: string) =>
  authed<Entry>(c, '/api/file', json('PUT', { path, content }));

const transfer = (kind: 'move' | 'copy') => (c: Connection, path: string, destDir: string, overwrite = false) =>
  authed<Entry>(c, `/api/${kind}`, json('POST', { path, dest_dir: destDir, overwrite }));

/** Move / copy a file or folder into `destDir`. Reject with status 409 if the name is taken and !overwrite. */
export const moveItem = transfer('move');
export const copyItem = transfer('copy');

// Folder zips are built by a background job on the server: start it, poll it,
// then fetch the result (which also cleans the job up).
export type ZipStatus = {
  status: 'running' | 'done' | 'cancelled' | 'error';
  done: number;
  total: number;
  error: string | null;
  name: string;
};

/** Rejects with status 413 when the folder is over the server's zip size limit. */
export const startZip = (c: Connection, path: string) =>
  authed<{ job: string; total: number }>(c, '/api/zip', json('POST', { path }));

export const zipStatus = (c: Connection, job: string) => authed<ZipStatus>(c, `/api/zip/status?job=${enc(job)}`);

/** Stops a running job, or discards a finished one that was never downloaded. */
export const cancelZip = (c: Connection, job: string) =>
  authed<{ ok: boolean }>(c, `/api/zip?job=${enc(job)}`, { method: 'DELETE' });

export const zipDownloadUrl = (c: Connection, job: string) => `${c.base}/api/zip/download?job=${enc(job)}`;

/** Deletes a file, or a folder with everything in it. */
export const deleteItem = (c: Connection, path: string) =>
  authed<{ ok: boolean }>(c, `/api/delete?path=${enc(path)}`, { method: 'DELETE' });

// Bookmarks are folders, shared with the web UI (stored on the server).
export const listBookmarks = (c: Connection) => authed<{ bookmarks: Bookmark[] }>(c, '/api/bookmarks');

export const addBookmark = (c: Connection, path: string) =>
  authed<{ path: string }>(c, '/api/bookmarks', json('POST', { path }));

export const deleteBookmark = (c: Connection, path: string) =>
  authed<{ ok: boolean }>(c, `/api/bookmarks?path=${enc(path)}`, { method: 'DELETE' });

/** Upload one picked file into `targetDir`. Rejects with status 409 if it exists and !overwrite. */
export function uploadFile(c: Connection, targetDir: string, file: PickedFile, overwrite = false) {
  const form = new FormData();
  // React Native's FormData streams a local file when given {uri, name, type}.
  form.append('file', {
    uri: file.uri,
    name: file.name,
    type: file.mimeType || 'application/octet-stream',
  } as unknown as Blob);
  form.append('target_dir', targetDir);
  form.append('overwrite', overwrite ? 'true' : 'false');
  return authed<Entry>(c, '/api/upload', { method: 'POST', body: form });
}

export type ResumeResult =
  | { status: 'ok'; conn: Connection }
  | { status: 'none' } // nothing saved
  | { status: 'failed'; conn: Connection; message: string };

/** Load the saved connection and make sure its token is live. */
export async function resume(): Promise<ResumeResult> {
  const conn = await loadConnection().catch(() => null);
  if (!conn) return { status: 'none' };
  try {
    await fetchMe(conn);
    return { status: 'ok', conn };
  } catch (e) {
    const message = e instanceof Error ? e.message : "Couldn't connect.";
    return { status: 'failed', conn, message };
  }
}

export const joinPath = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);
export const parentPath = (path: string) => path.split('/').slice(0, -1).join('/');

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}
