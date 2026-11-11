// Twitch Helix API
const HELIX = 'https://api.twitch.tv/helix/';

export class AuthError extends Error {
  constructor(message = '認証が無効です。再ログインしてください。') {
    super(message);
    this.name = 'AuthError';
  }
}

class Limiter {
  constructor(max) {
    this.max = max;
    this.active = 0;
    this.queue = [];
  }
  async run(fn) {
    while (this.active >= this.max) await new Promise((r) => this.queue.push(r));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }
}

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    }, { once: true });
  });

export class TwitchApi {
  /**
   * @param {{clientId: string, getToken: () => string|null, concurrency?: number}} opts
   */
  constructor({ clientId, getToken, concurrency = 6 }) {
    this.clientId = clientId;
    this.getToken = getToken;
    this.limiter = new Limiter(concurrency);
    this.rate = { remaining: Infinity, resetAt: 0 };
    this.requestCount = 0;
  }

  async get(path, params = {}, { signal } = {}) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v == null) continue;
      for (const item of Array.isArray(v) ? v : [v]) qs.append(k, item);
    }
    const url = `${HELIX}${path}?${qs}`;

    return this.limiter.run(async () => {
      for (let attempt = 0; ; attempt++) {
        signal?.throwIfAborted();
        // 残りが少ないときはリセットまで待つ
        if (this.rate.remaining <= this.limiter.max && Date.now() < this.rate.resetAt) {
          await sleep(this.rate.resetAt - Date.now() + 200, signal);
        }
        const token = this.getToken();
        if (!token) throw new AuthError('ログインしていません。');

        this.requestCount++;
        const res = await fetch(url, {
          headers: { 'Client-Id': this.clientId, Authorization: `Bearer ${token}` },
          signal,
        });
        this.#updateRate(res);

        if (res.ok) return res.json();
        if (res.status === 401) throw new AuthError();
        if ((res.status === 429 || res.status >= 500) && attempt < 5) {
          const wait = res.status === 429
            ? Math.max(this.rate.resetAt - Date.now(), 1000)
            : 500 * 2 ** attempt;
          await sleep(wait, signal);
          continue;
        }
        let msg = `${res.status}`;
        try { msg += ` ${(await res.json()).message ?? ''}`; } catch { /* ignore */ }
        throw new Error(`Twitch API エラー: ${msg}`);
      }
    });
  }

  #updateRate(res) {
    const remaining = res.headers.get('Ratelimit-Remaining');
    const reset = res.headers.get('Ratelimit-Reset');
    if (remaining != null) this.rate.remaining = Number(remaining);
    if (reset != null) this.rate.resetAt = Number(reset) * 1000;
  }

  async getUserByLogin(login, opts) {
    const res = await this.get('users', { login: login.trim().toLowerCase() }, opts);
    return res.data[0] ?? null;
  }

  /** チャットの名前の色（#RRGGBB）。未設定なら null */
  async getChatColor(userId, opts) {
    const res = await this.get('chat/color', { user_id: userId }, opts);
    const color = res.data[0]?.color;
    return /^#[0-9a-f]{6}$/i.test(color ?? '') ? color : null;
  }

  /** ゲームIDの配列 → Map<id, {id, name, box_art_url}> */
  async getGames(ids, opts) {
    const unique = [...new Set(ids.filter(Boolean))];
    const map = new Map();
    const chunks = [];
    for (let i = 0; i < unique.length; i += 100) chunks.push(unique.slice(i, i + 100));
    await Promise.all(chunks.map(async (chunk) => {
      const res = await this.get('games', { id: chunk }, opts);
      for (const g of res.data) map.set(g.id, g);
    }));
    return map;
  }

  /**
   * クリップ1ページ分（再生数の多い順）
   * @returns {Promise<{data: object[], cursor: string|null}>}
   */
  async getClipsPage({ broadcasterId, startedAt, endedAt, first = 100, after }, opts) {
    const res = await this.get('clips', {
      broadcaster_id: broadcasterId,
      started_at: startedAt.toISOString(),
      ended_at: endedAt.toISOString(),
      first,
      after,
    }, opts);
    return { data: res.data, cursor: res.pagination?.cursor || null };
  }
}
