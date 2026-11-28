# Architecture Decision Records

## ADR-000 — 隔離 worktree で段階的に収束させる

- Context: 本番運用中の PWA に対して、広範な構造改善を安全に進める必要がある。
- Decision: `origin/main` から `architecture/entropy-reduction` ブランチを作成し、別 worktree で作業する。各改善は独立コミットにし、PR と CI を通してから main に戻す。
- Consequences: 他ブランチの変更と併行可能。マージ時の競合は小さくなるが、ベースの追従と統合確認が必要。

## ADR-001 — 外部契約は不変として扱う

- Context: `/api/analyze`、`/api/push/*`、IndexedDB v6、バックアップ v3、通知ペイロード、レート制限はクライアントと複数ランタイム（Cloudflare / OCI / ローカル）にまたがる契約。
- Decision: 内部実装を変更してもExternal契約と永続データ形式は維持する。変更が必要な場合は破壊的移行として `TASK_POOL.md` に `blocked` 記録し、ユーザー確認を待つ。
- Consequences: 移行の安全性は担保されるが、正規化だけでは解消できない契約上の重複（例: ランタイムごとのレート制限実装）は残る。

## ADR-002 — 削除を伴わない抽象化は採用しない

- Context: 過去に付加された薄いラッパーや互換 re-export が理解コストを増大させる。
- Decision: 新しい共通実装を導入したら、全呼び出し元を移行し、旧定義を削除するまでを1バッチとする。
- Consequences: 一時的な併存期間はコミット内に限定される。移行漏れは CI の静的検査またはテストで検出する。

## ADR-003 — 通知時刻判定は `functions/shared/schedule.js` が権威

- Context: `jstDate` / `shouldSendAtHour` が `features2.js` と `functions/shared/schedule.js` に重複し、設定時刻ちょうどの再実行で片方だけ二重送信を許す挙動不一致があった。本番 `reminder.js` は片方、`subscribe.js` はもう片方を参照し、テストはクライアント側だけを検証していた。
- Decision: `functions/shared/schedule.js` を唯一の実装とし、同一 JST 日かつ同一設定時刻の再実行を抑止するガードを採用する。`subscribe.js` の `public/js` 直接 import を廃止し、テストは本番共有モジュールを import する。
- Consequences: サーバー/クライアント/テストの挙動が一致する。通知本文・購読契約は不変。旧 `features2.js` の export は移行後に削除した。

## ADR-004 — レート制限ポリシーは `functions/shared/limits.js` が権威

- Context: 解析ハンドラと Durable Object が同じ 5/20/30/200 を別定義し、購読・キー検証・クライアントにも同一趣旨の定数/関数が分散していた。境界変更時に片方だけ更新されるリスクがあった。
- Decision: ポリシー値と上限判定を `functions/shared/limits.js` に集約し、すべてのサーバー実装が参照する。テスト専用だったクライアント側の重複関数は削除し、Durable Object が同じポリシーを使う契約テストを追加する。
- Consequences: Wrangler ビルドは外側モジュールをバンドルするため DO プロジェクトからも参照可能。BYOK と共有キーの差、429 の境界、購読/キー検証の上限は不変。共有キーのみ制限という仕様記述との差は B-001 として保留。

## ADR-005 — アーキテクチャ規範は依存追加なしの静的テストで強制する

- Context: Round 1/2 で解消したレイヤー逆転と二重定義が、将来の開発で再導入されることを防ぐ必要がある。lint/format 基盤はまだ存在しない。
- Decision: `tests/architecture.test.js` にファイルスキャン-based の不変条件を書き、`npm test`（CI の `npm run test`）に載せる。新しい依存は追加しない。
- Consequences: 規範変更はテストと同じ PR でレビューできる。正規表現ベースのため、新しい違反パターンが出た場合は検査自体を拡張する必要がある。

## ADR-006 — 通知の購読不足はローカルとサーバーで状態を分ける

- Context: 旧 `subscriptionMissing` は `PushManager.getSubscription()` と `/api/push/subscribe` の 410 を同じフラグに混在させていた。設定再オープン時のローカル再検証が 410 警告を消し、逆に起動時同期の結果が固定されて購読消失警告が出ない flakes も起きていた。
- Decision: `localSubscriptionMissing` と `serverSubscriptionMissing` を分離し、表示は両者の OR で決める。設定オープン時はローカルのみ再検証し、410 は再有効化または無効化まで保持する。
- Consequences: 設定再オープンでローカル購読の変化を反映でき、410 警告も消えない。再オープン直後に一瞬古い表示が描画されるが、非同期更新で直ちに訂正される。

## ADR-007 — 低リスク改善の収束と残課題の扱い

- Context: Round 1〜8 で通知判定、レート制限、規範強制、デッドコード、flakes、ID/画像/列挙、HTTP レスポンスを順に集約し、unit 73 / E2E 46 が安定した。残る候補はプロダクト判断（AI 期限既定値・通知スケジュール・BYOK 制限）か、共有 `state` / `ui` の所有権再設計という高リスク変更だけである。
- Decision: 安全に自動化できる高価値改善はここで収束とした。残課題は `TASK_POOL.md` に `blocked` / `queued` として保持し、判断または専用の設計ラウンドを待つ。
- Consequences: 追加の抽象化やディレクトリ移動を行わず、既存の契約とテストを維持する。再開時は TASK_POOL の先頭から次のラウンドを始める。
