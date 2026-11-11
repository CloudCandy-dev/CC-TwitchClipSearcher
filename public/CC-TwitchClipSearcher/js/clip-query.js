// 絞り込み・並べ替え

/**
 * @param {object[]} clips
 * @param {{text?: string, textField?: 'title'|'creator', gameId?: string, minViews?: number, featuredOnly?: boolean, from?: Date, to?: Date}} f
 *   textField 省略時はタイトルと作成者の両方
 */
export function filterClips(clips, f = {}) {
  const words = (f.text ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  return clips.filter((c) => {
    if (f.gameId && c.game_id !== f.gameId) return false;
    if (f.minViews && c.view_count < f.minViews) return false;
    if (f.featuredOnly && !c.is_featured) return false;
    if (f.from || f.to) {
      const t = new Date(c.created_at);
      if (f.from && t < f.from) return false;
      if (f.to && t >= f.to) return false;
    }
    if (words.length) {
      const hay = (f.textField === 'title' ? c.title
        : f.textField === 'creator' ? c.creator_name
          : `${c.title} ${c.creator_name}`).toLowerCase();
      if (!words.every((w) => hay.includes(w))) return false;
    }
    return true;
  });
}

export const SORTS = {
  views_desc: { label: '再生数が多い順', fn: (a, b) => b.view_count - a.view_count },
  views_asc: { label: '再生数が少ない順', fn: (a, b) => a.view_count - b.view_count },
  date_desc: { label: '新しい順', fn: (a, b) => b.created_at.localeCompare(a.created_at) },
  date_asc: { label: '古い順', fn: (a, b) => a.created_at.localeCompare(b.created_at) },
  duration_desc: { label: '長い順', fn: (a, b) => b.duration - a.duration },
};

export function sortClips(clips, key = 'views_desc') {
  return [...clips].sort((SORTS[key] ?? SORTS.views_desc).fn);
}

/** ゲームごとの件数（多い順） */
export function countByGame(clips) {
  const m = new Map();
  for (const c of clips) m.set(c.game_id, (m.get(c.game_id) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}
