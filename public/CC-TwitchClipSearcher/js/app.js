// 画面
import { CONFIG } from './config.js';
import * as auth from './auth.js';
import { TwitchApi, AuthError } from './twitch-api.js';
import { fetchTopClips, fetchAllClips } from './clip-fetcher.js';
import { filterClips, sortClips, countByGame, SORTS } from './clip-query.js';
import { cacheGet, cacheSet } from './result-cache.js';
import { applyChannelTheme } from './channel-theme.js';
import * as motion from './motion.js';

const $ = (id) => document.getElementById(id);
const PAGE_SIZE = 100;
const THEME_KEY = 'tcs_theme';
const RETURN_KEY = 'tcs_return_search';   // ログイン前の URL（?以降）。ログイン後に戻すため
const DEFAULTS = { preset: 'this-year', mode: 'top', qField: 'title', sort: 'views_desc' };
const DAY = 864e5;
const CACHE_TTL_MS = 5 * 60 * 1000;          // 今日を含む期間の結果を使い回す時間
const PAST_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 過去だけの期間の結果（再生数は変わるので1日で取り直す）
const USER_TTL_MS = 24 * 60 * 60 * 1000;       // チャンネル情報（アイコン・色など）

const api = new TwitchApi({ clientId: CONFIG.clientId, getToken: auth.getToken, concurrency: CONFIG.concurrency });

const state = {
  loggedIn: false,
  searched: false,     // 一度でも検索したか（以降は期間を変えるだけで再検索する）
  user: null,          // 対象チャンネル
  range: null,         // 取得した期間 {start, end}
  mode: 'top',
  clips: [],           // 取得結果
  games: new Map(),    // game_id -> game
  buckets: [],         // タイムラインの区切り [{start, end, label, daily}]
  selection: null,     // タイムラインで選んだ区切り {from, to}（インデックス）
  view: [],            // 絞り込み・並べ替え後
  shown: 0,
  controller: null,
  cache: new Map(),    // 取得条件 -> 結果
  pending: null,       // URL から復元する絞り込み条件（検索結果が出てから当てはめる）
  openClipId: null,    // 再生中のクリップ（URL に載せる）
};

const storage = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch { /* ignore */ } },
};

