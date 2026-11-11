// 設定
export const CONFIG = {
  clientId: '1uyy3l71x9g7o34oq8fkem89tha79c',
  // Twitch Developer Console の OAuth Redirect URLs に登録する
  // このページのあるディレクトリ（例: https://cloud-candy.cc/CC-TwitchClipSearcher/）。
  // ルート直下（ローカルの http://localhost:8000）は末尾の / なし。
  redirectUri: (() => {
    const dir = new URL('./', window.location.href);
    return dir.pathname === '/' ? dir.origin : dir.href;
  })(),
  // 同時リクエスト数
  concurrency: 6,
  // 全件取得の上限
  maxClips: 20000,
};
