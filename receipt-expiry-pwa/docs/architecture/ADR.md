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
