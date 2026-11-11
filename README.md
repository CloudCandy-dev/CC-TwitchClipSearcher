# Twitch Clip Searcher

Twitch のクリップを期間を指定して探せるブラウザアプリです。サーバーは不要で、静的ファイルだけで動きます。

## 使い方

1. [CC-TwitchClipSearcher](https://cloud-candy.cc/CC-TwitchClipSearcher) にアクセス
2. 「Twitchでログイン」からログイン
3. 検索したい配信者のIDを入力し検索

## 機能

- チャンネルと期間（7日 / 30日 / 今年 / 昨年 / 全期間 / 日付指定）でクリップを検索
- 人気順（各月の上位100件）とすべての取得を切り替え
- タイトル・作成者・カテゴリ・再生数で絞り込み、並べ替え
- 月別・日別のクリップ数グラフから期間を絞り込み
- ページ内でクリップを再生
- ライト / ダーク対応、配信者のチャットの色に合わせた配色


## ファイル構成

| ファイル | 内容 |
|---|---|
| `js/config.js` | 設定 |
| `js/auth.js` | Twitch ログイン |
| `js/twitch-api.js` | Twitch API |
| `js/clip-fetcher.js` | クリップの取得 |
| `js/clip-query.js` | 絞り込み・並べ替え |
| `js/result-cache.js` | 検索結果のキャッシュ |
| `js/channel-theme.js` | 配信者の色の反映 |
| `js/motion.js` | アニメーション（GSAP） |
| `js/app.js` | 画面 |

## クリップの取得について

Get Clips API は期間内のクリップを再生数順に返しますが、1つの期間をページングし続けると約1000件で止まります。そのため月ごとに数ページずつ取得し、まだ残っている場合は期間を分割して取得しています。
