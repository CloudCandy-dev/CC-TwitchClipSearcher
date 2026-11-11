// Twitch ログイン（Implicit Grant）
const TOKEN_KEY = 'tcs_token';
const STATE_KEY = 'tcs_oauth_state';

function storageGet(store, key) {
  try { return store.getItem(key); } catch { return null; }
}
function storageSet(store, key, value) {
  try { value == null ? store.removeItem(key) : store.setItem(key, value); } catch { /* ignore */ }
}

export function startLogin({ clientId, redirectUri }) {
  const state = crypto.randomUUID();
  storageSet(sessionStorage, STATE_KEY, state);
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'token',
    scope: '',
    state,
  });
  window.location.assign(`https://id.twitch.tv/oauth2/authorize?${params}`);
}

/**
 * ログイン後のリダイレクト（URL の #access_token=...）を処理する。
 * @returns {{token?: string, error?: string} | null} リダイレクトでなければ null
 */
export function handleRedirect() {
  const hash = window.location.hash.startsWith('#') ? window.location.hash.slice(1) : '';
  const query = new URLSearchParams(window.location.search);
  const params = new URLSearchParams(hash);
  const error = params.get('error') || query.get('error');
  const token = params.get('access_token');
  if (!token && !error) return null;

  const expectedState = storageGet(sessionStorage, STATE_KEY);
  const state = params.get('state') || query.get('state');
  storageSet(sessionStorage, STATE_KEY, null);
  history.replaceState(null, '', window.location.pathname);

  if (error) {
    return { error: params.get('error_description') || query.get('error_description') || error };
  }
  if (!expectedState || state !== expectedState) {
    return { error: 'state が一致しません。もう一度ログインしてください。' };
  }
  storageSet(localStorage, TOKEN_KEY, token);
  return { token };
}

export function getToken() {
  return storageGet(localStorage, TOKEN_KEY);
}

/** トークンを検証。無効なら消して null */
export async function validateToken(token = getToken()) {
  if (!token) return null;
  const res = await fetch('https://id.twitch.tv/oauth2/validate', {
    headers: { Authorization: `OAuth ${token}` },
  });
  if (res.status === 401) {
    clearToken();
    return null;
  }
  if (!res.ok) throw new Error(`トークン検証に失敗しました (${res.status})`);
  return res.json(); // { client_id, login, user_id, expires_in, scopes }
}

export function clearToken() {
  storageSet(localStorage, TOKEN_KEY, null);
}

export async function logout({ clientId }) {
  const token = getToken();
  clearToken();
  if (!token) return;
  try {
    await fetch('https://id.twitch.tv/oauth2/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: clientId, token }),
    });
  } catch { /* ignore */ }
}