// ---------- 共通の小物 ----------
const pad = (n) => String(n).padStart(2, '0');
const toInput = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fromInput = (v) => { const [y, m, d] = v.split('-').map(Number); return new Date(y, m - 1, d); };
const fmtNum = (n) => n.toLocaleString('ja-JP');
const fmtDay = (d) => `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())}`;
const fmtDateTime = (iso) => { const d = new Date(iso); return `${fmtDay(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const fmtDur = (s) => `${Math.floor(s / 60)}:${pad(Math.round(s % 60))}`;

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (k in node && typeof v !== 'string') node[k] = v;
    else node.setAttribute(k, v);
  }
  node.append(...children.filter((c) => c != null && c !== false));
  return node;
}

// アイコン（lucide）
const ICON = {
  play: '<svg class="i i-fill" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4.5v15l12-7.5z"/></svg>',
  eye: '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M2.06 12.35a1 1 0 0 1 0-.7 10.75 10.75 0 0 1 19.88 0 1 1 0 0 1 0 .7 10.75 10.75 0 0 1-19.88 0"/><circle cx="12" cy="12" r="3"/></svg>',
  user: '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>',
};

/** role="radiogroup" のボタン群 */
function radioGroup(group, onChange) {
  const buttons = [...group.querySelectorAll('button')];
  motion.pill(group);
  const ctl = {
    get value() { return buttons.find((b) => b.getAttribute('aria-checked') === 'true')?.dataset.value; },
    set value(v) { for (const b of buttons) b.setAttribute('aria-checked', String(b.dataset.value === v)); },
  };
  for (const b of buttons) {
    b.addEventListener('click', () => {
      if (ctl.value === b.dataset.value) return;
      ctl.value = b.dataset.value;
      onChange?.(b.dataset.value);
    });
  }
  return ctl;
}

/** 開閉ボタンとパネル */
function disclosure(button, panel) {
  button.addEventListener('click', () => {
    const open = button.getAttribute('aria-expanded') !== 'true';
    button.setAttribute('aria-expanded', String(open));
    motion.reveal(panel, open);
  });
}

/**
 * チャンネルIDを取り出す。URL・「twitch.tv//id」・先頭のスラッシュや @ を許容する。
 */
function normalizeLogin(value) {
  return value.trim()
    .replace(/^(https?:\/\/)?([a-z]+\.)?twitch\.tv/i, '')
    .replace(/^[\s/@]+/, '')
    .split(/[/?#\s]/)[0]
    .toLowerCase();
}

// ---------- テーマ ----------
const themeButtons = [...document.querySelectorAll('[data-theme-value]')];
function applyTheme(theme) {
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
  for (const b of themeButtons) b.setAttribute('aria-checked', String(b.dataset.themeValue === (theme || 'auto')));
}
motion.pill(document.querySelector('.theme-switch'));
for (const b of themeButtons) {
  b.addEventListener('click', () => { storage.set(THEME_KEY, b.dataset.themeValue); applyTheme(b.dataset.themeValue); });
}
applyTheme(storage.get(THEME_KEY) || 'auto');

// ---------- 認証 ----------
/** トークンを確かめて、ヘッダーとバナーの表示を合わせる */
async function refreshAuth() {
  let info = null;
  try { info = await auth.validateToken(); } catch (e) { showError(e.message); }
  state.loggedIn = !!info;
  $('auth-login').textContent = info?.login ?? '';
  $('auth-user').hidden = !info?.login;
  $('login-btn').hidden = state.loggedIn;
  $('why-login-header').hidden = state.loggedIn;
  $('logout-btn').hidden = !state.loggedIn;
  if (!state.searched) showIntro();
  setBusy(false);
}

const login = () => {
  // ログイン後は redirect URI（トップ）に戻るので、今の URL を覚えておいて戻す
  try { sessionStorage.setItem(RETURN_KEY, location.search); } catch { /* ignore */ }
  auth.startLogin(CONFIG);
};
$('login-btn').onclick = login;
$('welcome-login').onclick = login;
$('why-login-go').onclick = login;

// 「なぜログインが必要？」の説明
const whyLogin = $('why-login');
for (const b of document.querySelectorAll('[data-why-login]')) {
  b.addEventListener('click', () => {
    $('why-login-go').hidden = state.loggedIn;
    whyLogin.showModal();
    motion.dialogIn(whyLogin);
  });
}
const closeWhyLogin = () => motion.dialogOut(whyLogin, () => whyLogin.close());
whyLogin.querySelector('[data-close]').onclick = closeWhyLogin;
whyLogin.addEventListener('click', (ev) => { if (ev.target === whyLogin) closeWhyLogin(); });
whyLogin.addEventListener('cancel', (ev) => { ev.preventDefault(); closeWhyLogin(); });
$('logout-btn').onclick = async () => { await auth.logout(CONFIG); location.reload(); };

// ---------- バナー ----------
function showIntro() {
  $('banner').classList.remove('has-image');
  $('banner-img').hidden = true;
  $('banner-channel').hidden = true;
  $('banner-intro').hidden = false;
  $('intro-actions').hidden = state.loggedIn;   // ログイン前だけログインを促す
}

function showChannel(user) {
  const img = $('banner-img');
  const banner = $('banner');
  if (user.offline_image_url) {
    const show = () => { img.hidden = false; banner.classList.add('has-image'); };
    img.onload = () => { show(); motion.bannerImageIn(img); };
    img.onerror = () => { img.hidden = true; banner.classList.remove('has-image'); };
    if (img.src !== user.offline_image_url) {
      img.hidden = true;
      banner.classList.remove('has-image');
      img.src = user.offline_image_url;
    } else if (img.complete && img.naturalWidth > 0) {
      // 同じ画像だと onload が来ないので、読み込み済みならそのまま表示
      show();
    }
  } else {
    img.hidden = true;
    img.removeAttribute('src');
    banner.classList.remove('has-image');
  }
  const channelUrl = `https://www.twitch.tv/${encodeURIComponent(user.login)}`;
  $('channel-avatar-link').href = channelUrl;
  $('channel-name-link').href = channelUrl;
  $('channel-avatar').src = user.profile_image_url || '';
  $('channel-name').textContent = user.display_name || user.login;
  $('banner-intro').hidden = true;
  $('banner-channel').hidden = false;
  applyChannelTheme(user.chat_color);
}


// ---------- 期間・取得方法 ----------
const preset = radioGroup($('preset'), () => {
  applyPreset();
  if (preset.value !== 'custom') autoSearch();
});
const mode = radioGroup($('mode'), () => { updateModeUi(); autoSearch(); });
disclosure($('advanced-toggle'), $('advanced'));

function updateModeUi() {
  const all = mode.value === 'all';
  motion.reveal($('min-views-row'), all);
  $('mode-hint').textContent = all
    ? '期間内のクリップをすべて取得します。件数が多いと時間がかかります'
    : '各月の再生数上位100件を取得します。高速に取得可能。';
}
$('fetch-min-views').addEventListener('change', () => { updateModeUi(); autoSearch(); });
for (const id of ['from', 'to']) $(id).addEventListener('change', () => autoSearch());

