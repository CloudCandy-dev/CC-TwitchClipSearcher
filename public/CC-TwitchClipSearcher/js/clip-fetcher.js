// クリップの取得
// Get Clips は1つの期間をページングし続けると約1000件で止まるので、
// 月ごとに数ページ取り、まだ残っていれば期間を分割して取り直す。

/** [start, end) をローカル時刻の月境界で分割する */
export function splitByMonth(start, end) {
  const ranges = [];
  let s = new Date(start);
  while (s < end) {
    const next = new Date(s.getFullYear(), s.getMonth() + 1, 1);
    const e = next < end ? next : new Date(end);
    ranges.push([s, e]);
    s = e;
  }
  return ranges;
}

const byViewsDesc = (a, b) => b.view_count - a.view_count || b.created_at.localeCompare(a.created_at);

/** 人気順：各月の上位N件だけ取る */
export async function fetchTopClips(api, { broadcasterId, start, end, perMonth = 100, signal, onProgress }) {
  const months = splitByMonth(start, end);
  const clips = new Map();
  let done = 0;
  await Promise.all(months.map(async ([s, e]) => {
    const { data } = await api.getClipsPage(
      { broadcasterId, startedAt: s, endedAt: e, first: perMonth }, { signal });
    for (const c of data) clips.set(c.id, c);
    done++;
    onProgress?.({ done, total: months.length, clips: clips.size });
  }));
  return { clips: [...clips.values()].sort(byViewsDesc), truncated: false };
}

/** すべて：期間内のクリップを全件（minViews 指定時はそれ以上だけ）取る */
export async function fetchAllClips(api, {
  broadcasterId, start, end,
  minViews = 0,
  maxClips = 20000,
  minSpanMs = 10 * 60 * 1000,
  splitFactor = 4,
  pagesBeforeSplit = 3,
  signal, onProgress,
}) {
  const months = splitByMonth(start, end);
  const clips = new Map();
  let truncated = false;
  let done = 0;

  const add = (data) => {
    for (const c of data) {
      if (c.view_count < minViews) continue;
      if (clips.size >= maxClips) { truncated = true; return; }
      clips.set(c.id, c);
    }
  };
  // 再生数順なので、最後が minViews 未満なら残りは不要
  const reachedFloor = (data) => minViews > 0 && data.length > 0 && data[data.length - 1].view_count < minViews;

  // 狭い期間では出てこないクリップがあるので、分割する前に数ページ取る
  async function fetchRange(s, e) {
    const canSplit = e - s > minSpanMs;
    let cursor;
    for (let i = 0; !truncated && (!canSplit || i < pagesBeforeSplit); i++) {
      const page = await api.getClipsPage({ broadcasterId, startedAt: s, endedAt: e, after: cursor }, { signal });
      add(page.data);
      cursor = page.cursor;
      if (!cursor || page.data.length === 0 || reachedFloor(page.data)) return;
    }
    if (truncated) return;

    const span = e - s;
    const step = Math.max(Math.floor(span / splitFactor / 1000) * 1000, 1000);
    const parts = [];
    for (let t = s.getTime(); t < e.getTime(); t += step) {
      parts.push([new Date(t), new Date(Math.min(t + step, e.getTime()))]);
    }
    await Promise.all(parts.map(([a, b]) => fetchRange(a, b)));
  }

  await Promise.all(months.map(async ([s, e]) => {
    await fetchRange(s, e);
    done++;
    onProgress?.({ done, total: months.length, clips: clips.size });
  }));

  return { clips: [...clips.values()].sort(byViewsDesc), truncated };
}
