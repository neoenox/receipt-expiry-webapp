# receipt-expiry-webapp

レシート画像から食材と賞味期限を抽出し、在庫を管理する PWA。仕様は `01_要件定義書_機能仕様書.md`〜`03_プログラム設計書_詳細設計書.md`。

## 構成

- `public/` — PWA の静的ファイル（HTML/CSS/JS、Service Worker、アイコン）
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

`main` は PR 経由のマージのみ、`ci` チェック成功が必須、force push と削除は禁止です。