function applyPreset() {
  const p = preset.value;
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const set = (from, to) => { $('from').value = from ? toInput(from) : ''; $('to').value = to ? toInput(to) : ''; };
  if (p === '7d') set(new Date(today - 6 * DAY), today);
  else if (p === '30d') set(new Date(today - 29 * DAY), today);
  else if (p === 'this-year') set(new Date(now.getFullYear(), 0, 1), today);
  else if (p === 'last-year') set(new Date(now.getFullYear() - 1, 0, 1), new Date(now.getFullYear() - 1, 11, 31));
  else if (p === 'all') set(null, today);
  else if (!$('from').value) set(new Date(now.getFullYear(), now.getMonth(), 1), today);
  motion.slide($('date-range'), p === 'custom');
}

/** 入力から [start, end) を作る。終了日はその日の終わりまで含める。 */
function getRange(user) {
  const now = new Date();
  const start = $('from').value ? fromInput($('from').value) : new Date(user.created_at);
  let end = $('to').value ? new Date(fromInput($('to').value).getTime() + DAY) : now;
  if (end > now) end = now;
  return { start, end };
}

// ---------- 検索 ----------
/** 一度検索したあとは、期間や取得方法を変えただけで検索し直す */
function autoSearch() {
  if (state.searched && state.loggedIn && normalizeLogin($('channel').value)) search();
}

$('fetch-form').onsubmit = (ev) => { ev.preventDefault(); search(); };
$('cancel-btn').onclick = () => { state.controller?.abort(); };

/**
 * @param {{fromUrl?: boolean}} opts fromUrl: URL から復元した検索（履歴を増やさない）
 */
async function search({ fromUrl = false } = {}) {
  clearError();
  const login = normalizeLogin($('channel').value);
  if (!login) {
    showError('チャンネルIDを入力してください。');
    $('channel').focus();
    return;
  }
  $('channel').value = login;

  state.controller?.abort();                  // 前の検索が走っていれば止める
  const controller = new AbortController();
  state.controller = controller;
  const isCurrent = () => state.controller === controller;
  setBusy(true);
  setProgress(0, '準備しています…');
  const t0 = performance.now();
  try {
    const user = await loadChannel(login, controller.signal);
    if (!user) throw new Error(`チャンネルID「${login}」は見つかりませんでした。綴りを確認してください。`);

    const fetchMode = mode.value;
    const minViews = fetchMode === 'all' ? Number($('fetch-min-views').value) || 0 : 0;
    // 終了日時は毎回変わるので、キーには入力値を使う
    const key = [user.id, $('from').value || 'created', $('to').value || 'now', fetchMode, minViews].join('|');

    let result = state.cache.get(key);
    if (result && result.expiresAt < Date.now()) {
      state.cache.delete(key);
      result = null;
    }
    if (!result) { // IndexedDB
      const stored = await cacheGet(`clips|${key}`);
      if (stored) {
        result = reviveResult(stored);
        state.cache.set(key, result);
      }
    }
    const fromCache = !!result;
    const range = result?.range ?? getRange(user);
    if (range.start >= range.end) throw new Error('開始日が終了日より後になっています。日付を確認してください。');
    if (!result) {
      const onProgress = ({ done, total, clips }) => {
        if (isCurrent()) setProgress(done / total, `${done} / ${total} か月を取得　${fmtNum(clips)} 件`);
      };
      const opts = { broadcasterId: user.id, start: range.start, end: range.end, signal: controller.signal, onProgress };
      const fetched = fetchMode === 'top'
        ? await fetchTopClips(api, opts)
        : await fetchAllClips(api, { ...opts, minViews, maxClips: CONFIG.maxClips });
      const games = await api.getGames(fetched.clips.map((c) => c.game_id), { signal: controller.signal });
      // 今日を含む期間は短め
      const openEnded = Date.now() - range.end.getTime() < 60 * 1000;
      const ttl = openEnded ? CACHE_TTL_MS : PAST_CACHE_TTL_MS;
      result = {
        ...fetched, games, range,
        seconds: (performance.now() - t0) / 1000,
        expiresAt: Date.now() + ttl,
      };
      state.cache.set(key, result);
      cacheSet(`clips|${key}`, serializeResult(result), ttl);
    }
    if (!isCurrent()) return;

    state.query = { // URL に載せる検索条件
      login: user.login, preset: preset.value, from: $('from').value, to: $('to').value, mode: fetchMode, minViews,
    };
    const channelChanged = state.user?.id !== user.id;
    Object.assign(state, {
      searched: true, user, range, mode: fetchMode,
      clips: result.clips, games: result.games, selection: null,
    });
    if (channelChanged && !state.pending) resetFilters();
    $('status').hidden = true;
    showChannel(user);
    if (channelChanged) motion.channelIn();
    renderChannelMeta(result, minViews, fromCache);
    state.buckets = makeBuckets(range.start, range.end);
    renderGameOptions();
    applyPending();
    $('results').hidden = false;
    document.title = `${user.display_name || user.login} のクリップ | Clip Searcher`;
    applyFilters({ syncUrl: false });
    motion.growBars($('timeline-bars'));
    motion.countUp($('summary').querySelector('strong'), state.view.length, (n) => `${fmtNum(n)}件`);
    writeUrl({ push: !fromUrl });             // 検索条件が変わったので履歴を1つ増やす
    if (state.openClipId) {
      const clip = state.clips.find((c) => c.id === state.openClipId);
      if (clip) openPlayer(clip); else { state.openClipId = null; writeUrl(); }
    }
  } catch (e) {
    if (!isCurrent()) return;                 // 新しい検索に置き換わった
    state.pending = null;
    if (e.name === 'AbortError') {
      setProgress(0, '検索を中止しました。');
    } else {
      $('status').hidden = true;
      showError(e.message);
      if (e instanceof AuthError) { auth.clearToken(); refreshAuth(); }
    }
  } finally {
    if (isCurrent()) state.controller = null;
    if (!state.controller) setBusy(false);
  }
}

