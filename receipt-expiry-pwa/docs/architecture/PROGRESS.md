# アーキテクチャ・エントロピー低減 — 進捗

## 作業拠点

- Worktree: `C:/vibe/receipt-expiry-architecture`
- Branch: `architecture/entropy-reduction`
- Base: `origin/main` @ `4c3781a`（PR #76 マージ済み）
- 作業ルール: `receipt-expiry-pwa/AGENTS.md`

## 不変条件

1. 外部契約（API リクエスト/レスポンス、IndexedDB v6、バックアップ v3、VAPID、レート制限）を維持する。
2. 各バッチは「移行 → 旧実装削除 → 検証 → 回帰制約」まで完了させる。追加だけのバッチは作らない。
3. 動作確認は unit + E2E の両方。CSS/DOM 変更は `AGENTS.md` に従い実画面でも確認する。
4. 判断を保留する事项は `TASK_POOL.md` に `blocked` として記録し、他の独立タスクを進める。

## ベースライン

| 検査 | 結果 | 日付 |
|---|---|---|
| `npm ci` | 成功 | 2026-11-28 |
| `npm test` | 57 pass / 0 fail | 2026-11-28 |
| `npm run test:e2e` | 46 pass / 0 fail | 2026-11-28 |

## Round 0 — 全体スキャン

状態: 完了。4スキャン（FrontendMap / ServerMap / DuplicationAudit / TestToolAudit）の結果を `ARCHITECTURE.md` と `TASK_POOL.md` に反映。

主要検出: `jstDate` / `shouldSendAtHour` の二重実装と挙動不一致、保存場所・理由・日付パターン・上限値の多重定義、通知 Worker の同名二重設定、未配線の re-export、レイヤー逆転（`functions` → `public/js`）、アーキテクチャ規範の未強制。

成果物:

- `ARCHITECTURE.md` — アーキテクチャマップ、依存、状態所有権、重複一覧
- `ADR.md` — 意思決定記録
- `TASK_POOL.md` — 優先付けされた改善タスク

## 完了したラウンド

| Round | 内容 | コミット | 検証 |
|---|---|---|---|
| 1 | 通知時刻判定の単一化とレイヤー逆転の解消 | `e6c98a0` | unit 58 pass / E2E 45 pass + 既知 flake 1 / 独立レビュー済み |
| 2 | レート制限ポリシーの単一化 | `cd4c62d` | unit 61 pass / E2E 45 pass + 既知 flake 1 / Wrangler dry-run / 独立レビュー済み |
| 3 | アーキテクチャ規範の CI 強制 | `e71daec` | unit 64 pass / E2E 45 pass + 既知 flake 1 / 違反検出の実証 / 独立レビュー済み |
| 4 | 未配線の通知 Worker 削除と仕様同期 | `8bd9775` | unit 64 pass / E2E 45 pass + 既知 flake 1 / 独立レビュー済み |
| 5 | 通知設定の購読状態 split（既知 flake 解消） | 同コミット | unit 64 pass / E2E 46 pass / 通知関連4テスト / 実画面確認 / 独立レビュー2回 |

## 既知の flakes

- Round 1〜4 で観測された `notify status warns when getSubscription returns null after enabling` は Round 5 で解消。変更前ベースラインでも再現していたが、設定再オープン時のローカル購読再検証と 410 状態の分離により全 E2E が 46/46 通過した。
