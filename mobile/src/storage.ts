import * as SecureStore from 'expo-secure-store';

// The connection lives in the OS keychain/keystore (via expo-secure-store),
// never in plain storage. The credential is kept alongside the token so the app
// can silently sign in again when the 7-day session token expires.
const KEY = 'filepeek.connection';

/** How the user signs in. 'none' = the server runs without a login. */
export type AuthMode = 'password' | 'apikey' | 'none';

export interface Connection {
  base: string; // normalized, no trailing slash, e.g. http://100.x.y.z:8765
  mode: AuthMode;
  secret: string; // the password or API key ('' for mode 'none')
  token: string; // session token from POST /api/login ('' for mode 'none')
}

export async function saveConnection(conn: Connection): Promise<void> {
  await SecureStore.setItemAsync(KEY, JSON.stringify(conn));
}

export async function loadConnection(): Promise<Connection | null> {
  const raw = await SecureStore.getItemAsync(KEY);
  if (!raw) return null;
  try {
    const p = JSON.parse(raw);
    if (
      typeof p?.base === 'string' &&
      typeof p?.secret === 'string' &&
      typeof p?.token === 'string' &&
      ['password', 'apikey', 'none'].includes(p?.mode)
    ) {
      return p as Connection;
    }
  } catch {
    // corrupt entry — treat as no connection.
  }
  return null;
}

export async function clearConnection(): Promise<void> {
  await SecureStore.deleteItemAsync(KEY);
}