/** チャンネル情報（とチャットの色）を取得する。1日は保存したものを使う */
async function loadChannel(login, signal) {
  if (state.user?.login === login) return state.user;
  const key = `user|${login}`;
  const cached = await cacheGet(key);
  if (cached) return cached;
  const user = await api.getUserByLogin(login, { signal });
  if (!user) return null;
  user.chat_color = await api.getChatColor(user.id, { signal }).catch(() => null);
  cacheSet(key, user, USER_TTL_MS);
  return user;
}

// IndexedDB 保存用
function serializeResult(r) {
  return {
    clips: r.clips, games: [...r.games], truncated: r.truncated, seconds: r.seconds, expiresAt: r.expiresAt,
    range: { start: r.range.start.toISOString(), end: r.range.end.toISOString() },
  };
}
function reviveResult(r) {
  return {
    ...r, games: new Map(r.games),
    range: { start: new Date(r.range.start), end: new Date(r.range.end) },
  };
}

function setBusy(busy) {
  $('fetch-btn').disabled = busy || !state.loggedIn;
  $('fetch-btn').title = state.loggedIn ? '' : '先に Twitch でログインしてください';
  $('fetch-btn').hidden = busy;
  $('cancel-btn').hidden = !busy;
  $('status').classList.toggle('is-busy', busy);
  $('results').classList.toggle('is-loading', busy);
}

function setProgress(ratio, text) {
  $('status').hidden = false;
  $('progress-fill').style.transform = `scaleX(${Math.min(1, Math.max(0, ratio))})`;
  $('progress').textContent = text;
}

function renderChannelMeta(result, minViews, fromCache) {
  const { range } = state;
  const lastDay = new Date(range.end.getTime() - 1);
  const how = state.mode === 'top' ? '人気順' : (minViews ? `すべて（${fmtNum(minViews)}回以上）` : 'すべて');
  $('channel-meta').textContent =
    `${fmtDay(range.start)} 〜 ${fmtDay(lastDay)}　${how}　${fmtNum(result.clips.length)}件（${fromCache ? '保存済みの結果' : `${result.seconds.toFixed(1)}秒`}）`;
  if (result.truncated) {
    showError(`上限の ${fmtNum(CONFIG.maxClips)} 件に達したため、途中で取得を止めました。期間を狭めるか、取得する再生数の下限を上げてください。`);
  }
}

// ---------- タイムライン ----------
/** 期間を区切る。62日以内なら日ごと、それより長ければ月ごと。 */
function makeBuckets(start, end) {
  const daily = end - start <= 62 * DAY;
  const buckets = [];
  let s = daily
    ? new Date(start.getFullYear(), start.getMonth(), start.getDate())
    : new Date(start.getFullYear(), start.getMonth(), 1);
  while (s < end) {
    const e = daily
      ? new Date(s.getFullYear(), s.getMonth(), s.getDate() + 1)
      : new Date(s.getFullYear(), s.getMonth() + 1, 1);
    buckets.push({
      start: s, end: e, daily,
      label: daily ? `${s.getMonth() + 1}月${s.getDate()}日` : `${s.getFullYear()}年${s.getMonth() + 1}月`,
    });
    s = e;
  }
  return buckets;
}

function bucketIndexOf(clip) {
  const t = new Date(clip.created_at).getTime();
  const b = state.buckets;
  let lo = 0, hi = b.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (t < b[mid].start.getTime()) hi = mid - 1;
    else if (t >= b[mid].end.getTime()) lo = mid + 1;
    else return mid;
  }
  return -1;
}

