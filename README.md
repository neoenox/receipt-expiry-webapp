# receipt-expiry-webapp

レシート画像から食材と賞味期限を抽出し、在庫を管理する PWA。仕様は `01_要件定義書_機能仕様書.md`〜`03_プログラム設計書_詳細設計書.md`。

## 構成

- `public/` — PWA の静的ファイル（HTML/CSS/JS、Service Worker、アイコン）。`js/backup.js` が在庫の JSON バックアップを処理
- `functions/api/analyze.js` — Cloudflare Pages Functions。Gemini API へのプロキシと応答検証
- `oci/` — OCI VM 上で動かす Node サーバーと Nginx の設定
- `deploy-cloudflare.sh` — Cloudflare Pages への Direct Upload スクリプト

## ローカル実行

```bash
cd receipt-expiry-pwa
PORT=8099 node oci/server.js
# http://localhost:8099/
```

Gemini API キーは設定画面から各自で登録できます。共有キーを使う場合は `GEMINI_API_KEY` を環境変数に設定してください。

## Cloudflare Pages へのデプロイ

```bash
cd receipt-expiry-pwa
npx wrangler@4 login
./deploy-cloudflare.sh
```

公開 URL: https://receipt-expiry-pwa.pages.dev

## CI

`.github/workflows/ci.yml` が PR と main push で JavaScript 構文・自動テスト（`node --test tests/*.js`）・JSON・Shell 構文・Pages Functions のビルドを検証します。main への push では、以下の Repository secrets が揃っていれば Cloudflare Pages へ自動デプロイします。

- `CLOUDFLARE_API_TOKEN` — Pages:Edit / Account:Read 権限の API トークン
- `CLOUDFLARE_ACCOUNT_ID` — Cloudflare アカウント ID
- `GEMINI_API_KEY` — 任意。設定すると共有キーを Pages の Secret に同期します

## レート制限

Cloudflare では `wrangler.toml` の `RATE_LIMIT_KV` バインディング（KV namespace: `receipt-expiry-rate-limit`）で全拠点共通の利用回数を管理します。共有キー利用時のみ1分5回・1日20回を超過すると `429` を返します。KV が使えない OCI / ローカル実行ではプロセス内カウンタにフォールバックします。


## ブランチ保護

`main` は PR 経由のマージのみ、`ci` チェック成功が必須、force push と削除は禁止です。GitHub では PR 作成者が自分の PR を承認できないため、承認要件は 0 件（作成者が `ci` 通過後に自分でマージ可能）です。


## 追加機能

- **オフライン解析キュー:** オフラインで撮影したレシートを端末に保存し、接続復帰後に自動解析（APIキーは保存しない）
- **消費・廃棄履歴:** 削除時に「食べた / 捨てた」を記録し、今月の件数を設定画面で表示
- **賞味期限の学習:** 編集した期限を食材名ごとに端末内へ保存し、次回の確認画面の初期値に反映（AIへは送らない）
- **期限通知:** 設定で有効にすると、最も近い賞味期限の日付だけをサーバーへ登録し、Cron Worker が Web Push を送信（食材名・数量は送信しない）
- **JSONバックアップ:** 設定画面から在庫をエクスポート/インポート

通知の仕組み: `notify-worker/` に Cron Worker（`web-push`、秘密鍵は Cloudflare Secret）、Pages Functions に `/api/push/*`、KV バインディングは `PUSH_KV` です。


最新の追加対応:

- バックアップ v2: 在庫に加えて消費履歴と学習した賞味期限も JSON に含め、復元時は ID / 食材名でマージ
- 在庫の検索（食材名・メモ）と並び替え（期限 / 名前 / 登録日 / 保存場所）
- CI が Pages と通知 Worker の両方をデプロイし、Playwright の E2E テストも実行
- テスト: `node --test tests/*.js` と `npm run test:e2e`


さらに:

- BYOK キーは保存前に `/api/validate-key` で Gemini へ検証し、無効キーを保存しない
- オフラインキューは設定画面で個別再試行・削除が可能（最大3回）
- 共有キーのレート制限は Durable Object で厳密にカウント（KV はフォールバック）
- E2E にオフラインキューを追加、ダークモード（`prefers-color-scheme`）に対応
- CI が `ratelimit-worker` もデプロイ




仕上げ:

- バックアップ復元時に「既存データを削除して置き換える」を選択可能
- 画像は WebP を優先し、サイズに応じて品質 0.9→0.8→0.7 に自動調整（非対応ブラウザは JPEG）
- 通知本文に「最も近い賞味期限まであとN日」を含める（食材名は送信しない）
- `app.js` から設定・キュー UI を `settings.js` / `queueUI.js` へ分離
- E2E は BYOK 検証・ダークモード・通知オプトインも検証（計5ケース）

- 設定画面は「基本 / 通知・キュー / データ・AI」の3タブに整理し、詳細オプションはアコーディオンに格納
- テーマは自動 / ライト / ダークを設定画面で選択可能。色はセマンティック変数に集約し、主要テキストのコントラスト比を E2E で検証
