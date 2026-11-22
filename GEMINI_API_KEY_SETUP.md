# Gemini API キー取得・設定チュートリアル

このアプリのレシート解析は Gemini API（`gemini-2.5-flash`）を使います。キーの取得からアプリへの設定までを説明します。

## 0. まず全体像

| モード | キーの置き場所 | 向いている人 |
|---|---|---|
| **BYOK（自分のキー）** | ブラウザの `localStorage`（この端末だけ） | まず試したい・自分の枠を使いたい |
| **共有キー** | Cloudflare Pages の Secret（サーバー側） | 運用者が用意し、利用者はキー入力なしで使いたい |

公開サイト（https://receipt-expiry-pwa.pages.dev ）では現時点で**共有キーを設定していない**ため、まずは BYOK で試すのが確実です。

---

## 1. Google AI Studio でキーを取得する

### 手順

1. Google アカウントを用意します（Gmail アカウントで可）。
2. https://aistudio.google.com/apikey を開き、サインインします。
3. 初回利用時に利用規約の同意を求められます。内容を確認して同意してください。
   - 新規ユーザーの場合、AI Studio が **デフォルトの Google Cloud プロジェクト** と API キーを自動作成することがあります。
4. 左メニューの **API Keys（API キー）** を開きます。
5. **「Create API key」/「API キーを作成」** をクリックします。
6. 既存の Google Cloud プロジェクトを使う場合は、先に **Dashboard → Projects → Import projects** でプロジェクトを取り込んでから、そのプロジェクトを選択します。
7. 生成されたキー（`AIza...` で始まる文字列）をコピーします。
   - API Keys ページからいつでも再確認できます。
   - 使用量は https://aistudio.google.com/usage で確認できます。

### 2026 年時点の注意点

- 2026-05-28 以降に新規作成されるキーは **Authorization key（認証キー）** がデフォルトです。サービスアカウントに紐づき、Gemini API にのみ使えるため、このアプリでもそのまま利用できます。
- **Unrestricted の古い標準キーは Gemini API 側で拒否されます**。API Keys ページで `Unrestricted` と表示されている古いキーは、**Add restrictions → Restrict to Gemini API only** を選んで制限を追加してください。
- 無料枠（free tier）を使うにはプロジェクトの確認（verification）が必要な場合があります。設定画面で求められたら指示に従うか、Google Cloud で課金を有効にしてください。

### 「キーを作成できない」場合

`You do not have permission to create a key in this project` と表示される場合は、その Google Cloud プロジェクトにキー作成権限がありません。

- 管理者に `apikeys.keys.create` などの権限を付与してもらう
- または、組織に属さない新しい Google Cloud プロジェクトを作ってそこでキーを作成する

---

## 2. BYOK としてアプリに設定する（推奨）

1. https://receipt-expiry-pwa.pages.dev を開きます。
2. 右上の **⚙（設定）** をタップします。
3. **「自分のGemini APIキーを使う（BYOK）」** の入力欄に、手順 1 でコピーしたキーを貼り付けます。
4. **「保存」** を押します。`この端末にAPIキーが保存されています` と表示されれば完了です。
5. レシートを撮影すると、以降の解析でこのキーが自動的に使われます。

- キーはこの端末の `localStorage` にのみ保存され、アプリのサーバーには保存されません。
- 別の端末では再度設定が必要です。
- 削除したい場合は同じ画面の「削除」を押してください。

---

## 3. 共有キーとして設定する（運用者向け）

全ユーザーがキー入力なしで解析できるようにする場合です。**公開アプリで使うキーなので、課金・利用量に注意してください。**

### Cloudflare Pages に Secret を設定

```bash
cd receipt-expiry-pwa
npx wrangler@4 pages secret put GEMINI_API_KEY --project-name=receipt-expiry-pwa
# プロンプトにキーを貼り付けて Enter
```

設定後、再デプロイしなくても新しいデプロイから Secret が参照されます。

### GitHub Actions から自動デプロイする場合

Repository secrets を設定します（Settings → Secrets and variables → Actions）:

```bash
gh secret set CLOUDFLARE_API_TOKEN -R neoenox/receipt-expiry-webapp
gh secret set CLOUDFLARE_ACCOUNT_ID -R neoenox/receipt-expiry-webapp
# 共有キーも CI から同期したい場合のみ
gh secret set GEMINI_API_KEY -R neoenox/receipt-expiry-webapp
```

`GEMINI_API_KEY` を設定すると、main への push 時に CI が Pages の Secret も更新します。

### 制限の付け方

- キーは **Gemini API のみ**に制限してください（AI Studio の API Keys ページで設定できます）。
- このアプリは Cloudflare のサーバーから Gemini を呼び出すため、**IP 制限や HTTP リファラー制限は付けないでください**。Cloudflare の送信元 IP は変わるため、正規のリクエストまで拒否されます。

---

## 4. セキュリティ

- API キーは **パスワードと同じ**です。GitHub やチャット、スクリーンショットに貼らないでください。
- 誤って公開した場合は、AI Studio の API Keys ページでキーを削除（無効化）し、新しいキーを作成してください。
- アプリ側はキーを URL クエリに載せず、`x-goog-api-key` ヘッダで送信します。
- BYOK のキーが漏れても、このアプリのサーバーには保存されません。ただし端末の localStorage は他のスクリプトから読めるため、信頼できない端末では共有キーを使い、BYOK キーは保存しないでください。

---

## 5. トラブルシューティング

| メッセージ / 症状 | 原因と対処 |
|---|---|
| `Gemini APIキーが無効です` | コピー漏れ、キーの削除、制限設定のミス。AI Studio でキー状態を確認 |
| `AIの利用上限に達しました`（429） | 無料枠の quota 超過。https://aistudio.google.com/usage で確認し、時間をおくか BYOK に切り替える |
| `指定されたGeminiモデルが利用できません` | キーの権限／モデルの提供状況を確認。アプリは `gemini-2.5-flash` を使用 |
| `解析用のAPIキーが未設定です` | 共有キー未設定かつ BYOK 未登録。設定画面でキーを登録してください |
| `You do not have permission to create a key` | Google Cloud プロジェクトの権限不足。権限を付与されるか新規プロジェクトを作成 |
| Unrestricted の古いキーが動かない | AI Studio で **Restrict to Gemini API only** を設定するか、新しいキーを作成する |

---

## 参考リンク

- Google AI Studio（キー管理）: https://aistudio.google.com/apikey
- API キーの公式ドキュメント: https://ai.google.dev/gemini-api/docs/api-key
- 使用量: https://aistudio.google.com/usage