function renderTimeline(clips) {
  const counts = new Array(state.buckets.length).fill(0);
  for (const c of clips) {
    const i = bucketIndexOf(c);
    if (i >= 0) counts[i]++;
  }
  const max = Math.max(1, ...counts);
  const n = state.buckets.length;
  const sel = state.selection;
  const every = n <= 16 ? 1 : n <= 40 ? 3 : 0;

  const bars = state.buckets.map((b, i) => {
    const s = b.start;
    const isMajor = b.daily ? s.getDate() === 1 : s.getMonth() === 0;
    let label = '';
    if (b.daily) {
      if (i === 0 || isMajor) label = `${s.getMonth() + 1}/${s.getDate()}`;
      else if (every && i % Math.max(1, Math.round(n / 8)) === 0) label = String(s.getDate());
    } else if (isMajor && i > 0) label = `${s.getFullYear()}年`;
    else if (i === 0) label = every ? `${s.getMonth() + 1}月` : `${s.getFullYear()}/${s.getMonth() + 1}`;
    else if (every && i % every === 0) label = `${s.getMonth() + 1}月`;

    const selected = sel != null && i >= sel.from && i <= sel.to;
    return el('button', {
      type: 'button',
      class: `bucket${isMajor && i > 0 ? ' is-major' : ''}`,
      'aria-pressed': String(selected),
      'aria-label': `${b.label} ${counts[i]}件`,
      disabled: counts[i] === 0 && !selected,
      onclick: (ev) => selectBucket(i, ev.shiftKey),
      onmouseenter: () => setReadout(i, counts[i]),
      onfocus: () => setReadout(i, counts[i]),
      onmouseleave: () => setReadout(),
      onblur: () => setReadout(),
    },
    el('span', { class: 'bucket-bar', style: `height:${counts[i] ? Math.max(3, (counts[i] / max) * 100) : 0}%` }),
    label ? el('span', { class: 'bucket-label' }, label) : null);
  });
  $('timeline-bars').replaceChildren(...bars);
  $('timeline').classList.toggle('has-selection', !!sel);
  motion.slide($('timeline-clear'), !!sel);
  state.counts = counts;
  setReadout();
}

const coarsePointer = window.matchMedia('(pointer: coarse)');

function setReadout(i, count, sel = state.selection) {
  if (drag?.moved && i != null) return;      // ドラッグ中は選んでいる範囲を出し続ける
  const out = $('timeline-readout');
  out.replaceChildren();
  if (i != null) {
    out.append(el('strong', {}, state.buckets[i].label), `　${fmtNum(count)}件`);
    return;
  }
  if (sel) {
    const a = state.buckets[sel.from].label;
    const b = state.buckets[sel.to].label;
    const n = state.counts ? state.counts.slice(sel.from, sel.to + 1).reduce((x, y) => x + y, 0) : null;
    out.append(el('strong', {}, sel.from === sel.to ? a : `${a} 〜 ${b}`), n != null ? `　${fmtNum(n)}件に絞り込み中` : ' に絞り込み中');
  } else {
    const unit = state.buckets[0]?.daily ? '日' : '月';
    if (coarsePointer.matches) {
      out.textContent = `${unit}ごとのクリップ数　タップでその${unit}だけ表示、横になぞると範囲指定`;
    } else {
      out.append(`${unit}ごとのクリップ数　クリックでその${unit}だけ表示、ドラッグか `, el('kbd', {}, 'Shift'), '+クリックで範囲指定');
    }
  }
}

/** ドラッグ中は見た目だけ変える */
function previewSelection(sel) {
  const buttons = $('timeline-bars').children;
  for (let i = 0; i < buttons.length; i++) {
    buttons[i].setAttribute('aria-pressed', String(sel != null && i >= sel.from && i <= sel.to));
  }
  $('timeline').classList.toggle('has-selection', !!sel);
  setReadout(undefined, undefined, sel);
}

// ---------- 期間バーのドラッグ ----------
const barsEl = $('timeline-bars');
let drag = null;
let suppressClick = false;

/** 画面上の x 座標 → 何本目の棒か（棒はすべて同じ幅） */
function bucketIndexAt(clientX) {
  const r = barsEl.getBoundingClientRect();
  const n = state.buckets.length;
  return Math.min(n - 1, Math.max(0, Math.floor(((clientX - r.left) / r.width) * n)));
}

barsEl.addEventListener('pointerdown', (ev) => {
  if (ev.button !== 0 || !state.buckets.length) return;
  suppressClick = false;
  drag = { anchor: bucketIndexAt(ev.clientX), x0: ev.clientX, id: ev.pointerId, moved: false, sel: null };
});
barsEl.addEventListener('pointermove', (ev) => {
  if (!drag || ev.pointerId !== drag.id) return;
  if (!drag.moved) {
    if (Math.abs(ev.clientX - drag.x0) < 8) return;   // 少し動いただけならタップ扱い
    drag.moved = true;
    barsEl.setPointerCapture(ev.pointerId);
    barsEl.classList.add('is-dragging');
  }
  const i = bucketIndexAt(ev.clientX);
  drag.sel = { from: Math.min(drag.anchor, i), to: Math.max(drag.anchor, i) };
  previewSelection(drag.sel);
});
function endDrag(ev, commit) {
  if (!drag || ev.pointerId !== drag.id) return;
  const { moved, sel } = drag;
  drag = null;
  barsEl.classList.remove('is-dragging');
  if (!moved) return;                        // タップ・クリックは各棒の click で処理する
  suppressClick = true;                      // ドラッグの後に来る click は無視する
  if (commit && sel) {
    state.selection = sel;
    applyFilters();
  } else {
    previewSelection(state.selection);
  }
}
barsEl.addEventListener('pointerup', (ev) => endDrag(ev, true));
barsEl.addEventListener('pointercancel', (ev) => endDrag(ev, false));   // 縦スクロールが始まった等
barsEl.addEventListener('click', (ev) => {
  if (suppressClick) { ev.stopPropagation(); ev.preventDefault(); suppressClick = false; }
}, true);

function selectBucket(i, extend) {
  const sel = state.selection;
  if (extend && sel) state.selection = { from: Math.min(sel.from, i), to: Math.max(sel.to, i) };
  else if (sel && sel.from === i && sel.to === i) state.selection = null;
  else state.selection = { from: i, to: i };
  applyFilters();
}
$('timeline-clear').onclick = () => { state.selection = null; applyFilters(); };

// ---------- 絞り込み・表示 ----------
const qField = radioGroup($('q-field'), () => {
  $('q').placeholder = qField.value === 'creator' ? '作成者で絞り込み' : 'タイトルで絞り込み';
  applyFilters();
  $('q').focus();
});
disclosure($('filter-toggle'), $('filter-panel'));

const sortSelect = $('sort');
for (const [key, { label }] of Object.entries(SORTS)) sortSelect.add(new Option(label, key));
for (const id of ['q', 'game', 'min-views', 'featured', 'sort']) $(id).addEventListener('input', applyFilters);

function resetFilters() {
  $('q').value = '';
  $('game').value = '';
  $('min-views').value = '0';
  $('featured').checked = false;
}
$('filter-reset').onclick = () => {
  const q = $('q').value;
  resetFilters();
  $('q').value = q;   // キーワードは詳細条件ではないので残す
  applyFilters();
};

function renderGameOptions() {
  const sel = $('game');
  const current = sel.value;
  sel.length = 1;
  for (const [id, n] of countByGame(state.clips)) {
    sel.add(new Option(`${state.games.get(id)?.name ?? (id ? '不明なカテゴリ' : 'カテゴリなし')}（${n}）`, id));
  }
  sel.value = [...sel.options].some((o) => o.value === current) ? current : '';
}

function applyFilters({ syncUrl = true } = {}) {
  if (syncUrl) queueMicrotask(() => writeUrl());   // 絞り込みの変更は履歴を増やさず URL だけ更新
  const minViews = Number($('min-views').value) || 0;
  const base = filterClips(state.clips, {
    text: $('q').value,
    textField: qField.value,
    gameId: $('game').value,
    minViews,
    featuredOnly: $('featured').checked,
  });
  renderTimeline(base);

  const active = [$('game').value, minViews > 0, $('featured').checked].filter(Boolean).length;
  const badge = $('filter-badge');
  const changed = badge.textContent !== String(active);
  badge.textContent = String(active);
  badge.hidden = active === 0;
  if (changed) motion.pop(badge);

  const sel = state.selection;
  const filtered = sel
    ? filterClips(base, { from: state.buckets[sel.from].start, to: state.buckets[sel.to].end })
    : base;
  state.view = sortClips(filtered, sortSelect.value);
  state.shown = 0;
  motion.resetCards();
  $('clip-list').replaceChildren();

  const summary = $('summary');
  summary.replaceChildren(el('strong', {}, `${fmtNum(state.view.length)}件`));
  if (state.view.length !== state.clips.length) summary.append(` / ${fmtNum(state.clips.length)}件`);
  if (state.mode === 'top') summary.append('　人気順で取得（各月の上位100件まで）');
  $('empty').hidden = state.view.length > 0;
  renderMore();
}

function renderMore() {
  const next = state.view.slice(state.shown, state.shown + PAGE_SIZE);
  const ranked = sortSelect.value === 'views_desc';
  const items = next.map((c, k) => clipItem(c, ranked ? state.shown + k + 1 : null));
  $('clip-list').append(...items);
  motion.cardsIn(items);
  state.shown += next.length;
  $('more-btn').hidden = state.shown >= state.view.length;
  $('more-btn').textContent = `さらに表示（残り ${fmtNum(state.view.length - state.shown)}件）`;
}
$('more-btn').onclick = renderMore;

function markTruncated(ev) {
  const a = ev.currentTarget;
  if (!a.classList.contains('is-truncated')) a.classList.toggle('is-truncated', a.scrollWidth > a.clientWidth);
}

function clipItem(c, rank) {
  const game = state.games.get(c.game_id)?.name;
  const thumb = el('button', {
    type: 'button', class: 'clip-thumb', 'aria-label': `再生: ${c.title || '無題のクリップ'}`,
    onclick: () => openPlayer(c),
  },
  el('img', { src: c.thumbnail_url, loading: 'lazy', alt: '' }),
  el('span', { class: 'clip-play', html: ICON.play }),
  c.is_featured ? el('span', { class: 'clip-featured' }, '注目') : null,
  rank != null && rank <= 999 ? el('span', { class: 'clip-rank', 'aria-hidden': 'true' }, `#${rank}`) : null,
  el('span', { class: 'clip-badge clip-views', html: ICON.eye }, fmtNum(c.view_count)),
  el('span', { class: 'clip-badge clip-duration' }, fmtDur(c.duration)));

  return el('li', { class: 'clip' },
    thumb,
    el('h3', { class: 'clip-title' },
      el('a', {
        href: c.url, target: '_blank', rel: 'noopener',
        // 省略されているときだけホバーで全文
        onmouseenter: markTruncated, onfocus: markTruncated,
      }, c.title || '(無題)')),
    el('p', { class: 'clip-sub' },
      el('span', { class: 'clip-date' }, fmtDay(new Date(c.created_at))),
      el('span', { class: 'clip-creator', html: ICON.user, title: `作成者 ${c.creator_name}` }, el('span', {}, c.creator_name))),
    el('span', { class: `clip-game${game ? '' : ' is-none'}`, title: game ?? '' }, game ?? 'カテゴリなし'));
}

// ---------- プレイヤー ----------
const player = $('player');
function openPlayer(c) {
  const url = new URL(c.embed_url);
  url.searchParams.set('parent', location.hostname);
  url.searchParams.set('autoplay', 'true');
  $('player-frame').src = url;
  $('player-title').textContent = c.title || '(無題)';
  const game = state.games.get(c.game_id)?.name;
  $('player-meta').replaceChildren(...[
    `${fmtNum(c.view_count)}回再生`, fmtDateTime(c.created_at), fmtDur(c.duration), `作成者 ${c.creator_name}`, game,
  ].filter(Boolean).map((t) => el('span', {}, t)));
  $('player-link').href = c.url;
  if (!player.open) { player.showModal(); motion.dialogIn(player); }
  state.openClipId = c.id;
  writeUrl();
}
// close イベントは遅れることがあるので、ここでも後片付けする
function closePlayer() {
  if (player.open) motion.dialogOut(player, () => player.close());
  onPlayerClosed();
}
function onPlayerClosed() {
  if (state.openClipId == null && $('player-frame').src === 'about:blank') return;
  $('player-frame').src = 'about:blank';
  state.openClipId = null;
  writeUrl();
}
$('player-close').onclick = closePlayer;
player.addEventListener('click', (ev) => { if (ev.target === player) closePlayer(); });
player.addEventListener('cancel', (ev) => { ev.preventDefault(); closePlayer(); });
player.addEventListener('close', onPlayerClosed);   // Esc で閉じたとき

// ---------- URL と画面の状態 ----------
// 例: ?c=rio_shinohana&p=custom&from=2026-01-01&to=2026-03-31&m=all&mv=100&q=歌&qf=creator&g=509658&v=500&f=1&s=date_desc&t=2026-02&clip=Abc
const bucketId = (b) => (b.daily ? toInput(b.start) : toInput(b.start).slice(0, 7));

/** 今の状態を URL に書く。push=true なら履歴を1つ増やす（検索条件が変わったとき） */
function writeUrl({ push = false } = {}) {
  if (state.controller && !push) return;     // 検索中は結果が出てから書く
  const p = new URLSearchParams();
  const q = state.query;
  if (state.searched && q) {
    p.set('c', q.login);
    if (q.preset !== DEFAULTS.preset) p.set('p', q.preset);
    if (q.preset === 'custom') {
      if (q.from) p.set('from', q.from);
      if (q.to) p.set('to', q.to);
    }
    if (q.mode !== DEFAULTS.mode) p.set('m', q.mode);
    if (q.mode === 'all' && q.minViews) p.set('mv', q.minViews);

    if ($('q').value) p.set('q', $('q').value);
    if (qField.value !== DEFAULTS.qField) p.set('qf', qField.value);
    if ($('game').value) p.set('g', $('game').value);
    if (Number($('min-views').value) > 0) p.set('v', $('min-views').value);
    if ($('featured').checked) p.set('f', '1');
    if (sortSelect.value !== DEFAULTS.sort) p.set('s', sortSelect.value);
    const sel = state.selection;
    if (sel) {
      const a = bucketId(state.buckets[sel.from]);
      const b = bucketId(state.buckets[sel.to]);
      p.set('t', a === b ? a : `${a}_${b}`);
    }
    if (state.openClipId) p.set('clip', state.openClipId);
  }
  const search = p.toString();
  const url = `${location.pathname}${search ? `?${search}` : ''}`;
  if (url === location.pathname + location.search) return;
  history[push ? 'pushState' : 'replaceState'](null, '', url);
}

/** URL を読んで入力欄に反映する。検索が必要なら true */
function readUrl() {
  const p = new URLSearchParams(location.search);
  const login = normalizeLogin(p.get('c') ?? '');
  $('channel').value = login;

  const presetValue = p.get('p');
  preset.value = ['7d', '30d', 'this-year', 'last-year', 'all', 'custom'].includes(presetValue) ? presetValue : DEFAULTS.preset;
  applyPreset();
  if (preset.value === 'custom') {
    const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v ?? '');
    if (isDate(p.get('from'))) $('from').value = p.get('from');
    if (isDate(p.get('to'))) $('to').value = p.get('to');
  }
  mode.value = p.get('m') === 'all' ? 'all' : DEFAULTS.mode;
  $('fetch-min-views').value = String(Math.max(0, Number(p.get('mv')) || 0));
  updateModeUi();

  // 絞り込みは検索結果が出てから当てはめる（カテゴリや期間バーは結果しだいのため）
  state.pending = {
    q: p.get('q') ?? '',
    qField: p.get('qf') === 'creator' ? 'creator' : DEFAULTS.qField,
    game: p.get('g') ?? '',
    minViews: Math.max(0, Number(p.get('v')) || 0),
    featured: p.get('f') === '1',
    sort: SORTS[p.get('s')] ? p.get('s') : DEFAULTS.sort,
    t: p.get('t') ?? '',
  };
  state.openClipId = p.get('clip');
  return !!login;
}

/** URL から読んだ絞り込みを当てはめる */
function applyPending() {
  const pd = state.pending;
  if (!pd) return;
  state.pending = null;
  $('q').value = pd.q;
  qField.value = pd.qField;
  $('q').placeholder = pd.qField === 'creator' ? '作成者で絞り込み' : 'タイトルで絞り込み';
  $('game').value = [...$('game').options].some((o) => o.value === pd.game) ? pd.game : '';
  $('min-views').value = String(pd.minViews);
  $('featured').checked = pd.featured;
  sortSelect.value = pd.sort;
  const [a, b = a] = pd.t.split('_');
  const from = state.buckets.findIndex((x) => bucketId(x) === a);
  const to = state.buckets.findIndex((x) => bucketId(x) === b);
  state.selection = from >= 0 && to >= 0 ? { from: Math.min(from, to), to: Math.max(from, to) } : null;
}

/** 何も検索していないトップの状態に戻す */
function showTop() {
  state.controller?.abort();
  Object.assign(state, { searched: false, query: null, user: null, clips: [], selection: null, openClipId: null, pending: null });
  $('channel').value = '';
  $('results').hidden = true;
  $('status').hidden = true;
  clearError();
  closePlayer();
  document.title = 'Clip Searcher';
  applyChannelTheme(null);
  showIntro();
}

// ブラウザの戻る・進む
window.addEventListener('popstate', () => {
  if (readUrl()) {
    if (state.loggedIn) search({ fromUrl: true });
    if (player.open && !state.openClipId) closePlayer();
  } else {
    showTop();
  }
});

// ロゴでトップに戻る
document.querySelector('.brand').addEventListener('click', (ev) => {
  if (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.button !== 0) return;   // 新しいタブで開く操作はそのまま
  ev.preventDefault();
  if (location.search) history.pushState(null, '', location.pathname);
  showTop();
  window.scrollTo({ top: 0 });
});

// ---------- ツールバーの固定表示 ----------
const toolbar = document.querySelector('.toolbar-wrap');
window.addEventListener('scroll', () => {
  toolbar.classList.toggle('is-stuck', !$('results').hidden && toolbar.getBoundingClientRect().top <= 0);
}, { passive: true });

// ---------- エラー表示 ----------
function showError(msg) {
  $('error').textContent = msg;
  $('error').hidden = false;
}
function clearError() { $('error').hidden = true; }

// ---------- 起動 ----------
async function boot() {
  // ログインから戻ってきたら、ログイン前の URL（検索条件）に戻す
  const redirect = auth.handleRedirect();
  if (redirect) {
    let saved = null;
    try { saved = sessionStorage.getItem(RETURN_KEY); sessionStorage.removeItem(RETURN_KEY); } catch { /* ignore */ }
    if (saved) history.replaceState(null, '', location.pathname + saved);
    if (redirect.error) showError(`ログインに失敗しました: ${redirect.error}`);
  }

  qField.value = DEFAULTS.qField;
  const hasChannel = readUrl();
  showIntro();
  motion.intro();
  await refreshAuth();
  if (hasChannel && state.loggedIn) search({ fromUrl: true });
}
boot();
